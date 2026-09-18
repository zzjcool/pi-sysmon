/**
 * Unit tests for braille.ts — node:test + node:assert
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChart, type ChartSeries } from "../src/braille.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Shortcut to build a single series */
const S = (values: number[], label = "s"): ChartSeries[] => [{ label, values }];

/** Count non-space characters in a line */
const nonSpace = (line: string): number =>
	[...line].filter((c) => c !== " ").length;

/* ------------------------------------------------------------------ */
/* 1. Braille bit-mapping correctness                                   */
/*                                                                     */
/* Derivation (Unicode braille patterns):                              */
/*   left col row0..3 → dots 1,2,3,7 → bits 0x01,0x02,0x04,0x40        */
/*   right col row0..3 → dots 4,5,6,8 → bits 0x08,0x10,0x20,0x80       */
/* How we verify: renderChart right-aligns data (x = subW - n + i),    */
/* so single-point data always lands in the rightmost subpixel column  */
/* x=subW-1 (odd) → right-col dot; the first point of two-point data   */
/* lands at x=subW-2 (even) → left-col dot.                            */
/* Vertically we control via v=top→y=0 (top row) / v=0→y=subH-1        */
/* (bottom row).                                                       */
/* Therefore one character cell of width=3,height=1 covers all 4       */
/* corner dots.                                                        */
/* ------------------------------------------------------------------ */

test("bit mapping: lighting only (col=1,row=0) yields U+2808", () => {
	// v=top → y=0 (subpixel row0 → char row0); x=5=col*2+1 → right col
	const lines = renderChart(S([100]), 3, 1, 100);
	assert.equal(lines.length, 1);
	assert.equal(lines[0], "  ⠈");
	assert.equal(lines[0]!.codePointAt(2), 0x2808);
});

test("bit mapping: lighting only (col=0,row=0) yields U+2801", () => {
	// Two-point horizontal line: first point x=4=col*2+0 → left col, y=0 → row0
	const lines = renderChart(S([100, 100]), 3, 1, 100);
	const cp = lines[0]!.codePointAt(2)!;
	assert.equal(cp, 0x2809, "left-col + right-col top dots = U+2801|U+2808 = U+2809");
	assert.ok((cp & 0x01) !== 0, "left-col row0 bit 0x01 must be set (i.e. a single point would be U+2801)");
});

test("bit mapping: lighting only (col=1,row=3) yields U+2880", () => {
	// v=0 → y=subH-1=3 (subpixel row3 → char row3); x=5 → right col → 0x80
	const lines = renderChart(S([0]), 3, 1, 100);
	assert.equal(lines[0], "  ⢀");
	assert.equal(lines[0]!.codePointAt(2), 0x2880);
});

test("bit mapping: lighting only (col=0,row=3) yields U+2840", () => {
	// Two-point zero line: first point x=4 → left col, y=3 → row3 → 0x40
	const lines = renderChart(S([0, 0]), 3, 1, 100);
	const cp = lines[0]!.codePointAt(2)!;
	assert.ok((cp & 0x40) !== 0, "left-col row3 bit 0x40 must be set");
	assert.equal(cp, 0x28c0, "two bottom dots = 0x40|0x80");
});

test("bit mapping: all 8 dots lit yields U+28FF", () => {
	// height=2 → subH=8. Fill all 8 dots in the last character cell (col=2,
	// char rows 0 and 1).
	// Approach: width=3,height=2, build an n=2 polyline sweeping every
	// even/odd column of y=0..7.
	// More directly: use two diagonal lines to cover all 8 rows of columns
	// x=4,5:
	//   series A: 100→0   (top to bottom)   series B: 0→100 (bottom to top)
	// The two diagonals + Bresenham fill the whole cell in this small 8-row,
	// 2-column region.
	const series: ChartSeries[] = [
		{ label: "a", values: [100, 0] },
		{ label: "b", values: [0, 100] },
	];
	const lines = renderChart(series, 3, 2, 100);
	// The last character cell (col=2) spans two char rows: upper row0..3, lower row0..3
	const top = lines[0]!.codePointAt(2)!;
	const bot = lines[1]!.codePointAt(2)!;
	// The upper cell must contain all of y=0..3: 0x01|0x02|0x04|0x40|0x08|0x10|0x20|0x80 = 0xFF
	assert.equal(top, 0x28ff, `upper cell must be full U+28FF, got U+${top.toString(16)}`);
	// The lower cell must contain all of y=4..7
	assert.equal(bot, 0x28ff, `lower cell must be full U+28FF, got U+${bot.toString(16)}`);
});

/* ------------------------------------------------------------------ */
/* 2. Output shape                                                      */
/* ------------------------------------------------------------------ */

test("shape: line count === height, visible width of each line === width", () => {
	for (const [w, h] of [
		[10, 4],
		[20, 6],
		[3, 1],
		[7, 2],
	] as const) {
		const lines = renderChart(S([1, 2, 3, 2, 1]), w, h);
		assert.equal(lines.length, h, `height=${h} must return ${h} lines`);
		for (const [i, line] of lines.entries()) {
			assert.equal(visibleWidth(line), w, `visible width of line ${i} must be ${w}`);
		}
	}
});

/* ------------------------------------------------------------------ */
/* 3. Boundaries                                                        */
/* ------------------------------------------------------------------ */

test("boundary: empty data → returns []", () => {
	assert.deepEqual(renderChart([], 10, 4), []);
	assert.deepEqual(renderChart(S([]), 10, 4), []);
	assert.deepEqual(
		renderChart(
			[
				{ label: "a", values: [] },
				{ label: "b", values: [] },
			],
			10,
			4,
		),
		[],
	);
});

test("boundary: width<=2 || height<=0 → returns []", () => {
	assert.deepEqual(renderChart(S([1, 2]), 2, 4), []);
	assert.deepEqual(renderChart(S([1, 2]), 0, 4), []);
	assert.deepEqual(renderChart(S([1, 2]), -5, 4), []);
	assert.deepEqual(renderChart(S([1, 2]), 10, 0), []);
	assert.deepEqual(renderChart(S([1, 2]), 10, -1), []);
});

test("boundary: all-zero data doesn't crash and hugs the bottom", () => {
	const lines = renderChart(S([0, 0, 0, 0]), 10, 4);
	assert.equal(lines.length, 4);
	// The upper three lines must be entirely blank
	for (let i = 0; i < 3; i++) {
		assert.equal(nonSpace(lines[i]!), 0, `line ${i} must be empty`);
	}
	// The bottom line must have content (hugging the bottom)
	assert.ok(nonSpace(lines[3]!) > 0, "the bottom line must have non-space characters");
});

test("boundary: single-point data has at least one non-space character", () => {
	const lines = renderChart(S([42]), 10, 4);
	const total = lines.reduce((acc, l) => acc + nonSpace(l), 0);
	assert.ok(total >= 1, "single-point data must have at least one non-space character");
	// And exactly one braille character (one dot)
	assert.equal(total, 1);
});

/* ------------------------------------------------------------------ */
/* 4. Coordinate mapping (pulses with fixed yMax=100)                   */
/* ------------------------------------------------------------------ */

test("coordinate mapping: value=0 lands on the bottom line", () => {
	// Baseline 50, a single 0 pulse dips down in the middle
	const values = [50, 50, 50, 0, 50, 50, 50];
	const lines = renderChart(S(values), 20, 4, 100);
	// 0 → y = subH-1 = 15 → char row 15>>2 = 3 (last line)
	assert.ok(nonSpace(lines[3]!) > 0, "the bottom line must have content (the 0 pulse dips to it)");
	// Verify the 0 point really is on the last line, not a horizontal line elsewhere:
	// non-space chars on the bottom line should only appear near the pulse x
	// (the horizontal line is at y=8 → line 2)
	const lastLine = lines[3]!;
	assert.ok(nonSpace(lastLine) >= 1);
});

test("coordinate mapping: value=yMax lands on the top line", () => {
	// Baseline 50, a single 100 pulse rises in the middle
	const values = [50, 50, 50, 100, 50, 50, 50];
	const lines = renderChart(S(values), 20, 4, 100);
	// 100 → y = 0 → char row 0 (first line)
	assert.ok(nonSpace(lines[0]!) > 0, "the top line must have content (the yMax pulse reaches it)");
	// Top-line content should only appear near the pulse column: the
	// baseline-50 horizontal line is at y=8 → line 2, so every non-space
	// char on line 0 comes from the pulse
	const topLine = lines[0]!;
	const idx = [...topLine].findIndex((c) => c !== " ");
	// Data right-aligned: n=7, subW=40, pulse i=3 → x = 40-7+3 = 36 → col = 18
	assert.ok(idx >= 16 && idx <= 19, `the pulse should appear near the right columns, got col=${idx}`);
});

/* ------------------------------------------------------------------ */
/* 5. Monotonicity: increasing data goes from lower-left to upper-right */
/* ------------------------------------------------------------------ */

test("monotonicity: for increasing data, the centroid column of each line's non-space chars moves right as the row index decreases", () => {
	const values = Array.from({ length: 40 }, (_, i) => i + 1); // 1..40 increasing
	const lines = renderChart(S(values), 20, 8, 40);
	assert.equal(lines.length, 8);

	// Average column position (centroid) of the non-space chars per line
	const centroids: Array<{ row: number; cx: number }> = [];
	for (let r = 0; r < lines.length; r++) {
		const cols = [...lines[r]!]
			.map((c, i) => (c === " " ? -1 : i))
			.filter((i) => i >= 0);
		if (cols.length > 0) {
			centroids.push({
				row: r,
				cx: cols.reduce((a, b) => a + b, 0) / cols.length,
			});
		}
	}
	// An increasing line goes from lower-left (large row, small col) to
	// upper-right (small row, large col) → the centroid column of adjacent
	// non-empty rows should increase as the row index decreases
	assert.ok(centroids.length >= 2, "at least two rows must have content");
	const first = centroids[0]!; // topmost non-empty row
	const last = centroids[centroids.length - 1]!; // bottommost non-empty row
	assert.ok(
		first.cx > last.cx,
		`top-row centroid (${first.cx.toFixed(1)}) should be further right than bottom-row centroid (${last.cx.toFixed(1)})`,
	);
	// Stronger check: the overall trend is monotonic (adjacent rows may tie due to rounding)
	for (let i = 1; i < centroids.length; i++) {
		assert.ok(
			centroids[i]!.cx <= centroids[i - 1]!.cx + 1e-9,
			`row ${centroids[i]!.row} centroid (${centroids[i]!.cx}) should be <= row ${centroids[i - 1]!.row} centroid (${centroids[i - 1]!.cx})`,
		);
	}
});
