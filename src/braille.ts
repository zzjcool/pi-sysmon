/**
 * braille 折线图渲染器 —— 纯字符，零依赖。
 *
 * 原理：每个 braille 字符（U+2800..U+28FF）可编码 2 列 × 4 行的点子像素，
 *      相当于把终端分辨率横向×2、纵向×4，用来画折线图足够细腻。
 *      这是 bottom 用的技术（ratatui Marker::Braille）。
 *
 * 点阵位映射（2×4）：
 *     左列 bit0/1/2/6（点 1,2,3,7）   右列 bit3/4/5/7（点 4,5,6,8）
 */

const BRAILLE_BASE = 0x2800;

/** (col: 0|1, row: 0..3) → bit 值 */
function dotBit(col: number, row: number): number {
	// 左列：row0->0x01, row1->0x02, row2->0x04, row3->0x40
	// 右列：row0->0x08, row1->0x10, row2->0x20, row3->0x80
	const left = [0x01, 0x02, 0x04, 0x40];
	const right = [0x08, 0x10, 0x20, 0x80];
	return (col === 0 ? left : right)[row] ?? 0;
}

export interface ChartSeries {
	label: string;
	/** 数值序列，索引 0 是最旧的数据 */
	values: number[];
}

/** 一个字符格子的绘制结果 */
export interface ChartGlyph {
	/** braille 字符；" " 表示该格无点 */
	char: string;
	/** 命中的序列下标；多序列命中同一格时取下标最小的；无点时为 -1 */
	series: number;
}

/**
 * 把多组序列画成 braille 点阵，并保留**每格命中的序列下标**。
 *
 * 之所以要单独的入口：多序列同格时点阵需要按位或合并（否则两线相交处会断），
 * 但一个字符格只能有一种颜色。调用方若需要按序列着色（如网络图的 RX/TX 用不同颜色），
 * 就得知道每格归哪个序列。`renderChart` 是它的单色包装。
 */
export function renderChartGlyphs(
	series: ChartSeries[],
	width: number,
	height: number,
	yMax?: number,
	opts?: { stretch?: boolean; slots?: number },
): ChartGlyph[][] {
	if (width <= 2 || height <= 0) return [];
	const subW = width * 2; // 子像素列数
	const subH = height * 4; // 子像素行数

	// 所有序列共用的数据点数量（取最长）
	const maxLen = Math.max(0, ...series.map((s) => s.values.length));
	if (maxLen === 0) return [];

	// y 轴上限：显式值也要归一化（yMax=0/负数/NaN 会让 v/top 变 NaN → 坐标 NaN → 越界崩溃）
	let top = yMax;
	if (top === undefined) {
		top = 0;
		for (const s of series) for (const v of s.values) if (v > top) top = v;
	}
	if (!Number.isFinite(top) || top <= 0) top = 1;

	// 每张图一个点阵缓冲（[行][列]）
	const grids: number[][][] = series.map(() =>
		Array.from({ length: subH }, () => new Array<number>(subW).fill(0)),
	);

	series.forEach((s, si) => {
		const grid = grids[si];
		if (!grid) return;
		const n = s.values.length;
		if (n === 0) return;
		// 把数据点映射到子像素坐标。
		// 默认右侧对齐（与 bottom 一致）：x 轴代表固定时间窗，最新数据在最右、历史向左延伸。
		// 传 opts.stretch 则拉伸铺满，避免启动初期图表过空。
		const pts: Array<{ x: number; y: number }> = [];
		const stretch = opts?.stretch ?? false;
		// slots（时间比例槽）：整个 x 轴 = slots 个数据点。
		// 一点占 `subW / slots` 个子像素列 —— 这个比例**不随已有多少点而变**，
		// 所以“一秒”在屏幕上的宽度是恒定的，x 轴标签的时长才是诚实的。
		// （对比 `stretch=false` 的旧路径：那里一点 = 一子像素列，
		//  满窗口 60 点只能填满 60/subW 的宽度，右侧会空着。）
		const slots =
			Number.isFinite(opts?.slots) && (opts?.slots as number) > 0
				? Math.floor(opts?.slots as number)
				: 0;
		const perSlot = slots > 0 ? subW / slots : 0;
		// stretch：把现有历史线性铺满整宽。
		// 关键不变量是「最新数据在最右列」—— `i/(n-1)*(subW-1)` 在 n>=2 时
		// 末点必然落 subW-1（右边缘）；只有 n=1 时这个式子退化成 0，
		// 单点会被画到**最左列**，与「最右=now」的语义相反（启动第一个采样点就会看到）。
		// 所以先把单点的拉伸位置定下来，再走通用映射。
		const stretchedX = (i: number): number => {
			if (n === 1) return subW - 1;
			return Math.round((i / (n - 1)) * (subW - 1));
		};
		for (let i = 0; i < n; i++) {
			// 三种定位方式（优先级从高到低）：
			//  slots   —— 时间比例：一点 = subW/slots 列，最新点在右边缘
			//  stretch —— 拉伸铺满（启动期观感好，但 x 轴不代表固定时长）
			//  默认    —— 右对齐，一点 = 一子像素列（bottom 的做法）
			let x: number;
			if (slots > 0) {
				// 最新点贴右边缘，历史向左按槽宽排开
				x = Math.round(subW - 1 - (n - 1 - i) * perSlot);
			} else if (stretch) {
				x = stretchedX(i);
			} else {
				x = subW - n + i;
			}
			if (x < 0 || x >= subW) continue; // 超过窗口的旧数据丢弃
			const raw = s.values[i] ?? 0;
			// NaN / Infinity 容错：污染物直接当 0，避免整张图被毁
			const v = Number.isFinite(raw) ? Math.max(0, Math.min(top, raw)) : 0;
			// y: 0 在底部 → subH-1
			const y = Math.round((1 - v / top) * (subH - 1));
			if (!Number.isFinite(y)) continue; // 兑底：坐标非有限就不画，避免越界
			pts.push({ x, y: Math.max(0, Math.min(subH - 1, y)) });
		}
		// 用 Bresenham 把相邻点连成线，避免锯齿断裂
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1];
			const b = pts[i];
			if (a && b) plotLine(grid, a, b);
		}
		// 只有 1 个点时 Bresenham 无从画线，手工打点（双重防御：行/列都先取再写）
		const solo = pts[0];
		if (pts.length === 1 && solo) {
			const row = grid[solo.y];
			if (row) row[solo.x] = 1;
		}
	});

	// 把点阵合成 braille 字符。
	// 多序列在同一格命中时用**位或合并**（而非后画覆盖），这样两线相交处不会丢线；
	// 代价是该格只能用一种颜色，因此取第一个命中的序列颜色。
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
 * 把多组序列画成一张 braille 折线图（单色）。
 *
 * @param series   曲线（各自带标签，用于图例）
 * @param width    字符宽度
 * @param height   字符高度（行数）
 * @param yMax     纵轴上限（固定值；传 undefined 则自动取各序列最大值）
 * @param opts.stretch  数据点少于可用列数时是否拉伸铺满。
 *                      false（默认）= 右侧对齐，x 轴严格对应固定时间窗（与 bottom 一致），
 *                      但启动初期因历史尚短，曲线只占右侧一小段；
 *                      true = 把现有历史拉伸铺满整宽，启动即可看清趋势（x 轴含义="当前缓冲区全部内容"）。
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

/** Bresenham 直线，写入点阵 */
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
	// guard 按实际最长边推导，避免极宽图被 10000 提前截断
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
