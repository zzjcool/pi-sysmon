/**
 * chart-panel — draws metrics as **bottom-style** framed charts, laid out
 * responsively in multiple columns based on terminal width.
 *
 * The layout rules in this file **align item by item with bottom's actual
 * output**, based on three kinds of empirical evidence:
 *  1. ratatui's chart.rs (the plotting component bottom uses): the layout
 *     algorithm for axis lines/ticks;
 *  2. bottom source `src/canvas/components/time_series/base.rs`: Block border +
 *     title_top, x labels `["-Ns", "0s"]`, legend hidden_legend_constraints;
 *  3. Running `btm` at controlled widths (50/72/100/150 cols) and capturing
 *     frames for character-by-character verification.
 *
 * A single bottom chart looks like this (real frame at 150 cols, 3 side by side):
 * ```
 * ┌ CPU ─ 1.91 1.80 2.17 ────────────────────────┐
 * │100%│                          ┌────────────┐ │
 * │    │                          │AVG      7% │ │
 * │    │                          └────────────┘ │
 * │  0%│                                          │
 * │    └──────────────────────────────────────────│
 * │  60s                                        0s│
 * └──────────────────────────────────────────────┘
 * ```
 * Key points: the title is **embedded in the top border**; there are only two
 * or three y ticks; the x-axis line starts with `└` on the left and **does not
 * extend into the y-axis column**; the time-label row has no vertical lines;
 * the floating readout box is **painted over the top-right corner of the plot
 * area** and disappears entirely when there isn't enough room.
 *
 * Two **deliberate deviations** from bottom in this project (each justified
 * inline near the code):
 *  · When width is tight, **degrade to 4 / 2 / 1 columns** (column count adapts
 *    to block count 3/4) instead of squeezing several charts to 16 columns wide
 *    like bottom does;
 *  · The floating box show/hide threshold is "does it fit + leave at least 2
 *    columns of curve" instead of bottom's proportionally computed threshold —
 *    that threshold was calibrated for 40+ column charts and would never show
 *    anything on our 20~30 column charts.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderChartGlyphs } from "./braille.ts";

/**
 * Theme color names. Values come from pi's `ThemeColor` (theme.d.ts); only the
 * subset this file uses is declared here.
 * Note `Theme.fg(color, text)` has the signature `fg(color: ThemeColor, text: string): string`.
 */
export type ThemeColor =
	| "accent"
	| "border"
	| "borderMuted"
	| "success"
	| "warning"
	| "error"
	| "muted"
	| "dim"
	| "text";

export type ThemeLike = {
	fg: (color: ThemeColor, text: string) => string;
};

/** A piece of colored text */
export interface Seg {
	text: string;
	color?: ThemeColor;
}

/** A line made of several colored segments (used for floating box content) */
export type StyledLine = Seg[];

/** One curve in a chart */
export interface BlockSeries {
	values: number[];
	/** Cells owned exclusively by this curve use this color; defaults to the
	 *  block's main color. When multiple curves share a cell, the earlier series wins */
	color?: ThemeColor;
	/**
	 * When true this series is excluded from the y-scale computation (dataMax
	 * sampling) and from overflow detection — its values are expected to be
	 * pre-mapped to the axis by the caller (e.g. a secondary 0-100% series
	 * mapped onto the primary axis' scale).
	 *
	 * Known transient: the caller computes the mapping against the scale it saw
	 * at build time; if a later frame's scale (from the *included* series only)
	 * shrinks, the pre-mapped values can momentarily exceed `axisMax` and the
	 * braille renderer clamps them to the top row. That is the existing safe
	 * behaviour, so it is documented rather than special-cased here.
	 */
	excludeFromScale?: boolean;
}

/** Y-axis spec: labels (**index 0 at the bottom**, same as ratatui) + scale upper bound */
export interface AxisSpec {
	labels: string[];
	max: number;
}

export interface MetricBlock {
	/** Name in the border title, e.g. "CPU" / "Memory" / "Network" */
	name: string;
	/** Curve data (may be multiple, drawn in the same chart) */
	series: BlockSeries[];
	/** Main color: used for the border, title, y ticks, time labels, and curves without their own color */
	color: ThemeColor;
	/**
	 * Readout segments in the title bar, rendered as `┌ NAME ─ <segments...> ────┐`.
	 *
	 * Array order = **descending importance**: when the block is too narrow,
	 * segments are dropped from the tail, so the most important reading (current
	 * value) goes first and details (load averages, cumulative traffic) go last.
	 * Split into segments (rather than one long string) precisely so they can be
	 * dropped piece by piece, instead of "whole thing doesn't fit → show nothing".
	 */
	titleInfo?: StyledLine;
	/** Content lines of the floating readout box (border not included); hidden when empty or doesn't fit */
	legend?: StyledLine[];
	/**
	 * Scale sampling **point count** (active when > 0): the y-axis scale only
	 * looks at the last this many points. Default = the whole visible window.
	 *
	 * **Why it's needed**: if the scale took the max of the whole window, one
	 * spike would pin it until that point rolls out of the window (a full 60
	 * seconds for a 60s window) — meanwhile all later data is squashed into a
	 * bottom-hugging line, and the user sees "the height won't come down".
	 * Letting the scale only look at a recent slice makes it fall back once the
	 * spike passes.
	 *
	 * **Absolute point count** instead of a fraction: a fraction has to be
	 * multiplied by the "current array length", and early after startup that
	 * array is still short, so the same fraction would yield a growing scale
	 * window and erratic recovery times (measured 10s↔18s).
	 * The point count is computed by `buildBlocks` from the **target window**
	 * (independent of how much has been collected).
	 *
	 * A **cubic decay weight** is applied within the slice (1 at the newest
	 * point → 0 at the slice tail). This isn't just cosmetic — a hard cutoff
	 * makes the whole scale **jump abruptly** on the frame the spike exits the
	 * slice (measured 143→1.4, 100×), and the chart visibly snaps; cubic decay
	 * compresses the single-frame jump to 2.7× and settles smoothly within 10s.
	 *
	 * Cost: peaks older than the slice get clipped at the top (drawn as a flat
	 * ceiling). The render layer already clamps (`Math.min(top, raw)` in
	 * `braille.ts`), so nothing goes out of bounds. This is the universal
	 * off-scale semantics of terminal charts: better an old spike hugging the
	 * top than later data being invisible.
	 *
	 * Note it's still a **pure function** (depends only on this frame's data),
	 * introducing no hidden cross-frame state — so the render harness and
	 * full-width scan assertions stay reproducible.
	 */
	scaleWindowPoints?: number;
	/** Tick spec generator. dataMax = max within the scale sampling slice, plotRows = plot row count (for tick thinning) */
	axis: (dataMax: number, plotRows: number) => AxisSpec;
	/**
	 * Optional single label overlaid at the **top-right** of the plot area —
	 * the scale readout for a secondary, pre-mapped y axis (e.g. `100°` for the
	 * CPU temperature curve, mirroring the TPS block's cache-hit-rate dual axis).
	 *
	 * The secondary series is expected to be `excludeFromScale` and pre-mapped
	 * by the caller so that its values live on the primary axis' 0..max window
	 * (for CPU: 1°C ≡ 1% of the plot height, so raw °C needs no mapping at all).
	 * This label is the only on-screen trace of that second scale — skipped
	 * entirely (like the left ticks) when the plot area is too narrow for it.
	 */
	rightAxisLabel?: string;
	/**
	 * The **target point count** represented by the entire x axis (window seconds
	 * × 1000 / sampling interval).
	 *
	 * Used to position the curve **proportionally in time**: one point occupies
	 * `plotWidth*2 / windowPoints` sub-pixel columns. The key is that this ratio
	 * **doesn't change with how many points have been collected** — so one
	 * second has a constant on-screen width and the `60s` label in the
	 * bottom-left corner is honest (3 seconds after startup the data only fills
	 * the rightmost 1/20 of the width instead of being stretched to impersonate
	 * a full window).
	 *
	 * Default (undefined) = the old stretch-to-fill behavior.
	 */
	windowPoints?: number;
}

/* ------------------------------------------------------------------ */
/* Responsive layout                                                   */
/* ------------------------------------------------------------------ */

/**
 * Minimum usable width of a single block.
 *
 * Now that ticks are drawn **inside the plot area** they no longer occupy
 * dedicated columns, so the width floor only needs to cover "2 border columns
 * + a sliver of plot area"; the numeric ticks themselves must still be able to
 * overlay the chart (otherwise they're skipped).
 */
export const MIN_BLOCK_W = 24;

/** Minimum plot columns (character columns) of a single block. Below this, y ticks are not drawn */
const MIN_PLOT_W = 10;

/**
 * Fixed overhead rows per block: top border + bottom border = 2 rows (plot rows
 * counted separately).
 *
 * Reduced from 4 to 2: the x-axis line and time labels used to take one row
 * each; now the time labels are **embedded in the bottom border** (symmetric
 * to the title in the top border), and the x-axis line is served by the last
 * plot row (which is the 0 baseline itself).
 */
export const BLOCK_CHROME_ROWS = 2;

/**
 * Result of the internal width allocation of a single block.
 *
 * Extracted into a standalone pure function because **both consumers must use
 * the same ledger** — `renderBlock` uses it to decide how wide to draw, and
 * `index.ts` uses it to derive how many data points to slice. These two sides
 * used to each keep an approximate formula, and once a narrow block triggered
 * degradation, the two ledgers diverged by several columns.
 */
export interface BlockMetrics {
	/**
	 * Columns occupied by the y tick text overlaid on the left of the plot area
	 * (only used to decide "does the overlay fit", **not deducted from the plot
	 * area**).
	 */
	gutter: number;
	/**
	 * Whether to overlay y ticks on the left of the plot area.
	 *
	 * Previously named `showAxis` (whether to draw the y-axis vertical line);
	 * now ticks are **overlaid on the chart** and there is no standalone vertical
	 * line, so the flag just means "print ticks or not".
	 */
	showAxis: boolean;
	/** Columns available to curves = block width - left/right borders */
	plotW: number;
}

/**
 * Given the block width and tick spec, compute the internal width allocation.
 *
 * **Ticks no longer deduct columns from the plot area**: previously it was
 * `│` + gutter (tick columns) + `│` + curve, with ticks owning 5 columns
 * (4 digit columns + 1 vertical line); now the tick text is **overlaid on the
 * left few columns of the curve**, giving the plot area the full inner width.
 * This is the main source of the "chart utilization" improvement.
 *
 * Whether the overlay fits is guarded by `MIN_PLOT_W`: when the plot area is
 * too narrow, skip the ticks (better no ticks than squashing the curve into a
 * thread for their sake).
 */
export function blockMetrics(
	blockWidth: number,
	rawGutter: number,
): BlockMetrics {
	const w = Math.max(6, Math.floor(blockWidth));
	const plotW = Math.max(1, w - 2);
	const gutter = Math.max(0, Math.floor(rawGutter));
	// Overlaying ticks needs enough width: the ticks themselves plus some room for the curve to stay visible
	const showAxis = plotW >= Math.max(MIN_PLOT_W, gutter + 4);
	return { gutter, showAxis, plotW };
}

/**
 * Given the block width, compute a **conservative estimate** of the plot
 * columns, for "how many data points to slice".
 *
 * Estimated with the widest ticks (rateAxis's 5 columns) — deliberately
 * conservative: underestimating just slices a few points fewer and the curve
 * naturally right-aligns without misalignment; overestimating would report a
 * window label longer than what's actually drawn.
 */
export function plotWidthFor(blockWidth: number): number {
	return blockMetrics(blockWidth, RATE_GUTTER).plotW;
}

/**
 * Time-window label at the left end of the x axis.
 *
 * bottom's cell is a fixed-format `<window>s` (e.g. `60s`), because it only
 * offers 60s~10m windows. This project's window size is set by
 * `PI_SYSMON_POINTS` and can run to tens of minutes or even hours, so long
 * windows are converted to m/h — otherwise a 5-character label like `4000s`
 * would squeeze the border out.
 */
export function fmtWindowLabel(secs: number): string {
	const s = Math.max(0, Math.round(secs));
	if (s < 120) return `${s}s`;
	if (s < 7200) return `${Math.round(s / 60)}m`;
	return `${Math.round(s / 3600)}h`;
}

/**
 * Label width of rateAxis (`0KB` / `119.9` right-aligned to 5 columns).
 *
 * Exported so tests can reference **the same constant** instead of hardcoding
 * 5 — otherwise changing the implementation while tests still assert the old
 * value would give green tests with a jittery UI.
 */
export const RATE_GUTTER = 5;

/**
 * Lower bound for plot rows. 1 plot row squashes any curve into a straight
 * line (measured at 72 cols), so it's better to spend height on a chart where
 * trends are visible — this floor takes priority over the row budget.
 */
export const MIN_PLOT_ROWS = 2;

/**
 * Decide the column count from width and **block count**. A **pure function**
 * of width (never depends on data) — otherwise the column/row count would
 * jitter with data, re-triggering the old "row count changes shift the editor"
 * problem.
 *
 * Why block count matters: with 3 blocks the old logic laid out 3+1 at ≥96
 * cols (the 4th cell an empty row); with 4 blocks (showDisks), ≥96 cols should
 * be a true 4×1 (8 rows), 48..95 a 2×2, <48 stacked. The principle is to
 * **never pick a column count that leaves a half-empty group** (only use it
 * when the grid fills completely). Default `count = 3`, so old single-argument
 * callers behave exactly as before.
 */
export function chooseColumns(width: number, count = 3): number {
	if (count >= 4 && width >= MIN_BLOCK_W * 4) return 4;
	if (count === 3 && width >= MIN_BLOCK_W * 3) return 3;
	if (width >= MIN_BLOCK_W * 2) return 2;
	return 1;
}

export interface Layout {
	/** Column count */
	cols: number;
	/** How many bands (rows of blocks) to lay out (3 charts in 2 columns = 2 bands) */
	bands: number;
	/** Width of each block, length = cols; the remainder goes to the earlier blocks, sum exactly = width */
	widths: number[];
	/** Plot rows of each block */
	plotRows: number;
	/** Total rows of the whole panel */
	totalRows: number;
}

/**
 * Full layout computation: column count + width allocation + plot rows.
 *
 * At generous widths the row count is decided by `chartH` alone; on narrow
 * terminals (1 column, several charts stacked) it's auto-squeezed to fit the
 * `maxRows` budget so a few charts don't eat the whole screen.
 */
export function computeLayout(
	width: number,
	chartH: number,
	count: number,
	maxRows: number,
): Layout {
	// Defensive: `renderPanel` is exported, so any caller may pass 0/negative/NaN.
	// A negative width would put negatives into `widths` below, then
	// `" ".repeat(-2)` throws RangeError.
	const safeW = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
	const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	// Zero blocks: return an empty layout explicitly instead of faking one via the side effect of `Math.max(1, 0)`
	if (safeCount === 0) {
		return { cols: 0, bands: 0, widths: [], plotRows: 0, totalRows: 0 };
	}

	const cols = Math.min(chooseColumns(safeW, safeCount), safeCount);
	const bands = Math.ceil(safeCount / cols);

	// Width allocation: equal shares first, remainder to the earlier blocks.
	// The sum strictly equals width (otherwise joining overflows or leaves gaps)
	const base = Math.floor(safeW / cols);
	const rem = safeW - base * cols;
	const widths = Array.from(
		{ length: cols },
		(_, i) => base + (i < rem ? 1 : 0),
	);

	// Height budget: each band holds blocks whose chrome is a constant number of
	// rows; the rest is plot rows. The MIN_PLOT_ROWS floor takes priority over
	// the budget — the budget only *prevents* getting too tall, it isn't used to
	// squash charts into a line.
	const budget = Number.isFinite(maxRows) ? Math.floor(maxRows) : 0;
	const plotRows = Math.max(
		MIN_PLOT_ROWS,
		Math.min(chartH, Math.floor(budget / bands) - BLOCK_CHROME_ROWS),
	);

	return {
		cols,
		bands,
		widths,
		plotRows,
		totalRows: bands * (plotRows + BLOCK_CHROME_ROWS),
	};
}

/* ------------------------------------------------------------------ */
/* Cell model                                                          */
/* ------------------------------------------------------------------ */

/**
 * A row is represented as an "array of fixed-width cells".
 *
 * Why not just concatenate strings: the floating readout box has to be
 * **overlaid** onto plot rows, and plot rows contain ANSI escape sequences —
 * doing string surgery with `slice`/`padEnd` would count escape bytes into the
 * length and directly trigger pi's "Rendered line exceeds terminal width"
 * crash (see ARCHITECTURE.md pitfall 1). Lay out cells first, overlay, then
 * colorize uniformly at the end: width bookkeeping is exact by construction,
 * and only the last step emits ANSI.
 */
interface Cell {
	ch: string;
	color?: ThemeColor;
}

type Row = Cell[];

function blank(n: number, color?: ThemeColor): Row {
	return Array.from({ length: Math.max(0, n) }, () => ({ ch: " ", color }));
}

/**
 * Turn colored text segments into a cell row.
 *
 * This maintains the cell model's **core invariant**:
 *
 * > Each cell occupies exactly one display column: `row.length === visibleWidth(the row's text)`
 *
 * All alignment inside `renderBlock` (`putRight` right-aligned ticks/time
 * labels, border at `w-1`) is built on this invariant. `visibleWidth` is
 * computed via `get-east-asian-width`, which differs from "character count" in
 * three cases, so each must be handled (measured values):
 *
 * | Category | Example | visibleWidth | char count | Handling |
 * | --- | --- | --- | --- | --- |
 * | Regular (incl. box/braille) | `─` `⣿` `‑` | 1 | 1 | one cell |
 * | Wide chars | `あ` `🙂` `\u3000` | 2 | 1 | char + 1 empty placeholder cell |
 * | Combining/zero-width | `e\u0301` `\u200b` | 0 (whole string) / 0 | — | merge into previous cell |
 *
 * Not handling wide chars makes rows **wider** (visible width > declared
 * width) → pi throws and exits; not handling zero-width chars makes rows
 * **narrower** (subsequent content shifts left relative to the border) →
 * border misalignment. This project's own text is all ASCII, but
 * `block.name` / `titleInfo` / `legend` come from callers and can't be assumed.
 */
function segsToRow(segs: StyledLine): Row {
	const row: Row = [];
	for (const s of segs) {
		for (const ch of s.text) {
			const vw = visibleWidth(ch);
			if (vw === 0) {
				// Combining chars (e.g. e + accent) and zero-width chars take no column.
				// Merge them into the previous cell: keeps the char itself without
				// inflating the column count.
				// A leading zero-width char has nothing to merge into; drop it (it's invisible anyway).
				const prev = row.at(-1);
				if (prev) prev.ch += ch;
				continue;
			}
			const cell: Cell = { ch, color: s.color };
			row.push(cell);
			// A wide char occupies vw display columns; append vw-1 empty placeholder
			// cells to align the column count.
			// A loop rather than hardcoded `=== 2`, so if pi-tui later reclassifies
			// some ambiguous char as even wider, we don't suddenly overflow.
			for (let k = 1; k < vw; k++) row.push({ ...cell, ch: "" });
		}
	}
	return row;
}

/** Colorize a cell row into the final string; **pure-space runs get no ANSI**, avoiding floods of escape sequences */
function paint(theme: ThemeLike, row: Row): string {
	let out = "";
	let i = 0;
	while (i < row.length) {
		const first = row[i];
		if (!first) break;
		let j = i + 1;
		while (j < row.length && row[j]?.color === first.color) j++;
		let text = "";
		for (let k = i; k < j; k++) text += row[k]?.ch ?? "";
		// Pure spaces (including wide-char placeholder cells) get no color,
		// otherwise every row would drag a long tail of escape sequences
		const meaningful = text.trim() !== "";
		out += first.color && meaningful ? theme.fg(first.color, text) : text;
		i = j;
	}
	return out;
}

/** Overwrite cells into row at offset (out-of-bounds parts are ignored) */
function overlay(row: Row, offset: number, cells: Row) {
	for (let i = 0; i < cells.length; i++) {
		const at = offset + i;
		const c = cells[i];
		if (at >= 0 && at < row.length && c) row[at] = c;
	}
}

/**
 * Truncate a cell row to a display width **without splitting a wide char from
 * its placeholder cells**.
 *
 * Why `row.slice(0, n)` doesn't work: `segsToRow` splits a wide char into
 * "char cell + empty placeholder cells", and the placeholder cells are **one
 * unit** with the char cell (missing one means occupying an extra column).
 * A hard cut like `slice(0, 9)` would leave the last wide char's placeholder
 * outside, returning 9 cells that actually render 10 columns — the invariant
 * breaks and the following `┐` gets pushed past the edge (that's how `w=14`
 * with a long CJK block name lost its right border).
 *
 * So accumulate in whole "characters" here; if a full char doesn't fit, drop it entirely.
 */
function truncateRow(row: Row, maxCells: number): Row {
	if (row.length <= maxCells) return row;
	const out: Row = [];
	let room = Math.max(0, maxCells);
	let i = 0;
	while (i < row.length) {
		const c = row[i];
		if (!c) break;
		// A complete "character" = 1 non-empty cell + the following empty placeholder cells
		const span: Row = [c];
		let j = i + 1;
		while (j < row.length && row[j]?.ch === "") {
			const ph = row[j];
			if (ph) span.push(ph);
			j++;
		}
		if (span.length > room) break;
		out.push(...span);
		room -= span.length;
		i = j;
	}
	return out;
}

/**
 * Render a colored text line into a single-row string of **exactly width columns**
 * (overflow truncated with `…`, shortfall padded with spaces).
 *
 * Why it exists: `line` mode (`/sysmon line`) must share the same width and
 * color discipline as the charts, and "assemble a string yourself + padEnd"
 * is exactly the pit this repo has fallen into — multi-byte characters get
 * their column width miscounted, and once any row exceeds the terminal width
 * pi throws and exits. This reuses the chart's internal cell model
 * (`segsToRow` / `truncateRow` / `paint`), so:
 *  · wide characters (CJK/emoji) are measured by display columns and keep
 *    their placeholder cell;
 *  · truncation never cuts a wide character off its placeholder cell;
 *  · space-only segments aren't painted (avoiding a pile of escape sequences
 *    every frame).
 *
 * The returned string **already contains ANSI** and can be handed directly to
 * a `setWidget` component for rendering.
 */
export function renderStyledLine(
	theme: ThemeLike,
	segs: StyledLine,
	width: number,
): string {
	const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
	const row = truncateRow(segsToRow(segs), w);
	// Pad with spaces: constant row count + constant row width, so the editor
	// doesn't shift up and down (ARCHITECTURE pitfall 2)
	while (row.length < w) row.push({ ch: " " });
	return paint(theme, row);
}

/** Display width of a styled line (uses pi-tui's `visibleWidth`, so wide chars/ANSI are measured the same way as at render time) */
export function segsWidth(segs: StyledLine): number {
	let n = 0;
	for (const s of segs) n += visibleWidth(s.text);
	return n;
}

/* ------------------------------------------------------------------ */
/* Tick specs                                                          */
/* ------------------------------------------------------------------ */

/**
 * Percent chart: only labels `100%` at the **top**.
 *
 * Used to match bottom's `percent.rs` with two labels (`0%` at the bottom,
 * `100%` at the top). Now that ticks are **overlaid on the plot area**, a
 * bottom `0%` would hug the 0 baseline and fight the curve; and the 0%
 * information is already conveyed clearly by the bottom baseline itself.
 * So keep only the top value — it says how much the top edge represents,
 * which the baseline can't tell you.
 * The scale stays fixed at `0..100.5` (doesn't change with data, so different
 * moments are directly comparable).
 */
export function percentAxis(): AxisSpec {
	return { labels: ["100%"], max: 100.5 };
}

const KIBI = 1024;
const MEBI = 1024 ** 2;
const GIBI = 1024 ** 3;
const TEBI = 1024 ** 4;

/**
 * Ticks for rate charts — replicates bottom's `network_graph.rs: adjust_network_data_point`
 * (Linear branch) line by line: scale = max × 1.5, unit picked from K/M/G/T by
 * scale, fixed 4 labels `0<unit>` / `0.5×` / `1×` / `1.5×`, each right-aligned
 * to 5 columns.
 */
export function rateAxis(dataMax: number): AxisSpec {
	// Non-finite values (NaN/Infinity) must fall back to 0 first: otherwise
	// `NaN <= 0` is false and we'd compute `max: NaN` and "NaN" labels all the
	// way down, then NaN coordinates → out of bounds.
	// Any NaN in the coordinate system is a disaster (see ARCHITECTURE.md pitfall 4).
	const dm = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
	// Empty data (dm=0): can't let all four labels collapse into `0.0`.
	// Ticks are now **overlaid on the plot area**, and four `0.0`s stacked on
	// the chart are messier than putting the ticks in their own column.
	// Provide a minimal usable scale (1 unit) so labels read `0.0/0.5/1.0/1.5` —
	// the chart is still a flat line but the ticks at least make sense.
	const effective = dm === 0 ? 1 : dm;
	const upper = dm === 0 ? 1.5 : dm * 1.5;
	let scaled = effective;
	let prefix = "";
	if (upper < KIBI) {
		scaled = effective;
	} else if (upper < MEBI) {
		scaled = effective / KIBI;
		prefix = "K";
	} else if (upper < GIBI) {
		scaled = effective / MEBI;
		prefix = "M";
	} else if (upper < TEBI) {
		scaled = effective / GIBI;
		prefix = "G";
	} else {
		scaled = effective / TEBI;
		prefix = "T";
	}
	// Fixed-width normalization: all labels are exactly `RATE_GUTTER` columns.
	//
	// Skipping this hits two pitfalls (both measured):
	//  1. **Raggedness within one frame**: when `scaled*1.5` crosses 1000 it has
	//     one more digit than the other labels (dataMax=670 → `1005.0` is 6
	//     columns while the rest are 5), so the tick column's right edge doesn't
	//     line up and looks like a rendering glitch.
	//  2. **Cross-frame jitter**: `renderBlock` computes the overlay width from
	//     the "longest label", so when the network peak wobbles around 670, the
	//     overlay region **jumps left/right by one column every frame** — that
	//     flicker is far uglier than the ticks themselves.
	//
	// The normalization strategy is **reduce precision, don't truncate**: try one
	// decimal first; if it doesn't fit, fall back to an integer.
	// Truncation yields mangled strings like `1005.`; reducing precision only
	// drops one decimal, and ticks are coarse scale indicators anyway, so
	// readability is unaffected.
	// There's only one top label, so **append the unit to the number**
	// (e.g. `1.2K` / `150B`). That's mandatory: otherwise the screen shows a
	// bare `150.0` and you can't tell B/s from MB/s.
	// Width still follows `RATE_GUTTER`, keeping the overlay width stable across frames.
	const fitWithUnit = (v: number): string => {
		const unit = `${prefix}B`;
		const one = v.toFixed(1);
		// Try one decimal first; fall back to integer if it doesn't fit; the unit is always kept
		if (one.length + unit.length <= RATE_GUTTER)
			return `${one}${unit}`.padStart(RATE_GUTTER);
		const zero = v.toFixed(0);
		if (zero.length + unit.length <= RATE_GUTTER)
			return `${zero}${unit}`.padStart(RATE_GUTTER);
		// Extreme scale: keep only the unit, truncate the number's high digits
		return `${zero.slice(0, Math.max(1, RATE_GUTTER - unit.length))}${unit}`;
	};
	// Only label **one value at the top** (the scale upper bound); no more 0 /
	// midpoint / 1.5×.
	//
	// Why no `0B`: the 0 position is the baseline at the bottom of the plot area,
	// already self-evident; and ticks are now overlaid on the curve, so a bottom
	// `0B` would crowd the curve/baseline. The top value is the information the
	// chart can't otherwise convey ("how much the top edge represents").
	return {
		labels: [fitWithUnit(scaled * 1.5)],
		max: upper,
	};
}

/** Label indexes kept after thinning (by original index). The first and last
 *  labels are always kept: they carry the semantics of the scale.
 *
 * floor is used here, consistent with ratatui's `i*(h-1)/(n-1)`.
 */
function keptIndexes(n: number, plotRows: number): Set<number> {
	const keep = new Set<number>();
	if (n <= 2 || plotRows <= 1) {
		for (let i = 0; i < n; i++) keep.add(i);
		return keep;
	}
	const rowsAvailable = plotRows - 1;
	if (rowsAvailable >= n - 1) {
		for (let i = 0; i < n; i++) keep.add(i);
		return keep;
	}
	let lastDy = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < n; i++) {
		const dy = Math.floor((i * rowsAvailable) / (n - 1));
		if (i === n - 1 || dy > lastDy) {
			keep.add(i);
			lastDy = dy;
		}
	}
	return keep;
}

/* ------------------------------------------------------------------ */
/* Single-block rendering                                              */
/* ------------------------------------------------------------------ */

/**
 * Draw one bottom-style framed metric block, returning **exactly
 * `plotRows + 4` rows**.
 *
 * Width identities (every row has exactly `width` cells):
 * ```text
 * title row = "┌ " + name + " ─ " + info + " " + fill + "┐"      = width
 * plot row  = "│" + ticks(gutter) + "│" + curve(plotW) + "│"     = width
 * axis row  = "│" + spaces(gutter) + "└" + "─"(plotW) + "│"      = width
 * time row  = "│" + left label(gutter+1) + right label(plotW) + "│" = width
 * bottom    = "└" + "─"(width-2) + "┘"                            = width
 * ```
 */
export function renderBlock(
	theme: ThemeLike,
	block: MetricBlock,
	width: number,
	plotRows: number,
	windowSecs: number,
): string[] {
	const w = Math.max(6, Math.floor(width));
	const rows = Math.max(1, plotRows);

	let dataMax = 0;
	// Scale sampling range: the whole visible window by default; when
	// scaleWindowPoints is set, only look at that last slice, with a quadratic
	// decay weight applied inside the slice (see the comment on scaleRolloff).
	// Take at least 1 point (otherwise the scale becomes 0 and the chart slams the top).
	const scalePts =
		Number.isFinite(block.scaleWindowPoints) &&
		(block.scaleWindowPoints as number) > 0
			? Math.floor(block.scaleWindowPoints as number)
			: Number.POSITIVE_INFINITY;
	const rolloff = scalePts !== Number.POSITIVE_INFINITY;
	for (const s of block.series) {
		// Pre-mapped series (e.g. a percentage drawn on the primary axis) must not
		// feed the scale: their values are in the axis' unit only by courtesy of
		// the caller's mapping, so sampling them would let them stretch the axis.
		if (s.excludeFromScale) continue;
		const n = s.values.length;
		const span = Math.max(1, scalePts);
		const from = Math.max(0, n - span);
		// Only apply quadratic decay when the scale window **really is a sub-interval
		// of the display window**.
		// With `span >= n` (whole-window max, or history shorter than one window
		// early after startup) use the plain max:
		//   ① the `PI_SYSMON_SCALE_WINDOW=1` escape hatch must be **exactly** the old behavior;
		//   ② the whole window has no "inner boundary" — points roll out naturally
		//     from the left edge, nothing to smooth.
		const smooth = rolloff && span < n;
		for (let i = from; i < n; i++) {
			const v = s.values[i];
			if (v === undefined || !Number.isFinite(v) || v <= 0) continue;
			// ageIdx = 0 is the newest point. The weight decays by **cubic power** to 0 at the slice tail:
			// the newest point's weight is always 1 → the scale is always >= the current value, never under-scaled;
			// the slice tail's weight is 0 → by the time a spike **leaves the slice, the
			// scale has already come down**, so no jump occurs.
			//
			// The power was measured (10s window, 100x spike, 3-point-wide burst):
			//   hard cutoff → 100x single-frame jump (the whole chart snaps)
			//   linear      → 10x jump (1/span residue at the tail)
			//   quadratic   → 4x jump
			//   cubic       → 2.7x jump, settles within 7 frames  ← pick this
			//   quartic     → 2.6x jump (marginal gain), but the falloff feels "harder"
			// Cubic is the best trade between "smooth" and "falls back promptly"; the
			// residual 2.7x jump only happens a few frames after the scale is already
			// near the baseline, when the baseline is visually near the top, so it's imperceptible.
			let eff = v;
			if (smooth) {
				const ageFrac = (n - 1 - i) / Math.max(1, span - 1);
				const k = Math.max(0, 1 - ageFrac);
				eff = v * k * k * k;
			}
			if (eff > dataMax) dataMax = eff;
		}
	}

	const spec = block.axis(dataMax, rows);
	const rawGutter = spec.labels.reduce(
		(m, l) => Math.max(m, visibleWidth(l)),
		1,
	);
	const axisMax = Number.isFinite(spec.max) && spec.max > 0 ? spec.max : 1;

	// Overflow detection: when a visible data point exceeds the scale, it gets
	// clipped to the top (clamped to `top` in braille).
	//
	// Why detection is a must: the scale is computed from the "most recent 1/6
	// window" (the user-requested auto-fallback), so ~10s after a 10MB/s spike,
	// the scale has fallen back to the few-hundred-KB baseline, but **the spike
	// is still inside the 60s display window** — it gets clipped to the top.
	// If the top tick isn't marked then, a reader would think "the max is a few
	// hundred KB" while a spike clearly reaches the top of the screen: the scale would be lying.
	let overflow = false;
	for (const s of block.series) {
		// Same reason as the scale sampling: an excluded series knows it is drawn
		// in axis units, so it must never trip the `+` overflow marker.
		if (s.excludeFromScale) continue;
		for (const v of s.values) {
			if (Number.isFinite(v) && v > axisMax) {
				overflow = true;
				break;
			}
		}
		if (overflow) break;
	}

	// Width allocation: ticks no longer occupy columns, but `gutter` still decides whether the overlay fits
	const { showAxis, plotW } = blockMetrics(w, rawGutter);

	const color = block.color;

	// Borders use the neutral `borderMuted` (darkGray) instead of `border` (blue):
	// with three charts side by side, three big saturated **boxes** would be more
	// eye-catching than the curves themselves, and bottom's borders are neutral
	// anyway. Metric colors only go on "title name + curve + readouts" — keeps
	// the "tell charts apart at a glance" ability without color spam.
	const edge: ThemeColor = "borderMuted";
	const axis: ThemeColor = "muted";

	// ── Top border + title (bottom's title_top effect) ──
	// Border body in neutral color, name in the metric color — this is the key to
	// "tell at a glance which chart is which".
	const nameSegs: StyledLine = [{ text: block.name, color }];
	let head: Row;
	{
		// Must use **display width**, not `.length`: `.length` counts code points,
		// while CJK/emoji take 2 columns. Using `.length` would underestimate the
		// title width → fill computed too large → the right border `┐` gets cut
		// off (that's how a test with a CJK block name like "… CPU" exposed the bug).
		const nameW = visibleWidth(block.name);
		// Row layout: `┌␣name␣─␣info␣` + fill×`─` + `┐`
		// Fixed columns used = 1(┌) + 1(␣) + nameW + 1(␣) + 1(─) + 1(␣) + infoW + 1(␣)
		// plus 1 column for `┐`; the rest is fill.
		const FIXED_NO_INFO = 4; // ┌␣ + space after name + ┐
		const FIXED_WITH_INFO = 7; // ┌␣ + ␣─␣ + space after info + ┐
		const roomForInfo = Math.max(0, w - nameW - FIXED_WITH_INFO - 1);

		// Accumulate segment by segment, stop when it doesn't fit — so narrow
		// blocks at least keep the most important reading
		const infoCells: Row = [];
		for (const seg of block.titleInfo ?? []) {
			const cells = segsToRow([seg]);
			if (infoCells.length + cells.length > roomForInfo) break;
			infoCells.push(...cells);
		}
		const useInfo = infoCells.length > 0;

		head = [
			{ ch: "┌", color: edge },
			{ ch: " ", color: edge },
			...segsToRow(nameSegs),
		];
		if (useInfo) {
			head.push(
				{ ch: " ", color: edge },
				{ ch: "─", color: edge },
				{ ch: " ", color: edge },
				...infoCells,
				{ ch: " ", color: edge },
			);
		} else {
			head.push({ ch: " ", color: edge });
		}
		// Fill with `─` up to the right border (bottom's `title_top` look), instead of leaving blank
		const fill = Math.max(
			1,
			w - nameW - (useInfo ? infoCells.length + FIXED_WITH_INFO : FIXED_NO_INFO),
		);
		head.push(...Array.from({ length: fill }, () => ({ ch: "─", color: edge })), {
			ch: "┐",
			color: edge,
		});
		// When the title is longer than the block (long name + narrow block):
		// make sure the right `┐` always survives — a closed border matters more
		// than a complete title.
		// Do that by truncating the name itself to "block width - decoration
		// columns used", not by cutting the row's tail (cutting the tail would
		// remove the name entirely, leaving no way to tell which chart this is).
		if (head.length > w) {
			const prefix = 2; // "┌ "
			const suffix = 3; // at least 1 fill plus "┐", with a bit of buffer
			const nameRoom = Math.max(0, w - prefix - suffix);
			// Use truncateRow (not slice) to guarantee no wide char gets cut in half
			const namePart = truncateRow(
				segsToRow([{ text: block.name, color }]),
				nameRoom,
			);
			// Compute how many `─` to fill up front so `┐` **lands on the last column**.
			// Can't join everything first and pad with `while (head.length < w) push(" ")` —
			// that would strand `┐` mid-row with a tail of trailing blanks (at w=6 you'd get `┌ C─┐ `).
			const fillN = Math.max(1, w - prefix - namePart.length - 1);
			head = [
				{ ch: "┌", color: edge },
				{ ch: " ", color: edge },
				...namePart,
				...Array.from({ length: fillN }, () => ({ ch: "─", color: edge })),
				{ ch: "┐", color: edge },
			];
		}
		while (head.length < w) head.push({ ch: " ", color });
	}

	const lines: Row[] = [head];

	// ── Plot rows ──
	const glyphs = renderChartGlyphs(
		block.series.map((s) => ({ label: block.name, values: s.values })),
		plotW,
		rows,
		axisMax,
		// Position proportionally in time (when windowPoints is set): one second
		// of screen width is constant, so the `60s` label in the bottom-left is
		// honest; otherwise fall back to stretch-to-fill.
		block.windowPoints && block.windowPoints > 0
			? { slots: block.windowPoints }
			: { stretch: true },
	);

	// y tick positions: aligned with ratatui — dy = i*(plotH-1)/(n-1), drawn at plotBottom - dy.
	// Must be **floor** (integer division), not Math.round: ratatui's `render_y_labels` has
	// `i as u16 * (graph_area.height - 1) / (labels_len - 1)`, and u16 division truncates.
	// Verified empirically (bottom frame capture of the Network block, plotH=8, 4 ticks):
	//   floor → dy={0,2,4,7} matches the capture exactly; round → dy={0,2,5,7} puts the third tick 1 row off.
	// I originally wrote round; this frame capture is what caught it.
	const kept = keptIndexes(spec.labels.length, rows);
	const tickAt = new Map<number, string>();
	if (showAxis) {
		const n = spec.labels.length;
		for (let i = 0; i < n; i++) {
			if (!kept.has(i)) continue;
			// A single label goes **at the top** instead of the bottom.
			// The general formula `rows-1 - floor(i*(rows-1)/(n-1))` degenerates to
			// `rows-1` (bottom) when n=1, while the sole label is the "scale upper
			// bound" and semantically belongs at the top.
			const dy = n <= 1 ? 0 : Math.floor((i * (rows - 1)) / (n - 1));
			const y = n <= 1 ? 0 : rows - 1 - dy;
			if (y >= 0 && y < rows) {
				const lab = spec.labels[i] ?? "";
				// On overflow, append `+` to the **top tick** (e.g. `293KB` → `293K+`, read as "at least this much").
				// The **character length must stay the same**: `rawGutter` was computed
				// from the original labels, and if the overlay width changes, the plot
				// area's left edge jumps by one column (see ARCHITECTURE pitfall 6).
				tickAt.set(
					y,
					overflow && y === 0 && lab.length >= 2 ? `${lab.slice(0, -1)}+` : lab,
				);
			}
		}
	}

	// Start index of plot rows in `lines`: 1, not 0 — `lines[0]` is the head
	// (title/border) row pushed first; the plot rows start right after it.
	// (Was 0 for a long time, which made the floating legend box's top border
	// overlay the **title row** — masked by tests because the title row happens
	// to contain its own ┌/┐ corners. Found while wiring the right-axis label,
	// which needs the true top plot row to sit on.)
	const plotTop = 1;
	for (let r = 0; r < rows; r++) {
		const row = blank(w);
		row[0] = { ch: "│", color: edge };
		row[w - 1] = { ch: "│", color: edge };
		// Curve: per-cell coloring (the grid is per-cell independent, so color by
		// cell, not by row).
		// The plot area now spans the full inner width (left edge at col 1); ticks
		// are overlaid on top of it later.
		const gl = glyphs[r];
		for (let c = 0; c < plotW; c++) {
			const g = gl?.[c];
			if (!g || g.char === " ") continue;
			const series = g.series >= 0 ? block.series[g.series] : undefined;
			row[1 + c] = { ch: g.char, color: series?.color ?? color };
		}
		// The 0 baseline **no longer gets its own `─` run**.
		//
		// Previously (when ticks/axis line each owned a row) the horizontal line
		// here drew the x axis; but after switching to "the bottom border doubles
		// as the x axis", the bottom border is already a `─`, so another `─` run
		// in the last plot row makes **two parallel horizontal lines**, looking
		// like a stray extra line (user feedback: "there's an extra line at the bottom").
		//
		// Now the 0 position is expressed by the **bottom border** (it's the lower
		// edge of the plot area), no extra line needed. Zero-value curve points
		// land in the last plot row, hugging the bottom border — semantics stay clear.
		// y ticks are **overlaid** on the left of the plot area (no dedicated columns).
		// Overlaid on top of the curve: ticks are reference info, and occasionally
		// covering a small curve segment is acceptable; the reverse (curve covering
		// ticks) would make tick readings untrustworthy.
		if (showAxis) {
			const label = tickAt.get(r);
			if (label) {
				const cells = segsToRow([{ text: label, color: axis }]);
				overlay(row, 1, cells);
			}
		}
		lines.push(row);
	}

	let legendLx = -1; // left column of the floating box, when drawn
	// ── Floating readout box: overlaid on the top-right corner of the plot area (bottom's legend TopRight) ──
	if (block.legend && block.legend.length > 0) {
		const legendInner = block.legend.reduce(
			(m, l) =>
				Math.max(
					m,
					l.reduce((n, s) => n + visibleWidth(s.text), 0),
				),
			0,
		);
		const legendW = legendInner + 2;
		const legendH = block.legend.length + 2;
		// Show/hide rule: draw whenever "it fits + doesn't collide with the x-axis line / 0% baseline".
		//
		// There used to be a stricter width rule here, "leave at least 40% of the
		// curve visible"; combined with the height rule below it **permanently
		// blocked** Network's box (it has the longest readout text and two lines).
		// But "covering the top-right curve" is the floating box's design intent
		// (bottom's legend is an overlay too, with no reserved space), so there's
		// no reason to demand blank space — fitting is enough for width.
		//
		// What truly can't be violated is the **vertical** direction: the 0%
		// baseline is in the last plot row, and if the box spans all plot rows,
		// its bottom border merges with the baseline into a double line that
		// looks like a rendering bug. So require **at least one row left below
		// the box** — i.e. `legendH - 1 < rows - 1`, equivalent to `legendH < rows`.
		//
		// Note the rule itself was never wrong; what killed Network was its
		// two-line box (legendH=4) against a default plot area of exactly 4 rows —
		// the fix was compressing its readout to one line (the rate is already in
		// the title bar; the box only carries cumulative traffic), not loosening this rule.
		if (legendW <= plotW && legendH < rows) {
			const plotLeft = 1;
			const plotRight = plotLeft + plotW;
			const lx = plotRight - legendW;
			legendLx = lx;
			const boxTop: Row = [
				{ ch: "┌", color: edge },
				...Array.from({ length: Math.max(0, legendW - 2) }, () => ({
					ch: "─",
					color: edge,
				})),
				{ ch: "┐", color: edge },
			];
			const boxBottom: Row = [
				{ ch: "└", color: edge },
				...Array.from({ length: Math.max(0, legendW - 2) }, () => ({
					ch: "─",
					color: edge,
				})),
				{ ch: "┘", color: edge },
			];
			overlay(lines[plotTop] ?? [], lx, boxTop);
			for (let i = 0; i < block.legend.length; i++) {
				const segs = block.legend[i] ?? [];
				const textRow = segsToRow(segs);
				const body = blank(legendW - 2);
				overlay(body, 0, textRow);
				const row: Row = [
					{ ch: "│", color: edge },
					...body,
					{ ch: "│", color: edge },
				];
				overlay(lines[plotTop + 1 + i] ?? [], lx, row);
			}
			overlay(lines[plotTop + legendH - 1] ?? [], lx, boxBottom);
		}
	}

	// ── Secondary (right) axis label: drawn AFTER the floating box so it can dodge it ──
	// One label at the top row of the plot area, the mirror image of the left-tick
	// overlay. Same discipline as the left side — it's reference info overlaid on
	// the curve, and it's skipped when it wouldn't clear the left tick region plus
	// a couple of curve columns (a cramped `100%100°` mashup is worse than no
	// secondary scale).
	//
	// **Drawn after the legend box on purpose**: the box is painted over the
	// top-right corner of the plot area (the exact spot the label wants), so
	// when a box is present the label hugs the box's LEFT edge on the same row
	// instead of being buried under it (measured: with `labelMode=box` the
	// `100°` label was completely covered by the `AVG 37%` box and the
	// temperature curve lost its scale readout). Same row, left of the box —
	// reads naturally (`│100%  ⣀ 100°┌─────┐│`), and when no box is drawn the
	// label sits flush against the right border as before.
	if (block.rightAxisLabel) {
		const labW = visibleWidth(block.rightAxisLabel);
		// The right edge the label must clear: the right border normally, the
		// floating box's left edge when one is drawn (plus a 1-column gap).
		const rightEdge = legendLx >= 0 ? legendLx - 1 : w - 1;
		// Left tick region ends at column 1+rawGutter; require 2 columns of gap.
		// (rawGutter is the *left* spec's width even when showAxis is false —
		// conservative is fine here: no left ticks drawn means even more room.)
		if (labW > 0 && rightEdge - labW >= 1 + rawGutter + 2) {
			overlay(
				lines[plotTop] ?? [],
				rightEdge - labW,
				segsToRow([{ text: block.rightAxisLabel, color: axis }]),
			);
		}
	}

	// ── Bottom border (time labels embedded inside, symmetric to the title in the top border) ──
	// Oldest on the left, now on the right. To keep the border from looking
	// chopped up, leave one space between each label and the horizontal line:
	//   `└ 60s ────────────── 0s ┘`
	// Time labels used to occupy their own row (there was nowhere else to put
	// them); embedding them in the border saves a whole row, which goes back to
	// the plot area.
	{
		const row: Row = [
			{ ch: "└", color: edge },
			...Array.from({ length: Math.max(0, w - 2) }, () => ({
				ch: "─",
				color: edge,
			})),
			{ ch: "┘", color: edge },
		];
		const leftLabel = fmtWindowLabel(windowSecs);
		const rightLabel = "0s";
		// Columns needed for embedding: border 1 + left space 1 + left label + left space 1
		//   + right space 1 + right label + right space 1 + border 1 (at least 0 `─` in between)
		// i.e. L + R + 6; both labels need surrounding spaces so they don't look glued to the border.
		const need = leftLabel.length + rightLabel.length + 6;
		if (w >= need) {
			// Left end: `└ 60s `
			row[1] = { ch: " ", color: edge };
			for (let i = 0; i < leftLabel.length; i++)
				row[2 + i] = { ch: leftLabel[i] ?? " ", color: axis };
			row[2 + leftLabel.length] = { ch: " ", color: edge };
			// Right end: ` 0s ┘` (label ends at w-2, leaving one space before `┘`)
			const labStart = Math.max(0, w - 2 - rightLabel.length);
			row[labStart - 1] = { ch: " ", color: edge };
			for (let i = 0; i < rightLabel.length; i++)
				row[labStart + i] = { ch: rightLabel[i] ?? " ", color: axis };
			row[w - 2] = { ch: " ", color: edge };
		}
		lines.push(row);
	}

	return lines.map((row) => paint(theme, row));
}

/* ------------------------------------------------------------------ */
/* Panel assembly                                                      */
/* ------------------------------------------------------------------ */

/**
 * Arrange several blocks into a multi-column panel.
 *
 * Assembly discipline: each block internally guarantees a **constant row
 * count** and **exactly blockW cells per row**, so they can be joined
 * horizontally here directly (borders touching, same as bottom's `┐┌`, no
 * gaps), and finally each line is truncated with
 * `truncateToWidth(line, width, "", true)` as a safety net
 * — the net must explicitly pass `ellipsis=""`, otherwise `truncateToWidth`
 * appends `...` and wrecks the width bookkeeping.
 */
export function renderPanel(
	theme: ThemeLike,
	blocks: MetricBlock[],
	width: number,
	layout: Layout,
	windowSecs: number,
): string[] {
	// Zero blocks / zero-row layout: return empty explicitly, don't rely on side effects of later loops
	if (blocks.length === 0 || layout.bands === 0 || layout.cols === 0) return [];
	// Defensive: when a caller passes 0/negative, the `" ".repeat` and `truncateToWidth` below would blow up
	const safeW = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;

	const { cols, widths, plotRows } = layout;
	const blockLines = blocks.map((b, i) => {
		const w = widths[i % cols] ?? widths[0] ?? safeW;
		return renderBlock(theme, b, w, plotRows, windowSecs);
	});

	// Padding: when there aren't enough blocks, pad with blanks (keeps the grid shape and total row count unchanged)
	const cellH = plotRows + BLOCK_CHROME_ROWS;
	const cells: string[][][] = [];
	for (let band = 0; band < layout.bands; band++) {
		const rowCells: string[][] = [];
		for (let c = 0; c < cols; c++) {
			const b = blockLines[band * cols + c];
			const w = Math.max(0, Math.floor(widths[c] ?? safeW));
			// Blank cells get spaces, not an empty frame: an empty frame looks like a broken chart and is easier to misread than whitespace
			rowCells.push(b ?? Array.from({ length: cellH }, () => " ".repeat(w)));
		}
		cells.push(rowCells);
	}

	const out: string[] = [];
	for (const rowCells of cells) {
		const h = Math.max(...rowCells.map((c) => c.length));
		for (let r = 0; r < h; r++) {
			out.push(rowCells.map((c) => c[r] ?? "").join(""));
		}
	}
	// Safety-net truncation: explicitly pass `ellipsis=""` — `truncateToWidth`
	// appends `...` by default, which would wreck the width bookkeeping (3 extra
	// columns, and pad=true can't truncate it back).
	return out.map((line) => truncateToWidth(line, safeW, "", true));
}
