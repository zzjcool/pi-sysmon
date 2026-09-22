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
	tokenAxis,
	DEFAULT_SCALE_WINDOW_FRAC,
	MIN_TPS_SCALE,
	TPS_GUTTER,
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
	memUsed: 33 * 1024 ** 3,
	memTotal: 64 * 1024 ** 3,
	memPct: 52,
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
		mem: wave(50, 4, 11),
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
	// With a wide enough block the total traffic must be there too
	for (const w of [150, 200]) {
		const layout = computeLayout(w, 4, 4, 18);
		const lines = renderPanel(
			plainTheme,
			buildBlocks(hist, snap, { points: 60 }),
			w,
			layout,
			60,
		);
		assert.ok(
			lines.join("\n").includes("Σ"),
			`w=${w}: Network cumulative total traffic not rendered`,
		);
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

test("buildBlocks: Tokens block is wired correctly (both up/down shown, same accounting as pi footer)", () => {
	// Asserting only the block name isn't enough: if the series were wired to
	// some other history array (like hist.cpu), or the reading args were
	// forgotten (always 0), a name-only test would still pass.
	const h = fakeHist(50);
	const tok = buildBlocks(h, fakeSnap(), {
		points: 30,
		tpsNow: 250,
		tokensIn: 5671,
		tokensOut: 11,
		tokensCacheRead: 640,
	}).find((b) => b.name === "Tokens");
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
	// Both up/down must appear (the user's reported problem: only one direction)
	assert.ok(title.includes("\u2191"), `should contain upload: ${title}`);
	assert.ok(title.includes("\u2193"), `should contain download: ${title}`);
	// Numbers match pi footer's formatTokens (lowercase k)
	assert.ok(title.includes("5.7k"), `↑5671 should format as 5.7k: ${title}`);
	assert.ok(title.includes("R640"), `cache reads should show as R640: ${title}`);
	// Cumulative values are exact numbers reported by the provider and **must not** carry `~`
	const ioOnly = title.slice(title.indexOf("\u2191"));
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
		mem: new Array(n).fill(50),
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
		mem: flat(50),
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
	// The other readings survive untouched
	assert.ok(title.includes("~250t/s") && title.includes("\u2191") && title.includes("\u2193"), title);
});

test("buildBlocks: Tokens title segments are ordered rate → · → ⌀ → ↑ → ↓ → R", () => {
	// Segment order **is** the degradation policy (the title bar accumulates
	// segment by segment and drops the tail), so the order must be asserted
	// directly, not inferred from the narrow-width cases.
	const tok = buildBlocks(fakeHist(50), fakeSnap(), {
		points: 30,
		tpsNow: 250,
		tokensIn: 5671,
		tokensOut: 11,
		tokensCacheRead: 640,
		hitNow: 88,
	}).find((b) => b.name === "Tokens");
	const segs = tok?.titleInfo ?? [];
	const texts = segs.map((s) => s.text);
	// Exact sequence (the leading spaces belong to the segment they precede)
	assert.deepEqual(texts, [
		"~250t/s",
		" \u00b788%",
		" \u230010%",
		"  \u21915.7k",
		" \u219311",
		" R640",
	]);
	// …and with the colors that let the two modes be cross-checked
	assert.deepEqual(
		segs.map((s) => s.color),
		["accent", "success", "warning", "muted", "muted", "muted"],
	);
	// The cumulative rate is recomputed from the running totals: 640 / (640+5671)
	const cum = (640 / (640 + 5671)) * 100; // ≈10.14 → 10%
	assert.equal(texts[2], ` \u2300${Math.round(cum)}%`);
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
			mem: [],
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
				mem: [],
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
			mem: [],
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
		mem: [],
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
	assert.match(text, /↑5\.7k/); // same convention as pi footer's formatTokens (lowercase k)
	assert.match(text, /↓89/);
	assert.match(text, /R2\.7k/);
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
	};
	// 80 columns: TOK is in, NET is out (measured: NET only appears at 84+)
	const w80 = segsText(plainLineSegs(opts, 80));
	assert.match(w80, /TOK /, `TOK must survive at 80 cols: ${w80}`);
	assert.doesNotMatch(w80, /NET /, `NET should already be dropped at 80 cols: ${w80}`);
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
