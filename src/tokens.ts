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
