/**
 * Layout and safety tests for chart-panel / blocks.
 *
 * What matters most here is not "whether the typography looks good", but
 * **two hard constraints that would crash or misalign pi**:
 *  1. The visible width of any line must never exceed the terminal width —
 *     if it does, pi throws "Rendered line exceeds terminal width" and
 *     **exits directly** (tui-main-screen.js:485);
 *  2. For the same width, the panel's line count must stay constant — a
 *     changing line count shifts the editor up/down, breaking mouse
 *     selections anchored to screen coordinates (shows up as "can't copy text").
 *
 * That's why there are **sweep tests** over the full 8..220 width range with
 * several height and block-count combinations, instead of only testing a few
 * "looks fine" widths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	BLOCK_CHROME_ROWS,
	blockMetrics,
	computeLayout,
	chooseColumns,
	percentAxis,
	plotWidthFor,
	RATE_GUTTER,
	rateAxis,
	renderPanel,
	renderStyledLine,
	segsWidth,
	MIN_BLOCK_W,
	type MetricBlock,
	type StyledLine,
	type ThemeLike,
} from "../src/chart-panel.ts";
import {
	buildBlocks,
	fmtTokensTotal,
	parsePlacement,
	plainLineSegs,
	resolveWindow,
	rssAxisMax,
	tokenAxis,
	DEFAULT_SCALE_WINDOW_FRAC,
	MIN_TPS_SCALE,
	RSS_AXIS_HEADROOM,
	RSS_LABEL_W,
	TPS_GUTTER,
	type BlockOptions,
	type History,
} from "../src/blocks.ts";

/**
 * Test helper: explicitly opt into the legacy default ratio with
 * "auto fall-back" (scale window = 1/6 of the display window).
 *
 * `DEFAULT_SCALE_WINDOW_FRAC` is now `1` (scale window == display window,
 * 20s → 62s), so tests exercising auto fall-back must pass this value
 * explicitly to enter the sub-window branch.
 */
const DEFAULT_SCALE_WINDOW_FRAC_OPT_IN = 1 / 6;
import { fmtBytes, type Snapshot } from "../src/metrics.ts";

/**
 * Fake theme with ANSI. **Escape sequences are added on purpose** — bugs like
 * width overflow are exposed exactly when ANSI is present (doing string
 * surgery with `slice`/`padEnd` counts the escape codes into the length).
 */
const ANSI: Record<string, string> = {
	accent: "\x1b[36m",
	border: "\x1b[37m",
	borderMuted: "\x1b[90m",
	success: "\x1b[32m",
	warning: "\x1b[33m",
	error: "\x1b[31m",
	muted: "\x1b[90m",
	dim: "\x1b[2m",
	text: "\x1b[37m",
};
const ansiTheme: ThemeLike = {
	fg: (c, s) => (s.trim() === "" ? s : `${ANSI[c] ?? ""}${s}\x1b[0m`),
};
/** Plain-text theme without ANSI, to make asserting character positions easy */
const plainTheme: ThemeLike = { fg: (_c, s) => s };

const fakeSnap = (over: Partial<Snapshot> = {}): Snapshot => ({
	cpuPct: 37,
	cpuTemp: 61,
	memUsed: 33 * 1024 ** 3,
	memTotal: 64 * 1024 ** 3,
	memPct: 52,
	procRss: 700 * 1024 ** 2,
	load1: 1.23,
	load5: 4.56,
	load15: 7.89,
	rxBps: 123_456,
	txBps: 7_890,
	rxTotal: 129.8 * 1024 ** 3,
	txTotal: 178.9 * 1024 ** 3,
	readBps: 1024,
	writeBps: 2048,
	...over,
});

/** Build a wavy history (all-zero would degenerate the chart into a line and hide coordinate bugs) */
function fakeHist(n: number): History {
	const wave = (base: number, amp: number, k: number) =>
		Array.from({ length: n }, (_, i) =>
			Math.max(0, base + amp * Math.sin(i / k) + amp * 0.4 * Math.sin(i / 2.7)),
		);
	return {
		cpu: wave(20, 15, 7),
		// Realistic laptop range (45..75°C), non-flat so "is the red curve wired to
		// cpuTemp?" is distinguishable from "is it drawing a constant?" — same
		// discipline as sessHit. Values stay raw °C: `buildBlocks` maps nothing
		// (1°C ≡ 1% of plot height by construction).
		cpuTemp: wave(58, 12, 9),
		mem: wave(50, 4, 11),
		// Non-flat (and in bytes, i.e. MB × 1024²): a flat line would make "is the
		// red curve wired to procRss?" indistinguishable from "is it drawing a
		// constant?". Values stay **raw bytes** — `buildBlocks` is the layer that
		// maps them onto the percent axis.
		procRss: wave(680, 30, 13).map((v) => v * 1024 ** 2),
		netRx: wave(20_000, 15_000, 5),
		netTx: wave(5_000, 4_000, 3),
		diskR: wave(1_000, 900, 4),
		diskW: wave(2_000, 1_500, 6),
		tps: wave(50, 30, 9),
		// Non-flat and in the real 0..100 range: a flat series would make "is the
		// second curve wired to sessHit?" indistinguishable from "is it drawing a
		// constant?". The values stay **raw percentages** here (out of range would
		// silently invalidate the source data), while `buildBlocks` is the layer
		// that pre-maps them onto the TPS axis for rendering.
		sessHit: wave(85, 8, 13),
	};
}

/* ------------------------------------------------------------------ */
/* 1. Column-count breakpoints                                            */
/* ------------------------------------------------------------------ */

test("chooseColumns: with count=4, ≥96 uses 4 columns, 48..95 uses 2 columns (eliminating the 3+1 empty slot)", () => {
	// The old logic capped at 3 columns, so 4 blocks (showDisks) on a wide
	// terminal were laid out 3+1 and the 4th slot was an entire blank row.
	// New logic: use 4 columns when count>=4 and 4 blocks fit the width.
	assert.equal(chooseColumns(95, 4), 2);
	assert.equal(chooseColumns(96, 4), 4);
	assert.equal(chooseColumns(220, 4), 4);
	assert.equal(chooseColumns(72, 4), 2);
	assert.equal(chooseColumns(47, 4), 1);
});

test("chooseColumns: count=3 behavior unchanged (regression)", () => {
	// The breakpoints for 3 blocks must match the original implementation
	// point for point: ≥72 → 3 cols, 48..71 → 2 cols, <48 → 1 col
	assert.equal(chooseColumns(72, 3), 3);
	assert.equal(chooseColumns(96, 3), 3);
	assert.equal(chooseColumns(150, 3), 3);
	assert.equal(chooseColumns(48, 3), 2);
	assert.equal(chooseColumns(47, 3), 1);
	// Default is 3 when count is omitted: protects all legacy single-arg callers
	for (let w = 40; w <= 220; w += 7) {
		assert.equal(chooseColumns(w), chooseColumns(w, 3), `w=${w}`);
	}
});

test("computeLayout: count=4 at ≥96 is a single 4×1 band with no empty slot", () => {
	// 96 cols: 4 blocks fit exactly in one row (24 cols each), 6+2=8 rows total
	const l96 = computeLayout(96, 6, 4, 18);
	assert.equal(l96.cols, 4);
	assert.equal(l96.bands, 1);
	assert.equal(l96.plotRows, 6);
	assert.equal(l96.totalRows, 8);
	// 150 cols likewise, and the column widths sum strictly to the total width
	const l150 = computeLayout(150, 6, 4, 18);
	assert.equal(l150.cols, 4);
	assert.equal(l150.bands, 1);
	assert.equal(l150.totalRows, 8);
	assert.equal(
		l150.widths.reduce((a, b) => a + b, 0),
		150,
		JSON.stringify(l150.widths),
	);
	// 72 cols: previously 3 columns (3+1 empty slot), now 2×2, 2×(6+2)=16 rows total
	const l72 = computeLayout(72, 6, 4, 18);
	assert.equal(l72.cols, 2);
	assert.equal(l72.bands, 2);
	assert.equal(l72.totalRows, 16);
});

test("computeLayout: with count=4, totalRows ≤ maxRows and plotRows ≥ 2 at every width", () => {
	// Budget contract: 4 blocks never exceed the row budget at any width, and
	// plot rows never fall below MIN_PLOT_ROWS.
	// All three arrangements (4×1 / 2×2 / 1×4) must be covered, so sweep the
	// whole width range.
	for (let w = 1; w <= 220; w++) {
		const l = computeLayout(w, 6, 4, 18);
		assert.ok(l.totalRows <= 18, `w=${w}: totalRows=${l.totalRows} > 18`);
		assert.ok(l.plotRows >= 2, `w=${w}: plotRows=${l.plotRows} < 2`);
	}
});

test("chooseColumns: breakpoints strictly follow width, and it's a pure function", () => {
	assert.equal(chooseColumns(MIN_BLOCK_W * 3 - 1), 2);
	assert.equal(chooseColumns(MIN_BLOCK_W * 3), 3);
	assert.equal(chooseColumns(MIN_BLOCK_W * 2 - 1), 1);
	assert.equal(chooseColumns(MIN_BLOCK_W * 2), 2);
	assert.equal(chooseColumns(MIN_BLOCK_W - 1), 1);
	assert.equal(chooseColumns(500), 3);
	// Pure function: same input always gives the same output (column count must not flicker with data)
	for (const w of [50, 60, 90, 120]) {
		assert.equal(chooseColumns(w), chooseColumns(w));
	}
});

test("computeLayout: column widths sum strictly to the total width (neither overflowing nor leaving gaps)", () => {
	for (let w = 1; w <= 300; w++) {
		for (const count of [3, 4]) {
			const l = computeLayout(w, 4, count, 18);
			const sum = l.widths.reduce((a, b) => a + b, 0);
			assert.equal(sum, w, `width=${w} count=${count} sum=${sum}`);
			assert.equal(l.widths.length, l.cols);
			assert.equal(l.bands, Math.ceil(count / l.cols));
			// The remainder goes to the earlier blocks → widths are monotonically non-increasing
			for (let i = 1; i < l.widths.length; i++) {
				assert.ok((l.widths[i] ?? 0) <= (l.widths[i - 1] ?? 0));
			}
		}
	}
});

test("computeLayout: rows = bands × (plot rows + 4) and plot rows never below the floor", () => {
	for (let w = 1; w <= 300; w += 7) {
		for (const chartH of [1, 2, 4, 6]) {
			const l = computeLayout(w, chartH, 3, 18);
			assert.ok(l.plotRows >= 1);
			assert.equal(l.totalRows, l.bands * (l.plotRows + BLOCK_CHROME_ROWS));
		}
	}
});

/* ------------------------------------------------------------------ */
/* 2. Axis ticks (aligned with bottom)                                  */
/* ------------------------------------------------------------------ */

test("percentAxis: only the top `100%` tick, fixed range", () => {
	// Changed to a single label (user request: "no need to constrain 0%, just
	// show the maximum at the top"). The 0% position is the bottom baseline
	// itself — already self-evident, and it would fight the curve under
	// overprinted ticks.
	const a = percentAxis();
	assert.deepEqual(a.labels, ["100%"]);
	// The range stays fixed at 100.5 (doesn't change with data, so different
	// times are directly comparable); 100.5 instead of 100 is bottom's
	// practice, so the 100% cell isn't cut off.
	assert.equal(a.max, 100.5);
	// No matter what dataMax is passed, the range must not change (percent
	// charts have a fixed range)
	assert.equal(percentAxis().max, a.max);
});

test("rateAxis: a single top tick, with unit and fixed width of 5 columns", () => {
	// Single label = range upper bound (max×1.5).
	const a = rateAxis(100_000); // 100 KB/s → upper = 150 000 < 1 MiB → K unit
	assert.equal(a.max, 150_000);
	assert.equal(a.labels.length, 1, "should have exactly one top tick");
	// Must carry a unit: otherwise a bare `150.0` on screen doesn't say whether it's B or MB
	assert.ok(a.labels[0]?.includes("KB"), JSON.stringify(a.labels[0]));
	// Fixed width: the overprint width stays stable, no frame-to-frame jitter
	assert.equal(a.labels[0]?.length, RATE_GUTTER, JSON.stringify(a.labels[0]));
});

test("rateAxis: unit switches B/K/M/G with the range, always with a unit", () => {
	const one = (dm: number) => rateAxis(dm).labels[0] ?? "";
	assert.ok(one(100).includes("B"), one(100));
	assert.ok(one(10 * 1024).includes("KB"), one(10 * 1024));
	assert.ok(one(10 * 1024 ** 2).includes("MB"), one(10 * 1024 ** 2));
	assert.ok(one(10 * 1024 ** 3).includes("GB"), one(10 * 1024 ** 3));
	// Empty data: must not collapse to `0.0`; give a minimal usable range
	const a = rateAxis(0);
	assert.equal(a.max, 1.5);
	assert.ok(a.labels[0]?.includes("B"), a.labels[0]);
	// Non-zero values are unaffected (range is still max×1.5)
	assert.equal(rateAxis(1).max, 1.5);
	assert.equal(rateAxis(10).max, 15);
});
test("rateAxis: inputs with NaN / Infinity / negatives don't produce NaN ranges or NaN labels", () => {
	for (const bad of [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		-5,
	]) {
		const a = rateAxis(bad);
		assert.ok(Number.isFinite(a.max) && a.max > 0, `max=${a.max} for ${bad}`);
		for (const l of a.labels) {
			assert.ok(!l.includes("NaN"), `NaN in label: ${l} (input ${bad})`);
			assert.ok(
				!l.includes("Infinity"),
				`Infinity in label: ${l} (input ${bad})`,
			);
		}
	}
});

test("plotWidthFor: the plot area gets the entire inner width (ticks no longer occupy columns)", () => {
	// Old geometry: `│` + gutter(4) + `│` + curve → plotW = bw - 2 - 1 - 5.
	// New geometry: ticks are **overprinted** on the left of the curve, no
	// longer occupying columns → plotW = bw - 2.
	// This is where "chart utilization grew" comes from (a 50-col block went
	// from 42 to 48 cols).
	for (let w = MIN_BLOCK_W; w <= 120; w++) {
		const p = plotWidthFor(w);
		assert.ok(p >= 1);
		assert.equal(p, Math.max(6, w) - 2, `bw=${w}`);
		// Must agree with blockMetrics (both sides share one ledger)
		assert.equal(p, blockMetrics(w, RATE_GUTTER).plotW, `bw=${w}`);
	}
	// Utilization really is higher than the old geometry: old formula is bw-8,
	// new is bw-2, always 6 columns more
	for (const bw of [24, 30, 50, 60, 100]) {
		assert.equal(plotWidthFor(bw) - (bw - 8), 6, `bw=${bw} should gain 6 columns over the old geometry`);
	}
});

test("blockMetrics: skip overprinted ticks when too narrow (better no ticks than squashing the curve)", () => {
	// Overprinting needs "tick width + some room for the curve"; if there isn't
	// enough, the block draws no ticks at all
	for (let w = 6; w <= 60; w++) {
		const m = blockMetrics(w, RATE_GUTTER);
		assert.ok(m.plotW >= 1, `bw=${w}`);
		assert.equal(m.plotW, Math.max(6, w) - 2, `bw=${w}`);
		// When ticks aren't drawn it must be because the width really isn't
		// enough, not for some other reason
		if (!m.showAxis) {
			assert.ok(
				m.plotW < Math.max(10, RATE_GUTTER + 4),
				`bw=${w} has no reason to skip ticks (plotW=${m.plotW})`,
			);
		}
	}
});

/* ------------------------------------------------------------------ */
/* 3. Hard constraints: width never overflows + constant row count      */
/*    (full-width sweep)                                                */
/* ------------------------------------------------------------------ */

test("sweep: at any width, every line's visible width <= terminal width (overflow makes pi exit)", () => {
	const hist = fakeHist(200);
	const snap = fakeSnap();
	// count must be derived from **blocks.length**, not computed by hand.
	// This once said `const count = showDisks ? 4 : 3`, while Tokens defaults
	// on, so the showDisks=false branch was "4 blocks rendered into a 3-slot
	// grid" — the 4th block would never be indexed by renderPanel,
	// **silently dropped**.
	// The result: this repo's most important crash defense (overflow = pi
	// exits) had never once been verified for the Tokens block while the test
	// stayed green. Using blocks.length removes that double bookkeeping.
	const variants = [
		{},
		{ showTokens: false },
		{ showDisks: true },
		{ showTokens: false, showDisks: true },
	] as const;
	// Non-zero readings: `fmtTps(0)="0 tok/s"` takes the short branch and
	// wouldn't catch long-reading overflow.
	// The token counters and `hitNow` are non-zero too, so every sweep iteration
	// exercises the Tokens block's **second (hit-rate) curve** and all six title
	// segments — otherwise the new content would never be width-checked, and the
	// one thing this sweep exists for (overflow makes pi exit) would go
	// unverified for exactly the newly added pixels.
	const readings = {
		tpsNow: 12345,
		tokensIn: 1234567,
		tokensOut: 987654,
		tokensCacheRead: 543210,
		hitNow: 88,
	};
	for (let w = 8; w <= 220; w++) {
		for (const chartH of [1, 3, 4, 6]) {
			for (const opts of variants) {
				const blocks = buildBlocks(hist, snap, {
					points: 60,
					...readings,
					...opts,
				});
				const layout = computeLayout(w, chartH, blocks.length, 18);
				const points = Math.max(10, plotWidthFor(layout.widths[0] ?? w) * 2);
				const lines = renderPanel(
					ansiTheme,
					blocks,
					w,
					layout,
					(points * 1000) / 1000,
				);
				const tag = `${JSON.stringify(opts)} count=${blocks.length}`;
				// Row count must equal the layout's declared rows (otherwise the editor shifts)
				assert.equal(
					lines.length,
					layout.totalRows,
					`width=${w} chartH=${chartH} ${tag}`,
				);
				for (const [i, line] of lines.entries()) {
					const lw = visibleWidth(line);
					assert.ok(
						lw <= w,
						`width=${w} chartH=${chartH} ${tag} line ${i}: ${lw} > ${w}`,
					);
				}
			}
		}
	}
});

test("sweep: at any width, row count equals the layout's declared rows (row count must be constant)", () => {
	const hist = fakeHist(200);
	for (let w = 8; w <= 220; w++) {
		const layout = computeLayout(w, 4, 4, 18);
		const points = 80;
		const lines = renderPanel(
			plainTheme,
			buildBlocks(hist, fakeSnap(), { points }),
			w,
			layout,
			60,
		);
		assert.equal(lines.length, layout.totalRows, `width=${w}`);
	}
});

test("constant rows: with data / without data returns the same row count (otherwise the editor shifts)", () => {
	const hist = fakeHist(200);
	for (let w = 8; w <= 220; w += 3) {
		const layout = computeLayout(w, 4, 4, 18);
		const withData = renderPanel(
			plainTheme,
			buildBlocks(hist, fakeSnap(), { points: 60 }),
			w,
			layout,
			60,
		);
		const noData = renderPanel(
			plainTheme,
			buildBlocks(hist, undefined, { points: 60 }),
			w,
			layout,
			60,
		);
		assert.equal(withData.length, noData.length, `width=${w}`);
		assert.equal(noData.length, layout.totalRows, `width=${w}`);
		// No overflow without data either (the empty path is the branch most often missed)
		for (const line of noData) assert.ok(visibleWidth(line) <= w, `width=${w}`);
	}
});

/* ------------------------------------------------------------------ */
/* 4. Border closure and label identifiability                          */
/* ------------------------------------------------------------------ */

test("every block is a closed box: top border ┌┐, bottom border └┘, corners aligned", () => {
	const layout = computeLayout(150, 4, 4, 18);
	const lines = renderPanel(
		plainTheme,
		buildBlocks(fakeHist(120), fakeSnap(), { points: 80 }),
		150,
		layout,
		60,
	);
	// The assertions must follow the **declared column count**, not hardcode 3:
	// at 150 cols the four-chart default is a 4×1 layout (cols=4); hardcoding 3
	// would accidentally turn this test into a false-green one that "passes even
	// if the last block is swept away" when there are 4 charts.
	// The width also can't be `w * cols`: `evenSplit` gives the remainder to the
	// earlier blocks, so columns aren't necessarily equal (4 cols split of 150 →
	// 38/38/37/37), hence the sum.
	const totalW = layout.widths.reduce((a, b) => a + b, 0);
	assert.equal(totalW, 150, "column widths must sum to the total width");
	assert.equal((lines[0] ?? "").length, totalW);
	assert.ok((lines[0] ?? "").startsWith("┌"));
	assert.ok((lines[0] ?? "").includes("┐┌"));
	assert.ok((lines[0] ?? "").endsWith("┐"));
	const last = lines[lines.length - 1] ?? "";
	assert.ok(last.startsWith("└"), last);
	assert.ok(last.endsWith("┘"), last);
	// The top and bottom border corners must land in the same column
	assert.equal(lines[0]?.indexOf("┐"), last.indexOf("┘"));
});

test("no extra horizontal line above the bottom border (regression)", () => {
	// When I changed the x-axis line to "the bottom border doubles as it", I
	// forgot to delete the 0 baseline in the plot area's last row, so the last
	// plot row `│───…───│` sat right above the bottom border `└──…──┘` —
	// visually **an extra line below** (reported by a user actually looking at
	// the chart).
	//
	// The invariant: except for the top/bottom border rows, no plot row should
	// contain a long run of horizontal lines.
	// (The curve itself is braille and never produces `─`; `─` belongs only to
	// borders/dividers.)
	const hist = fakeHist(120);
	const snap = fakeSnap();
	for (const w of [60, 90, 120, 150, 200]) {
		for (const h of [2, 4, 6]) {
			const layout = computeLayout(w, h, 4, 18);
			const lines = renderPanel(
				plainTheme,
				buildBlocks(hist, snap, { points: 60 }),
				w,
				layout,
				60,
			);
			const bw = layout.widths[0] ?? w;
			// Check block by block: plot rows (excluding the band's first top-border
			// row and last bottom-border row) must not have ≥3 consecutive `─`
			for (let band = 0; band < layout.bands; band++) {
				for (let c = 0; c < layout.cols; c++) {
					const lo = c * bw;
					const inner = layout.plotRows; // number of plot rows
					// The block's plot-row range: skip the band's top border (row 0) and bottom border (last row)
					const start = band * (inner + BLOCK_CHROME_ROWS) + 1;
					for (let r = start; r < start + inner; r++) {
						const seg = (lines[r] ?? "").slice(lo, lo + bw);
						assert.ok(
							!/─{3,}/.test(seg),
							`w=${w} h=${h} block(${band},${c}) row ${r} has a stray horizontal line: ${JSON.stringify(seg)}`,
						);
					}
				}
			}
		}
	}
});

test("every block title carries the metric name (fixes 'can't tell which chart is which')", () => {
	const layout = computeLayout(150, 4, 4, 18);
	const lines = renderPanel(
		plainTheme,
		buildBlocks(fakeHist(120), fakeSnap(), { points: 80 }),
		150,
		layout,
		60,
	);
	const head = lines[0] ?? "";
	assert.ok(head.includes("CPU"), head);
	assert.ok(head.includes("Memory"), head);
	assert.ok(head.includes("Network"), head);
	// The CPU title bar should carry the 1/5/15-minute load (aligned with bottom)
	assert.ok(head.includes("1.23 4.56 7.89"), head);
});

test("y-axis ticks and x-axis time labels are both rendered", () => {
	const layout = computeLayout(150, 4, 4, 18);
	const lines = renderPanel(
		plainTheme,
		buildBlocks(fakeHist(120), fakeSnap(), { points: 80 }),
		150,
		layout,
		60,
	);
	const all = lines.join("\n");
	assert.ok(all.includes("100%"), "missing y-axis upper tick");
	assert.ok(all.includes("0%"), "missing y-axis 0 tick");
	assert.ok(/─/.test(all), "missing x-axis line");
	assert.ok(all.includes("0s"), "missing x-axis right-end time label");
});

test("narrow blocks degrade gracefully: drop ticks to keep the curve when ticks don't fit, still no overflow", () => {
	for (let w = 6; w <= 40; w++) {
		const layout = computeLayout(w, 3, 1, 18);
		const lines = renderPanel(
			plainTheme,
			buildBlocks(fakeHist(60), fakeSnap(), { points: 40 }),
			w,
			layout,
			60,
		);
		for (const l of lines) assert.ok(visibleWidth(l) <= w, `w=${w}`);
		// The title name only survives when the block is wide enough: "CPU" needs
		// 3 cols, plus `┌ `, at least 1 fill column and `┐` — minimum 7 columns
		// ("CPU" + 4 border columns).
		// Narrower than that, only part of the name (or none) can be shown; we
		// can't insist the name is always there.
		if (w >= 8) assert.ok((lines[0] ?? "").includes("CPU"), `w=${w} lost the title`);
		// No matter how narrow, the border must close: that's the last resort for
		// telling "which chart this is"
		assert.ok((lines[0] ?? "").startsWith("┌"), `w=${w} missing top-left corner`);
		assert.ok((lines[0] ?? "").endsWith("┐"), `w=${w} missing top-right corner`);
	}
});

test("floating reading box: shown only with `PI_SYSMON_LABEL=box`, and hidden entirely when too narrow", () => {
	const hist = fakeHist(120);
	// Explicitly select box mode — the default is already `title` (readings in
	// the border title bar), so testing the floating box must enable it itself,
	// not rely on the default.
	const blocks = () =>
		buildBlocks(hist, fakeSnap(), { points: 80, labelMode: "box" });
	// Very wide → the AVG box shows
	const wide = renderPanel(
		plainTheme,
		blocks(),
		150,
		computeLayout(150, 4, 4, 18),
		60,
	).join("\n");
	assert.ok(wide.includes("AVG"), "a wide terminal should show the CPU floating reading box");
	// Very narrow → not shown, and no orphan border fragments left behind
	const narrow = renderPanel(
		plainTheme,
		blocks(),
		24,
		computeLayout(24, 3, 1, 18),
		60,
	).join("\n");
	assert.ok(!narrow.includes("AVG"), "a narrow terminal must not show the floating reading box");
});

test("Network readings show cumulative totals (regression: they used to never show)", () => {
	// The old bug: Network's floating box had **never rendered**, for two
	// stacked reasons:
	//  1. The width rule required "leave 40% for the curve", and its text is
	//     the longest (two RX/TX lines);
	//  2. The height rule `legendH + 1 <= rows`: a two-line box has legendH=4
	//     and the default plot area is 4 rows.
	// Now the readings go into the **border title bar** by default
	// (`PI_SYSMON_LABEL=title`): that row's `─` fill was pure decoration, so
	// putting readings there costs nothing and doesn't cover the curve.
	const hist = fakeHist(120);
	const snap = fakeSnap({
		rxTotal: 129.8 * 1024 ** 3,
		txTotal: 178.9 * 1024 ** 3,
	});

	// ① Default (title) mode: rate and cumulative traffic are both in the
	// title bar, with **rate first, total traffic after**
	const net = buildBlocks(hist, snap, { points: 80 }).find(
		(b) => b.name === "Network",
	);
	assert.ok(net, "there should be a Network block");
	const titleText = (net.titleInfo ?? []).map((s) => s.text).join("");
	assert.ok(
		titleText.includes("Σ"),
		`title bar should contain cumulative traffic (Σ), got: ${JSON.stringify(titleText)}`,
	);
	assert.ok(
		/130G/.test(titleText) && /179G/.test(titleText),
		`should contain RX/TX cumulative values (fmtBytes rounds to 130G/179G): ${JSON.stringify(titleText)}`,
	);
	// Order matters: **rate first, total traffic after**. When the title bar
	// runs out of width it drops from the tail, so total traffic is dropped
	// first while the rate (the chart's subject) survives at any width.
	assert.ok(
		titleText.indexOf("K/s") < titleText.indexOf("Σ"),
		`instantaneous rate should come before total traffic, got: ${JSON.stringify(titleText)}`,
	);
	assert.deepEqual(net.legend, [], "title mode must not draw a floating box");

	// ② In default mode it must really render on screen.
	// The rate comes first (with its unit), so it's visible at common widths;
	// total traffic is secondary info and only appears when the block is wide
	// enough.
	for (const w of [120, 150, 200]) {
		const layout = computeLayout(w, 4, 4, 18);
		const lines = renderPanel(
			plainTheme,
			buildBlocks(hist, snap, { points: 60 }),
			w,
			layout,
			60,
		);
		const txt = lines.join("\n");
		assert.ok(/[↓↑]\d/.test(txt), `w=${w}: Network rate not rendered`);
	}
	// With a wide enough block the whole Σ unit must be there. The Σ unit is
	// atomic (`Seg.atomic`, user-requested): download + upload totals appear
	// **together or not at all** — at mid widths (150: block 37 cols, the unit
	// needs 29) it vanishes entirely, never as a dangling `Σ` or a lone `Σ↓130G`.
	for (const w of [200, 240]) {
		const layout = computeLayout(w, 4, 4, 18);
		const lines = renderPanel(
			plainTheme,
			buildBlocks(hist, snap, { points: 60 }),
			w,
			layout,
			60,
		);
		const txt = lines.join("\n");
		assert.ok(
			/Σ↓130G ↑179G/.test(txt),
			`w=${w}: the Σ unit must render whole (both values together): ${JSON.stringify(txt.match(/Σ[^\n]*$/m)?.[0] ?? "")}`,
		);
	}
	// Mid width (150): too narrow for the whole unit → nothing at all. The old
	// segment-by-segment drop showed a dangling `Σ` (or a lonely `Σ↓130G`),
	// which read like a rendering bug — this is the exact regression pinned here.
	{
		const layout = computeLayout(150, 4, 4, 18);
		const lines = renderPanel(
			plainTheme,
			buildBlocks(hist, snap, { points: 60 }),
			150,
			layout,
			60,
		);
		const txt = lines.join("\n");
		assert.ok(
			!txt.includes("Σ"),
			`w=150: the Σ unit doesn't fit whole, so it must be absent entirely: ${JSON.stringify(txt.match(/Network[^\n]*$/m)?.[0] ?? "")}`,
		);
		// …while the rates (the chart's subject) still render
		assert.ok(/[↓↑]\d/.test(txt), "w=150: Network rate not rendered");
	}

	// ③ box mode: the floating box must contain the cumulative traffic too
	const boxNet = buildBlocks(hist, snap, {
		points: 80,
		labelMode: "box",
	}).find((b) => b.name === "Network");
	const boxText = (boxNet?.legend ?? [])
		.map((l) => l.map((s) => s.text).join(""))
		.join("|");
	assert.ok(
		boxText.includes("Σ"),
		`box-mode floating box should contain cumulative traffic: ${JSON.stringify(boxText)}`,
	);
});

/* ------------------------------------------------------------------ */
/* Reading placement (PI_SYSMON_LABEL)                                    */
/* ------------------------------------------------------------------ */

test("labelMode: title / box / both / none — all four modes behave correctly", () => {
	const hist = fakeHist(60);
	const snap = fakeSnap();
	const get = (labelMode: "title" | "box" | "both" | "none") => {
		const b = buildBlocks(hist, snap, { points: 40, labelMode });
		return {
			titles: b.filter((x) => (x.titleInfo?.length ?? 0) > 0).length,
			boxes: b.filter((x) => (x.legend?.length ?? 0) > 0).length,
		};
	};
	assert.deepEqual(get("title"), { titles: 4, boxes: 0 });
	assert.deepEqual(get("box"), { titles: 0, boxes: 4 });
	assert.deepEqual(get("both"), { titles: 4, boxes: 4 });
	assert.deepEqual(get("none"), { titles: 0, boxes: 0 });
	// When labelMode is omitted the default is title
	const def = buildBlocks(hist, snap, { points: 40 });
	assert.ok(
		def.every((x) => (x.titleInfo?.length ?? 0) > 0),
		"default should be title mode",
	);
	assert.ok(
		def.every((x) => (x.legend?.length ?? 0) === 0),
		"default must not draw floating boxes",
	);
});

test("title mode: readings live in the border title bar, row count identical to none mode (zero cost)", () => {
	// Key selling point: readings in the title bar add no rows and don't cover
	// the curve.
	const hist = fakeHist(120);
	for (let w = 30; w <= 200; w += 5) {
		const layout = computeLayout(w, 4, 4, 18);
		const withLabel = renderPanel(
			plainTheme,
			buildBlocks(hist, fakeSnap(), { points: 60 }),
			w,
			layout,
			60,
		);
		const noLabel = renderPanel(
			plainTheme,
			buildBlocks(hist, fakeSnap(), { points: 60, labelMode: "none" }),
			w,
			layout,
			60,
		);
		assert.equal(withLabel.length, noLabel.length, `w=${w}: row count changed`);
		assert.equal(withLabel.length, layout.totalRows, `w=${w}`);
		for (const l of withLabel) assert.ok(visibleWidth(l) <= w, `w=${w} overflow`);
	}
});

test("title mode: readings are ordered by descending importance; narrow blocks drop secondary info but the border always closes", () => {
	// titleInfo is an **array of segments**; narrow blocks drop segments from
	// the tail.
	// The importance order is "instantaneous rate > cumulative total traffic":
	// the curve plots the rate (the chart's subject), and the rate comes first,
	// so narrow blocks drop the total traffic first.
	const net = buildBlocks(fakeHist(60), fakeSnap(), { points: 40 }).find(
		(b) => b.name === "Network",
	);
	assert.ok(net, "there should be a Network block");
	const all = (net.titleInfo ?? []).map((s) => s.text).join("");
	assert.ok(/[↓↑]/.test(all), `the first segment should be the instantaneous rate, got ${JSON.stringify(all)}`);
	assert.ok(
		all.indexOf("K/s") < all.indexOf("Σ"),
		`rate should come before total traffic, got ${JSON.stringify(all)}`,
	);

	for (const bw of [20, 24, 28, 34, 40, 50, 60, 80, 100]) {
		const lines = renderPanel(
			plainTheme,
			[net],
			bw,
			{ cols: 1, bands: 1, widths: [bw], plotRows: 4, totalRows: 8 },
			60,
		);
		const head = lines[0] ?? "";
		// The border must close: no matter how little room the readings have, they
		// must not push the `┐` off
		assert.ok(head.startsWith("┌"), `bw=${bw}: missing top-left corner`);
		assert.ok(head.endsWith("┐"), `bw=${bw}: missing top-right corner ${JSON.stringify(head)}`);
		assert.equal(visibleWidth(head), bw, `bw=${bw}: title row width is wrong`);
		assert.ok(head.includes("Network"), `bw=${bw}: lost the block name`);
		// The rate comes first → if one segment fits, it's the rate
		if (bw >= 34) {
			assert.ok(/[↓↑]\d/.test(head), `bw=${bw}: should contain the instantaneous rate`);
		}
	}
	// Total traffic must appear in wide blocks (added only when width allows;
	// dropped first on narrow blocks)
	const wide = renderPanel(
		plainTheme,
		[net],
		100,
		{ cols: 1, bands: 1, widths: [100], plotRows: 4, totalRows: 8 },
		60,
	);
	assert.ok((wide[0] ?? "").includes("Σ"), "a wide block should contain cumulative total traffic");
});

test("floating reading box: when shown it must be a fully closed box and must not overlap the x-axis line", () => {
	// Sweep widths; wherever AVG renders, check both corners of the box exist
	// and the bottom-border row index < the axis-line row index
	const hist = fakeHist(120);
	for (let w = 30; w <= 200; w++) {
		const layout = computeLayout(w, 4, 4, 18);
		const lines = renderPanel(
			plainTheme,
			buildBlocks(hist, fakeSnap(), { points: 60, labelMode: "box" }),
			w,
			layout,
			60,
		);
		const text = lines.join("\n");
		if (!text.includes("AVG")) continue;
		// Find the AVG row; the row above it should be ┌...┐ and the row below └...┘
		const idx = lines.findIndex((l) => l.includes("AVG"));
		assert.ok(idx >= 1, `w=${w}: AVG appeared on row 0, no top border`);
		const top = lines[idx - 1] ?? "";
		const bottom = lines[idx + 1] ?? "";
		assert.ok(top.includes("┌") && top.includes("┐"), `w=${w}: floating box missing top border`);
		assert.ok(
			bottom.includes("└") && bottom.includes("┘"),
			`w=${w}: floating box missing bottom border`,
		);
		// The floating box's bottom border must not sit on the x-axis line's └
		// (that looks broken). The x-axis line ends with `└─…─│` (horizontal line
		// meets the right border), while the floating box's bottom border ends
		// with `└─…─┘` — use that difference to tell them apart, otherwise the
		// floating box's own bottom border would be mistaken for the axis line.
		const axisRow = lines.findIndex((l) => /└─+│/.test(l));
		if (axisRow >= 0)
			assert.ok(idx + 1 < axisRow, `w=${w}: floating box bottom border overlaps the x-axis line`);
	}
});

test("y tick row positions use floor (matching ratatui's integer division, not round)", () => {
	// Measured evidence: bottom's frame capture of the Network block with
	// plotRows=8 and 4 ticks puts the ticks on plot rows {0, 2, 4, 7} (0KB on
	// bottom row 7, 886.8 on top row 0).
	// ratatui's `render_y_labels` uses `i*(h-1)/(n-1)` (u16 division → floor).
	// With Math.round you'd get {0,2,5,7} — the third tick off by one row.
	// So here we pin the row numbers with a real 4-tick block (Network).
	const plotRows = 8;
	const layout = {
		cols: 1,
		bands: 1,
		widths: [60],
		plotRows,
		totalRows: plotRows + BLOCK_CHROME_ROWS,
	};
	const block: MetricBlock = {
		name: "Network",
		color: "accent",
		// Range 1000 → 4 ticks: 0.0 / 500.0 / 1000.0 / 1500.0, all 5 chars wide
		series: [{ values: [0, 100, 500, 900, 200, 700] }],
		legend: [],
		axis: () => ({ labels: ["  0.0", "500.0", "1000.", "1500."], max: 1000 }),
	};
	const lines = renderPanel(plainTheme, [block], 60, layout, 60);
	// block row 0 = top border, rows 1..plotRows = plot
	const rowOf = (s: string) =>
		lines.findIndex((l, i) => i >= 1 && i <= plotRows && l.includes(s));
	const plotIdx = (s: string) => rowOf(s) - 1; // convert to 0-based row within the plot
	assert.equal(plotIdx("1500."), 0, "the largest tick should be on the plot's first row");
	assert.equal(plotIdx("  0.0"), 7, "the zero tick should be on the plot's last row");
	// floor: i=2 → dy=floor(2*7/3)=4 → y=7-4=3
	assert.equal(
		plotIdx("1000."),
		3,
		"with the floor formula, 1000. should be on plot row 3 (round would give row 2)",
	);
	// floor: i=1 → dy=floor(7/3)=2 → y=5
	assert.equal(plotIdx("500.0"), 5, "with the floor formula, 500.0 should be on plot row 5");
});

test("robustness: zero blocks / negative width / NaN width neither crash nor overflow", () => {
	// renderPanel / computeLayout are exported functions; any caller may pass
	// bad values.
	// A negative width used to make `" ".repeat(-2)` throw RangeError, and zero
	// blocks would be masked by `Math.max(1, count)` into a fake "one block"
	// layout.
	const zero = computeLayout(100, 4, 0, 18);
	assert.equal(zero.bands, 0);
	assert.equal(zero.totalRows, 0);
	assert.deepEqual(zero.widths, []);

	const neg = computeLayout(-5, 4, 3, 18);
	assert.ok(
		neg.widths.every((w) => w >= 0),
		JSON.stringify(neg.widths),
	);
	assert.ok(neg.totalRows > 0);

	for (const w of [0, -5, Number.NaN]) {
		assert.deepEqual(
			renderPanel(plainTheme, [], w, computeLayout(100, 4, 3, 18), 60),
			[],
		);
	}
	// Negative width + blocks: must not throw
	assert.doesNotThrow(() =>
		renderPanel(
			plainTheme,
			buildBlocks(fakeHist(20), fakeSnap(), { points: 10 }),
			-5,
			computeLayout(100, 4, 3, 18),
			60,
		),
	);
});

test("robustness: non-ASCII text doesn't break the width ledger (CJK/combining/zero-width/full-width/emoji)", () => {
	// The cell model's invariant is "each cell occupies exactly one display
	// column", equivalent to `row.length === visibleWidth(rowText)`. And
	// `visibleWidth` follows `get-east-asian-width`, which differs from
	// "character count" in three cases (all measured):
	//   · wide chars (CJK/emoji/full-width space) → visibleWidth 2, char count 1
	//     → without padding compensation the line gets **wider** → pi exits
	//   · combining/zero-width chars → visibleWidth 0 → without merging into the
	//     previous cell, later content shifts **left** relative to the border
	// All of this project's own text is ASCII, but these three classes must be
	// defended, otherwise a caller passing Chinese text would crash it.
	const hist = fakeHist(60);
	const weird = [
		"处理器 CPU", // CJK (visibleWidth 2)
		"e\u0301\u0301 combining", // combining marks (visibleWidth 0)
		"zero\u200bwidth", // zero-width space (visibleWidth 0)
		"full\u3000space", // full-width space (visibleWidth 2)
		"emoji🙂test", // emoji (visibleWidth 2, surrogate pair)
		"\u200bstart", // starts with zero-width: no preceding cell to merge into; should be dropped rather than inflate a column
		"µs−x", // ambiguous chars like µ/minus sign (visibleWidth 1, must stay 1)
	];
	for (const name of weird) {
		const blocks = buildBlocks(hist, fakeSnap(), { points: 40 }).map((b) => ({
			...b,
			name,
			titleInfo: [{ text: name }],
			legend: [[{ text: name }]],
		}));
		for (const w of [24, 30, 45, 60, 100, 150, 200]) {
			const layout = computeLayout(w, 4, 4, 18);
			const lines = renderPanel(plainTheme, blocks, w, layout, 60);
			// No overflow (overflow = pi throws and exits)
			for (const [i, l] of lines.entries()) {
				assert.ok(
					visibleWidth(l) <= w,
					`text ${JSON.stringify(name)} w=${w} line ${i}: ${visibleWidth(l)} > ${w}`,
				);
			}
			// Constant row count (non-ASCII must not change the row count either)
			assert.equal(
				lines.length,
				layout.totalRows,
				`text ${JSON.stringify(name)} w=${w}`,
			);
			// The border must still close: non-ASCII must not push corner chars off.
			// Note: you can't check "last line endsWith ┘" — with 3 blocks in 2
			// columns the bottom-right corner is an **empty slot**, so the last line
			// is naturally blank. Instead check the border closure of each block's
			// **left** cell per block.
			//
			// Another trap: don't cut blocks with `String.slice(0, w0)`! In strings
			// containing CJK one code point occupies 2 display columns, while
			// `slice` counts code points, so the cut substring's width exceeds w0
			// and `endsWith("┐")` falsely reports failure. Here we cut by
			// accumulating **display columns**.
			const w0 = layout.widths[0] ?? 0;
			const firstBlock = (line: string): string => {
				const row: string[] = [];
				let used = 0;
				for (const ch of line) {
					const vw = visibleWidth(ch);
					if (used + vw > w0) break;
					row.push(ch);
					used += vw;
				}
				return row.join("");
			};
			const head0 = firstBlock(lines[0] ?? "");
			assert.equal(
				visibleWidth(head0),
				w0,
				`text ${JSON.stringify(name)} w=${w}: first block width is wrong`,
			);
			assert.ok(
				head0.endsWith("┐"),
				`text ${JSON.stringify(name)} w=${w}: first block lost its top-right corner ${JSON.stringify(head0)}`,
			);
			// The bottom border of the first block in the last band should close
			// (if that slot is occupied)
			const tail0 = firstBlock(lines[lines.length - 1] ?? "");
			assert.ok(
				tail0.endsWith("┘") || tail0.trim() === "",
				`text ${JSON.stringify(name)} w=${w}: last block's bottom border is abnormal ${JSON.stringify(tail0)}`,
			);
		}
	}
});

test("robustness: fmtBytes doesn't emit overly long strings for overflow values (otherwise it would burst the floating box)", () => {
	// A broken counter can yield values like 1e308; going through toFixed
	// produces 20+ chars, and this text goes straight into the floating reading
	// box → the width blowout wrecks the box.
	for (const big of [1e21, 1e308, Number.MAX_VALUE]) {
		const s = fmtBytes(big);
		assert.ok(s.length <= 6, `fmtBytes(${big}) = ${s} (too long)`);
	}
	assert.equal(fmtBytes(1e308), ">999T");
	// Normal values are unaffected
	assert.equal(fmtBytes(0), "0B");
	assert.equal(fmtBytes(1536), "1.5K");
	assert.equal(fmtBytes(Number.NaN), "0B");
	assert.equal(fmtBytes(Number.POSITIVE_INFINITY), "0B");
});

test("tokenAxis: labels are always TPS_GUTTER columns at every magnitude and carry a token unit", () => {
	// Same fixed-width constraint as rateAxis, but tokenAxis is **new code** and
	// must verify itself:
	//  1. Every branch must be exactly TPS_GUTTER columns — when the width
	//     changes the overprint area changes, and the plot area's left edge
	//     jumps left/right frame by frame (ARCHITECTURE pitfall 6).
	//  2. The unit must be tokens; **KB/MB must never appear** — that's exactly
	//     the wrong-unit bug reusing rateAxis would cause (1500 tok/s would show
	//     as `2.2KB`).
	for (let e = 0; e <= 15; e++) {
		for (const m of [1, 1.5, 6.7, 9.99, 670, 999]) {
			const dm = m * 10 ** e;
			if (!Number.isFinite(dm)) continue;
			const a = tokenAxis(dm);
			assert.ok(Number.isFinite(a.max) && a.max > 0, `dm=${dm}`);
			for (const l of a.labels) {
				assert.equal(
					l.length,
					TPS_GUTTER,
					`dm=${dm} → ${JSON.stringify(l)} should be exactly ${TPS_GUTTER} columns`,
				);
				assert.ok(!l.includes("KB"), `dm=${dm} must not show a byte unit: ${l}`);
				assert.ok(!l.includes("NaN"), `dm=${dm}: ${l}`);
				assert.ok(!l.includes("e+"), `dm=${dm}: ${l}`);
			}
		}
	}
	// It must really be a token unit
	assert.ok(tokenAxis(1500).labels[0]?.includes("t/s"));
});

test("tokenAxis: precision-drop fallback must not emit `1000Kt/s` (consistent with the >999K clamp)", () => {
	// A real bug we hit: `fit()` drops precision and rounds when one decimal
	// doesn't fit, but didn't handle rounding up to 1000 — so
	// `tokenAxis(666666)` output `1000Kt/s`, contradicting its own `>999Kt/s`
	// clamp (and `1000K` reads like 1M yet carries a K suffix).
	//
	// Note the trigger window is narrow: max = dm×1.5 must land in
	// [999500, 1e6). The multiplier set of the original "all-magnitude sweep"
	// happened to skip this window, so it never caught it — which is why this
	// deserves its own pinned test instead of relying on the sweep alone.
	for (const dm of [666666, 666333, 666667, 999999, 666600]) {
		const l = tokenAxis(dm).labels[0] ?? "";
		assert.ok(
			!l.includes("1000K"),
			`dm=${dm} must not output 1000K: ${JSON.stringify(l)}`,
		);
		assert.equal(l.length, TPS_GUTTER, `dm=${dm}: ${JSON.stringify(l)}`);
	}
	// The precision-drop branch itself must work (not just be bypassed)
	assert.equal(tokenAxis(100_000).labels[0], " 150Kt/s");
});

test("tokenAxis: range floor MIN_TPS_SCALE and bad inputs don't crash", () => {
	// The floor's purpose: during idle time a single 1 tok/s tail point
	// shouldn't pin the range to 1.5, otherwise the next 200 tok/s reply would
	// slam against the top.
	assert.equal(tokenAxis(0).max, MIN_TPS_SCALE);
	assert.equal(tokenAxis(1).max, MIN_TPS_SCALE, "1×1.5 < 10 → the floor takes over");
	assert.equal(tokenAxis(100).max, 150, "normal value: max×1.5");
	// NaN/Infinity/negatives must fall back to 0 first, otherwise they'd
	// produce NaN coordinates → overflow crash
	for (const bad of [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		-5,
	]) {
		const a = tokenAxis(bad);
		assert.equal(a.max, MIN_TPS_SCALE, `tokenAxis(${bad}).max`);
		assert.ok(Number.isFinite(a.max));
		assert.equal(a.labels.length, 1, "only the single top tick");
		assert.equal(a.labels[0]?.length, TPS_GUTTER);
	}
});

test("fmtTokensTotal: magnitude boundaries and width upper bound (aligned with pi footer)", () => {
	// The format matches pi footer's `formatTokens` **character for character**,
	// including the **lowercase k** — so the chart's `↑5.7k` can be compared
	// directly with pi's bottom line.
	assert.equal(fmtTokensTotal(0), "0");
	assert.equal(fmtTokensTotal(999), "999");
	assert.equal(fmtTokensTotal(1500), "1.5k");
	assert.equal(fmtTokensTotal(5671), "5.7k");
	assert.equal(fmtTokensTotal(12345), "12k");
	assert.equal(fmtTokensTotal(1.2e6), "1.2M");
	assert.equal(fmtTokensTotal(1e9), ">999M");
	// Width upper bound: it's a title-bar reading; overflow makes pi exit
	for (const v of [
		0,
		999,
		1e5,
		1e8,
		1e12,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-5,
	]) {
		const s = fmtTokensTotal(v);
		assert.ok(s.length <= 7, `fmtTokensTotal(${v})="${s}" too long`);
		assert.ok(!s.includes("e+"), `scientific notation: ${s}`);
		assert.ok(!s.includes("NaN") && !s.includes("Infinity"), `bad value: ${s}`);
	}
});

test("buildBlocks: Tokens block is wired correctly (totals shown only when showTokenTotals)", () => {
	// Asserting only the block name isn't enough: if the series were wired to
	// some other history array (like hist.cpu), or the reading args were
	// forgotten (always 0), a name-only test would still pass.
	const h = fakeHist(50);
	const mk = (over: Partial<BlockOptions> = {}) =>
		buildBlocks(h, fakeSnap(), {
			points: 30,
			tpsNow: 250,
			tokensIn: 5671,
			tokensOut: 11,
			tokensCacheRead: 640,
			...over,
		}).find((b) => b.name === "Tokens");
	const tok = mk();
	assert.ok(tok, "there should be a Tokens block by default (PI_SYSMON_TOKENS defaults on)");
	assert.deepEqual(
		tok.series[0]?.values,
		h.tps.slice(-30),
		"series must read hist.tps, not some other series",
	);
	const title = (tok.titleInfo ?? []).map((s) => s.text).join("");
	// Authenticity of the rate: the estimate carries `~` and uses the compact
	// form (`250t/s`, not `250 tok/s`) — the spelled-out unit would make the
	// whole reading vanish in a 24-col block.
	assert.ok(
		title.startsWith("~250t/s"),
		`the rate reading should carry ~ and use the compact form: ${JSON.stringify(title)}`,
	);
	// Widget modes sit next to pi's own footer, which permanently shows the
	// same `↑ ↓ R` numbers — so the default is OFF (no duplicate readings).
	assert.ok(!title.includes("\u2191"), `widget default must not duplicate upload: ${title}`);
	assert.ok(!title.includes("\u2193"), `widget default must not duplicate download: ${title}`);
	assert.ok(!title.includes("R640"), `widget default must not duplicate cache reads: ${title}`);
	// Footer mode (showTokenTotals) replaces pi's footer, so the totals come
	// back — same accounting, same format as pi footer's formatTokens (lowercase k).
	const ftTitle = (mk({ showTokenTotals: true })?.titleInfo ?? [])
		.map((s) => s.text)
		.join("");
	assert.ok(ftTitle.includes("\u2191"), `footer mode should contain upload: ${ftTitle}`);
	assert.ok(ftTitle.includes("\u2193"), `footer mode should contain download: ${ftTitle}`);
	assert.ok(ftTitle.includes("5.7k"), `↑5671 should format as 5.7k: ${ftTitle}`);
	assert.ok(ftTitle.includes("R640"), `cache reads should show as R640: ${ftTitle}`);
	// Cumulative values are exact numbers reported by the provider and **must not** carry `~`
	const ioOnly = ftTitle.slice(ftTitle.indexOf("\u2191"));
	assert.ok(!ioOnly.includes("~"), `cumulative values must not carry ~ (they're exact): ${ioOnly}`);
	assert.ok((tok.scaleWindowPoints ?? 0) > 0, "Tokens is a rate chart, it should have a scale window");
});

test("buildBlocks: Tokens cumulative readings degrade segment by segment with width (narrow blocks drop cache reads first)", () => {
	// Order of descending importance: rate → hit rates → upload → download →
	// cache reads. Verify degradation really happens in this order, not
	// "all or nothing".
	//
	// The thresholds are **measured against a single Tokens block**, i.e. in
	// block columns, so they don't move when the terminal layout's column split
	// changes (they used to be expressed in terminal widths, which silently
	// coupled them to `chooseColumns`):
	//   21–25 cols  rate only
	//   26–32 cols  + ⌀ cumulative hit rate
	//   33–36 cols  + ↑ upload
	//   37–41 cols  + ↓ download
	//   42+ cols    + R cache reads
	// (At 96 terminal columns the 4-up layout gives each block exactly 24 cols,
	// so the narrow end really only shows the rate — that is an intentional
	// priority, not a bug.)
	// The `·` instantaneous segment is **not** part of this chain: it sits before
	// `⌀` and only exists when a `hitNow` is supplied, so it has its own test.
	const h = fakeHist(50);
	const mkReading = () =>
		buildBlocks(h, fakeSnap(), {
			points: 30,
			tpsNow: 250,
			tokensIn: 5671,
			tokensOut: 11,
			tokensCacheRead: 640,
			// Footer mode: the totals are part of the degradation chain. The widget
			// default (off) is pinned by the wired-correctly test above.
			showTokenTotals: true,
		});
	const tok = mkReading().find((b) => b.name === "Tokens");
	const all = (tok?.titleInfo ?? []).map((s) => s.text).join("");
	// All five segments present when width isn't limited
	assert.ok(
		all.includes("\u2191") && all.includes("\u2193") && all.includes("R"),
		all,
	);

	/** Render just the Tokens block at an explicit **block** width and return its title bar */
	const shown = (blockW: number): string => {
		const lines = renderPanel(
			plainTheme,
			mkReading().filter((b) => b.name === "Tokens"),
			blockW,
			{ cols: 1, bands: 1, widths: [blockW], plotRows: 4, totalRows: 8 },
			60,
		);
		return (lines[0] ?? "").trimEnd();
	};
	// Block width 21 (tighter than the 24-col minimum of a 4-up layout) → rate only
	assert.ok(shown(21).includes("t/s"), `even at the narrowest the rate survives: ${shown(21)}`);
	assert.ok(
		!shown(25).includes("\u2300"),
		`block width 25 is one column short of ⌀: ${shown(25)}`,
	);
	assert.ok(
		!shown(25).includes("\u2191"),
		`at the narrowest, upload rightly yields its place: ${shown(25)}`,
	);
	// Block width 26 → cumulative hit rate appears
	assert.ok(shown(26).includes("\u2300"), `⌀ should appear at block width 26: ${shown(26)}`);
	// Block width 33 → upload appears
	assert.ok(
		!shown(32).includes("\u2191"),
		`block width 32 shouldn't have upload yet: ${shown(32)}`,
	);
	assert.ok(shown(33).includes("\u2191"), shown(33));
	assert.ok(
		!shown(33).includes("\u2193"),
		`block width 33 shouldn't have download yet: ${shown(33)}`,
	);
	// Block width 37 → download appears
	assert.ok(shown(37).includes("\u2193"), shown(37));
	// Block width 42 → cache reads appear
	assert.ok(
		!shown(41).includes("R640"),
		`block width 41 shouldn't have cache reads yet: ${shown(41)}`,
	);
	assert.ok(shown(42).includes("R640"), shown(42));
	// And the widget default: even at a generous width the totals stay off —
	// pi's own footer already shows them right below the panel.
	const plain = buildBlocks(h, fakeSnap(), {
		points: 30,
		tpsNow: 250,
		tokensIn: 5671,
		tokensOut: 11,
		tokensCacheRead: 640,
	}).find((b) => b.name === "Tokens");
	assert.ok(
		!(plain?.titleInfo ?? []).map((s) => s.text).join("").includes("R640"),
		"widget default must keep the totals off at any width",
	);
});

test("buildBlocks: Tokens instantaneous `·` segment outranks the cumulative `⌀` one (⌀ yields first)", () => {
	// `·N%` (this turn) outranks `⌀N%` (session average) — it is the actionable
	// number, and it sits directly after the rate. Since whole segments are
	// dropped from the tail, that ordering means ⌀ disappears **while · still
	// fits**. Measured on a single Tokens block:
	//   21–25 cols  rate only
	//   26–30 cols  + · (the instantaneous rate)
	//   31+ cols    + ⌀ (the cumulative average)
	const mk = () =>
		buildBlocks(fakeHist(50), fakeSnap(), {
			points: 30,
			tpsNow: 250,
			tokensIn: 5671,
			tokensOut: 11,
			tokensCacheRead: 640,
			hitNow: 88,
		});
	const shown = (blockW: number): string => {
		const lines = renderPanel(
			plainTheme,
			mk().filter((b) => b.name === "Tokens"),
			blockW,
			{ cols: 1, bands: 1, widths: [blockW], plotRows: 4, totalRows: 8 },
			60,
		);
		return (lines[0] ?? "").trimEnd();
	};
	assert.ok(
		!shown(25).includes("\u00b7"),
		`block width 25 shouldn't have the instantaneous reading yet: ${shown(25)}`,
	);
	const medium = shown(26);
	assert.ok(medium.includes("\u00b7"), `· should appear at block width 26: ${medium}`);
	assert.ok(
		!medium.includes("\u2300"),
		`⌀ must yield first, it isn't due yet at block width 26: ${medium}`,
	);
	const wide = shown(31);
	assert.ok(wide.includes("\u2300"), `⌀ should appear at block width 31: ${wide}`);
	assert.ok(
		wide.indexOf("\u00b7") < wide.indexOf("\u2300"),
		`· must precede ⌀ in the title bar: ${wide}`,
	);
});

test("buildBlocks: Tokens plots the cumulative hit rate as a second (warning) curve, TPS staying series[0]", () => {
	// Two curves share the token chart once the provider has reported cache
	// reads. The index order is **load-bearing**, not cosmetic:
	// `renderChartGlyphs` resolves a same-cell collision in favour of the lowest
	// index, so TPS must be series[0] or the yellow line would steal the rate
	// curve's cells (and its colour) wherever the two overlap.
	const h = fakeHist(50);
	const tok = buildBlocks(h, fakeSnap(), {
		points: 30,
		tpsNow: 250,
		tokensIn: 5671,
		tokensOut: 11,
		tokensCacheRead: 640,
		hitNow: 88,
	}).find((b) => b.name === "Tokens");
	assert.ok(tok);
	assert.equal(tok.series.length, 2, "with cache reads there are two curves");
	assert.deepEqual(
		tok.series[0]?.values,
		h.tps.slice(-30),
		"series[0] must be TPS (lowest index wins same-cell collisions)",
	);
	assert.equal(
		tok.series[0]?.color,
		undefined,
		"series[0] must carry no color so it inherits the block accent",
	);
	assert.equal(tok.series[1]?.color, "warning", "series[1] is the yellow hit-rate line");
	// The values are **not** the raw percentages: `buildBlocks` pre-maps them onto
	// the TPS axis (`hit% / 100 × axis top`) and marks the series
	// `excludeFromScale`, so that a 3000 t/s spike can't squash a 90% hit rate to
	// a 2%-tall line glued to the floor. Derive the expected top through
	// `tokenAxis` itself (same rule as `renderBlock`'s dataMax: finite and > 0).
	const hitTail = h.sessHit.slice(-30);
	const tpsTail = h.tps.slice(-30);
	let tpsTailMax = 0;
	for (const v of tpsTail) if (Number.isFinite(v) && v > tpsTailMax) tpsTailMax = v;
	const scaleTop = tokenAxis(tpsTailMax).max;
	assert.equal(
		tok.series[1]?.excludeFromScale,
		true,
		"the yellow line must be excluded from the y-scale and overflow detection",
	);
	assert.deepEqual(
		tok.series[1]?.values,
		hitTail.map((x) => (scaleTop * x) / 100),
		"series[1] must be sessHit pre-mapped onto the TPS axis (0-100% share the plot height)",
	);
	assert.equal(
		tok.series[1]?.values.length,
		hitTail.length,
		"pre-mapping must not drop or add points",
	);
});

test("buildBlocks: a 90% hit rate renders in the upper half even with a 3000 t/s spike (no shared-axis squash)", () => {
	// The bug this pins: with a **shared** token axis a 3000 t/s peak pushes the
	// top to 4500 t/s, so a 90% hit rate lands at 90/4500 ≈ 2% of the axis height
	// — i.e. the yellow line sits on the floor exactly while the model is
	// streaming, which is precisely when the user is looking at the chart.
	// After the fix the yellow line's height is its own percentage (`90% × plot
	// height`), regardless of how tall the TPS axis is.
	const n = 50;
	const hist: History = {
		cpu: new Array(n).fill(20),
		cpuTemp: new Array(n).fill(60),
		mem: new Array(n).fill(50),
		// Explicitly unknown: these fixtures exist to pin the Tokens block's scale
		// behaviour, so a second Memory curve would only add unrelated noise.
		procRss: new Array(n).fill(0),
		netRx: new Array(n).fill(1000),
		netTx: new Array(n).fill(1000),
		diskR: new Array(n).fill(1000),
		diskW: new Array(n).fill(1000),
		// Mostly idle, with one big response in the window (3000 t/s peak)
		tps: Array.from({ length: n }, (_, i) => (i === n - 5 ? 3000 : 20)),
		sessHit: new Array(n).fill(90),
	};
	const tok = buildBlocks(hist, fakeSnap(), {
		points: 30,
		tpsNow: 3000,
		tokensIn: 5671,
		tokensOut: 11,
		tokensCacheRead: 640,
	}).find((b) => b.name === "Tokens");
	assert.ok(tok);
	const plotRows = 6;
	const W = 96;
	const lines = renderPanel(
		ansiTheme,
		[tok],
		W,
		{ cols: 1, bands: 1, widths: [W], plotRows, totalRows: plotRows + 4 },
		60,
	);
	// Plot rows come after the title row (`renderBlock` emits head first).
	const plotLines = lines.slice(1, 1 + plotRows);
	assert.equal(plotLines.length, plotRows, "the plot area must have the requested rows");
	const WARN = "\x1b[33m";
	const yellowRows = plotLines
		.map((l, i) => (l.includes(WARN) ? i : -1))
		.filter((i) => i >= 0);
	assert.ok(
		yellowRows.length > 0,
		`the yellow hit-rate line must be drawn somewhere:\n${lines.join("\n")}`,
	);
	const topYellow = Math.min(...yellowRows);
	assert.ok(
		topYellow < plotRows / 2,
		`a 90% hit rate must render in the upper half (row ${topYellow} of ${plotRows}, half=${plotRows / 2}):\n${lines.join("\n")}`,
	);
});

test("buildBlocks: a low-TPS session no longer has its token axis pinned by the percentage curve", () => {
	// This **replaces the old pin** (`sessHit=100 + tps=5 ⇒ axis top 150t/s`,
	// where the raw percentage was fed into the shared scale and squashed the TPS
	// curve against the floor). Now the yellow series is `excludeFromScale` and
	// pre-mapped, so `renderBlock`'s dataMax only ever sees TPS: the axis top is
	// `tokenAxis(5).max = MIN_TPS_SCALE = 10`, and the 100% hit rate maps to
	// `10 × 100/100 = 10` — i.e. it touches the top of the (short) axis, which is
	// the correct semantic for a 100% reading.
	const n = 50;
	const flat = (v: number) => new Array(n).fill(v);
	const hist: History = {
		cpu: flat(20),
		cpuTemp: flat(60),
		mem: flat(50),
		// Unknown (see the note in the fixture above): keeps this Tokens-scale test
		// free of an unrelated second Memory curve.
		procRss: flat(0),
		netRx: flat(1000),
		netTx: flat(1000),
		diskR: flat(1000),
		diskW: flat(1000),
		tps: flat(5),
		sessHit: flat(100),
	};
	const tok = buildBlocks(hist, fakeSnap(), {
		points: 30,
		tpsNow: 5,
		tokensIn: 5671,
		tokensOut: 11,
		tokensCacheRead: 640, // seenCache gate on, so the yellow line exists
		hitNow: 88,
	}).find((b) => b.name === "Tokens");
	assert.ok(tok);
	// `renderBlock` computes dataMax over the non-excluded series only; derive it
	// the same way instead of hardcoding 5.
	let dataMax = 0;
	for (const s of tok.series) {
		if (s.excludeFromScale) continue;
		for (const v of s.values) if (Number.isFinite(v) && v > dataMax) dataMax = v;
	}
	assert.equal(dataMax, 5, "the yellow line's percentages must not feed the scale");
	assert.equal(
		tok.axis(dataMax, 4).max,
		MIN_TPS_SCALE,
		"a 5 t/s session floors the axis at 10t/s — it is no longer stretched to 150 by the hit rate",
	);
	// The pre-mapped 100% value: exactly the axis top (touching the ceiling).
	// The window is `points=30`, so the tail slice is 30 points long.
	assert.deepEqual(
		tok.series[1]?.values,
		flat(MIN_TPS_SCALE).slice(-30),
		"100% maps to 10 × 100/100 = 10 (the axis top), not to a raw 100",
	);
	assert.equal(tok.series[1]?.excludeFromScale, true);
	// …and it must render without blowing up: every line exactly the tested width.
	const W = 96;
	const lines = renderPanel(plainTheme, [tok], W, computeLayout(W, 6, 4, 18), 60);
	assert.ok(lines.length > 0, "the Tokens block must render");
	for (const line of lines)
		assert.equal(visibleWidth(line), W, `line wider than ${W}: ${JSON.stringify(line)}`);
});

/* ------------------------------------------------------------------ */
/* 4b. CPU temperature curve (dual-axis, mirroring the TPS/hit-rate      */
/*     pattern the user asked to imitate)                                */
/* ------------------------------------------------------------------ */

test("buildBlocks: CPU plots the temperature as a second (error) curve, CPU% staying series[0]", () => {
	// The index order is **load-bearing**, not cosmetic (same as the Tokens
	// block): `renderChartGlyphs` resolves a same-cell collision in favour of
	// the lowest index, so CPU% must be series[0] or the red temperature line
	// would steal the % curve's cells (and its colour) wherever they cross.
	const h = fakeHist(50);
	const cpu = buildBlocks(h, fakeSnap(), { points: 30 }).find(
		(b) => b.name === "CPU",
	);
	assert.ok(cpu);
	assert.equal(cpu.series.length, 2, "with a temperature reading there are two curves");
	assert.deepEqual(
		cpu.series[0]?.values,
		h.cpu.slice(-30),
		"series[0] must be CPU% (lowest index wins same-cell collisions)",
	);
	assert.equal(
		cpu.series[0]?.color,
		undefined,
		"series[0] must carry no color so it inherits the block success colour",
	);
	assert.equal(cpu.series[1]?.color, "error", "series[1] is the red temperature line");
	// The values are the **raw °C** — no pre-mapping: the temperature scale
	// (0..100°C) and the % axis geometry coincide by construction (1°C ≡ 1% of
	// plot height), unlike the Tokens block whose hit-rate curve is scaled onto
	// the TPS axis' varying top.
	assert.deepEqual(
		cpu.series[1]?.values,
		h.cpuTemp.slice(-30),
		"series[1] must be the raw °C history",
	);
	assert.equal(
		cpu.series[1]?.excludeFromScale,
		true,
		"the temperature line must be excluded from the y-scale and overflow detection",
	);
	// The secondary-scale readout at the top-right corner of the plot area.
	assert.equal(cpu.rightAxisLabel, "100°");
	// And the axis itself stays the fixed percent scale — the temperature
	// series must not have stretched it (that's what excludeFromScale buys).
	assert.equal(cpu.axis(999, 4).max, 100.5, "CPU range stays fixed at 100.5");
});

test("buildBlocks: no temperature source ⇒ single-curve CPU block, no `100°` label (graceful degradation)", () => {
	// A platform whose sensor is unreadable pushes 0s; "unknown ⇒ curve absent"
	// beats drawing a red line glued to 0°C. Same degradation philosophy as
	// `ctxPct` (unknown ⇒ segment absent), pinned here so a future refactor
	// can't quietly turn "unknown" into a fabricated 0°C reading.
	const h = fakeHist(50);
	h.cpuTemp = new Array(50).fill(0);
	const snap = fakeSnap({ cpuTemp: 0 });
	const cpu = buildBlocks(h, snap, { points: 30 }).find((b) => b.name === "CPU");
	assert.ok(cpu);
	assert.equal(cpu.series.length, 1, "no reading ⇒ no second curve");
	assert.equal(cpu.rightAxisLabel, undefined, "no reading ⇒ no 100° label");
	// The title bar must not carry a `0°` reading either.
	const title = (cpu.titleInfo ?? []).map((s) => s.text).join("");
	assert.ok(!title.includes("°"), `no ° in the title bar: ${JSON.stringify(title)}`);
});

test("buildBlocks: a temperature history with ANY real reading in the window turns the curve on", () => {
	// The gate is over the **visible window** (not the whole store): a sensor
	// that just came back (e.g. helper installed mid-session) flips the chart
	// to two curves as soon as one >0 sample enters the window.
	const h = fakeHist(50);
	h.cpuTemp = new Array(50).fill(0);
	h.cpuTemp[49] = 42; // one real reading, the newest
	const cpu = buildBlocks(h, fakeSnap({ cpuTemp: 42 }), { points: 30 }).find(
		(b) => b.name === "CPU",
	);
	assert.ok(cpu);
	assert.equal(cpu.series.length, 2);
	assert.equal(cpu.rightAxisLabel, "100°");
	// Unknown points inside the window render as 0, not NaN (NaN coordinates
	// are the road to out-of-bounds crashes — ARCHITECTURE pitfall 4).
	const tail = cpu.series[1]?.values ?? [];
	assert.ok(tail.every((v) => Number.isFinite(v)), `no NaN in the temp series: ${tail}`);
});

test("buildBlocks: the CPU title bar carries the temperature readout after the usage, before the load averages", () => {
	// Descending importance (user-requested default): usage% → `°` temperature →
	// load1/5/15. The temperature pairs with this block's second (red) curve,
	// so it outranks the load averages — the load segment is dropped first on
	// narrow blocks, symmetric to Network's "rate before Σ" rule.
	const h = fakeHist(50);
	const cpu = buildBlocks(h, fakeSnap({ cpuTemp: 61.4 }), { points: 30 }).find(
		(b) => b.name === "CPU",
	);
	assert.ok(cpu);
	const texts = (cpu.titleInfo ?? []).map((s) => s.text);
	const joined = texts.join("");
	assert.ok(joined.includes("61°"), `rounded °C reading: ${JSON.stringify(joined)}`);
	assert.ok(
		joined.indexOf("61°") < joined.indexOf("1.23 4.56 7.89"),
		"the ° reading must come before the load averages",
	);
	assert.ok(
		joined.indexOf("61°") > joined.indexOf("37%"),
		"the ° reading must come after the usage%",
	);
});

test("buildBlocks: CPU title degrades usage → ° → load averages (atomic Σ-style ordering is not needed here)", () => {
	// The new default order means a mid-width block shows `37% 61°` while the
	// load averages yield — exactly the priority the user asked for. Sweep
	// block widths: whenever ° is present it must sit between the usage and
	// any surviving load segment, and never render a lone `% °`-without-values
	// fragment (each segment here is one piece, no atomic runs involved).
	const h = fakeHist(50);
	const cpu = buildBlocks(h, fakeSnap({ cpuTemp: 61 }), { points: 30 }).find(
		(b) => b.name === "CPU",
	);
	assert.ok(cpu);
	for (const bw of [20, 24, 26, 28, 32, 36, 40, 50, 60, 100]) {
		const lines = renderPanel(
			plainTheme,
			[cpu],
			bw,
			{ cols: 1, bands: 1, widths: [bw], plotRows: 4, totalRows: 8 },
			60,
		);
		const head = lines[0] ?? "";
		assert.ok(head.startsWith("┌") && head.endsWith("┐"), `bw=${bw}: border must close: ${JSON.stringify(head)}`);
		assert.equal(visibleWidth(head), bw, `bw=${bw}: title row width`);
		const hasDeg = head.includes("°");
		const hasLoad = head.includes("1.23");
		// ° outranks the loads: any width showing loads must also show °
		if (hasLoad) assert.ok(hasDeg, `bw=${bw}: loads without ° — wrong priority: ${JSON.stringify(head)}`);
	}
});

test("renderBlock: the `100°` secondary label lands at the plot area's top-right corner", () => {
	const h = fakeHist(50);
	const cpu = buildBlocks(h, fakeSnap(), { points: 30 }).find((b) => b.name === "CPU");
	assert.ok(cpu);
	const W = 50;
	const plotRows = 6;
	const lines = renderPanel(
		plainTheme,
		[cpu],
		W,
		{ cols: 1, bands: 1, widths: [W], plotRows, totalRows: plotRows + BLOCK_CHROME_ROWS },
		60,
	);
	// Top plot row = lines[1] (after the title row). The label must sit flush
	// against the right border: `100°`'s last column is w-2 (border at w-1).
	const top = lines[1] ?? "";
	const at = (i: number) => top[i];
	assert.equal(at(W - 1), "│", "right border column");
	assert.ok(top.endsWith("100°│"), `label flush against the right border: ${JSON.stringify(top)}`);
	// The left tick (`100%`) must still be there — the two scales coexist.
	assert.ok(top.includes("100%"), `left tick present: ${JSON.stringify(top)}`);
	// The temperature curve is drawn in the error colour: with wave(58,12,9)
	// data the red line must exist somewhere in the plot area.
	const ansiLines = renderPanel(
		ansiTheme,
		[cpu],
		W,
		{ cols: 1, bands: 1, widths: [W], plotRows, totalRows: plotRows + BLOCK_CHROME_ROWS },
		60,
	);
	const plot = ansiLines.slice(1, 1 + plotRows).join("\n");
	assert.ok(
			plot.includes("\x1b[31m"),
			"the red temperature curve must be drawn somewhere in the plot area",
		);
});

test("renderBlock: y-tick colors are bound to the curves (left = series[0], right = the last series)", () => {
	// Uniform grey ticks gave no clue which scale belonged to which line once a
	// block carried two curves (CPU% + temp, TPS + hit rate): `100%` and `100°`
	// looked like one and the same axis. The rule pinned here:
	//   · the LEFT tick column wears the **primary** curve's effective color
	//     (`series[0].color`, else the block's main color);
	//   · the RIGHT axis label wears the **last** curve's effective color;
	//   · the neutral `muted` survives only as the no-series fallback and for the
	//     x-axis time labels (they belong to no curve).
	const h = fakeHist(50);
	const cpu = buildBlocks(h, fakeSnap(), { points: 30 }).find((b) => b.name === "CPU");
	assert.ok(cpu);
	// The CPU block's own color wiring is the premise of this test, so pin it
	// here: series[0] = CPU% (no color ⇒ inherits the block's `success`),
	// series[1] = package temperature with an explicit `error`.
	assert.equal(cpu.series[0]?.color, undefined, "CPU% inherits the block color");
	assert.equal(cpu.series[1]?.color, "error", "temp carries an explicit red");
	assert.equal(cpu.color, "success");
	const W = 50;
	const plotRows = 6;
	const layout = {
		cols: 1,
		bands: 1,
		widths: [W],
		plotRows,
		totalRows: plotRows + BLOCK_CHROME_ROWS,
	};
	const lines = renderPanel(ansiTheme, [cpu], W, layout, 60);
	const top = lines[1] ?? "";
	// Position is unchanged (existing tests pin `│100%…100°│`); only the color moved.
	assert.ok(top.startsWith("\x1b[90m│\x1b[0m\x1b[32m100%\x1b[0m"), `left tick must wear the CPU% color (success/green): ${JSON.stringify(top)}`);
	assert.ok(
		top.includes("\x1b[31m100°\x1b[0m\x1b[90m│\x1b[0m"),
		`right label must wear the temp color (error/red): ${JSON.stringify(top)}`,
	);
	// The x-axis time labels are NOT bound to a curve: they stay neutral.
	const bottom = lines.at(-1) ?? "";
	assert.ok(
		bottom.includes("\x1b[90m60s\x1b[0m") && bottom.includes("\x1b[90m0s\x1b[0m"),
		`time labels stay muted: ${JSON.stringify(bottom)}`,
	);

	// Generic rule on synthetic blocks (the CPU case alone can't tell "last
	// series' color" apart from "series[1]"): series[0] has its own color, the
	// right label follows the LAST series — not series[0], not the block color.
	const vals = Array.from({ length: 30 }, (_, i) => 40 + 20 * Math.sin(i / 3));
	const mk = (over: Partial<MetricBlock>): MetricBlock => ({
		name: "X",
		color: "warning",
		series: [
			{ values: vals, color: "accent" },
			{ values: vals, color: "text", excludeFromScale: true },
		],
		rightAxisLabel: "100°",
		axis: () => percentAxis(),
		...over,
	});
	const synth = (over: Partial<MetricBlock>): string =>
		renderPanel(ansiTheme, [mk(over)], W, layout, 60)[1] ?? "";
	const explicit = synth({});
	assert.ok(
		explicit.includes("\x1b[36m100%\x1b[0m") && explicit.includes("\x1b[37m100°\x1b[0m"),
		`series colors win over the block color on both ends: ${JSON.stringify(explicit)}`,
	);
	// No per-series color anywhere ⇒ both ends fall back to the block's main color.
	const inherited = synth({
		series: [
			{ values: vals },
			{ values: vals, excludeFromScale: true },
		],
	});
	assert.ok(
		inherited.includes("\x1b[33m100%\x1b[0m") && inherited.includes("\x1b[33m100°\x1b[0m"),
		`both ends inherit the block color when the series have none: ${JSON.stringify(inherited)}`,
	);
	// No series at all (a data-less block): keep the neutral tick color.
	const bare = synth({ series: [] });
	assert.ok(
		bare.includes("\x1b[90m100%\x1b[0m") && bare.includes("\x1b[90m100°\x1b[0m"),
		`no series ⇒ neutral ticks: ${JSON.stringify(bare)}`,
	);
});

test("renderBlock: the `100°` label dodges the floating legend box instead of hiding under it", () => {
	// labelMode=box: the floating box is painted over the plot area's top-right
	// corner — the exact spot the `100°` label wants. The label must hug the
	// box's LEFT edge on the same row (never under it, never dropped):
	// `│100%          100° ┌───────┐│`.
	// This also pins the `plotTop` fix: the box's top border must sit on the
	// FIRST PLOT ROW, not on the title row (the old plotTop=0 overlaid it onto
	// the title, masked by the title's own ┌/┐ corners).
	const h = fakeHist(50);
	const cpu = buildBlocks(h, fakeSnap(), { points: 30, labelMode: "box" }).find(
		(b) => b.name === "CPU",
	);
	assert.ok(cpu);
	const W = 50;
	const plotRows = 6;
	const lines = renderPanel(
		plainTheme,
		[cpu],
		W,
		{ cols: 1, bands: 1, widths: [W], plotRows, totalRows: plotRows + BLOCK_CHROME_ROWS },
		60,
	);
	// The box top border ┌…┐ is on the first plot row (lines[1]), NOT on the title row.
	const title = lines[0] ?? "";
	const firstPlot = lines[1] ?? "";
	assert.ok(
		!/┌─+┐/.test(title.replace("┌ CPU", "")),
		`the legend box top border must not invade the title row: ${JSON.stringify(title)}`,
	);
	assert.ok(firstPlot.includes("┌") && lines[2]?.includes("AVG"), `the box top is on the first plot row and the body on the second: ${JSON.stringify(firstPlot)}`);
	// The label is present, to the LEFT of the box, on the same row as the box top.
	const li = firstPlot.indexOf("100°");
	const bi = firstPlot.indexOf("┌");
	assert.ok(li >= 0, `100° must be drawn: ${JSON.stringify(firstPlot)}`);
	assert.ok(
			bi > li && bi - (li + 4) >= 1,
			`100° must sit left of the box with a gap: ${JSON.stringify(firstPlot)}`,
	);
	// …and the left percent tick still leads the row.
	assert.ok(firstPlot.startsWith("│100%"), `left tick present: ${JSON.stringify(firstPlot)}`);
});

test("renderBlock: the `100°` label is dropped when the block is too narrow (never overflows)", () => {
	// The right-label guard requires room for the left tick + the label + a
	// 2-column gap. Below that the label must be **absent** — a cramped
	// `100%100°` mashup is worse than no secondary scale, and an overflowing
	// row crashes pi outright.
	const h = fakeHist(50);
	for (let w = 6; w <= 40; w++) {
		const cpu = buildBlocks(h, fakeSnap(), { points: 30 }).find((b) => b.name === "CPU");
		assert.ok(cpu);
		const lines = renderPanel(
			plainTheme,
			[cpu],
			w,
			{ cols: 1, bands: 1, widths: [w], plotRows: 4, totalRows: 4 + BLOCK_CHROME_ROWS },
			60,
		);
		for (const l of lines) assert.ok(visibleWidth(l) <= w, `w=${w}: ${JSON.stringify(l)}`);
		// `100°` never appears glued to the left tick; when present it must
		// have at least 2 columns of separation from the left tick region.
		const top = lines[1] ?? "";
		const li = top.indexOf("100%");
		const ri = top.indexOf("100°");
		if (ri >= 0) {
			assert.ok(li >= 0, `w=${w}: right label without left tick`);
			assert.ok(
				ri - (li + 4) >= 2,
				`w=${w}: right label too close to the left tick: ${JSON.stringify(top)}`,
			);
		}
	}
});

test("renderBlock: a hot CPU (>100°C) clamps to the top without stretching the % axis or lying a `+`", () => {
	// The two excludeFromScale guarantees, at render level:
	//  ① the % axis stays 100.5 (a 105°C reading must not stretch it);
	//  ② the overflow detector skips the excluded series, so the `100%` tick
	//     carries no `+` (the temperature curve's own ceiling semantics: pinned
	//     to the top = "at or above 100°C").
	const n = 50;
	const h = fakeHist(n);
	h.cpuTemp = new Array(n).fill(105); // sustained >100°C
	const cpu = buildBlocks(h, fakeSnap({ cpuTemp: 105 }), { points: 30 }).find(
		(b) => b.name === "CPU",
	);
	assert.ok(cpu);
	// Scale: derive dataMax the same way renderBlock does (excluded series skipped).
	let dataMax = 0;
	for (const s of cpu.series) {
		if (s.excludeFromScale) continue;
		for (const v of s.values) if (Number.isFinite(v) && v > dataMax) dataMax = v;
	}
	assert.equal(cpu.axis(dataMax, 4).max, 100.5, "a 105°C reading must not stretch the % axis");
	// Render: no `+` on the top tick, exact widths everywhere.
	const W = 50;
	const lines = renderPanel(
		plainTheme,
		[cpu],
		W,
		{ cols: 1, bands: 1, widths: [W], plotRows: 6, totalRows: 6 + BLOCK_CHROME_ROWS },
		60,
	);
	assert.ok(lines.length > 0);
	for (const line of lines)
		assert.equal(visibleWidth(line), W, `line wider than ${W}: ${JSON.stringify(line)}`);
	const topRow = lines[1] ?? "";
	assert.ok(!topRow.includes("100%+"), `no overflow marker on the tick: ${JSON.stringify(topRow)}`);
});

test("buildBlocks: without cache reads the Tokens block stays single-curve and has no ·/⌀ segments", () => {
	// This is the pre-existing behaviour for a session that never touches the
	// prompt cache: no second curve, no hit-rate readouts. `tokR === 0` is the
	// single gate for all three (`seenCache`), so this test pins the whole
	// degradation path.
	const h = fakeHist(50);
	const tok = buildBlocks(h, fakeSnap(), {
		points: 30,
		tpsNow: 250,
		tokensIn: 5671,
		tokensOut: 11,
		tokensCacheRead: 0,
		hitNow: 88, // even a supplied reading must not leak through
	}).find((b) => b.name === "Tokens");
	assert.ok(tok);
	assert.equal(tok.series.length, 1, "no cache reads ⇒ single curve");
	const title = (tok.titleInfo ?? []).map((s) => s.text).join("");
	assert.ok(!title.includes("\u00b7"), `no · segment without cache reads: ${title}`);
	assert.ok(!title.includes("\u2300"), `no ⌀ segment without cache reads: ${title}`);
	assert.ok(!title.includes("R"), `no R readout without cache reads: ${title}`);
	// The other readings survive untouched (totals are footer-only now, so no
	// ↑/↓ in the widget default either)
	assert.ok(title.includes("~250t/s"), title);
});

test("buildBlocks: Tokens title segments are ordered rate → ◔ → · → ⌀ → ↑ → ↓ → R", () => {
	// Segment order **is** the degradation policy (the title bar accumulates
	// unit by unit and drops the tail), so the order must be asserted
	// directly, not inferred from the narrow-width cases. Footer mode
	// (showTokenTotals) covers the full chain; the widget default is the same
	// list minus the trailing ↑/↓/R.
	// The ◔ context-usage segment is the **second** slot (user-requested
	// default): the reading order on this block is rate → context → hits.
	const mk = (over: Partial<BlockOptions> = {}) =>
		buildBlocks(fakeHist(50), fakeSnap(), {
			points: 30,
			tpsNow: 250,
			tokensIn: 5671,
			tokensOut: 11,
			tokensCacheRead: 640,
			hitNow: 88,
			ctxPct: 42,
			...over,
		}).find((b) => b.name === "Tokens");
	const segs = mk({ showTokenTotals: true })?.titleInfo ?? [];
	const texts = segs.map((s) => s.text);
	// Exact sequence (the leading spaces belong to the segment they precede)
	assert.deepEqual(texts, [
		"~250t/s",
		" \u25d442%",
		" \u00b788%",
		" \u230010%",
		"  \u21915.7k",
		" \u219311",
		" R640",
	]);
	// …and with the colors that let the two modes be cross-checked
	assert.deepEqual(
		segs.map((s) => s.color),
		["accent", "muted", "success", "warning", "muted", "muted", "muted"],
	);
	// The cumulative rate is recomputed from the running totals: 640 / (640+5671)
	const cum = (640 / (640 + 5671)) * 100; // ≈10.14 → 10%
	assert.equal(texts[3], ` \u2300${Math.round(cum)}%`);
	// Widget default: same head, no totals
	assert.deepEqual(
		(mk()?.titleInfo ?? []).map((s) => s.text),
		["~250t/s", " \u25d442%", " \u00b788%", " \u230010%"],
	);
});

test("Tokens readings stay visible at minimum block width (regression)", () => {
	// A bug we measured: with the spelled-out unit `~12.3K tok/s` (12 cols),
	// roomForInfo was only 10 cols at the narrowest 4-up block width (24 cols),
	// so **the entire reading vanished**, leaving only
	// `┌ Tokens ────────────┐` on screen.
	// It triggers at rate ≥1000 tok/s (`~635 tok/s` happens to be exactly 10
	// cols, just lucky).
	const h = fakeHist(50);
	for (const tpsNow of [635, 12345, 999999]) {
		const blocks = buildBlocks(h, fakeSnap(), {
			points: 30,
			tpsNow,
			tokensIn: 5671,
			tokensOut: 11,
			tokensCacheRead: 640,
		});
		const lines = renderPanel(
			plainTheme,
			blocks,
			96,
			computeLayout(96, 6, 4, 18),
			60,
		);
		const head = lines[0] ?? "";
		assert.ok(head.includes("Tokens"), head);
		// The title bar must show the current rate reading (with `~`), not an empty box
		assert.ok(
			head.includes("~") && head.includes("t/s"),
			`with tpsNow=${tpsNow} the reading must not vanish: ${JSON.stringify(head)}`,
		);
	}
});

test("rateAxis: label width is always 5 — neither ragged nor jittering the plot area's left edge frame by frame", () => {
	// This watches two real measured problems (raised by the oracle advisor's
	// gutter-jitter concern):
	//  1. "Ragged within one frame": when `scaled*1.5` crosses 1000 the label
	//     gains a digit over the others (dataMax=670 → `1005.0` is 6 columns,
	//     the rest are 5).
	//  2. "Frame-to-frame jitter": `renderBlock` takes the gutter from the
	//     "longest label", so as the network peak fluctuates around 670 the
	//     plot area's left edge jumps one column per frame.
	// Both were fixed by fit()'s "drop precision instead of truncating": all
	// labels must be exactly 5 columns.
	const bad: string[] = [];
	for (let e = 0; e <= 15; e++) {
		for (const m of [1, 1.5, 6.7, 9.99, 2.5, 5, 8.8, 670, 999]) {
			const dm = m * 10 ** e;
			if (!Number.isFinite(dm)) continue;
			for (const l of rateAxis(dm).labels)
				if (l.length !== RATE_GUTTER) bad.push(`dm=${dm} -> ${JSON.stringify(l)}`);
		}
	}
	assert.deepEqual(bad, [], `found labels whose width isn't ${RATE_GUTTER}`);

	// Key regression: 600..800 is the range that used to jitter (the 1005/1020
	// digit crossing)
	const widths = new Set<number>();
	for (let dm = 600; dm <= 800; dm++)
		for (const l of rateAxis(dm).labels) widths.add(l.length);
	assert.deepEqual(
		[...widths],
		[RATE_GUTTER],
		"gutter width changed somewhere in the 600..800 range",
	);

	// Normalization must "drop precision", not "truncate": no mangled strings
	// like `1005.`
	for (const dm of [670, 680, 999]) {
		for (const l of rateAxis(dm).labels) {
			assert.ok(!l.trimEnd().endsWith("."), `truncation artifact found: ${JSON.stringify(l)}`);
		}
	}
});

/* ------------------------------------------------------------------ */
/* X-axis time window (a bug where it used to drift with terminal width) */
/* ------------------------------------------------------------------ */

test("auto range: with an explicit sub-window, a fallen spike is marked `+` (regression)", () => {
	// The user asked: "why did the network chart peak at 10MB/s in the middle,
	// and a while later the maximum becomes a few hundred KB again, before the
	// 10MB even had time to leave the time window".
	//
	// This is the **inevitable side effect** of auto fall-back (the previous
	// test): the range only looks at the most recent 1/6 window, so ~10s after
	// the spike the range has fallen back, yet the spike **is still in the 60s
	// display window**.
	// Values beyond the range get clamped to the top when drawing (braille's
	// `Math.min(top, raw)`), turning the spike into a line that slams the
	// ceiling.
	//
	// If the top tick isn't marked, a reader would think "the peak is only a
	// few hundred KB" while there's plainly a ceiling-slamming spike on screen
	// — the tick would be lying.
	// So on overflow the top tick gets a `+` (read as "at least this much").
	//
	// Note: with the default scale window == display window there can be no
	// overflow, so `+` can only appear when a **sub-window is explicitly
	// enabled** (`PI_SYSMON_SCALE_WINDOW<1`); the cases below all pass it
	// explicitly.
	const POINTS = 60;
	const SPIKE = 10 * 1024 * 1024;
	// age=25: the spike happened 25s ago, **still inside the 60s window**, but
	// already outside the 10s scale window
	// `sessHit: []` on purpose: these Network-focused fixtures carry no cache
	// history, so `buildBlocks` sees `tokR === 0` and the Tokens block stays
	// single-curve (exactly the shape the real session has before it has read
	// anything from the prompt cache).
	const mk = (age: number): History => {
		const h: History = {
			cpu: [],
			cpuTemp: [],
			mem: [],
			procRss: [],
			netRx: [],
			netTx: [],
			diskR: [],
			diskW: [],
			tps: [],
			sessHit: [],
		};
		for (let i = 0; i < POINTS; i++) {
			const a = POINTS - 1 - i;
			h.cpu.push(5);
			h.mem.push(50);
			h.netTx.push(0);
			h.netRx.push(a === age ? SPIKE : 200_000);
		}
		return h;
	};
	const label = (age: number): string => {
		// Explicit opt-in to the sub-window: only this way can we build the
		// overflow scenario "spike still in the display window but beyond the
		// scale window" (with the default scale window == display window,
		// overflow is impossible).
		const net = buildBlocks(mk(age), fakeSnap(), {
			points: POINTS,
			scaleWindowFrac: DEFAULT_SCALE_WINDOW_FRAC_OPT_IN,
		}).find((b) => b.name === "Network");
		const lines = renderPanel(
			plainTheme,
			[net!],
			56,
			computeLayout(56, 6, 1, 18),
			60,
		);
		// Must slice the tick out at a **fixed width**, not trim:
		// `rateAxis` labels are right-aligned fixed-width (`" 15MB"` has leading
		// spaces) — trim would eat the leading spaces and the width check would
		// be off.
		// And the curve is overprinted on the same row, so we can only cut the
		// tick columns.
		return (lines[1] ?? "").slice(1, 1 + RATE_GUTTER);
	};
	// Spike just happened: the range hasn't fallen back yet and still covers it → **no** `+`
	assert.ok(
		!label(0).trim().endsWith("+"),
		`at the moment of the spike there should be no +: ${JSON.stringify(label(0))}`,
	);
	// Spike has slid out of the scale window but is still in the display
	// window: the range can't cover it → **must** mark `+`
	for (const age of [20, 25, 40, 59]) {
		const l = label(age);
		assert.ok(
			l.trim().endsWith("+"),
			`when the spike is ${age}s old (still in the window but beyond the scale window) the top tick should be marked +, got: ${JSON.stringify(l)}`,
		);
		// Key: `+` **replaces** the last character, it's not appended — the label
		// width must not change, otherwise the overprint width varies per frame
		// and the plot area's left edge jumps one column with it (pitfall 6).
		assert.equal(
			l.length,
			RATE_GUTTER,
			`after adding + it must still occupy ${RATE_GUTTER} columns, got: ${JSON.stringify(l)}`,
		);
	}
});

test("parsePlacement: defaults to below (belowEditor), only explicit 'above' goes back up", () => {
	// pi's official `setWidget(key, content, { placement })` supports
	// "aboveEditor" / "belowEditor" (since 0.8x, see dist/core/extensions/types.d.ts).
	// Here we only parse the env var: lenient values, no errors on bad config.
	//
	// **Default = belowEditor** (user-specified: charts go below the input box).
	// So the default and every invalid value fall back to below; only words
	// explicitly saying "above" go up.
	for (const v of [
		undefined,
		"",
		"below",
		"BELOW",
		" below ",
		"belowEditor",
		"bottom",
		"随便",
		"0",
	])
		assert.equal(
			parsePlacement(v),
			"belowEditor",
			`${JSON.stringify(v)} should parse/fall back to below`,
		);
	// Only values that clearly mean "above" go up (this was the development-time
	// default; the escape hatch for keeping the old look)
	for (const v of ["above", "ABOVE", " above ", "aboveEditor", "top"])
		assert.equal(parsePlacement(v), "aboveEditor", `"${v}" should parse to above`);
});

test("resolveWindow: 60s window by default, and **width-independent** (regression)", () => {
	// The old bug: the window was derived from "how many points fit in the plot
	// area" (plotWidthFor(blockW) * 2 / interval), so the same machine got
	// 52s/64s/84s/118s at 100/120/150/200 columns — the time scale changed with
	// the window size, incomparable across widths or machines. It's now fixed
	// to bottom's 60s.
	const base = { windowSecs: 60, intervalMs: 1000 };
	// Without passing available (simulating enough accumulated history): 60
	// points / 60s at any width
	for (const available of [60, 200, 5000]) {
		const w = resolveWindow({ ...base, available });
		assert.equal(w.points, 60, `available=${available}`);
		assert.equal(w.windowSecs, 60, `available=${available}`);
	}
	// The interface has no width parameter at all — that assertion is already
	// guaranteed by the type system; here we state the intent once more: the
	// time scale must not be a function of width.
	assert.equal(
		Object.keys(resolveWindow({ ...base }))
			.sort()
			.join(","),
		"points,windowSecs",
	);
});

test("resolveWindow: sampling interval and window are linked (points = seconds × 1000 / interval)", () => {
	// A 60s window needs 120 points at 500ms sampling; the larger the interval
	// the fewer points needed.
	assert.equal(resolveWindow({ windowSecs: 60, intervalMs: 500 }).points, 120);
	assert.equal(resolveWindow({ windowSecs: 60, intervalMs: 1000 }).points, 60);
	assert.equal(resolveWindow({ windowSecs: 60, intervalMs: 2000 }).points, 30);
	// Custom window
	assert.equal(resolveWindow({ windowSecs: 30, intervalMs: 1000 }).points, 30);
	assert.equal(resolveWindow({ windowSecs: 300, intervalMs: 1000 }).points, 300);
});

test("resolveWindow: window duration is fixed from the first second (doesn't shrink with accumulated history)", () => {
	// User feedback: "the time isn't fixed at 60s from the start".
	// This used to shrink the labels to the actual point count via
	// `min(points, available)`, giving `3s`/`14s`/`30s` — so the x-axis
	// duration kept changing during startup and nobody could compare "the
	// current stretch" with "a full window".
	// Now the tick is **always** the configured window length, while the data
	// grows in from the right proportional to time (positioned via
	// MetricBlock.windowPoints, one second of screen width stays constant).
	for (const available of [0, 1, 5, 14, 30, 59, 60, 200]) {
		const spec = resolveWindow({ windowSecs: 60, intervalMs: 1000, available });
		assert.equal(spec.points, 60, `available=${available}: point count should be fixed`);
		assert.equal(
			spec.windowSecs,
			60,
			`available=${available}: window duration must stay 60s (must not shrink to ${available}s)`,
		);
	}
	// Custom window likewise
	for (const available of [0, 3, 300]) {
		assert.equal(
			resolveWindow({ windowSecs: 300, intervalMs: 1000, available }).windowSecs,
			300,
		);
	}
});

test("resolveWindow: duration is derived from the actual point count (must not lie with PI_SYSMON_POINTS)", () => {
	// If it returned `windowSecs` directly, `PI_SYSMON_POINTS=200` would
	// falsely report `60s` — it's actually drawing 200 1-second samples = 200s.
	// So the duration must be derived from the point count.
	const spec = resolveWindow({
		windowSecs: 60,
		intervalMs: 1000,
		fixedPoints: 200,
		available: 500,
	});
	assert.equal(spec.points, 200);
	assert.equal(spec.windowSecs, 200, "200 1-second samples = 200s, must not report 60s");
	// Also correct with a different interval: 120 points × 500ms = 60s
	const fast = resolveWindow({ windowSecs: 60, intervalMs: 500 });
	assert.equal(fast.points, 120);
	assert.equal(fast.windowSecs, 60);
});

/* ------------------------------------------------------------------ */
/* Auto-range fall-back (user feedback: after the spike passes, the     */
/* height doesn't come back down)                                        */
/* ------------------------------------------------------------------ */

/** Get the y-tick text of a block at the top of a plot row */
function topTick(lines: string[]): number {
	const row = lines[1] ?? "";
	const seg = row.replace(/^│/, "").split("│")[0] ?? "";
	return Number.parseFloat(seg.trim());
}

test("auto range: by default (scale window == display window) the top tick never carries `+` (regression)", () => {
	// User request: "I don't need +, I just want to see where the maximum is,
	// and a 60s window".
	// I.e. y-axis top = the true maximum within these 60s. Then **overflow is
	// impossible**: the draw-time clamp (braille's `Math.min(top, raw)`)
	// naturally never triggers.
	//
	// This invariant pins two things together:
	//   default ratio == 1  AND  every height on the tick can be read directly
	//   (no "there's a spike on screen but the tick only reports a small value").
	assert.equal(DEFAULT_SCALE_WINDOW_FRAC, 1, "the default scale window must equal the display window");

	const POINTS = 60;
	const MB = 1024 * 1024;
	// Sweep all spike positions × several magnitudes: none should make the tick
	// carry `+``
	for (const age of [0, 1, 5, 10, 20, 35, 59]) {
		for (const mult of [2, 10, 50, 1000]) {
			const h: History = {
				cpu: [],
				cpuTemp: [],
				mem: [],
				procRss: [],
				netRx: [],
				netTx: [],
				diskR: [],
				diskW: [],
				tps: [],
				sessHit: [],
			};
			for (let i = 0; i < POINTS; i++) {
				const a = POINTS - 1 - i;
				h.cpu.push(5);
				h.mem.push(50);
				h.netTx.push(0);
				h.netRx.push(a === age ? mult * MB : 200_000);
			}
			const net = buildBlocks(h, fakeSnap(), { points: POINTS }).find(
				(b) => b.name === "Network",
			);
			const lines = renderPanel(
				plainTheme,
				[net!],
				56,
				computeLayout(56, 6, 1, 18),
				60,
			);
			// Slice the tick out at a **fixed width** (right-aligned fixed width with
			// leading spaces; the curve is overprinted on the same row)
			const tick = (lines[1] ?? "").slice(1, 1 + RATE_GUTTER);
			assert.ok(
				!tick.includes("+"),
				`at age=${age}s mult=${mult}× there should be no overflow marker: ${JSON.stringify(tick)}`,
			);
			assert.equal(tick.length, RATE_GUTTER);
		}
	}
});

test("auto range: the range falls back after the spike passes (regression)", () => {
	// User feedback: "when the maximum is large, even after the big value has
	// passed, the height stays that high and never shrinks, making later values
	// all look tiny".
	// Root cause: the range took the maximum of the **entire display window**,
	// so one spike pins it until that point scrolls out (a full 60 seconds for
	// a 60s window).
	// Fix: the range only looks at the **most recent scaleWindowPoints points**
	// (1/6 of the window by default).
	const hist = fakeHist(0) as unknown as History;
	hist.cpu = [];
	hist.mem = [];
	hist.netRx = [];
	hist.netTx = [];
	hist.diskR = [];
	hist.diskW = [];
	hist.tps = [];
	const push = (v: number) => {
		hist.netRx.push(v);
		hist.netTx.push(0);
		hist.cpu.push(10);
		hist.mem.push(50);
	};
	const POINTS = 60;
	const top = () => {
		// Explicit opt-in: auto fall-back is no longer the default (see
		// DEFAULT_SCALE_WINDOW_FRAC)
		const net = buildBlocks(hist, fakeSnap(), {
			points: POINTS,
			scaleWindowFrac: DEFAULT_SCALE_WINDOW_FRAC_OPT_IN,
		}).find((b) => b.name === "Network");
		assert.ok(net);
		return topTick(
			renderPanel(
				plainTheme,
				[net],
				64,
				{ cols: 1, bands: 1, widths: [64], plotRows: 4, totalRows: 8 },
				60,
			),
		);
	};

	for (let i = 0; i < 30; i++) push(1e6);
	const before = top();
	assert.ok(before < 3, `when calm the range should be small, got ${before}`);

	for (let i = 0; i < 3; i++) push(100e6);
	const during = top();
	assert.ok(during > 100, `during the burst the range should widen, got ${during}`);

	// 12 seconds after the burst (> the 10s scale window) → the range must fall back
	for (let i = 0; i < 12; i++) push(1e6);
	const after = top();
	assert.ok(
		after < during / 10,
		`12s after the spike the range should have fallen back substantially: during ${during} → now ${after}`,
	);
	// The fallen-back range should be in the same league as the calm one (the
	// baseline is readable again)
	assert.ok(after < 3, `insufficient fall-back (${after}), the baseline is still squashed`);
});

test("auto range: recovery time is fixed, independent of how long it's been running", () => {
	// A proportional scheme (scaleWindowFrac × current array length) makes the
	// scale window very short right after startup and longer later, so recovery
	// time wandered (measured 10s↔18s).
	// With absolute point counts derived from the **target window** it's stable.
	const POINTS = 60;
	const recoverSecs = (preFrames: number): number => {
		const hist: History = {
			cpu: [],
			cpuTemp: [],
			mem: [],
			procRss: [],
			netRx: [],
			netTx: [],
			diskR: [],
			diskW: [],
			tps: [],
			sessHit: [],
		};
		const push = (v: number) => {
			hist.netRx.push(v);
			hist.netTx.push(0);
			hist.cpu.push(10);
			hist.mem.push(50);
		};
		for (let i = 0; i < preFrames; i++) push(1e6);
		for (let i = 0; i < 3; i++) push(100e6);
		const top = () => {
			const net = buildBlocks(hist, fakeSnap(), {
				points: POINTS,
				scaleWindowFrac: DEFAULT_SCALE_WINDOW_FRAC_OPT_IN,
			}).find((b) => b.name === "Network");
			return topTick(
				renderPanel(
					plainTheme,
					[net!],
					64,
					{ cols: 1, bands: 1, widths: [64], plotRows: 4, totalRows: 8 },
					60,
				),
			);
		};
		for (let a = 1; a <= 30; a++) {
			push(1e6);
			if (top() < 5) return a;
		}
		return -1; // no fall-back within 30s (should not happen)
	};
	const results = [5, 20, 59, 60, 200].map(recoverSecs);
	assert.ok(
		results.every((r) => r > 0),
		`some case didn't fall back: ${results}`,
	);
	assert.deepEqual(
		[...new Set(results)].length,
		1,
		`recovery time should be fixed, got ${JSON.stringify(results)}`,
	);
});

test("auto range: percent charts are unaffected (range fixed 0..100)", () => {
	const blocks = buildBlocks(fakeHist(120), fakeSnap(), { points: 60 });
	const cpu = blocks.find((b) => b.name === "CPU");
	const mem = blocks.find((b) => b.name === "Memory");
	assert.equal(cpu?.scaleWindowPoints, undefined, "CPU must not set a scale window");
	assert.equal(mem?.scaleWindowPoints, undefined, "Memory must not set a scale window");
	assert.equal(cpu?.axis(999, 4).max, 100.5, "CPU range should be fixed");
	assert.equal(mem?.axis(999, 4).max, 100.5, "Memory range should be fixed");
	// Only rate charts set one
	for (const n of ["Network"]) {
		const b = blocks.find((x) => x.name === n);
		assert.ok((b?.scaleWindowPoints ?? 0) > 0, `${n} should have a scale window`);
	}
});

test("auto range: setting the window to the whole window (frac=1) reverts to the old behavior", () => {
	// Escape hatch: pass 1 to get the old "whole-window max" behavior back
	const hist = fakeHist(0) as unknown as History;
	hist.cpu = [];
	hist.mem = [];
	hist.netRx = [];
	hist.netTx = [];
	hist.diskR = [];
	hist.diskW = [];
	const push = (v: number) => {
		hist.netRx.push(v);
		hist.netTx.push(0);
		hist.cpu.push(10);
		hist.mem.push(50);
	};
	for (let i = 0; i < 30; i++) push(1e6);
	for (let i = 0; i < 3; i++) push(100e6);
	for (let i = 0; i < 12; i++) push(1e6);
	const topWith = (frac: number) => {
		const net = buildBlocks(hist, fakeSnap(), {
			points: 60,
			scaleWindowFrac: frac,
		}).find((b) => b.name === "Network");
		return topTick(
			renderPanel(
				plainTheme,
				[net!],
				64,
				{ cols: 1, bands: 1, widths: [64], plotRows: 4, totalRows: 8 },
				60,
			),
		);
	};
	// frac=1 → whole-window max, the spike is still inside the window → range stays large
	assert.ok(topWith(1) > 100, `frac=1 should keep the large range, got ${topWith(1)}`);
	// Default (1/6) → already fallen back
	assert.ok(topWith(1 / 6) < 3, `default should have fallen back, got ${topWith(1 / 6)}`);
});

test("auto range: fall-back is smooth, no single-frame whole-chart jumps (regression)", () => {
	// The first fix used a **hard window** (only the last N points, no
	// in-segment weighting), so on the frame the spike exited the segment the
	// range jumped straight from 143 to 1.4 (a measured 100× jump) — the chart
	// visibly snapped. That traded one bug for another.
	// Now segments stack a quadratic decay weight (new points 1 → segment tail
	// 0), making the decay continuous.
	const hist: History = {
		cpu: [],
		cpuTemp: [],
		mem: [],
		procRss: [],
		netRx: [],
		netTx: [],
		diskR: [],
		diskW: [],
		tps: [],
		sessHit: [],
	};
	const push = (v: number) => {
		hist.netRx.push(v);
		hist.netTx.push(0);
		hist.cpu.push(10);
		hist.mem.push(50);
	};
	const top = () => {
		const net = buildBlocks(hist, fakeSnap(), {
			points: 60,
			scaleWindowFrac: DEFAULT_SCALE_WINDOW_FRAC_OPT_IN,
		}).find((b) => b.name === "Network");
		return topTick(
			renderPanel(
				plainTheme,
				[net!],
				64,
				{ cols: 1, bands: 1, widths: [64], plotRows: 4, totalRows: 8 },
				60,
			),
		);
	};
	for (let i = 0; i < 35; i++) push(1e6);
	for (let i = 0; i < 3; i++) push(100e6);

	const trail: number[] = [];
	for (let a = 0; a < 14; a++) {
		if (a > 0) push(1e6);
		trail.push(top());
	}
	// Per-frame change shouldn't be "the whole chart snapping". Measure it by
	// **baseline height change** (that's what the user sees): the hard window
	// was 66 percentage points (jumping straight from 1% to 67%); the cubic
	// decay spreads the change over multiple frames, max ~44pp per frame —
	// visually a continuous zoom.
	// Note topTick's unit is MB/s while the baseline is 1MB/s, so
	// height% = 1/tick*100.
	const heights = trail.map((s) => (1 / s) * 100);
	for (let i = 1; i < heights.length; i++) {
		const d = Math.abs((heights[i] ?? 0) - (heights[i - 1] ?? 0));
		assert.ok(
			d < 55,
			`frame ${i}: baseline height jumps ${d.toFixed(0)} percentage points, close to the hard window's 66pp (should be smooth)`,
		);
	}
	// Key regression: never allow the hard window's 100x whole-chart jump
	for (let i = 1; i < trail.length; i++) {
		const prev = trail[i - 1] ?? 0;
		const cur = trail[i] ?? 0;
		if (prev <= 0 || cur <= 0) continue;
		const ratio = Math.max(prev / cur, cur / prev);
		assert.ok(
			ratio < 10,
			`frame ${i}: range jumps ${ratio.toFixed(1)}x, like a hard window (should fall back smoothly)`,
		);
	}
	// And it really did come down (not "smoothly staying high forever")
	assert.ok(
		(trail[trail.length - 1] ?? 1e9) < 5,
		`should finally fall back to a small range, got ${trail[trail.length - 1]}`,
	);
	// Monotonically non-increasing (the fall-back must not bounce)
	for (let i = 1; i < trail.length; i++) {
		assert.ok(
			(trail[i] ?? 0) <= (trail[i - 1] ?? 0) + 1e-9,
			`frame ${i}: range bounced back up: ${trail[i - 1]} → ${trail[i]}`,
		);
	}
});

/* ------------------------------------------------------------------ */
/* 5. Construction logic of blocks.ts                                   */
/* ------------------------------------------------------------------ */

test("buildBlocks: 4 blocks by default (incl. Tokens), 5 with showDisks, names stable", () => {
	const h = fakeHist(50);
	// Default combination = CPU/Memory/Network/Tokens (Tokens defaults on, see PI_SYSMON_TOKENS)
	assert.deepEqual(
		buildBlocks(h, fakeSnap(), { points: 30 }).map((b) => b.name),
		["CPU", "Memory", "Network", "Tokens"],
	);
	// Disks is the optional 5th block, appended last (doesn't shift the first four's indices)
	assert.deepEqual(
		buildBlocks(h, fakeSnap(), { points: 30, showDisks: true }).map(
			(b) => b.name,
		),
		["CPU", "Memory", "Network", "Tokens", "Disks"],
	);
	// Explicitly disabling Tokens should return to the old three-chart form
	assert.deepEqual(
		buildBlocks(h, fakeSnap(), { points: 30, showTokens: false }).map(
			(b) => b.name,
		),
		["CPU", "Memory", "Network"],
	);
});

test("buildBlocks: every block has at least one series; Network has two (RX/TX) with different colors", () => {
	const blocks = buildBlocks(fakeHist(50), fakeSnap(), { points: 30 });
	for (const b of blocks) assert.ok(b.series.length >= 1, `${b.name} has no series`);
	const net = blocks.find((b) => b.name === "Network");
	assert.equal(net?.series.length, 2);
	assert.notEqual(net?.series[0]?.color, net?.series[1]?.color);
});

test("buildBlocks: series length is capped by points (doesn't stuff the entire history in)", () => {
	const h = fakeHist(500);
	const blocks = buildBlocks(h, fakeSnap(), { points: 40 });
	for (const b of blocks)
		for (const s of b.series)
			assert.ok(s.values.length <= 40, `${b.name}: ${s.values.length}`);
});

test("buildBlocks: without a snapshot it doesn't crash and the structure is complete (prerequisite for constant row count)", () => {
	const blocks = buildBlocks(fakeHist(10), undefined, { points: 20 });
	// Default four blocks (incl. Tokens) — without a snapshot the row count
	// must be exactly the same as with a snapshot
	assert.equal(blocks.length, 4);
	for (const b of blocks) {
		assert.equal(b.titleInfo, undefined);
		assert.deepEqual(b.legend, []);
		assert.ok(b.axis(100, 4).labels.length >= 1);
	}
});

/**
 * Regression: renderBlock must also hold when the **declared width exactly
 * equals the actual grid column count**.
 * This watches the correspondence between "the row lengths joined in
 * renderPanel" and layout.widths — as soon as one block writes a single extra
 * character, the side-by-side join shifts the whole next block to the right.
 */
test("side-by-side join: each block contributes exactly layout.widths[i] columns", () => {
	const layout = computeLayout(150, 4, 4, 18);
	const widths = layout.widths;
	const blocks: MetricBlock[] = buildBlocks(fakeHist(120), fakeSnap(), {
		points: 80,
	});
	// Check directly that in the joined rows, block i's border column positions
	// match the cumulative widths
	const lines = renderPanel(plainTheme, blocks, 150, layout, 60);
	const border0 = lines[0] ?? "";
	let acc = 0;
	for (let i = 0; i < widths.length; i++) {
		const w = widths[i] ?? 0;
		// Each block's top border must start with ┌ and end with ┐ within its range
		assert.equal(border0[acc], "┌", `block ${i} start at ${acc}`);
		assert.equal(border0[acc + w - 1], "┐", `block ${i} end at ${acc + w - 1}`);
		acc += w;
	}
	assert.equal(acc, 150);
});

/* ------------------------------------------------------------------ */
/* 4c. Process RSS curve (second Memory curve, its own adaptive byte axis) */
/* ------------------------------------------------------------------ */

const memBlockOf = (h: History, snap: Snapshot | undefined, points = 30) => {
	const b = buildBlocks(h, snap, { points }).find((x) => x.name === "Memory");
	assert.ok(b, "the Memory block must always exist");
	return b;
};

/** Render exactly one block at a fixed width, the way `renderPanel` would */
const renderOne = (block: MetricBlock, w: number, plotRows = 6): string[] =>
	renderPanel(plainTheme, [block], w, {
		cols: 1,
		bands: 1,
		widths: [w],
		plotRows,
		totalRows: plotRows + BLOCK_CHROME_ROWS,
	}, 60);

test("rssAxisMax: window max × headroom, and 0 whenever there is no usable axis", () => {
	// The function is the whole reason the curve exists in a visible form, so its
	// contract is pinned directly rather than only through `buildBlocks`.
	const mb = 1024 ** 2;
	// No usable axis ⇒ exactly 0, never NaN/negative: the caller gates the whole
	// curve on `hasProc` and would otherwise draw a flat line at some garbage
	// scale. Garbage in the window must be *ignored* (`Infinity > max` is true, so
	// a missing `Number.isFinite` would let one bad sample define the axis).
	for (const [label, input] of [
		["empty", []],
		["all zero", [0, 0, 0]],
		["all NaN", [Number.NaN, Number.NaN]],
		["only Infinity", [Number.POSITIVE_INFINITY]],
		["only negatives", [-5, -1, -1e9]],
		["Infinity plus zeros", [Number.POSITIVE_INFINITY, 0]],
	] as const)
		assert.equal(rssAxisMax([...input]), 0, `${label} ⇒ no axis`);
	// Normal case: max × headroom, and the headroom is the rateAxis convention
	// (1.5) — that is what makes the mapped peak land at 2/3 height.
	assert.equal(RSS_AXIS_HEADROOM, 1.5, "same headroom as rateAxis/tokenAxis");
	assert.equal(rssAxisMax([700 * mb]), 700 * mb * RSS_AXIS_HEADROOM);
	assert.equal(rssAxisMax([300 * mb, 700 * mb, 650 * mb]), 700 * mb * RSS_AXIS_HEADROOM);
	// Garbage inside an otherwise usable window is skipped, not averaged in.
	assert.equal(
		rssAxisMax([300 * mb, Number.NaN, 700 * mb, Number.POSITIVE_INFINITY, -1]),
		700 * mb * RSS_AXIS_HEADROOM,
	);
	// The axis **follows the window**: it is not a per-machine constant. This is
	// the property the whole redesign rests on (a fixed 0..100% axis squeezed the
	// curve into one braille sub-row).
	assert.ok(
		rssAxisMax([900 * mb]) > rssAxisMax([100 * mb]),
		"a bigger window ⇒ a bigger axis top",
	);
	// A window whose max would overflow the multiply still cannot produce a
	// non-finite axis: `Infinity × 1.5` is `Infinity` and that reaches the
	// coordinate maths (ARCHITECTURE pitfall 4).
	assert.equal(
		rssAxisMax([Number.MAX_VALUE]),
		0,
		"a max that scales past the float range degrades to `no axis`",
	);
});

test("buildBlocks: Memory plots this process's RSS as a second (error) curve on its own adaptive byte axis", () => {
	// The decision, in one place:
	//  · index order — `renderChartGlyphs` gives a same-cell collision to the
	//    **lowest** index, so Memory% must be series[0] or the red RSS line would
	//    steal the % curve's cells and colour wherever the two cross;
	//  · colour — `error`, matching the `pi 706M` title segment and the
	//    right-hand scale label (the colour binding is what tells the two
	//    curves' scales apart);
	//  · `excludeFromScale` — see the render-level test (it is what keeps the
	//    `100%` tick free of a `+`);
	//  · the byte→axis mapping itself, computed live from `rssAxisMax(tail)`
	//    (never a hard-coded ratio, and **never `memTotal`** — v2 dropped the
	//    machine's RAM out of the mapping entirely).
	const h = fakeHist(50);
	const snap = fakeSnap();
	const mem = memBlockOf(h, snap);
	assert.equal(mem.series.length, 2, "with a live RSS reading there are two curves");
	assert.deepEqual(
		mem.series[0]?.values,
		h.mem.slice(-30),
		"series[0] must be Memory% (lowest index wins same-cell collisions)",
	);
	assert.equal(
		mem.series[0]?.color,
		undefined,
		"series[0] carries no color so it inherits the block's warning colour",
	);
	assert.equal(mem.series[1]?.color, "error", "series[1] is the red RSS line");
	assert.equal(
		mem.series[1]?.excludeFromScale,
		true,
		"the RSS line must be excluded from the y-scale and from overflow detection",
	);
	const rssTail = h.procRss.slice(-30);
	const axisTop = rssAxisMax(rssTail);
	assert.deepEqual(
		mem.series[1]?.values,
		rssTail.map((v) => (percentAxis().max * v) / axisTop),
		"the RSS bytes must be pre-mapped onto the percent axis via their own window max",
	);
	// The whole point of v2: the mapped peak is `axisMax / headroom` ⇒ ~2/3 of the
	// plot height, whatever the machine's RAM is. On the old fixed 0..100% axis the
	// same fixture mapped to `100 * rss / memTotal` ≈ 1.1, i.e. one braille
	// sub-row: a dead flat line at the baseline, which is what the user rejected.
	const peak = Math.max(...(mem.series[1]?.values ?? []));
	assert.ok(
		Math.abs(peak - percentAxis().max / RSS_AXIS_HEADROOM) < 1e-9,
		`the mapped peak sits at axisMax/headroom ≈ 67, got ${peak}`,
	);
	// The block's axis spec is untouched: `percentAxis()` is a **fixed** axis, and
	// that is exactly why the RSS curve has to be pre-mapped instead of getting a
	// second scale. Proving it means showing the argument is ignored — asserting
	// `max === 100.5` for one input would pass for any implementation that
	// happens to return 100.5 there.
	assert.deepEqual(
		mem.axis(0, 4),
		mem.axis(1e9, 4),
		"percentAxis ignores dataMax ⇒ the Memory scale cannot be redefined by the RSS curve",
	);
	assert.equal(mem.axis(1e9, 4).max, 100.5, "Memory range stays fixed at 100.5");
});

test("buildBlocks: the mapped RSS peak is ~67 whatever the machine's RAM is (the axis is not memTotal)", () => {
	// The v2 core property, stated as an equality between two wildly different
	// scenarios: 700MB on 16GB and 3GB on 128GB both map to the same peak, because
	// the axis top comes from the window's own maximum (× 1.5), not from `memTotal`.
	// Under v1 the two peaks differed by 2× (`100*700M/16G` vs `100*3G/128G`), and
	// both were sub-1% ⇒ invisible.
	const mb = 1024 ** 2;
	const gb = 1024 ** 3;
	const flat = (n: number, v: number) => new Array(n).fill(v);
	const histOf = (rss: number): History => ({
		cpu: flat(30, 20),
		cpuTemp: flat(30, 60),
		mem: flat(30, 45),
		procRss: flat(30, rss),
		netRx: flat(30, 1000),
		netTx: flat(30, 1000),
		diskR: flat(30, 1000),
		diskW: flat(30, 1000),
		tps: flat(30, 20),
		sessHit: flat(30, 60),
	});
	const peakOf = (rss: number, memTotal: number): number => {
		const mem = memBlockOf(histOf(rss), fakeSnap({ procRss: rss, memTotal }), 30);
		assert.equal(mem.series.length, 2, `rss=${rss}: the curve must be drawn`);
		return Math.max(...(mem.series[1]?.values ?? []));
	};
	const small = peakOf(700 * mb, 16 * gb);
	const big = peakOf(3 * gb, 128 * gb);
	assert.ok(Number.isFinite(small), `peak must be finite, got ${small}`);
	assert.ok(
		Math.abs(small - big) < 1e-9,
		`700MB/16G and 3GB/128G must map identically, got ${small} vs ${big}`,
	);
	assert.ok(
		Math.abs(small - percentAxis().max / RSS_AXIS_HEADROOM) < 1e-9,
		`and that shared peak is axisMax/headroom ≈ 67, got ${small}`,
	);
	// Cross-check against the v1 formula, which is what made the curve invisible:
	// on the same 16GB machine the old mapping put the peak at ~4.3 axis units out
	// of 100.5 — 4.3% of the plot height, i.e. ~1 braille sub-row out of 24 for a
	// 6-row plot, so the line sat on the baseline. The new peak is ~67, i.e. ~16
	// sub-rows: the same reading is now legible.
	const oldPeak = (100 * 700 * mb) / (16 * gb);
	assert.ok(oldPeak > 0 && oldPeak < 5, `precondition: v1 mapped to ~4.3 axis units, got ${oldPeak}`);
	assert.ok(
		small / oldPeak > 10,
		`the v2 peak must be an order of magnitude taller than v1's (${small} vs ${oldPeak})`,
	);
});

test("buildBlocks: no RSS reading ⇒ single-curve Memory block, no right-axis label (graceful degradation)", () => {
	// The gate is a **two**-condition AND, and each variant isolates exactly one leg
	// — a variant that flips two legs at once cannot tell you which leg died (that
	// is how the window-scan leg once went uncovered: the only variant that touched
	// it also killed the live frame, so removing the loop was 0-red).
	// ① kills the window scan **and** the live frame (the "nothing at all" case);
	// ② isolates `snap !== undefined`;
	// ③ isolates the live `snap.procRss` leg (window alive);
	// ④ isolates the window-scan leg (live frame alive, window all zeros);
	// ⑤ `memTotal: 0` — deliberately **not** a gate leg any more (v2 has no
	//    denominator); it is asserted in the opposite direction below.
	const noTitlePi = (mem: MetricBlock) => {
		const title = (mem.titleInfo ?? []).map((s) => s.text).join("");
		assert.ok(!title.includes("pi "), `no RSS segment in the title: ${JSON.stringify(title)}`);
	};

	// ① nothing anywhere: no window history, no live reading
	{
		const h = fakeHist(50);
		h.procRss = new Array(50).fill(0);
		const mem = memBlockOf(h, fakeSnap({ procRss: 0 }));
		assert.equal(mem.series.length, 1, "①no reading ⇒ no second curve");
		assert.equal(mem.rightAxisLabel, undefined, "①no reading ⇒ no byte-scale label");
		noTitlePi(mem);
	}
	// ② no snapshot at all (collection has not run / failed)
	{
		const mem = memBlockOf(fakeHist(50), undefined);
		assert.equal(mem.series.length, 1, "②no snapshot ⇒ single curve");
		assert.equal(mem.rightAxisLabel, undefined, "②no snapshot ⇒ no label");
		assert.equal(mem.titleInfo, undefined, "②no snapshot ⇒ no title readouts");
	}
	// ③ history looks alive but this frame has no live reading: don't draw a
	//    curve whose newest value is missing
	{
		const mem = memBlockOf(fakeHist(50), fakeSnap({ procRss: 0 }));
		assert.equal(mem.series.length, 1, "③stale window + dead sensor ⇒ single curve");
		assert.equal(mem.rightAxisLabel, undefined, "③no live reading ⇒ no label");
		noTitlePi(mem);
	}
	// ④ window is all zeros while this frame is live: the **window-scan** leg has
	//    to work on its own. Without it, "the newest value exists" would be taken
	//    as "there is history" and a curve would be drawn from an all-zero window
	//    (which `rssAxisMax` maps to `no usable axis` anyway — but the gate must not
	//    even ask it).
	{
		const h = fakeHist(50);
		h.procRss = new Array(50).fill(0);
		const mem = memBlockOf(h, fakeSnap()); // procRss is the live 700M
		assert.equal(
			mem.series.length,
			1,
			"④a zero-only window ⇒ no curve even with a live frame",
		);
		assert.equal(mem.rightAxisLabel, undefined, "④no >0 reading in the window ⇒ no label");
		// The title readout is gated **independently** (`snap.procRss` only), so it
		// survives here: a deliberate asymmetry, pinned so it cannot drift.
		const title = (mem.titleInfo ?? []).map((s) => s.text).join("");
		assert.ok(
			title.includes(`pi ${fmtBytes(fakeSnap().procRss)}`),
			`④the title readout only needs the live frame: ${JSON.stringify(title)}`,
		);
	}
	// ⑤ The live `snap.procRss` leg must reject non-finite garbage, not just 0
	//    (`procRss > 0` alone lets `Infinity` through, and `Infinity` in the gate
	//    means a scale the axis maths cannot express).
	for (const procRss of [Number.POSITIVE_INFINITY, Number.NaN]) {
		const mem = memBlockOf(fakeHist(50), fakeSnap({ procRss }));
		assert.equal(mem.series.length, 1, `⑤procRss=${procRss} ⇒ single curve`);
		assert.equal(mem.rightAxisLabel, undefined, `⑤procRss=${procRss} ⇒ no label`);
	}
	// ⑥ The **window** half of the gate: a window full of non-finite garbage while
	//    the live frame is healthy. The window question is answered by
	//    `rssAxisMax(rssTail) > 0` (which subsumes both `Number.isFinite` and
	//    `> 0`), so this pins that the gate reads the window at all — the leg
	//    that used to be a separate scan loop and was unfalsifiable next to it.
	//    `NaN` covers the comparison-silently-false direction, `Infinity` the
	//    silently-true one.
	for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
		const h = fakeHist(50);
		h.procRss = new Array(50).fill(bad);
		const mem = memBlockOf(h, fakeSnap()); // live procRss is the healthy 700M
		assert.equal(
			mem.series.length,
			1,
			`⑥window all ${bad} ⇒ no curve (the scan leg must reject non-finite values)`,
		);
		assert.equal(mem.rightAxisLabel, undefined, `⑥window all ${bad} ⇒ no label`);
	}
	// ⑦ A **finite but enormous** window value (`>= Number.MAX_VALUE / 1.5`): the
	//    one input where "some reading exists" and "the scale is expressible" give
	//    different answers, because `max * 1.5` overflows to `Infinity` and
	//    `rssAxisMax` then reports 0 = "no axis". Gating on the **axis** rather
	//    than on "a reading exists" is what keeps this from dividing by zero and
	//    emitting a series of `Infinity` points plus a `0B` scale label.
	for (const bad of [1.3e308, Number.MAX_VALUE]) {
		const h = fakeHist(50);
		h.procRss = new Array(50).fill(bad);
		const mem = memBlockOf(h, fakeSnap());
		assert.equal(mem.series.length, 1, `⑦window all ${bad} ⇒ no usable axis ⇒ no curve`);
		assert.equal(mem.rightAxisLabel, undefined, `⑦window all ${bad} ⇒ no 0B label`);
	}
});

test("buildBlocks: memTotal plays no part in the RSS gate — the curve survives any memory total (v2 behaviour flip)", () => {
	// This is the **behaviour flip** that v2's D4 mandates. Under v1 the mapping
	// needed `memTotal` as a denominator, so `memTotal: 0` suppressed the second
	// curve (and `100 * v / 0` would have been Infinity ⇒ NaN coordinates).
	// In v2 the axis top is the window's own max, so the machine's RAM is not an
	// input at all: a host where the memory total is unreadable (non-Linux, or a
	// failed `/proc/meminfo` read falling back to 0) still gets a perfectly
	// drawable RSS curve, and suppressing it there would be a regression.
	// Two-sided by construction: the same frame with a real `memTotal` must look
	// the same, and the Memory% curve must still be the (degenerate) 0% line.
	// The whole category is looped, not just `0`: v1 had a dedicated variant for
	// non-finite totals (`fmtBytes(Infinity)` degrades to `0B`), and dropping it
	// outright would leave the "write the label back to `fmtBytes(memTotal)`"
	// regression catchable only for the `0` input.
	const withTotal = memBlockOf(fakeHist(50), fakeSnap());
	for (const memTotal of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
		const h = fakeHist(50);
		h.mem = new Array(50).fill(0);
		const mem = memBlockOf(h, fakeSnap({ memTotal, memPct: 0 }));

		assert.equal(mem.series.length, 2, `memTotal=${memTotal} ⇒ the RSS curve still exists`);
		assert.equal(
			mem.rightAxisLabel,
			fmtBytes(rssAxisMax(h.procRss.slice(-30))).padStart(RSS_LABEL_W),
			`memTotal=${memTotal} ⇒ the byte-scale label still exists (it no longer reads memTotal)`,
		);
		assert.ok(mem.rightAxisLabel, `memTotal=${memTotal}: precondition for the assertion below`);
		assert.ok(
			// The label must not be the (absent) memory total: `fmtBytes(0)` and
			// `fmtBytes(Infinity)` are both `0B`, and a `0B` scale label would be the
			// exact nonsense v1's non-finite guard was avoiding — v2 must not
			// reintroduce it from the other direction.
			!mem.rightAxisLabel.includes("0B"),
			`a 0-byte scale label would be nonsense: ${JSON.stringify(mem.rightAxisLabel)}`,
		);
		// Nothing about the RSS curve depends on `memTotal`: identical label AND
		// identical mapped values with a real total vs no total.
		assert.deepEqual(
			mem.series[1]?.values,
			withTotal.series[1]?.values,
			`the RSS curve must be bit-identical with and without a memory total (${memTotal})`,
		);
		// The Memory% curve is 0 everywhere (no memory data on such a host), which is
		// the part that *does* depend on `memTotal` — the two curves' scales really did
		// come apart here, which is the point.
		assert.deepEqual(mem.series[0]?.values, new Array(30).fill(0), "Memory% is a flat 0 line");
	}
});

test("buildBlocks: per-point non-finite/negative RSS readings map to 0 instead of poisoning the curve", () => {
	// The gate decides whether there is a curve; this decides what the **points**
	// inside it are worth. A partially-bad window (one failed sample, a sentinel
	// `-1`, a `NaN` from a broken source) must map the bad points to the baseline,
	// never to `NaN`/`Infinity` — NaN coordinates are the road to out-of-bounds
	// crashes (ARCHITECTURE pitfall 4) and braille has no gap semantics to draw a
	// hole.
	//
	// The window is chosen so the guard is the only thing under test: `rssAxisMax`
	// ignores the bad points too, so without the guard a NaN would become a real
	// NaN **value** in the plotted series (it would not merely be scaled away).
	const mb = 1024 ** 2;
	const h = fakeHist(50);
	h.procRss = [0, Number.NaN, -5, 700 * mb, 0, Number.POSITIVE_INFINITY, 650 * mb, -1];
	const mem = memBlockOf(h, fakeSnap({ memTotal: 64 * 1024 ** 3 }));

	// A >0 reading exists in the window ⇒ the curve is drawn.
	assert.equal(mem.series.length, 2, "a window holding some >0 readings still draws the curve");
	const values = mem.series[1]?.values ?? [];
	assert.equal(values.length, h.procRss.length, "every window point survives into the curve");
	for (const [i, v] of values.entries()) {
		assert.ok(
			Number.isFinite(v),
			`point ${i} must be finite, got ${v} (input ${h.procRss[i]})`,
		);
		assert.ok(v >= 0, `point ${i} must not be negative, got ${v} (input ${h.procRss[i]})`);
	}
	// Two-sided: the bad points must land on **exactly 0**, and the good points
	// must keep their real mapped value — otherwise "everything is 0" would
	// satisfy the assertions above, and a guard that clamps the whole series
	// would look correct.
	const axisTop = rssAxisMax(h.procRss);
	assert.ok(axisTop > 0, "precondition: the window does have a usable axis");
	for (const [i, v] of h.procRss.entries()) {
		const expected = Number.isFinite(v) && v > 0 ? (percentAxis().max * v) / axisTop : 0;
		assert.equal(
			values[i],
			expected,
			`point ${i} (input ${v}) must map to ${expected}`,
		);
	}
	// At least one good point must be non-zero, or the loop above proves nothing
	// about "keeps its real value".
	assert.ok(
		values.some((v) => v > 0),
		"the usable readings must land above the baseline, not be flattened to 0",
	);
});

test("buildBlocks: the RSS sub-axis label is fmtBytes(rssAxisMax(tail)) — the axis top in bytes, not the current RSS", () => {
	// Semantics: the label says what the **top of the plot** represents for the red
	// curve (`1.2G` = window max × 1.5), exactly like the CPU block's `100°` says
	// what the top of that plot represents in °C. Using the current RSS here is the
	// classic reversal and would make the label meaningless as a scale readout —
	// and using `memTotal` is the v1 behaviour v2 removed (the axis stopped being
	// the machine's RAM).
	const snap = fakeSnap();
	const h = fakeHist(50);
	const axisTop = rssAxisMax(h.procRss.slice(-30));
	const mem = memBlockOf(h, snap);
	assert.equal(mem.rightAxisLabel, fmtBytes(axisTop).padStart(RSS_LABEL_W));
	assert.notEqual(
		mem.rightAxisLabel,
		fmtBytes(snap.procRss).padStart(RSS_LABEL_W),
		"the sub-axis is the axis top, not the current reading",
	);
	assert.notEqual(
		mem.rightAxisLabel,
		fmtBytes(snap.memTotal).padStart(RSS_LABEL_W),
		"the sub-axis is no longer the machine's RAM (that was v1)",
	);
	// Guards against a hard-coded literal that happens to match this fixture: a
	// different RSS shape must produce a different label.
	const otherHist = fakeHist(50);
	otherHist.procRss = new Array(50).fill(300 * 1024 ** 2);
	const other = memBlockOf(otherHist, fakeSnap({ procRss: 300 * 1024 ** 2 }));
	assert.equal(
		other.rightAxisLabel,
		fmtBytes(300 * 1024 ** 2 * RSS_AXIS_HEADROOM).padStart(RSS_LABEL_W),
	);
	assert.notEqual(other.rightAxisLabel, mem.rightAxisLabel, "the label follows the window");
});

test("buildBlocks: the RSS sub-axis label is a constant RSS_LABEL_W columns, including across the M→G carry", () => {
	// Why this is a test and not a comment: `fmtBytes` output width changes with the
	// value (`0B`=2, `75M`=3, `300M`=4, `1020M`=5, `1.0G`=4). The axis top climbs as
	// RSS grows and crosses exactly those boundaries, and `renderBlock` anchors the
	// label to the **right**, so an unpadded label's left edge jumps a column while
	// the axis crosses a boundary — visible flicker of both the text and the plot's
	// top-right corner (ARCHITECTURE pitfall 6). Sweeping a continuous range of axis
	// tops is the only way to actually cross the carries; a couple of spot values
	// can all happen to land on the same width.
	const mb = 1024 ** 2;
	const labelOf = (rss: number): string | undefined => {
		const h = fakeHist(50);
		h.procRss = new Array(50).fill(rss);
		// `memTotal` deliberately varied too: it must not appear anywhere in the label.
		return memBlockOf(h, fakeSnap({ procRss: rss, memTotal: 16 * 1024 ** 3 }))
			.rightAxisLabel;
	};

	// The explicit boundary pair the contract names: 680MB × 1.5 ≈ 1020M (5 cols,
	// no padding involved) vs 690MB × 1.5 ≈ 1.0G (4 cols ⇒ padding is what keeps
	// it at 5). Without `padStart` these two differ in length.
	const raw680 = fmtBytes(680 * mb * RSS_AXIS_HEADROOM);
	const raw690 = fmtBytes(690 * mb * RSS_AXIS_HEADROOM);
	assert.equal(raw680.length, RSS_LABEL_W, "precondition: the M-side label fills the field");
	assert.ok(
		raw690.length < RSS_LABEL_W,
		`precondition: the G-side label is narrower (${JSON.stringify(raw690)}), else padding is untested`,
	);
	assert.equal(labelOf(680 * mb)?.length, RSS_LABEL_W, "680MB ⇒ 5 columns");
	assert.equal(labelOf(690 * mb)?.length, RSS_LABEL_W, "690MB ⇒ 5 columns (padded)");

	// And the general property: every axis top in a wide sweep yields exactly
	// RSS_LABEL_W columns. The range is chosen to cross B→K→M→G carries (32KB..512GB
	// of RSS) so several unit changes are exercised, not just one.
	const rssValues: number[] = [];
	for (let e = 32 * 1024; e < 512 * 1024 ** 3; e *= 1.7) rssValues.push(e);
	assert.ok(rssValues.length >= 20, "precondition: the sweep crosses many carries");
	const seenWidths = new Set<number>();
	const seenUnits = new Set<string>();
	for (const rss of rssValues) {
		const label = labelOf(rss);
		assert.ok(label !== undefined, `rss=${rss}: a live curve must have a label`);
		assert.equal(
			label.length,
			RSS_LABEL_W,
			`rss=${rss} ⇒ label ${JSON.stringify(label)} is ${label.length} columns, not ${RSS_LABEL_W}`,
		);
		seenWidths.add(fmtBytes(rss * RSS_AXIS_HEADROOM).length);
		seenUnits.add(fmtBytes(rss * RSS_AXIS_HEADROOM).replace(/^[\d.]+/, ""));
	}
	// Positive control for the whole test: the **unpadded** widths really do vary
	// across this sweep, so "all 5" is a property of the padding and not of the
	// fixture happening to produce 5-column strings everywhere.
	assert.ok(
		seenWidths.size >= 2,
		`precondition: the raw fmtBytes widths must vary across the sweep (saw ${[...seenWidths].join("/")})`,
	);
	assert.ok(
		seenUnits.size >= 3,
		`precondition: the sweep must cross unit boundaries (saw ${[...seenUnits].join("/")})`,
	);
});

test("buildBlocks: the title bar carries `pi 700M` as the LAST segment (dropped first on narrow blocks)", () => {
	// Segment order **is** the degradation policy: `renderBlock` drops title
	// segments from the tail, so the RSS readout going last means a narrow block
	// loses it before it loses the memory percentage or the `33G/64G` pair.
	const snap = fakeSnap();
	const mem = memBlockOf(fakeHist(50), snap);
	const title = mem.titleInfo ?? [];
	assert.equal(title[0]?.text, "52%", "the percentage still leads");
	// `fmtBytes`-computed rather than a `33G\/64G` literal: a hard-coded string
	// only reproduces the fixture's current numbers, so the day `fakeSnap`
	// changes the failure would point at the wrong thing (D10's rule).
	assert.equal(
		title[1]?.text,
		`  ${fmtBytes(snap.memUsed)}/${fmtBytes(snap.memTotal)}`,
		"the used/total pair is still second",
	);
	const last = title.at(-1);
	assert.ok(last, "the title must have a tail segment");
	assert.equal(last.text, `  pi ${fmtBytes(snap.procRss)}`, "the RSS reading is the last segment");
	assert.equal(last.color, "error", "same colour as the curve it describes");
	assert.equal(last.atomic, undefined, "a single segment needs no atomic weld");
	// A non-finite live reading must not reach the title either: `fmtBytes` floors
	// every non-finite input to `0B`, so `procRss > 0` alone would print the very
	// `pi 0B` stub this segment promises never to render. Same predicate as line
	// mode (`Number.isFinite && > 0`), asserted here so the two modes can't drift.
	for (const procRss of [Number.POSITIVE_INFINITY, Number.NaN, -1]) {
		const t = (memBlockOf(fakeHist(50), fakeSnap({ procRss })).titleInfo ?? [])
			.map((s) => s.text)
			.join("");
		assert.ok(!t.includes("pi "), `procRss=${procRss}: no RSS segment: ${JSON.stringify(t)}`);
		assert.ok(!t.includes("0B"), `procRss=${procRss}: no \`pi 0B\` stub: ${JSON.stringify(t)}`);
	}
});

test("renderBlock: the RSS curve peaks at ~2/3 height and never trips the `+` marker (v2: no longer ceiling-hugging)", () => {
	// Under v1 this test was about a curve **pinned to the ceiling**
	// (`procRss === memTotal` ⇒ mapped 100). v2 changed the semantics: the axis top
	// is the window max × 1.5, so the mapped peak is always `100.5/1.5 ≈ 67` and a
	// curve that touches the top is not reachable by construction. The guarantees
	// worth pinning are therefore:
	//  ① `excludeFromScale`'s real job — the overflow detector skips the RSS series;
	//     kept as a two-sided probe below (a genuinely >100 % curve **must** paint
	//     `100+`, so the negative assertion is falsifiable);
	//  ② the peak really lands at ~2/3 of the axis for a realistic window, so the
	//     curve is *visible* — that is the whole point of the redesign;
	//  ③ neither dataMax nor the axis spec moves because of the RSS curve.
	const n = 50;

	// ① FIRST, because it is the only part of this test that can actually fail when
	// `excludeFromScale` is wrong. Two-sided by construction:
	//   · probe validity — a curve that is **not** excluded and really exceeds the
	//     axis MUST paint `100+`. Without this positive case the negative assertion
	//     is unfalsifiable: it passes on any implementation that never draws a `+`
	//     at all, including one whose flag does nothing (exactly the hole that
	//     `!includes("100%+")` left — the real marker is `100+`, since `renderBlock`
	//     replaces the label's **last** character);
	//   · the real case — the RSS curve, excluded, must not.
	const W = 50;

	const realOver = fakeHist(n);
	realOver.mem = new Array(n).fill(150); // the % curve itself, genuinely >100
	const realTop = renderOne(memBlockOf(realOver, fakeSnap()), W)[1] ?? "";
	assert.ok(
		realTop.includes("100+"),
		`probe validity: a real >100% reading must paint "100+": ${JSON.stringify(realTop)}`,
	);

	// The residual case that still matters: a pre-mapped value above the axis. v2
	// makes this unreachable from `buildBlocks` (the axis is derived from the same
	// window), but `chart-panel`'s `excludeFromScale` contract is generic, so the
	// flag is still the thing that keeps a stray value from lying a `+` onto the
	// `100%` tick. Reaching it here needs the values handed to the renderer
	// directly — which is the honest way to test the renderer's own guarantee.
	const mem = memBlockOf(fakeHist(n), fakeSnap());
	const over: MetricBlock = {
		...mem,
		series: [
			mem.series[0] as (typeof mem.series)[number],
			{ values: new Array(n).fill(150), color: "error", excludeFromScale: true },
		],
	};
	const overLines = renderOne(over, W);
	for (const line of overLines)
		assert.equal(visibleWidth(line), W, `over: line wider than ${W}: ${JSON.stringify(line)}`);
	const overTop = overLines[1] ?? "";
	assert.ok(
		!overTop.includes("100+"),
		`an excluded >axis reading must not trip the overflow marker: ${JSON.stringify(overTop)}`,
	);
	assert.ok(
		overTop.includes("100%"),
		`the top tick is still the percentage label: ${JSON.stringify(overTop)}`,
	);

	// ② A realistic window (the `fakeHist` 680±30MB shape, in bytes, on a 64GB
	// machine): the peak must be ~67 axis units, i.e. ~2/3 of the plot height, and
	// **not** hugging the ceiling — that difference is exactly what v2 was for.
	const h = fakeHist(n);
	const mem2 = memBlockOf(h, fakeSnap({ procRss: h.procRss.at(-1) ?? 0 }));
	const lines = renderOne(mem2, W);
	assert.ok(lines.length > 0);
	for (const line of lines)
		assert.equal(visibleWidth(line), W, `line wider than ${W}: ${JSON.stringify(line)}`);
	const topRow = lines[1] ?? "";
	assert.ok(topRow.includes("100%"), `the top tick must survive: ${JSON.stringify(topRow)}`);
	assert.ok(!topRow.includes("100+"), `no overflow marker on the tick: ${JSON.stringify(topRow)}`);
	const rssValues = mem2.series[1]?.values ?? [];
	const peak = Math.max(...rssValues);
	assert.ok(
		Math.abs(peak - percentAxis().max / RSS_AXIS_HEADROOM) < 1e-9,
		`the mapped peak must sit at ~67 (2/3 height), got ${peak}`,
	);
	assert.ok(
		peak < percentAxis().max * 0.9,
		`and must stay clear of the ceiling (got ${peak}), which is what keeps the "+" off the tick`,
	);

	// ③ dataMax the way `renderBlock` computes it (excluded series skipped): it
	// must be the memory percentages' max, NOT the RSS curve's contribution.
	let dataMax = 0;
	for (const s of mem2.series) {
		if (s.excludeFromScale) continue;
		for (const v of s.values) if (Number.isFinite(v) && v > dataMax) dataMax = v;
	}
	const memMax = Math.max(...h.mem.slice(-n));
	assert.equal(dataMax, memMax, "the RSS curve must not feed the y-scale");
	assert.ok(dataMax < 100, `precondition: the % curve stays below the ceiling (got ${dataMax})`);
	// Fixed-axis identity, not a claim about `excludeFromScale`: `percentAxis()`
	// returns the same spec whatever `dataMax` is, which is precisely why the
	// Memory scale cannot be stretched by anything. What a wrong
	// `excludeFromScale` would break is the `+` marker, tested above.
	assert.deepEqual(
		mem2.axis(dataMax, 4),
		mem2.axis(1e9, 4),
		"percentAxis is a fixed axis: dataMax cannot change the Memory scale",
	);
	assert.equal(mem2.axis(dataMax, 4).max, 100.5, "the memory axis stays fixed at 100.5");
});

test("renderBlock: the Memory right-axis label lands flush against the right border", () => {
	// The data-layer test above only proves the field is set; this proves it is
	// actually **painted** — `renderBlock` has a roomfulness guard that silently
	// skips the label on a narrow block, and the byte label must be reachable at
	// the widths real terminals have.
	const h = fakeHist(50);
	const mem = memBlockOf(h, fakeSnap());
	const expected = fmtBytes(rssAxisMax(h.procRss.slice(-30))).padStart(RSS_LABEL_W);
	assert.ok(
		expected.startsWith(" "),
		`precondition: this fixture's label is padded (${JSON.stringify(expected)}), else the trailing-space check below is vacuous`,
	);
	const W = 50;
	const lines = renderOne(mem, W);
	const topRow = lines[1] ?? "";
	assert.ok(
		topRow.endsWith(`${expected}│`),
		`the byte-scale label must hug the right border: ${JSON.stringify(topRow)}`,
	);
	// The padding must survive rendering: the label's **first column is a space**, so
	// the visible text is right-aligned inside a fixed field. Without `padStart` the
	// label would start one column further left and this would fail.
	assert.ok(
		topRow.includes(` ${expected.trim()}│`),
		`the padding must be preserved as leading blanks: ${JSON.stringify(topRow)}`,
	);
	assert.ok(topRow.includes("100%"), `the left percent tick is on the same row: ${JSON.stringify(topRow)}`);
});

test("sweep: extreme process RSS never overflows at any width (label width crosses unit carries)", () => {
	// The natural full-width sweep covers the `fakeHist` 680±30MB curve. This one
	// covers the values that make the geometry hardest: the right-hand byte label
	// competing with the left percent tick on the same row, with the label's own
	// (unpadded) width moving between 3 and 5 columns across the unit carries.
	// The magnitudes are chosen at carry boundaries (`680MB·1.5` = `1020M` is the
	// widest output, `690MB·1.5` = `1.0G` is narrower) plus extremes far beyond any
	// real machine, so a padding or gutter regression shows up as an overflow
	// rather than as a cosmetic drift.
	const mb = 1024 ** 2;
	const gb = 1024 ** 3;
	const ram = 64 * gb;
	for (const rss of [700 * mb, 680 * mb, 690 * mb, ram, 512 * gb]) {
		const hist = fakeHist(200);
		hist.procRss = new Array(200).fill(rss);
		const snap = fakeSnap({ procRss: rss });
		for (let w = 8; w <= 220; w++) {
			for (const chartH of [1, 3, 4, 6]) {
				for (const opts of [{}, { showDisks: true }] as const) {
					const blocks = buildBlocks(hist, snap, { points: 60, ...opts });
					const layout = computeLayout(w, chartH, blocks.length, 18);
					const points = Math.max(10, plotWidthFor(layout.widths[0] ?? w) * 2);
					const lines = renderPanel(ansiTheme, blocks, w, layout, (points * 1000) / 1000);
					const tag = `rss=${rss} ${JSON.stringify(opts)} count=${blocks.length}`;
					assert.equal(lines.length, layout.totalRows, `width=${w} chartH=${chartH} ${tag}`);
					for (const [i, line] of lines.entries()) {
						const lw = visibleWidth(line);
						assert.ok(
							lw <= w,
							`width=${w} chartH=${chartH} ${tag} line ${i}: ${lw} > ${w}`,
						);
					}
				}
			}
		}
	}
});

test("sweep: the Memory block really carries the second curve (guard against a silently un-covered sweep)", () => {
	// The full-width sweep's coverage of the new pixels depends **entirely** on
	// `fakeSnap()` carrying a `procRss`. Delete that one line from the fixture and
	// the sweep stays green while checking none of the RSS rendering — the exact
	// class of silent coverage loss this repo has hit before (see the comment on
	// the main sweep's `blocks.length` derivation). This test turns that failure
	// mode itself into a red light.
	//
	// `buildBlocks` does **not** take a width, so its output is identical for
	// every `w` (verified: the same two series and the same label each time).
	// `w` only enters at `renderPanel`, so the second half of the test renders the
	// two-curve block at several widths and asserts the two panel invariants that
	// would crash or misalign pi — no line wider than `w`, constant row count.
	// That is the part that actually depends on the width.
	for (const w of [8, 24, 48, 96, 150, 220]) {
		const hist = fakeHist(200);
		const mem = buildBlocks(hist, fakeSnap(), { points: 60 }).find((b) => b.name === "Memory");
		assert.ok(mem, "no Memory block");
		assert.equal(
			mem.series.length,
			2,
			`w=${w}: fakeSnap lost procRss ⇒ the full-width sweep stopped checking the new pixels`,
		);
		// The label is derived from the **visible window**, not from the fixture's
		// `memTotal`: computing the expectation here (rather than hard-coding `64G`)
		// is what makes this a guard on `rssAxisMax` rather than on a stale literal.
		assert.equal(
			mem.rightAxisLabel,
			fmtBytes(rssAxisMax(hist.procRss.slice(-60))).padStart(RSS_LABEL_W),
			`w=${w}: no byte-scale label ⇒ the sweep lost the right-label coverage`,
		);

		const plotRows = 6;
		const layout = {
			cols: 1,
			bands: 1,
			widths: [w],
			plotRows,
			totalRows: plotRows + BLOCK_CHROME_ROWS,
		};
		const lines = renderPanel(plainTheme, [mem], w, layout, 60);
		assert.equal(
			lines.length,
			layout.totalRows,
			`w=${w}: the two-curve block changed the row count (${lines.length} ≠ ${layout.totalRows})`,
		);
		for (const [i, line] of lines.entries())
			assert.equal(
				visibleWidth(line),
				w,
				`w=${w}: line ${i} is ${visibleWidth(line)} columns, not ${w}`,
			);
	}
});

/* ------------------------------------------------------------------ */
/* 4. line mode (/sysmon line): content + width hard constraints        */
/* ------------------------------------------------------------------ */

/** Join colored segments into plain text (dropping colors), for content assertions */
const segsText = (segs: StyledLine): string => segs.map((s) => s.text).join("");

test("plainLineSegs: includes token readouts (rate + session cumulative), same convention as the charts", () => {
	const segs = plainLineSegs(
		{
			snap: fakeSnap(),
			tpsNow: 1234,
			tokensIn: 5671,
			tokensOut: 89,
			tokensCacheRead: 2700,
			hitNow: 88,
		},
		200,
	);
	const text = segsText(segs);
	assert.match(text, /CPU 37%/);
	assert.match(text, /MEM 52%/);
	assert.match(text, /NET/);
	// The old implementation had no tokens at all — this is the regression guard
	assert.match(text, /TOK/);
	assert.match(text, /~1\.2Kt\/s/); // fmtTps(1234)
	// Widget default: no ↑/↓/R — pi's own footer right below already shows
	// those exact numbers, and duplicating them was pure noise.
	assert.doesNotMatch(text, /↑5\.7k/, "token ↑ must be off in widget line mode");
	assert.doesNotMatch(text, /↓89/);
	assert.doesNotMatch(text, /R2\.7k/);
	// (the NET group's own ↑/↓ network arrows are a different reading and may
	// stay — only the **token** totals were the duplicate)
	// Cache hit rates: `·` instantaneous then `⌀` cumulative — same characters,
	// same order, same colors as the Tokens chart's title bar, so the two modes
	// can be cross-checked.
	assert.match(text, /·88%/);
	// cumulative = 2700 / (2700 + 5671) = 32.2% → 32%
	assert.match(text, /⌀32%/);
	assert.ok(
		text.indexOf("·") < text.indexOf("⌀"),
		`· must precede ⌀: ${text}`,
	);
	// Colors match the chart title bar, so the two modes are cross-checkable
	// (and `⌀` carries the same warning color as the curve it describes).
	const colorOf = (needle: string): string | undefined =>
		segs.find((s) => s.text.includes(needle))?.color;
	assert.equal(colorOf("~"), "accent");
	assert.equal(colorOf("·"), "success");
	assert.equal(colorOf("⌀"), "warning");
});

test("plainLineSegs: the MEM RSS segment costs 8 columns, pushing the NET threshold from 69 to 77", () => {
	// The RSS readout is not free: `pi 700M` plus its leading space is 8 columns
	// inside the MEM group, and the whole line drops groups from the **tail**, so
	// the NET group — dropped last — needs a correspondingly wider terminal. This
	// is the user-visible price of the feature and it belongs in an assertion, not
	// just a comment: a comment rots, and the previous comment here did (it said
	// 71 cols when the line was 77).
	//
	// Measured on this fixture (`fakeSnap()` defaults + tpsNow=1234 / tokensIn=5671
	// / tokensOut=89 / tokensCacheRead=2700 / hitNow=88), sweeping w=1..400:
	//   procRss=0    → full line 69 cols, MEM@24, TOK@48, NET@69
	//   procRss=700M → full line 77 cols, MEM@32, TOK@56, NET@77
	// (MEM/TOK/NET are the first `w` at which each group appears.)
	const opts = (procRss: number) => ({
		snap: fakeSnap({ procRss }),
		tpsNow: 1234,
		tokensIn: 5671,
		tokensOut: 89,
		tokensCacheRead: 2700,
		hitNow: 88,
	});
	const widthAt = (o: ReturnType<typeof opts>, needle: RegExp): number => {
		for (let w = 1; w <= 400; w++)
			if (needle.test(segsText(plainLineSegs(o, w)))) return w;
		return -1;
	};
	const rss = 700 * 1024 ** 2;
	const withRss = opts(rss);
	const without = opts(0);

	// Use `visibleWidth`, not `.length`: the arrows/`·`/`⌀` are width 1 today, but
	// the whole point of this repo's width discipline is not to bet on that.
	assert.equal(visibleWidth(segsText(plainLineSegs(withRss, 400))), 77, "full line with RSS");
	assert.equal(visibleWidth(segsText(plainLineSegs(without, 400))), 69, "full line without RSS");
	assert.equal(widthAt(withRss, /MEM /), 32, "MEM appears at 32 cols with RSS");
	assert.equal(widthAt(withRss, /TOK /), 56, "TOK appears at 56 cols with RSS");
	assert.equal(widthAt(withRss, / NET /), 77, "NET appears at the full 77 cols");
	assert.equal(widthAt(without, /MEM /), 24, "MEM appears at 24 cols without RSS");
	assert.equal(widthAt(without, /TOK /), 48, "TOK appears at 48 cols without RSS");
	assert.equal(widthAt(without, / NET /), 69, "NET appears at 69 cols without RSS");

	// The pinned thresholds themselves: NET at the full width, gone one column
	// short. This is the assertion that reddens when the MEM group grows or
	// shrinks, which is exactly what happened here.
	assert.match(
		segsText(plainLineSegs(withRss, 77)),
		/ NET /,
		"NET must return at the full 77-column width",
	);
	assert.doesNotMatch(
		segsText(plainLineSegs(withRss, 76)),
		/ NET /,
		"NET must still be dropped at 76 columns",
	);
});

test("plainLineSegs: CPU group carries the temperature with the chart's color rule", () => {
	// Same reading and thresholds as the CPU chart title (`tempColor`), so the
	// two modes can be cross-checked.
	const colorOf = (segs: StyledLine, needle: string): string | undefined =>
		segs.find((s) => s.text.includes(needle))?.color;
	const warm = plainLineSegs({ snap: fakeSnap({ cpuTemp: 61.4 }) }, 200);
	assert.match(segsText(warm), /^CPU 37% 61°  MEM /);
	assert.equal(colorOf(warm, "61°"), "muted");
	const hot = plainLineSegs({ snap: fakeSnap({ cpuTemp: 80 }) }, 200);
	assert.equal(colorOf(hot, "80°"), "warning");
	const burning = plainLineSegs({ snap: fakeSnap({ cpuTemp: 95 }) }, 200);
	assert.equal(colorOf(burning, "95°"), "error");
	// No sensor (reads 0) or a non-finite reading: no `°` stub at all.
	for (const cpuTemp of [0, Number.NaN]) {
		const text = segsText(plainLineSegs({ snap: fakeSnap({ cpuTemp }) }, 200));
		assert.match(text, /^CPU 37%  MEM /, `cpuTemp=${cpuTemp}: ${text}`);
		assert.doesNotMatch(text, /°/);
	}
});

test("plainLineSegs: MEM group carries the process RSS (omitted when unknown)", () => {
	// Same reading, colour and omission rule as the Memory chart's title bar, so
	// the two modes can be cross-checked. It stays **inside** the MEM group: the
	// group count and the drop-from-tail order are load-bearing (MEM is group 2
	// of 4, TOK must outrank NET), and a group of its own would change which
	// readings survive a narrow terminal.
	const colorOf = (segs: StyledLine, needle: string): string | undefined =>
		segs.find((s) => s.text.includes(needle))?.color;
	const snap = fakeSnap();
	const segs = plainLineSegs({ snap }, 200);
	const text = segsText(segs);
	// Computed, not literal (`33G` / `700M`): see D10's "no hard-coded fmtBytes".
	assert.match(
		text,
		new RegExp(
			`^CPU 37% 61°  MEM 52% ${fmtBytes(snap.memUsed)} pi ${fmtBytes(snap.procRss)}`,
		),
	);
	assert.equal(colorOf(segs, "pi "), "error", "same colour as the RSS curve");
	// The MEM group is still **not** split: the RSS segment travels with its
	// group when the line narrows (never a dangling `pi 700M` without `MEM`).
	for (let w = 1; w <= 200; w++) {
		const t = segsText(plainLineSegs({ snap }, w));
		if (t.includes("pi ")) assert.match(t, /MEM /, `w=${w}: RSS without its MEM group: ${t}`);
	}
	// Unknown reading (0 / non-finite): no `pi 0B` noise at all.
	for (const procRss of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
		const t = segsText(plainLineSegs({ snap: fakeSnap({ procRss }) }, 200));
		assert.match(
			t,
			new RegExp(`^CPU 37% 61°  MEM 52% ${fmtBytes(snap.memUsed)}  TOK `),
			`procRss=${procRss}: ${t}`,
		);
		assert.doesNotMatch(t, /pi /, `procRss=${procRss}: ${t}`);
		assert.ok(
			!t.includes(fmtBytes(snap.procRss)),
			`procRss=${procRss}: the RSS byte count must not be on the line: ${t}`,
		);
		assert.doesNotMatch(t, /0B/, `procRss=${procRss}: a non-finite reading must not render: ${t}`);
	}
});

test("plainLineSegs: TOK group sits before NET, and NET is the group dropped first", () => {
	// Group order is CPU → MEM → TOK → NET. Whole groups are dropped from the
	// tail, so this single ordering decides which of the two survives a narrow
	// terminal: the token readout is far less recoverable from anywhere else on
	// screen than the network rate.
	const opts = {
		snap: fakeSnap(),
		tpsNow: 12345,
		tokensIn: 1234567,
		tokensOut: 987654,
		tokensCacheRead: 543210,
		hitNow: 88,
		ctxPct: 42,
	};
	// The MEM group now carries ` pi 700M` (8 more columns), so every group
	// threshold after it shifted right. Measured on **this** fixture
	// (`fakeSnap()` defaults + tpsNow=12345 / tokensIn=1234567 / tokensOut=987654 /
	// tokensCacheRead=543210 / hitNow=88 / ctxPct=42, sweeping w=1..400):
	//   TOK first appears at w=62, NET at w=83, and the complete line is exactly
	//   83 columns (`w=82` yields the 62-column TOK-only line). Without the RSS
	//   segment the same fixture is 8 columns shorter (75 / TOK at 54), which is
	//   the user-visible cost of the reading: on an 82-column terminal NET is
	//   gone where it used to fit.
	// The assertions below pin both numbers: a comment rots, an assertion does not.
	const fullWidth = visibleWidth(segsText(plainLineSegs(opts, 400)));
	assert.equal(fullWidth, 83, `the complete line is ${fullWidth} columns on this fixture`);
	assert.match(
		segsText(plainLineSegs(opts, fullWidth)),
		/ NET /,
		"NET must be present at the full width",
	);
	assert.doesNotMatch(
		segsText(plainLineSegs(opts, fullWidth - 1)),
		/ NET /,
		`NET must be gone one column short of the full width (${fullWidth - 1})`,
	);
	// 70 columns: TOK is in, NET is out
	const w70 = segsText(plainLineSegs(opts, 70));
	assert.match(w70, /TOK /, `TOK must survive at 70 cols: ${w70}`);
	assert.doesNotMatch(w70, /NET /, `NET should already be dropped at 70 cols: ${w70}`);
	// Wide enough for both: TOK comes first
	const wide = segsText(plainLineSegs(opts, 200));
	assert.ok(
		wide.indexOf("TOK ") < wide.indexOf("NET "),
		`TOK must precede NET: ${wide}`,
	);
	// Sweep: NET may never appear while TOK is absent (that would mean the
	// priority is reversed), and there must exist a width where exactly that
	// drop happened (otherwise the ordering would be nominal).
	let tokAlone = false;
	for (let w = 1; w <= 200; w++) {
		const text = segsText(plainLineSegs(opts, w));
		if (text.includes("TOK ")) {
			if (!text.includes("NET ")) tokAlone = true;
		} else {
			assert.ok(
				!text.includes("NET "),
				`w=${w}: NET survived although TOK was dropped —— ${JSON.stringify(text)}`,
			);
		}
	}
	assert.ok(tokAlone, "there must be a width where NET is gone but TOK stays");
});

test("plainLineSegs: without cache reads there is no ·/⌀ on the line either", () => {
	// Same `seenCache` gate as the chart: both modes must agree, otherwise the
	// line would show a hit rate the chart doesn't draw.
	const text = segsText(
		plainLineSegs(
			{
				snap: fakeSnap(),
				tpsNow: 1234,
				tokensIn: 5671,
				tokensOut: 89,
				tokensCacheRead: 0,
				hitNow: 88,
			},
			200,
		),
	);
	assert.match(text, /TOK/);
	assert.doesNotMatch(text, /·/, `no instantaneous hit rate without cache reads: ${text}`);
	assert.doesNotMatch(text, /⌀/, `no cumulative hit rate without cache reads: ${text}`);
	assert.doesNotMatch(text, /R\d/, `no cache-read total without cache reads: ${text}`);
});

test("plainLineSegs: still emits the token line without a snapshot (the only meaningful metric on non-Linux)", () => {
	const segs = plainLineSegs({ tpsNow: 42 }, 200);
	const text = segsText(segs);
	assert.match(text, /TOK/);
	assert.match(text, /~42t\/s/);
	// Without a system snapshot, no CPU/MEM readouts should be fabricated
	assert.doesNotMatch(text, /CPU/);
});

test("sweep: line mode renders at exactly the declared width at any width (overflow makes pi exit)", () => {
	for (const w of Array.from({ length: 220 }, (_, i) => i + 1)) {
		for (const theme of [ansiTheme, plainTheme]) {
			const segs = plainLineSegs(
				{
					snap: fakeSnap(),
					tpsNow: 12345,
					tokensIn: 1234567,
					tokensOut: 987654,
					tokensCacheRead: 543210,
					// `hitNow` too, so the `·N%` segment is actually rendered and
					// width-swept in line mode (it's the one segment gated on it).
					hitNow: 88,
				},
				w,
			);
			const line = renderStyledLine(theme, segs, w);
			assert.equal(
				visibleWidth(line),
				w,
				`w=${w}: rendered width ${visibleWidth(line)} ≠ ${w}`,
			);
		}
	}
});

test("sweep: wide/zero-width character segments never overflow end to end and never split a wide char", () => {
	// This pins the agreement between "plainLineSegs's budget accounting" and
	// "renderStyledLine's actual render accounting" — they must match
	// (currently coincidentally so: the data is all ASCII). Feed segments
	// containing CJK/emoji/combining characters straight into the renderer and
	// sweep widths, nailing this agreement down.
	const cases: StyledLine[] = [
		[{ text: "你好世界你好世界", color: "accent" }],
		[
			{ text: "CPU ", color: "muted" },
			{ text: "你好", color: "success" },
		],
		[{ text: "e\u0301\u200bx", color: "muted" }],
		[{ text: "🙂🙂🙂", color: "warning" }],
		[
			{ text: "CPU 12%  ", color: "muted" },
			{ text: "内存 60%", color: "warning" },
			{ text: "  🙂", color: "accent" },
		],
	];
	for (const w of Array.from({ length: 60 }, (_, i) => i + 1)) {
		for (const segs of cases) {
			for (const theme of [ansiTheme, plainTheme]) {
				const line = renderStyledLine(theme, segs, w);
				assert.equal(
					visibleWidth(line),
					w,
					`w=${w} segs=${JSON.stringify(segs.map((s) => s.text))}`,
				);
			}
		}
	}
});

test("sweep: line mode never throws and never overflows at extreme/non-finite widths", () => {
	// `renderStyledLine` has a defensive branch for non-finite widths (clamps to
	// 1); this pins it down.
	// 0/negative/NaN/Infinity must all yield a finite-width line.
	for (const w of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
		const line = renderStyledLine(
			ansiTheme,
			plainLineSegs({ snap: fakeSnap() }, w),
			w,
		);
		const lw = visibleWidth(line);
		assert.ok(Number.isFinite(lw), `w=${w} produced a non-finite width`);
		assert.ok(lw >= 1, `w=${w} produced width ${lw} < 1`);
		assert.doesNotMatch(line, /NaN|undefined/, `w=${w}`);
	}
});

test("sweep: line mode never throws and never overflows at extremely narrow widths", () => {
	// Must stay stable even when the terminal is squeezed to 1 column (pad with
	// spaces to w columns, no overflow, no NaN characters)
	for (const w of [1, 2, 3, 5, 8, 12, 20]) {
		const line = renderStyledLine(
			ansiTheme,
			plainLineSegs({ snap: fakeSnap() }, w),
			w,
		);
		assert.equal(visibleWidth(line), w, `w=${w}`);
	}
});

test("plainLineSegs: drops whole segments only when short on width; the result is always a concatenation of complete segments (numbers never cut in half)", () => {
	const opts = {
		snap: fakeSnap(),
		tpsNow: 12345,
		tokensIn: 1234567,
		tokensOut: 987654,
		tokensCacheRead: 543210,
	};
	const full = segsText(plainLineSegs(opts, 500));
	// Group order by descending importance: CPU → MEM → TOK → NET.
	// TOK sits **before** NET (a deliberate change): the token readout is much
	// less recoverable from anywhere else on screen than the network rate, and
	// whole groups are dropped from the tail.
	const marks = ["CPU ", "MEM ", "TOK ", "NET "];
	// For every width: the result must be a prefix of full (after trimming trailing
	// spaces) and must end on a "segment boundary"
	for (let w = 1; w <= 120; w++) {
		const text = segsText(plainLineSegs(opts, w)).trimEnd();
		assert.ok(
			full.startsWith(text),
			`w=${w}: not a prefix —— ${JSON.stringify(text)}`,
		);
		// The end can never stop in the middle of a token number (e.g. inside `↑1.2M`)
		assert.doesNotMatch(
			text,
			/(?:↑|↓|R)[0-9.]*$/,
			`w=${w}: ends in a half number —— ${JSON.stringify(text)}`,
		);
	}
	// Critical point: TOK must never squeeze NET out (it outranks NET), and when
	// NET does survive, TOK is complete ahead of it.
	const withTok = segsText(plainLineSegs(opts, 120));
	assert.match(withTok, /TOK /);
	assert.match(withTok, /NET /);
	assert.ok(
		withTok.indexOf("TOK ") < withTok.indexOf("NET "),
		"TOK must come before NET (descending importance)",
	);
	// NET is dropped first: there must exist a width where TOK survives alone
	// without NET (otherwise the priority would be nominal only).
	let tokWithoutNet = false;
	for (let w = 1; w <= 120; w++) {
		const text = segsText(plainLineSegs(opts, w));
		if (text.includes("TOK ") && !text.includes("NET ")) tokWithoutNet = true;
		// The reverse can never happen: NET present while TOK is gone
		assert.ok(
			!(text.includes("NET ") && !text.includes("TOK ")),
			`w=${w}: NET survived while TOK was dropped —— ${JSON.stringify(text)}`,
		);
	}
	assert.ok(tokWithoutNet, "NET must be droppable while TOK survives");
	// The relative order of the four groups is fixed
	const idx = marks.map((m) => full.indexOf(m));
	for (let i = 1; i < idx.length; i++)
		assert.ok(
			(idx[i] ?? -1) > (idx[i - 1] ?? -1),
			`segment order wrong: ${marks.join(" → ")}`,
		);
});

test("sweep: line mode keeps the first segment at any width (a blank line makes people think the extension died)", () => {
	// With a snapshot the first segment is CPU, without one it's TOK — neither
	// may ever be empty.
	const withSnap = { snap: fakeSnap() };
	const noSnap = {};
	for (let w = 1; w <= 220; w++) {
		assert.match(segsText(plainLineSegs(withSnap, w)), /CPU/, `w=${w}`);
		assert.match(segsText(plainLineSegs(noSnap, w)), /TOK/, `w=${w} (no snapshot)`);
	}
});

test("segsWidth: same accounting as visibleWidth (wide chars count as 2 columns)", () => {
	assert.equal(segsWidth([{ text: "abc" }]), 3);
	assert.equal(segsWidth([{ text: "你好" }]), 4);
	assert.equal(segsWidth([{ text: "a" }, { text: "你" }, { text: "b" }]), 4);
});

test("plainLineSegs: non-finite widths must not degenerate into 'everything fits'", () => {
	// Regression: `Math.max(1, Math.floor(NaN))` is still NaN, and
	// `budget > NaN` is always false, which would return the whole line to the
	// caller — once the caller trusts that budget it overflows (pi exits).
	const opts = { snap: fakeSnap(), tpsNow: 12345, tokensIn: 1234567 };
	for (const w of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
		const text = segsText(plainLineSegs(opts, w)).trimEnd();
		assert.match(text, /CPU/, `w=${w} must still keep the first segment`);
		assert.doesNotMatch(text, /TOK /, `w=${w} must not degenerate into the full line —— ${text}`);
	}
});

/* ------------------------------------------------------------------ */
/* Context-window usage (◔N%) — fed by pi's getContextUsage()          */
/* ------------------------------------------------------------------ */

test("buildBlocks: ctxPct adds a ◔ segment right after the rate, colored by pi's footer thresholds", () => {
	// The reading is shown in both the chart title bar and line mode, so the
	// position (user-requested default: second slot, right after the rate and
	// before the hit rates) and the color thresholds (>90 error, >70 warning,
	// else muted — pi footer's own) must be pinned here, once, for the shared
	// helper both modes call.
	const mk = (ctxPct: number) =>
		buildBlocks(fakeHist(50), fakeSnap(), {
			points: 30,
			tpsNow: 250,
			tokensIn: 5671,
			tokensOut: 11,
			tokensCacheRead: 640,
			hitNow: 88,
			ctxPct,
		}).find((b) => b.name === "Tokens");
	const segs = mk(42)?.titleInfo ?? [];
	const texts = segs.map((s) => s.text);
	// Exact sequence (widget default, no totals): rate → ◔ → · → ⌀
	assert.deepEqual(texts, ["~250t/s", " \u25d442%", " \u00b788%", " \u230010%"]);
	// Colors: muted at 42% (the same tier as the other context info)
	assert.deepEqual(
		segs.map((s) => s.color),
		["accent", "muted", "success", "warning"],
	);
	// Thresholds: >70 warning, >90 error — identical to pi's built-in footer
	assert.equal(mk(71)?.titleInfo?.[1]?.color, "warning", "71% must be warning");
	assert.equal(mk(91)?.titleInfo?.[1]?.color, "error", "91% must be error");
	// Degradation: ◔ sits before the hit-rate segments, so on a narrowing
	// block ◔ survives while ·/⌀ (and the footer-mode counters after them)
	// drop first — the context usage is the reading the user front-loaded.
	const shown = (blockW: number): string => {
		const tok = mk(42);
		assert.ok(tok, "Tokens block must exist");
		const lines = renderPanel(
			plainTheme,
			[tok],
			blockW,
			{ cols: 1, bands: 1, widths: [blockW], plotRows: 4, totalRows: 8 },
			60,
		);
		return (lines[0] ?? "").trimEnd();
	};
	// ◔ first fits at width 26 (rate 7 + ◔ 5 = 12 = roomForInfo(26) = 26-6-7-1,
	// `Tokens` being 6 columns); · would need 5 more (width 31), ⌀ another 5
	// (width 36), so at 26 ◔ is present while ·/⌀ are not — the front-loaded
	// position doing its job.
	assert.ok(!shown(25).includes("\u25d4"), `◔ shouldn't fit yet at width 25: ${shown(25)}`);
	assert.ok(shown(26).includes("\u25d4"), `◔ must appear at width 26: ${shown(26)}`);
	assert.ok(!shown(26).includes("\u00b7"), `· must yield before ◔ at width 26: ${shown(26)}`);
	assert.ok(shown(31).includes("\u00b7"), `· should appear at width 31: ${shown(31)}`);
	assert.ok(
		shown(31).indexOf("\u25d4") < shown(31).indexOf("\u00b7"),
		`◔ must precede · in the title bar: ${shown(31)}`,
	);
});

test("buildBlocks: ctxPct undefined / non-finite / no-cache ⇒ no ◔ segment at all", () => {
	// Unknown (post-compaction, no model) must degrade to "absent", never to a
	// bogus ◔0% — the same rule as `·N%` before the first measurable prompt.
	// And it must NOT be gated on `seenCache`: context usage exists even when
	// the provider never reports cache reads (e.g. a non-caching provider with
	// a 200k window at 50%).
	for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
		const title = buildBlocks(fakeHist(50), fakeSnap(), {
			points: 30,
			tokensCacheRead: 640,
			ctxPct: bad,
		})
			.find((b) => b.name === "Tokens")
			?.titleInfo?.map((s) => s.text)
			.join("");
		assert.ok(!title?.includes("\u25d4"), `ctxPct=${bad} must not render ◔: ${title}`);
	}
	const noCache = buildBlocks(fakeHist(50), fakeSnap(), {
		points: 30,
		tokensCacheRead: 0,
		ctxPct: 55,
	})
		.find((b) => b.name === "Tokens")
		?.titleInfo?.map((s) => s.text)
		.join("");
	assert.ok(
		noCache?.includes("\u25d455%"),
		`◔ must render even without cache reads: ${noCache}`,
	);
});

test("plainLineSegs: ctxPct renders the same ◔ segment with the same colors as the chart", () => {
	// Cross-checkable by construction: same helper, same position (right
	// after the rate, before the hit rates), same color tiers. 71% exercises
	// the warning tier so the color assertion isn't vacuous.
	const segs = plainLineSegs(
		{
			snap: fakeSnap(),
			tpsNow: 1234,
			tokensIn: 5671,
			tokensOut: 89,
			tokensCacheRead: 2700,
			hitNow: 88,
			ctxPct: 71,
		},
		200,
	);
	const text = segs.map((s) => s.text).join("");
	assert.match(text, /◔71%/);
	assert.ok(
		text.indexOf("◔") < text.indexOf("·") &&
			text.indexOf("·") < text.indexOf("⌀") &&
			text.indexOf("⌀") < text.indexOf("↑"),
		`order must be ◔ → · → ⌀ → ↑: ${text}`,
	);
	const ctxSegColor = segs.find((s) => s.text.includes("◔"))?.color;
	assert.equal(ctxSegColor, "warning", "71% must be warning in line mode too");
	// Unknown ⇒ absent, same as the chart
	const unknown = plainLineSegs({ snap: fakeSnap(), ctxPct: undefined }, 200).map((s) =>
		s.text,
	).join("");
	assert.ok(!unknown.includes("◔"), unknown);
});
