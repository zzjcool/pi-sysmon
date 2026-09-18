/**
 * Braille line-chart renderer — pure characters, zero dependencies.
 *
 * Principle: each braille character (U+2800..U+28FF) encodes a 2-col × 4-row
 *      grid of dot sub-pixels, effectively multiplying terminal resolution by
 *      2 horizontally and 4 vertically — fine enough for line charts.
 *      This is the technique bottom uses (ratatui Marker::Braille).
 *
 * Dot-to-bit mapping (2×4):
 *     left col bit0/1/2/6 (dots 1,2,3,7)   right col bit3/4/5/7 (dots 4,5,6,8)
 */

const BRAILLE_BASE = 0x2800;

/** (col: 0|1, row: 0..3) → bit value */
function dotBit(col: number, row: number): number {
	// left col: row0->0x01, row1->0x02, row2->0x04, row3->0x40
	// right col: row0->0x08, row1->0x10, row2->0x20, row3->0x80
	const left = [0x01, 0x02, 0x04, 0x40];
	const right = [0x08, 0x10, 0x20, 0x80];
	return (col === 0 ? left : right)[row] ?? 0;
}

export interface ChartSeries {
	label: string;
	/** Value series; index 0 is the oldest sample */
	values: number[];
}

/** Rendering result for one character cell */
export interface ChartGlyph {
	/** Braille character; " " means the cell has no dots */
	char: string;
	/** Index of the series that hit this cell; the lowest index wins when
	 *  multiple series share a cell; -1 when the cell is empty */
	series: number;
}

/**
 * Render multiple series into a braille dot grid, keeping the **index of the
 * series that hit each cell**.
 *
 * Why a separate entry point: when several series share a cell their dot
 * patterns must be merged with a bitwise OR (otherwise intersecting lines
 * break apart), but a character cell can only carry one color. A caller that
 * wants per-series coloring (e.g. RX/TX in different colors on the network
 * chart) needs to know which series owns each cell. `renderChart` is the
 * single-color wrapper around this.
 */
export function renderChartGlyphs(
	series: ChartSeries[],
	width: number,
	height: number,
	yMax?: number,
	opts?: { stretch?: boolean; slots?: number },
): ChartGlyph[][] {
	if (width <= 2 || height <= 0) return [];
	const subW = width * 2; // sub-pixel columns
	const subH = height * 4; // sub-pixel rows

	// Data point count shared by all series (the longest one)
	const maxLen = Math.max(0, ...series.map((s) => s.values.length));
	if (maxLen === 0) return [];

	// Y-axis upper bound: explicit values must be normalized too (yMax=0/negative/NaN
	// would make v/top NaN → NaN coordinates → out-of-bounds crash)
	let top = yMax;
	if (top === undefined) {
		top = 0;
		for (const s of series) for (const v of s.values) if (v > top) top = v;
	}
	if (!Number.isFinite(top) || top <= 0) top = 1;

	// One dot-grid buffer per chart ([row][col])
	const grids: number[][][] = series.map(() =>
		Array.from({ length: subH }, () => new Array<number>(subW).fill(0)),
	);

	series.forEach((s, si) => {
		const grid = grids[si];
		if (!grid) return;
		const n = s.values.length;
		if (n === 0) return;
		// Map data points to sub-pixel coordinates.
		// Right-aligned by default (same as bottom): the x axis represents a fixed
		// time window, newest data at the far right, history extending leftward.
		// opts.stretch stretches to fill the width instead, avoiding an
		// overly empty chart right after startup.
		const pts: Array<{ x: number; y: number }> = [];
		const stretch = opts?.stretch ?? false;
		// slots (time-proportional slots): the whole x axis = slots data points.
		// One point occupies `subW / slots` sub-pixel columns — this ratio does
		// **not** change with how many points have been collected so far, so one
		// second has a constant on-screen width and the x-axis label's duration
		// stays honest.
		// (Compare the old `stretch=false` path: there one point = one sub-pixel
		//  column, so a full 60-point window only fills 60/subW of the width and
		//  the right side stays empty.)
		const slots =
			Number.isFinite(opts?.slots) && (opts?.slots as number) > 0
				? Math.floor(opts?.slots as number)
				: 0;
		const perSlot = slots > 0 ? subW / slots : 0;
		// stretch: linearly spread the collected history across the full width.
		// The key invariant is "newest data in the rightmost column" —
		// `i/(n-1)*(subW-1)` lands the last point on subW-1 (right edge) for
		// n>=2; only for n=1 does the formula degenerate to 0, which would draw
		// the single point in the **leftmost** column — the opposite of the
		// "right = now" semantics (visible on the very first sample after startup).
		// So pin the single-point stretch position first, then use the general mapping.
		const stretchedX = (i: number): number => {
			if (n === 1) return subW - 1;
			return Math.round((i / (n - 1)) * (subW - 1));
		};
		for (let i = 0; i < n; i++) {
			// Three positioning modes (highest priority first):
			//  slots   — time-proportional: one point = subW/slots columns, newest point on the right edge
			//  stretch — stretch to fill (looks better during startup, but the x axis no longer means a fixed duration)
			//  default — right-aligned, one point = one sub-pixel column (bottom's approach)
			let x: number;
			if (slots > 0) {
				// Newest point hugs the right edge; history spreads leftward by slot width
				x = Math.round(subW - 1 - (n - 1 - i) * perSlot);
			} else if (stretch) {
				x = stretchedX(i);
			} else {
				x = subW - n + i;
			}
			if (x < 0 || x >= subW) continue; // drop old data outside the window
			const raw = s.values[i] ?? 0;
			// NaN / Infinity tolerance: treat garbage as 0 so one bad value can't ruin the whole chart
			const v = Number.isFinite(raw) ? Math.max(0, Math.min(top, raw)) : 0;
			// y: 0 at the bottom → subH-1
			const y = Math.round((1 - v / top) * (subH - 1));
			if (!Number.isFinite(y)) continue; // last resort: skip non-finite coordinates to stay in bounds
			pts.push({ x, y: Math.max(0, Math.min(subH - 1, y)) });
		}
		// Connect adjacent points with Bresenham so the line doesn't break into jagged gaps
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1];
			const b = pts[i];
			if (a && b) plotLine(grid, a, b);
		}
		// With a single point Bresenham has nothing to draw; plot it manually
		// (belt and braces: fetch row/col before writing)
		const solo = pts[0];
		if (pts.length === 1 && solo) {
			const row = grid[solo.y];
			if (row) row[solo.x] = 1;
		}
	});

	// Compose the dot grids into braille characters.
	// Cells hit by multiple series are merged with a **bitwise OR** (instead of
	// later-paint-wins) so intersecting lines don't lose segments; the price is
	// that the cell can only have one color, so the first hitting series wins.
	const out: ChartGlyph[][] = [];
	for (let row = 0; row < height; row++) {
		const line: ChartGlyph[] = [];
		for (let col = 0; col < width; col++) {
			let merged = 0;
			let owner = -1;
			for (let si = 0; si < grids.length; si++) {
				const grid = grids[si];
				if (!grid) continue;
				let hit = false;
				for (let dy = 0; dy < 4; dy++) {
					for (let dx = 0; dx < 2; dx++) {
						const sy = row * 4 + dy;
						const sx = col * 2 + dx;
						if (sy < subH && sx < subW && grid[sy]?.[sx]) {
							merged |= dotBit(dx, dy);
							hit = true;
						}
					}
				}
				if (hit && owner < 0) owner = si;
			}
			line.push({
				char: merged ? String.fromCodePoint(BRAILLE_BASE | merged) : " ",
				series: owner,
			});
		}
		out.push(line);
	}
	return out;
}

/**
 * Render multiple series into one braille line chart (single color).
 *
 * @param series   curves (each with a label, used for legends)
 * @param width    character width
 * @param height   character height (rows)
 * @param yMax     vertical axis upper bound (fixed value; pass undefined to auto-take the max over all series)
 * @param opts.stretch  whether to stretch to fill when there are fewer data points than available columns.
 *                      false (default) = right-aligned, x axis strictly maps to a fixed time window (same as bottom),
 *                      but early after startup the short history only occupies a small right-hand segment;
 *                      true = stretch the collected history across the full width so trends are visible
 *                      immediately (x axis meaning = "entire current buffer content").
 */
export function renderChart(
	series: ChartSeries[],
	width: number,
	height: number,
	yMax?: number,
	opts?: { stretch?: boolean; slots?: number },
): string[] {
	return renderChartGlyphs(series, width, height, yMax, opts).map((row) =>
		row.map((g) => g.char).join(""),
	);
}

/** Bresenham line, written into the dot grid */
function plotLine(
	grid: number[][],
	a: { x: number; y: number },
	b: { x: number; y: number },
) {
	let { x: x0, y: y0 } = a;
	const { x: x1, y: y1 } = b;
	const dx = Math.abs(x1 - x0);
	const dy = Math.abs(y1 - y0);
	const sx = x0 < x1 ? 1 : -1;
	const sy = y0 < y1 ? 1 : -1;
	let err = dx - dy;
	const cols = grid[0]?.length ?? 0;
	// Derive the guard from the actual longest edge so very wide charts aren't truncated early by 10000
	const maxSteps = dx + dy + 2;
	for (let step = 0; step <= maxSteps; step++) {
		if (y0 >= 0 && y0 < grid.length && x0 >= 0 && x0 < cols) {
			const grow = grid[y0];
			if (grow) grow[x0] = 1;
		}
		if (x0 === x1 && y0 === y1) break;
		const e2 = 2 * err;
		if (e2 > -dy) {
			err -= dy;
			x0 += sx;
		}
		if (e2 < dx) {
			err += dx;
			y0 += sy;
		}
	}
}
