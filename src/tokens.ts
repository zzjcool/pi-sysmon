/**
 * Streaming token estimator — pure functions, zero dependencies, zero allocations (hot path).
 *
 * Background: during streaming pi only emits `message_update` incremental events
 * (text_delta / thinking_delta / toolcall_delta); the exact usage only arrives
 * when the message ends, so per-frame token counts must be estimated from the
 * delta text.
 *
 * Estimation convention: ASCII/other chars at 4 chars ≈ 1 token (matching the
 * chars/4 heuristic in pi-ai), CJK/kana/Hangul and other wide chars at
 * 1 char ≈ 1 token — without this distinction Chinese output would be
 * underestimated by roughly 4×.
 */

export type DeltaKind = "text" | "thinking" | "toolcall";

export interface TokenDelta {
	kind: DeltaKind;
	delta: string;
}

/** Whether a code point belongs to a CJK/wide range where each char is ~1 token.
 *  Uses range comparisons instead of regex: this runs once per delta on a hot
 *  path — range checks allocate nothing and avoid regex backtracking costs on
 *  large strings. */
function isCjkCodePoint(cp: number): boolean {
	return (
		(cp >= 0x3000 && cp <= 0x303f) || // CJK punctuation, ideographic space
		(cp >= 0x3040 && cp <= 0x30ff) || // Hiragana/Katakana
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
		(cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) // CJK Compatibility Ideographs
	);
}

/** Estimate the token count of a single delta text. Single pass, zero allocations, never throws.
 *  Empty string / non-string / non-finite result all return 0 — this value
 *  feeds directly into the chart, and NaN would blow up the y-axis scale. */
export function estimateDeltaTokens(delta: string): number {
	if (typeof delta !== "string" || delta.length === 0) return 0;
	let cjk = 0;
	let other = 0;
	for (const ch of delta) {
		const cp = ch.codePointAt(0) ?? 0;
		if (isCjkCodePoint(cp)) cjk++;
		else other++;
	}
	const est = Math.ceil(other / 4) + cjk;
	return Number.isFinite(est) ? est : 0;
}

export interface TpsMeter {
	/** Accumulate a delta. O(1), synchronous, never throws. */
	add(d: TokenDelta): void;
	/** Close the current bucket; returns the windowed rate and resets. */
	tick(nowMs: number): { tps: number; tokens: number };
	/** Token count accumulated in the current (unclosed) bucket. */
	pending(): number;
}

/** Create a tps meter. nowMs is an opaque millisecond clock (in production the
 *  caller passes performance.now()); only differences are used internally, the
 *  epoch is irrelevant. */
export function createTpsMeter(nowMs: number = Date.now()): TpsMeter {
	let last = nowMs;
	let pendingTokens = 0;

	return {
		add(d: TokenDelta): void {
			// Deltas come from external events, so wrap defensively: estimation must
			// never break the streaming flow even if it fails
			try {
				pendingTokens += estimateDeltaTokens(d?.delta ?? "");
			} catch {
				/* estimation errors must not affect the streaming main flow */
			}
		},
		tick(now: number): { tps: number; tokens: number } {
			const dtMs = now - last;
			last = now; // advance the baseline even on clock rollback: otherwise a bogus huge window accumulates
			const tokens = pendingTokens;
			pendingTokens = 0;
			// Never divide by zero when dtMs<=0 (clock rollback / two ticks in the
			// same millisecond) or non-finite — but still flush the bucket, otherwise
			// the next frame would double-count the old tokens
			if (!Number.isFinite(dtMs) || dtMs <= 0) return { tps: 0, tokens };
			const tps = (tokens * 1000) / dtMs;
			return { tps: Number.isFinite(tps) ? tps : 0, tokens };
		},
		pending(): number {
			return pendingTokens;
		},
	};
}

/**
 * Format a rate into the **compact** form used in chart titles: `635t/s` / `12.3Kt/s`.
 *
 * The width has a hard cap — this repo learned the hard way that any rendered
 * line wider than the terminal makes pi throw and exit (see the ">999T" clamp
 * precedent in fmtBytes). So clamp hard and never emit scientific notation.
 *
 * Why the compact form instead of the full unit (`635 tok/s`): the latter
 * doesn't fit the minimum block width (24 cols) of the four-chart layout —
 * `roomForInfo = 24 - 6 - 7 - 1 = 10` columns, while `~12.3K tok/s` is 12 —
 * so the **entire readout would disappear**, leaving a bare
 * `┌ Tokens ─────┐` on screen (observed in practice once tps ≥ 1000).
 *
 * `t/s` matches the y-axis tick style in `tokenAxis` (blocks.ts) exactly —
 * consistent and 3 columns shorter, so `~12.3Kt/s` (9 cols) fits even in a
 * 24-column block.
 *
 * Base 1000, consistent with `tokenAxis` and API billing conventions.
 */
export function fmtTps(tps: number): string {
	if (!Number.isFinite(tps) || tps <= 0) return "0t/s";
	if (tps >= 1e6) return ">999Kt/s";
	if (tps >= 1000) {
		const k = tps / 1000;
		// Prefer one decimal (`12.3K`); but the **decision must be based on the
		// formatted result**, not on comparing k to 100: at k=99.95, `toFixed(1)`
		// rounds up to `100.0` (9 columns) — longer than the integer form `100K`,
		// and wider than the value it just crossed — neither monotonic nor within
		// the compact budget.
		// This is the repo's usual "reduce precision instead of truncating": if one
		// decimal doesn't fit, fall back to an integer.
		const one = `${k.toFixed(1)}Kt/s`;
		if (one.length <= FMT_TPS_MAX) return one;
		const n = Math.round(k);
		// Rounding may reach 1000 (tps=999999 → `1000K`), so fall back to the
		// clamped value: emitting `1000Kt/s` would read like 1M yet carry a K
		// suffix, contradicting the >999Kt/s convention.
		return n >= 1000 ? ">999Kt/s" : `${n}Kt/s`;
	}
	return `${Math.floor(tps)}t/s`;
}

/**
 * Width upper bound for `fmtTps` output.
 *
 * 8 columns is not arbitrary: in the four-chart layout the minimum block width
 * is 24 columns (`MIN_BLOCK_W`), and the title bar `┌ Tokens ─ ` + readout +
 * ` ─┐` has exactly room for an 8-column readout. One more column would squeeze
 * the whole readout out (verified in practice: the full-unit form
 * `~12.3K tok/s` disappeared exactly that way).
 */
export const FMT_TPS_MAX = 8;

/**
 * Cache hit rate in percent, 0..100.
 *
 * Definition: `cacheRead / (cacheRead + input) × 100` — of the prompt tokens
 * the provider had to look at, how many were served from the prompt cache
 * instead of being re-billed as fresh input. This is the number that tells you
 * whether the cache is actually working (a low rate means every turn re-uploads
 * the whole context).
 *
 * Contract: `cacheRead + input <= 0` (nothing to compare), NaN/Infinity, or a
 * negative input all return 0 — the value feeds a chart series and a title
 * readout, and a NaN would poison both the shared token axis and the width
 * bookkeeping (wrong width → overflow → pi exits).
 */
export function hitRate(cacheRead: number, input: number): number {
	// Guard each operand before adding: `Infinity + (-Infinity)` is NaN, so a
	// single `Number.isFinite(cacheRead + input)` check would accept the
	// poisoned sum. Also rejects negatives: a negative token count is not a
	// cache miss, it's garbage.
	if (!Number.isFinite(cacheRead) || !Number.isFinite(input)) return 0;
	if (cacheRead < 0 || input < 0) return 0;
	const total = cacheRead + input;
	// `<= 0` covers the empty denominator (no prompt tokens yet): there is no
	// meaningful rate to report, and dividing would give NaN/Infinity.
	if (total <= 0) return 0;
	const pct = (cacheRead / total) * 100;
	// Clamp defensively: floating point can only push the result a hair outside
	// [0,100], but the chart axis and the width budget both assume the range.
	return Math.min(100, Math.max(0, pct));
}

/**
 * Format a hit rate as an integer percentage: `87%` / `100%`.
 *
 * Integer (not one decimal) on purpose: the title bar is the scarcest space in
 * this UI — the extra `.4` would cost two columns and tell the user nothing
 * (the curve already shows the fine shape).
 *
 * **Width is bounded by construction**: clamping to `[0,100]` before rounding
 * leaves at most `100%` = 4 columns, so callers can budget it exactly (this is
 * the same "never emit an unbounded-width readout" rule as `FMT_TPS_MAX`;
 * an over-wide title row makes pi exit).
 *
 * Non-finite input becomes `0%` rather than `NaN%`/`Infinity%`: same reasoning
 * as `fmtTps` — a stray character in the title row corrupts its width
 * accounting, and pi exits on an over-wide line.
 */
export function fmtHitPct(v: number): string {
	if (!Number.isFinite(v)) return "0%";
	const n = Math.round(Math.min(100, Math.max(0, v)));
	return `${n}%`;
}

/**
 * Format context-window usage as an integer percentage: `42%` / `100%`.
 *
 * **Delegates to `fmtHitPct`** rather than duplicating the body: both are
 * "integer percent, width-bounded by construction (max `100%` = 4 columns)"
 * readouts living in the same scarcest-space title bar, and a second copy of
 * the clamp/round dance is exactly the kind of drift this file exists to
 * prevent. The separate name exists for intent at the call site — a hit rate
 * and a context fill level are different quantities that happen to share a
 * formatting rule (and a `N%` suffix).
 */
export function fmtCtxPct(v: number): string {
	return fmtHitPct(v);
}
