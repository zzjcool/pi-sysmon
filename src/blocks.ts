/**
 * Metric block construction — turns "history + latest snapshot" into the
 * `MetricBlock[]` that chart-panel can draw.
 *
 * Why a dedicated file: this is the **only** place that decides "what each
 * chart shows and what its readouts say". Extracting it lets tests and the
 * render harness reuse it directly instead of copying a version elsewhere
 * that slowly drifts. No pi API, no TUI here — pure data in, pure data out.
 */
import {
	percentAxis,
	rateAxis,
	segsWidth,
	type AxisSpec,
	type BlockSeries,
	type MetricBlock,
	type Seg,
	type StyledLine,
	type ThemeColor,
} from "./chart-panel.ts";
import { fmtBytes, fmtRate, type Snapshot } from "./metrics.ts";
// The TPS formatter lives in the tokens module (the rightful home of anything
// token-related); import it here rather than writing a second copy — two
// formatters for the same quantity will drift sooner or later.
import { fmtHitPct, fmtTps, hitRate } from "./tokens.ts";

/** History series to plot as curves (all numeric arrays, index 0 = oldest) */
export interface History {
	cpu: number[];
	mem: number[];
	netRx: number[];
	netTx: number[];
	diskR: number[];
	diskW: number[];
	/**
	 * LLM token throughput (tok/s), estimated from pi's streaming `message_update` events.
	 *
	 * It is not a system metric (nothing to do with `/proc`) but the throughput
	 * between this pi process and the LLM API, so it is fed by the meter in
	 * `src/tokens.ts` — see the comments there.
	 */
	tps: number[];
	/**
	 * **Session-cumulative cache hit rate** (0..100), sampled once per frame.
	 *
	 * Not a metered quantity either: it is recomputed each sample from the running
	 * totals (`hitRate(tokCacheRead, tokIn)`) and is therefore a **step function**
	 * — it only moves when a `message_end` arrives, holding flat in between. That
	 * staircase shape is intentional and honest: the underlying numbers are exact
	 * provider-reported totals, so there is no sub-frame information to draw.
	 *
	 * Stored (rather than derived on the fly from a cumulative history) so the
	 * curve shows **how much this session's cache behaviour has changed**, instead
	 * of one single number repeated across the whole window.
	 */
	sessHit: number[];
}

/**
 * Default sampling fraction of the rate-chart scale window.
 *
 * `1` = **scale window == display window (60s)**, i.e. the top of the y axis is
 * the true maximum within these 60 seconds. This is the behavior the user
 * explicitly asked for:
 *   "I don't need + ... I just want it to show the highest point, with a 60s window"
 * Benefit: the height of any curve on screen can be read directly off the top
 * tick (**the scale never lies**), and no overflow marker `+` is needed.
 *
 * Cost (known and explicitly accepted by the user): one spike pins the scale
 * until it rolls out of the 60s window, during which later values look small.
 * We tried defaulting to `1/6` (only the last 10s) to mitigate that, but it
 * created a lying-scale problem: "tick says 293KB while a spike reaches the top
 * of the screen".
 *
 * To get the old auto-fallback behavior: set `PI_SYSMON_SCALE_WINDOW=1/6` (or
 * any fraction < 1); the overflow marker `+` then kicks in automatically so the
 * scale still doesn't lie.
 */
export const DEFAULT_SCALE_WINDOW_FRAC = 1;

export interface BlockOptions {
	/** How many recent data points each chart shows (derived from the layout's plot width, see plotWidthFor) */
	points: number;
	/** Whether to add an extra disk I/O block */
	showDisks?: boolean;
	/**
	 * Whether to show the TPS (LLM token throughput) chart. **On by default** (the user asked for four charts by default).
	 *
	 * Unlike the disk chart: disks default to off (four side-by-side blocks only
	 * look good on wide terminals), while TPS is a standing indicator the user
	 * explicitly requested.
	 */
	showTokens?: boolean;
	/** Current TPS reading (tok/s). Fed by the meter in `src/tokens.ts`, shown in the title bar */
	tpsNow?: number;
	/**
	 * Session-cumulative **uplink** tokens (the prompts we send to the model),
	 * taken from the exact `usage.input` of `message_end` (not an estimate).
	 */
	tokensIn?: number;
	/** Session-cumulative **downlink** tokens (model output), from the exact `usage.output` */
	tokensOut?: number;
	/** Session-cumulative cache-read tokens (`usage.cacheRead`), shown as `R…` */
	tokensCacheRead?: number;
	/**
	 * **Instantaneous** cache hit rate of the most recent assistant turn (0..100),
	 * computed from that turn's own `usage.input` / `usage.cacheRead`.
	 *
	 * Undefined means "no turn has reported a measurable prompt yet" (session
	 * start, or a message that carried no prompt tokens). The title bar shows it
	 * as `·N%` — the dot marks it as the *point* value, against `⌀N%`, the
	 * cumulative session average, which is what the second curve draws.
	 */
	hitNow?: number;
	/**
	 * Where to put the readouts: `title` (default) = border title bar; `box` =
	 * floating box at the top-right corner; `both` = draw both; `none` = draw neither.
	 *
	 * The two positions are fed separately: `MetricBlock.titleInfo` for the title
	 * bar, `MetricBlock.legend` for the floating box. That way each mode can use
	 * the wording that suits it best (e.g. the title bar can drop the `RX:` prefix
	 * because colors already distinguish RX/TX).
	 */
	labelMode?: LabelMode;
	/**
	 * **Scale sampling fraction** for rate charts (Network / Disks / Tokens), default `1`.
	 *
	 * Meaning: the y-axis scale looks at the maximum over the **whole window**
	 * (60s), not just a recent slice. That way the height of any curve on screen
	 * can be read directly off the top tick (the scale doesn't lie).
	 * Cost: spikes older than 10s get clipped at the top (drawn as a flat ceiling).
	 *
	 * Reference: btop's proven approach (`net_auto` in `btop_collect.cpp`:
	 * after a hysteresis of 5 frames, drop the scale to "recent mean × 1.3" with
	 * a 10KiB floor).
	 * Using "10 seconds" instead of btop's "5 frames" translates it to this
	 * project's time scale: 5 seconds is too twitchy — normal short bursts would
	 * be clipped the moment they're drawn.
	 *
	 * Pass `1` to fall back to the old "max over the whole window" behavior.
	 * Percent charts are unaffected (fixed 0..100 scale).
	 */
	scaleWindowFrac?: number;
}

/** Where readouts are rendered */
export type LabelMode = "title" | "box" | "both" | "none";

/**
 * Whether the chart widget hangs above or below the editor.
 *
 * Maps to pi's official `setWidget(key, content, { placement })`
 * (`WidgetPlacement` has been public API since 0.8x). Both `chart` and
 * `status` (i.e. `/sysmon line`) modes use it: both are widgets, so both can
 * land above or below the editor.
 * `footer` mode is not affected — it replaces the whole bottom, which is
 * below the editor anyway.
 */
export type Placement = "aboveEditor" | "belowEditor";

/**
 * Parse `PI_SYSMON_PLACEMENT`.
 *
 * **Default (unset) = `belowEditor`** (chart below the input box) —
 * the default chosen by the user: charts hug the bottom and don't take space
 * above the chat area.
 *
 * Lenient values: `above` / `aboveEditor` / `top` all mean "above";
 * everything else (including undefined and typos) falls back to the default
 * `belowEditor` — consistent with the error tolerance of `PI_SYSMON_LABEL` /
 * `PI_SYSMON_MODE`: one misconfigured env var shouldn't break the whole extension.
 *
 * During development the default was `aboveEditor`, so `PI_SYSMON_PLACEMENT=above`
 * restores that look.
 */
export function parsePlacement(v: string | undefined): Placement {
	const s = (v ?? "").trim().toLowerCase();
	return s === "above" || s === "aboveeditor" || s === "top"
		? "aboveEditor"
		: "belowEditor";
}

/** The three display modes. `status` is the internal name of `line` (historical reasons, see `parseMode`). */
export type Mode = "chart" | "status" | "footer";

/**
 * Parse a mode name (shared by `PI_SYSMON_MODE` and the config file).
 *
 * **Both `line` and `status` are accepted**, returning the internal `status`.
 * This leniency matters: in the external docs (README) this mode is called
 * `line` (matching `/sysmon line`), while the internal `Mode` is `status` —
 * if only the internal name were recognized, a user writing
 * `PI_SYSMON_MODE=line` per the docs would be **silently ignored** (falling
 * back to chart), and likewise for `line` in the config file.
 * Consistent with the error tolerance of `parsePlacement` / `PI_SYSMON_LABEL`:
 * a misconfigured value shouldn't break the extension, but a value that is
 * *documented* must work.
 *
 * Unknown/empty values fall back to the default `chart`.
 */
export function parseMode(v: string | undefined): Mode {
	switch ((v ?? "").trim().toLowerCase()) {
		case "line":
		case "status":
			return "status";
		case "footer":
			return "footer";
		default:
			return "chart";
	}
}

/**
 * Format a token count.
 *
 * **Deliberately byte-identical to pi footer `formatTokens`**
 * (`dist/modes/interactive/components/footer.js`): that way the chart's
 * `↑5.7k ↓11` matches the numbers in pi's bottom line `↑5.7k ↓11 R640`
 * exactly and they can be cross-checked. Including the **lowercase `k`** —
 * an uppercase `K` would both diverge from the host and collide with
 * `fmtTps`'s `Kt/s`.
 *
 * The only difference from pi is the **added upper-bound clamp**: this repo's
 * iron rule is that any over-wide rendered line crashes pi, so extreme values
 * must be capped (pi has no cap and grows all the way to `1000000M`).
 */
export function fmtTokensTotal(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n >= 1e9) return ">999M";
	if (n >= 1e7) return `${Math.round(n / 1e6)}M`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return Math.floor(n).toString();
}

/** Take the last n elements of an array (all of it if shorter) */
export function tail(arr: number[], n: number): number[] {
	return n >= arr.length ? arr : arr.slice(arr.length - n);
}

/**
 * Input for `line` mode (`/sysmon line`).
 *
 * Shares the same data sources as chart mode, so the field names match
 * `buildBlocks`'s `BlockOptions` / `History`
 * (`tpsNow` / `tokensIn` / `tokensOut` / `tokensCacheRead`) — the same
 * quantity under two names in two modes would drift sooner or later.
 */
export interface LineOptions {
	/** System snapshot; `undefined` means collection failed (non-Linux / /proc unreadable) */
	snap?: Snapshot;
	/** Current TPS (tok/s), fed by the meter in `src/tokens.ts` */
	tpsNow?: number;
	/** Session-cumulative uplink tokens (exact `usage.input`) */
	tokensIn?: number;
	/** Session-cumulative downlink tokens (exact `usage.output`) */
	tokensOut?: number;
	/** Session-cumulative cache-read tokens (exact `usage.cacheRead`) */
	tokensCacheRead?: number;
	/** Instantaneous cache hit rate of the last assistant turn (0..100), shown as `·N%` */
	hitNow?: number;
}

/** Segment construction helper: saves every readout from writing `{ text, color }` in full */
const seg = (text: string, color?: ThemeColor): Seg => ({ text, color });

/**
 * The text line of `line` mode — returns **tiered segments**; when width runs
 * out, whole segments are dropped from the tail.
 *
 * ## Why not just return a string
 *
 * The old implementation assembled a string itself + checked length with
 * `visibleWidth`, and had two real problems:
 *  1. No tokens (a gap the user explicitly called out);
 *  2. Once a wording tier was chosen the line was fixed — **a widening
 *     terminal would not add information back** — and what got dropped was a
 *     whole tier (all or nothing), not "degrade by importance".
 *
 * Now it's "a segment sequence sorted by importance + dropping whole segments
 * from the tail":
 *  · Descending importance: CPU → MEM → TOK → NET;
 *  · Each segment carries its own color, **same name, same color** as chart
 *    mode, so the two modes can be cross-checked against each other;
 *  · Truncation only happens when the whole line doesn't fit, and **never cuts
 *    a segment's text in half** (whole segments are dropped), avoiding
 *    half-numbers like `CPU 12`.
 *
 * **Never returns empty**: the first group (CPU when there's a snapshot, TOK
 * when there isn't) is kept no matter how narrow; over-width is left to
 * `renderStyledLine` to truncate — a CPU readout with its tail cut off is
 * better than a blank line (a blank line makes people think the extension
 * died).
 * So this function only produces "data + colors" and never touches ANSI.
 */
export function plainLineSegs(opts: LineOptions, width: number): StyledLine {
	// Non-finite widths must fall back to 1 first: `Math.max(1, Math.floor(NaN))`
	// is still NaN, and the comparison below uses `joinedWidth(...) > w` — any
	// comparison with NaN is false, so "everything fits" would return the
	// **whole line** (instead of keeping only the first segment), and a caller
	// trusting that width budget would overflow. Better conservative all the way.
	const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
	const s = opts.snap;

	// Descending importance, in whole "groups": never split inside a group.
	// Two-space gap between groups (other footer extensions lay out the same
	// way; it visually separates adjacent statuses).
	const groups: StyledLine[] = [];

	if (s) {
		groups.push([
			seg("CPU ", "muted"),
			seg(`${s.cpuPct.toFixed(0)}%`, "success"),
		]);
		groups.push([
			seg("MEM ", "muted"),
			seg(`${s.memPct.toFixed(0)}%`, "warning"),
			seg(` ${fmtBytes(s.memUsed)}`, "muted"),
		]);
	}

	// Token group: same convention as chart mode's `Tokens` block (current rate +
	// hit rates + session cumulative).
	// Emitted **even without a snapshot** — TPS doesn't depend on /proc; it's the
	// only metric that still means anything on non-Linux.
	//
	// It sits **before NET**, unlike the old CPU→MEM→NET→TOK order: when the line
	// runs out of room, whole groups are dropped from the tail, and the token
	// readout is far less recoverable from anywhere else on screen than the
	// network rate — so it outranks NET. There is deliberately **no in-group
	// degradation** (the group is all-or-nothing): the line is a single row with
	// no room for a second curve, and a half-dropped token group would show a
	// rate whose meaning depends on which neighbours happened to fit.
	const tps = opts.tpsNow ?? 0;
	const tokIn = opts.tokensIn ?? 0;
	const tokOut = opts.tokensOut ?? 0;
	const tokR = opts.tokensCacheRead ?? 0;
	// Same derived values as `buildBlocks` (see the long comment there): available
	// cache reads, and the cumulative rate recomputed from the running totals.
	// Deriving instead of storing keeps both modes reading from one source of
	// truth — the same numbers the chart draws.
	const seenCache = tokR > 0;
	const cumHit = hitRate(tokR, tokIn);
	const tokSegs: StyledLine = [
		seg("TOK ", "muted"),
		seg(`~${fmtTps(tps)}`, "accent"),
	];
	// Same order and colors as the chart title bar: instantaneous (`·`, success)
	// then cumulative (`⌀`, warning — the color of the curve it corresponds to).
	if (seenCache && opts.hitNow !== undefined && Number.isFinite(opts.hitNow))
		tokSegs.push(seg(` ·${fmtHitPct(opts.hitNow)}`, "success"));
	if (seenCache) tokSegs.push(seg(` ⌀${fmtHitPct(cumHit)}`, "warning"));
	// Cumulative initials `↑`/`↓`/`R` match pi's built-in footer in character and order, directly comparable
	if (tokIn > 0) tokSegs.push(seg(` ↑${fmtTokensTotal(tokIn)}`, "muted"));
	if (tokOut > 0) tokSegs.push(seg(` ↓${fmtTokensTotal(tokOut)}`, "muted"));
	if (seenCache) tokSegs.push(seg(` R${fmtTokensTotal(tokR)}`, "muted"));
	groups.push(tokSegs);

	if (s) {
		groups.push([
			seg("NET ", "muted"),
			seg(`↑${fmtRate(s.txBps)}`, "warning"),
			seg(` ↓${fmtRate(s.rxBps)}`, "accent"),
		]);
	}

	const joinedWidth = (gs: StyledLine[]): number =>
		gs.reduce((acc, g) => acc + segsWidth(g), 0) + Math.max(0, gs.length - 1) * 2;

	// Drop whole groups from the tail until it fits. **The first group is always
	// kept**: with a snapshot it's CPU (the shortest and most important),
	// without one it's TOK.
	// It's not dropped even if it alone overflows — what the caller renders then
	// is a truncated readout line rather than a blank one (a blank line makes
	// people think the extension died).
	let keep = groups.length;
	while (keep > 1 && joinedWidth(groups.slice(0, keep)) > w) keep--;
	const kept = groups.slice(0, keep);

	const out: StyledLine = [];
	kept.forEach((g, i) => {
		if (i > 0) out.push(seg("  "));
		out.push(...g);
	});
	return out;
}

/**
 * Scale floor for the TPS chart (tok/s). Without it, a 1 tok/s tail point
 * during idle would pin the scale at 1.5 and the next 200 tok/s reply would
 * slam the ceiling; with the floor the scale starts at 10 tok/s.
 */
export const MIN_TPS_SCALE = 10;

/**
 * Tick column width for the TPS chart.
 *
 * Wider than `RATE_GUTTER` (5): the widest tick this axis can emit is the
 * `>999Kt/s` clamp, which is 8 columns (`1.5Kt/s` is 7). The unit is the
 * **compact** `t/s`, not `tok/s` — see `fmtTps` for why.
 *
 * Like `RATE_GUTTER` it is **constant width**: when the tick label width
 * changes, the overlay width follows → the plot area's left edge jumps
 * left/right every frame (ARCHITECTURE pitfall 6).
 */
export const TPS_GUTTER = 8;

/**
 * Y axis for the TPS chart.
 *
 * Same algorithm as `rateAxis` (scale = max × 1.5, only the top value labeled,
 * fixed-width right-aligned), but the **unit is tokens, not bytes**.
 *
 * Why not just use `rateAxis`: it hardcodes the 1024 base and the `B/KB/MB`
 * suffixes — using it for tok/s would print scales like `2.2KB` (actually
 * 1500 tok/s). A chart saying KB when it's really tokens is worse than no scale.
 *
 * Base **1000**, not 1024: tokens are a decimal quantity, and `total_tokens`
 * in API billing is decimal too.
 */
export function tokenAxis(dataMax: number): AxisSpec {
	// NaN/Infinity/negatives fall back to 0 first: otherwise `Math.max` carries
	// NaN all the way into the tick text, and next stop is NaN coordinates →
	// out-of-bounds crash (see ARCHITECTURE.md pitfall 4).
	const dm = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
	// Scale = max × 1.5 (the peak lands at about 2/3 of the axis height, same
	// convention as rateAxis); empty/tiny data uses the floor to avoid a zero
	// scale (the chart would slam against the top).
	const top = Math.max(dm * 1.5, MIN_TPS_SCALE);
	// Fixed width, right-aligned: every branch must return exactly TPS_GUTTER columns.
	const fit = (v: number): string => {
		let s: string;
		if (v >= 1e6)
			s = ">999Kt/s"; // extreme values: give an upper bound, never scientific notation
		else if (v >= 1000) {
			const k = (v / 1000).toFixed(1);
			s = `${k}Kt/s`;
			// If it doesn't fit, reduce precision (`100.5K` → `101K`) instead of
			// truncating into a mangled stub like `100.5Kt/`.
			if (s.length > TPS_GUTTER) {
				// Rounding may yield 1000 (e.g. v=999999 → `1000K`), so fall back to
				// the clamped value: otherwise the tick would say `1000Kt/s`,
				// contradicting the `>999Kt/s` convention above (and `1000K` reads
				// like 1M yet still carries a K suffix).
				const n = Math.round(v / 1000);
				s = n >= 1000 ? ">999Kt/s" : `${n}Kt/s`;
			}
		} else {
			s = `${v.toFixed(0)}t/s`;
		}
		return s.padStart(TPS_GUTTER);
	};
	return { labels: [fit(top)], max: top };
}

/** Result of resolving the time window */
export interface WindowSpec {
	/** How many data points to plot */
	points: number;
	/** Duration (seconds) shown by the x-axis left label */
	windowSecs: number;
}

/**
 * Resolve "how much history to show".
 *
 * **This is the single source of truth for the horizontal time scale.** It was
 * extracted into a pure function because it used to be a real bug: the window
 * used to be derived in place from "how many points fit the plot area"
 * (`plotWidthFor(blockW) * 2 / interval`), so on the same machine, changing the
 * terminal width drifted the x-axis label from `60s` to `44s`/`84s`/`118s` —
 * the time scale changed with window size, making comparisons across widths
 * and machines impossible. And that logic lived inside a component closure
 * that no test could reach (the render harnesses each copied their own
 * version, so fixing one left the others drifting). Now there's only one copy,
 * and it's unit-testable.
 *
 * Two key behaviors:
 *  1. **Pick points by time, not by width** (aligned with bottom's
 *     `default_time_value = 60_000`);
 *  2. **The label always shows the configured window length** (shows `60s`
 *     even 3 seconds after startup) — it used to shrink to `3s` based on
 *     points collected so far, making the horizontal duration grow during
 *     startup so you couldn't compare "this stretch now" with "a full window".
 *     Combined with right-aligned rendering (`stretch: false`, data grows in
 *     from the right), the `60s` reading is honest: 3 seconds of data only
 *     occupy the rightmost 1/20 of the width instead of being stretched to
 *     impersonate 60 seconds.
 */
export function resolveWindow(opts: {
	/** Target window duration (seconds) */
	windowSecs: number;
	/** Sampling interval (milliseconds) — needed to convert the window into a point count */
	intervalMs: number;
	/** Explicitly specified point count (PI_SYSMON_POINTS); when set, the window seconds are ignored */
	fixedPoints?: number;
	/**
	 * How many points are actually in the buffer right now.
	 * @deprecated No longer used to shorten the window duration (that made the
	 * horizontal scale drift). The parameter is kept so existing call sites don't
	 * change; the passed value is ignored.
	 */
	available?: number;
}): WindowSpec {
	const points =
		opts.fixedPoints ??
		Math.max(2, Math.round((opts.windowSecs * 1000) / opts.intervalMs));
	// The window duration **does not change with collected history**: the scale must be stable.
	// The previous `min(points, available)` was meant to "keep the label honest",
	// but it made the horizontal axis keep growing during startup (3s→14s→30s→60s).
	// The truly honest approach is **time-proportional rendering** (data grows in
	// from the right, one second of screen width is constant), not rewriting the
	// scale to whatever duration happens to be buffered.
	//
	// The duration must be derived from the **actual point count**, not returned
	// as `windowSecs` directly: `PI_SYSMON_POINTS` can explicitly change the
	// point count, and then the real window is `points` sampling intervals,
	// unrelated to `windowSecs` (otherwise `POINTS=200` would falsely report `60s`).
	return { points, windowSecs: (points * opts.intervalMs) / 1000 };
}

/**
 * Build the metric blocks. When `snap === undefined` (collection failed / not
 * collected yet) still returns structurally complete blocks — just without
 * readouts and with empty curves — so the row count stays constant.
 */
export function buildBlocks(
	hist: History,
	snap: Snapshot | undefined,
	opts: BlockOptions,
): MetricBlock[] {
	const points = Math.max(1, Math.floor(opts.points));
	// Readout position switch: default `title` (title bar), i.e. only fill
	// titleInfo, not legend. Decided once here so each block doesn't repeat its
	// own `labelMode` check and risk missing one.
	const mode: LabelMode = opts.labelMode ?? "title";
	const wantTitle = mode === "title" || mode === "both";
	const wantBox = mode === "box" || mode === "both";
	/** Pick per switch: the unwanted copy is blanked out so renderBlock/renderPanel naturally skip it */
	const at = (title: StyledLine | undefined): StyledLine | undefined =>
		wantTitle ? title : undefined;
	const ab = (box: StyledLine[]): StyledLine[] => (wantBox ? box : []);
	// Scale sampling point count for rate charts: derived from the **target
	// window**, independent of how many points have been collected so far.
	// Absolute point count rather than a fraction, because a fraction applied to
	// the short arrays of early startup yields a growing scale window, making
	// recovery time erratic (measured drifting from 10s to 18s).
	const rateScalePts = Math.max(
		1,
		Math.round(points * (opts.scaleWindowFrac ?? DEFAULT_SCALE_WINDOW_FRAC)),
	);

	const blocks: MetricBlock[] = [
		{
			// Name matches bottom's border title
			name: "CPU",
			color: "success",
			// Title-bar readouts (descending importance; dropped from the tail on narrow blocks):
			// current usage → 1/5/15 min load averages (the latter formatted like bottom's `CPU ─ 1.52 1.71 2.26`)
			titleInfo: at(
				snap
					? [
							{ text: `${snap.cpuPct.toFixed(0)}%`, color: "success" },
							{
								text: `  ${snap.load1.toFixed(2)} ${snap.load5.toFixed(2)} ${snap.load15.toFixed(2)}`,
								color: "muted",
							},
						]
					: undefined,
			),
			series: [{ values: tail(hist.cpu, points) }],
			// Floating readout box for `PI_SYSMON_LABEL=box` (content overlaps the
			// title bar's, but since only one of the two modes is enabled, no need
			// to sacrifice information to avoid duplication)
			legend: ab(snap ? [[{ text: `AVG ${snap.cpuPct.toFixed(0)}%` }]] : []),
			windowPoints: points,
			axis: () => percentAxis(),
		},
		{
			name: "Memory",
			color: "warning",
			// Explicitly requested by the user: append `30G/62G` right after the
			// percentage in the title bar
			titleInfo: at(
				snap
					? [
							{ text: `${snap.memPct.toFixed(0)}%`, color: "warning" },
							{
								text: `  ${fmtBytes(snap.memUsed)}/${fmtBytes(snap.memTotal)}`,
								color: "muted",
							},
						]
					: undefined,
			),
			series: [{ values: tail(hist.mem, points) }],
			legend: ab(
				snap
					? [
							[
								{ text: `RAM ${snap.memPct.toFixed(0)}% ` },
								{ text: `${fmtBytes(snap.memUsed)}/${fmtBytes(snap.memTotal)}` },
							],
						]
					: [],
			),
			windowPoints: points,
			axis: () => percentAxis(),
		},
		{
			name: "Network",
			color: "accent",
			// Order is **instantaneous rate first, cumulative total after**, because
			// when the title bar runs out of width it **drops from the tail**, so
			// the later parts get hidden first.
			// Rate change is the main subject of this chart (the curves draw it), so
			// it goes first to survive any width; total traffic is background info
			// and is sacrificed first on narrow blocks.
			// Σ = cumulative (∑). Likewise ↓=RX in accent and ↑=TX in warning,
			// same colors as the two curves in the chart, so no extra text is
			// needed to tell directions apart.
			titleInfo: at(
				snap
					? [
							{ text: `↓${fmtRate(snap.rxBps)}`, color: "accent" },
							{ text: " ", color: "muted" },
							{ text: `↑${fmtRate(snap.txBps)}`, color: "warning" },
							// The Σ part is **split into three small segments** instead of one big block.
							//
							// Why: the title bar is "accumulate segment by segment, break when
							// it doesn't fit", so **segment granularity decides whether partial
							// display is possible**. The old `  Σ↓79G ↑128G` was one 14-char
							// segment — all in or all out. After the four-chart rework each
							// block got narrower (only 38 cols at 150 columns, roomForInfo≈23),
							// and the whole Σ was dropped (measured: Σ only reappeared at 164
							// columns, while the three-chart layout managed at 124). Split
							// apart, 150 columns can keep `Σ↓79G` — the info is no longer
							// all-or-nothing.
							{ text: "  Σ", color: "muted" },
							{ text: `↓${fmtBytes(snap.rxTotal)}`, color: "accent" },
							{ text: ` ↑${fmtBytes(snap.txTotal)}`, color: "warning" },
						]
					: undefined,
			),
			// RX/TX share one chart but each gets a color (aligned with bottom's blue/yellow dual lines)
			series: [
				{ values: tail(hist.netRx, points), color: "accent" },
				{ values: tail(hist.netTx, points), color: "warning" },
			],
			// Single line (the floating box only carries cumulative traffic, the one
			// thing not visible on the chart) — a two-line box has legendH=4 and
			// would overflow the default plotRows=4 plot area and get dropped entirely.
			legend: ab(
				snap
					? [
							[
								{ text: "Σ " },
								{ text: `↓${fmtBytes(snap.rxTotal)}`, color: "accent" },
								{ text: " " },
								{ text: `↑${fmtBytes(snap.txTotal)}`, color: "warning" },
							],
						]
					: [],
			),
			scaleWindowPoints: rateScalePts,
			windowPoints: points,
			axis: (dataMax) => rateAxis(dataMax),
		},
	];

	// TPS (LLM token throughput) — on by default, the standing fourth chart the
	// user explicitly asked for.
	// It goes last: that way the existing indexes and docs for the first three
	// positions (CPU/Memory/Network) stay unchanged, while "four charts by
	// default" still holds.
	if (opts.showTokens !== false) {
		// The curve only draws the **downlink (output) rate**, while the readouts
		// list both directions.
		//
		// Why not two curves (like Network's RX/TX): the two directions have
		// **fundamentally different time shapes**. Measured on a real call:
		// uplink input = 5671 tokens (uploaded in **one bulk chunk**),
		// downlink output = 11 tokens (**streamed token by token**) — a ~516:1 ratio.
		// On the same y axis, input would pin the scale at 5671 and output would
		// be squashed to 0.2% height, completely invisible — an extreme version
		// of the "spike pins the scale" problem the user complained about before.
		// So: the curve shows the only meaningful continuous quantity (output rate),
		// and the **cumulative** amounts of both directions go in the title bar —
		// they aren't rates and don't belong on a rate axis.
		//
		// The readout convention is **byte-identical to pi footer**
		// (`↑input ↓output RcacheRead`, session cumulative), so the numbers on the
		// chart can be checked directly against pi's bottom line.
		const cur = opts.tpsNow ?? 0;
		const tokIn = opts.tokensIn ?? 0;
		const tokOut = opts.tokensOut ?? 0;
		const tokR = opts.tokensCacheRead ?? 0;
		// ── Cache hit rate ──────────────────────────────────────────────
		// Cached prompt tokens are billed far cheaper than fresh input, so the hit
		// rate is the one number that says whether the cache is actually working.
		// Two views of it, deliberately different:
		//   · cumulative (`⌀`, what the yellow curve draws) — recomputed here from
		//     the running session totals, so it never needs its own accumulator;
		//   · instantaneous (`·`, title bar only) — the last turn's own ratio,
		//     which is the actionable one (it reacts immediately when a turn
		//     misses the cache; the cumulative average hides that for a long time).
		// `⌀` (U+2300 DIAMETER SIGN, width 1) reads as "average" without stealing
		// the `~` that already means "estimated" on the rate.
		//
		// `seenCache` / `cumHit` are derived, not stored: `seenCache ≡ tokR > 0`
		// is just "the provider has ever reported a cache read this session", and
		// `cumHit` is a pure function of the two cumulative counters already in
		// this scope. Keeping them derived removes any chance of a second ledger
		// drifting from the totals.
		const seenCache = tokR > 0;
		const cumHit = hitRate(tokR, tokIn);
		// `~` only goes on the **rate**: it's estimated from delta text, not metered.
		// Cumulative values come from the exact `usage` of `message_end`, so no `~` —
		// the distinction itself is information for the user (which number to trust).
		const curTxt = `~${fmtTps(cur)}`;
		// Segmented construction: **descending importance**, since the title bar is
		// accumulated segment by segment and drops from the tail when it runs out of
		// room. Order: rate → instantaneous hit → cumulative hit → ↑ → ↓ → R.
		// The two hit-rate readouts sit **right after the rate** because they're the
		// subject of the second curve; the cumulative token counters are background
		// info (already exact in pi's own footer) and yield first.
		// Leading spaces live inside each segment, so dropping one never glues its
		// neighbours together (` ·` + `⌀` vs ` ⌀` stays correct either way).
		const infoSegs: StyledLine = [{ text: curTxt, color: "accent" }];
		if (seenCache && opts.hitNow !== undefined && Number.isFinite(opts.hitNow))
			infoSegs.push({ text: ` ·${fmtHitPct(opts.hitNow)}`, color: "success" });
		if (seenCache)
			infoSegs.push({ text: ` ⌀${fmtHitPct(cumHit)}`, color: "warning" });
		if (tokIn > 0)
			infoSegs.push({ text: `  \u2191${fmtTokensTotal(tokIn)}`, color: "muted" });
		if (tokOut > 0)
			infoSegs.push({ text: ` \u2193${fmtTokensTotal(tokOut)}`, color: "muted" });
		if (seenCache)
			infoSegs.push({ text: ` R${fmtTokensTotal(tokR)}`, color: "muted" });
		// ── Second curve: cumulative hit rate (only once cache reads exist) ──
		// It shares **the TPS axis as-is** (raw 0..100 values, no independent
		// normalization). When TPS is high the yellow line therefore hugs the
		// floor — that is the accepted behaviour: a second y-scale would need a
		// second gutter, and two scales inside one 24-column block would leave no
		// room for the plot itself.
		// TPS must stay **series[0]**: `renderChartGlyphs` resolves same-cell
		// collisions in favour of the lowest index, so the rate curve keeps its
		// cells (and its colour) even when the two lines overlap.
		const tokSeries: BlockSeries[] = [{ values: tail(hist.tps, points) }];
		if (seenCache)
			tokSeries.push({ values: tail(hist.sessHit, points), color: "warning" });
		blocks.push({
			name: "Tokens",
			color: "accent",
			// Consistent with other blocks: when there's no snapshot (e.g. collection
			// failed on non-Linux), don't write readouts.
			// TPS itself doesn't depend on /proc, but the invariant (no snapshot ⇒
			// no readouts) is worth keeping.
			titleInfo: at(snap ? infoSegs : undefined),
			series: tokSeries,
			legend: ab([[{ text: curTxt }]]),
			scaleWindowPoints: rateScalePts,
			windowPoints: points,
			// Token-unit ticks (can't reuse rateAxis: it would label tok/s as KB)
			axis: (dataMax) => tokenAxis(dataMax),
		});
	}

	if (opts.showDisks) {
		blocks.push({
			name: "Disks",
			color: "error",
			titleInfo: at(
				snap
					? [
							{ text: `R ${fmtRate(snap.readBps)}`, color: "accent" },
							{ text: " ", color: "muted" },
							{ text: `W ${fmtRate(snap.writeBps)}`, color: "error" },
						]
					: undefined,
			),
			series: [
				{ values: tail(hist.diskR, points), color: "accent" },
				{ values: tail(hist.diskW, points), color: "error" },
			],
			legend: ab(
				snap
					? [
							[{ text: "R: " }, { text: fmtRate(snap.readBps), color: "accent" }],
							[{ text: "W: " }, { text: fmtRate(snap.writeBps), color: "error" }],
						]
					: [],
			),
			scaleWindowPoints: rateScalePts,
			windowPoints: points,
			axis: (dataMax) => rateAxis(dataMax),
		});
	}
	return blocks;
}
