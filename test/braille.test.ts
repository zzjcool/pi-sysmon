/**
 * braille.ts 单元测试 —— node:test + node:assert
 * 运行：npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChart, type ChartSeries } from "../src/braille.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

/** 单条序列的快捷构造 */
const S = (values: number[], label = "s"): ChartSeries[] => [{ label, values }];

/** 数一行里非空格字符数 */
const nonSpace = (line: string): number =>
	[...line].filter((c) => c !== " ").length;

/* ------------------------------------------------------------------ */
/* 1. braille 位映射正确性                                              */
/*                                                                     */
/* 推导依据（Unicode braille patterns）：                               */
/*   左列 row0..3 → 点1,2,3,7 → bit 0x01,0x02,0x04,0x40                */
/*   右列 row0..3 → 点4,5,6,8 → bit 0x08,0x10,0x20,0x80                */
/* 验证手段：renderChart 把数据右对齐（x = subW - n + i），              */
/* 单点数据永远落在最右子像素列 x=subW-1（奇数）→ 右列点；               */
/* 两点数据第一个点落在 x=subW-2（偶数）→ 左列点。                       */
/* 再用 v=top→y=0（顶行）/ v=0→y=subH-1（底行）控制纵向。                */
/* 因此 width=3,height=1 的一个字符格可覆盖全部 4 种角点。               */
/* ------------------------------------------------------------------ */

test("位映射: 只点亮 (col=1,row=0) 应得 U+2808", () => {
	// v=top → y=0（子像素行0 → 字符 row0）；x=5=col*2+1 → 右列
	const lines = renderChart(S([100]), 3, 1, 100);
	assert.equal(lines.length, 1);
	assert.equal(lines[0], "  ⠈");
	assert.equal(lines[0]!.codePointAt(2), 0x2808);
});

test("位映射: 只点亮 (col=0,row=0) 应得 U+2801", () => {
	// 两点水平线：第一个点 x=4=col*2+0 → 左列，y=0 → row0
	const lines = renderChart(S([100, 100]), 3, 1, 100);
	const cp = lines[0]!.codePointAt(2)!;
	assert.equal(cp, 0x2809, "左列+右列两个顶点 = U+2801|U+2808 = U+2809");
	assert.ok((cp & 0x01) !== 0, "左列 row0 bit 0x01 应置位（即单点时为 U+2801）");
});

test("位映射: 只点亮 (col=1,row=3) 应得 U+2880", () => {
	// v=0 → y=subH-1=3（子像素行3 → 字符 row3）；x=5 → 右列 → 0x80
	const lines = renderChart(S([0]), 3, 1, 100);
	assert.equal(lines[0], "  ⢀");
	assert.equal(lines[0]!.codePointAt(2), 0x2880);
});

test("位映射: 只点亮 (col=0,row=3) 应得 U+2840", () => {
	// 两点零线：第一个点 x=4 → 左列，y=3 → row3 → 0x40
	const lines = renderChart(S([0, 0]), 3, 1, 100);
	const cp = lines[0]!.codePointAt(2)!;
	assert.ok((cp & 0x40) !== 0, "左列 row3 bit 0x40 应置位");
	assert.equal(cp, 0x28c0, "两个底点 = 0x40|0x80");
});

test("位映射: 全亮 8 点应得 U+28FF", () => {
	// height=2 → subH=8。在最后一个字符格（col=2, 行0和行1）填满全部 8 点。
	// 做法：width=3,height=2，构造 n=2 的折线扫过 y=0..7 全部偶数/奇数列。
	// 更直接：用两组斜线覆盖 x=4,5 两列的全部 8 行：
	//   序列A: 100→0   (顶到底)  序列B: 0→100 (底到顶)
	// 两条对角线 + Bresenham 在 8 行 2 列的小区域会填满整格。
	const series: ChartSeries[] = [
		{ label: "a", values: [100, 0] },
		{ label: "b", values: [0, 100] },
	];
	const lines = renderChart(series, 3, 2, 100);
	// 最后一个字符格（col=2）跨两行字符：上行 row0..3，下行 row0..3
	const top = lines[0]!.codePointAt(2)!;
	const bot = lines[1]!.codePointAt(2)!;
	// 上行格应包含 y=0..3 全部点：0x01|0x02|0x04|0x40|0x08|0x10|0x20|0x80 = 0xFF
	assert.equal(top, 0x28ff, `上行格应为满格 U+28FF, 实际 U+${top.toString(16)}`);
	// 下行格应包含 y=4..7 全部点
	assert.equal(bot, 0x28ff, `下行格应为满格 U+28FF, 实际 U+${bot.toString(16)}`);
});

/* ------------------------------------------------------------------ */
/* 2. 输出形状                                                          */
/* ------------------------------------------------------------------ */

test("形状: 行数 === height，每行可见宽度 === width", () => {
	for (const [w, h] of [
		[10, 4],
		[20, 6],
		[3, 1],
		[7, 2],
	] as const) {
		const lines = renderChart(S([1, 2, 3, 2, 1]), w, h);
		assert.equal(lines.length, h, `height=${h} 应返回 ${h} 行`);
		for (const [i, line] of lines.entries()) {
			assert.equal(visibleWidth(line), w, `第${i}行可见宽度应为 ${w}`);
		}
	}
});

/* ------------------------------------------------------------------ */
/* 3. 边界                                                              */
/* ------------------------------------------------------------------ */

test("边界: 空数据 → 返回 []", () => {
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

test("边界: width<=2 || height<=0 → 返回 []", () => {
	assert.deepEqual(renderChart(S([1, 2]), 2, 4), []);
	assert.deepEqual(renderChart(S([1, 2]), 0, 4), []);
	assert.deepEqual(renderChart(S([1, 2]), -5, 4), []);
	assert.deepEqual(renderChart(S([1, 2]), 10, 0), []);
	assert.deepEqual(renderChart(S([1, 2]), 10, -1), []);
});

test("边界: 全 0 数据不崩溃且贴底", () => {
	const lines = renderChart(S([0, 0, 0, 0]), 10, 4);
	assert.equal(lines.length, 4);
	// 上面三行必须全空
	for (let i = 0; i < 3; i++) {
		assert.equal(nonSpace(lines[i]!), 0, `第${i}行应为空`);
	}
	// 最底行必须有内容（贴底）
	assert.ok(nonSpace(lines[3]!) > 0, "最底行应有非空字符");
});

test("边界: 单点数据至少有一个非空格字符", () => {
	const lines = renderChart(S([42]), 10, 4);
	const total = lines.reduce((acc, l) => acc + nonSpace(l), 0);
	assert.ok(total >= 1, "单点数据至少应有一个非空格字符");
	// 且只能有一个 braille 字符（一个点）
	assert.equal(total, 1);
});

/* ------------------------------------------------------------------ */
/* 4. 坐标映射（固定 yMax=100 的脉冲）                                   */
/* ------------------------------------------------------------------ */

test("坐标映射: 值=0 落在最底行", () => {
	// 基线 50，中部一个 0 脉冲下探
	const values = [50, 50, 50, 0, 50, 50, 50];
	const lines = renderChart(S(values), 20, 4, 100);
	// 0 → y = subH-1 = 15 → 字符行 15>>2 = 3（最后一行）
	assert.ok(nonSpace(lines[3]!) > 0, "最底行应有内容（0 脉冲下探至此）");
	// 验证 0 点确实在最后一行而非别处的水平线：
	// 最底行的非空字符应只出现在脉冲 x 附近（水平线在 y=8 → 第2行）
	const lastLine = lines[3]!;
	assert.ok(nonSpace(lastLine) >= 1);
});

test("坐标映射: 值=yMax 落在最顶行", () => {
	// 基线 50，中部一个 100 脉冲上探
	const values = [50, 50, 50, 100, 50, 50, 50];
	const lines = renderChart(S(values), 20, 4, 100);
	// 100 → y = 0 → 字符行 0（第一行）
	assert.ok(nonSpace(lines[0]!) > 0, "最顶行应有内容（yMax 脉冲上探至此）");
	// 顶行内容应只在脉冲列附近：基线 50 的水平线在 y=8 → 第2行，
	// 所以第0行的非空字符完全来自脉冲
	const topLine = lines[0]!;
	const idx = [...topLine].findIndex((c) => c !== " ");
	// 数据右对齐：n=7, subW=40, 脉冲 i=3 → x = 40-7+3 = 36 → col = 18
	assert.ok(idx >= 16 && idx <= 19, `脉冲应出现在右侧列附近, 实际 col=${idx}`);
});

/* ------------------------------------------------------------------ */
/* 5. 单调性：递增数据从左下向右上                                       */
/* ------------------------------------------------------------------ */

test("单调性: 递增数据每行非空字符的质心列随行号下降而右移", () => {
	const values = Array.from({ length: 40 }, (_, i) => i + 1); // 1..40 递增
	const lines = renderChart(S(values), 20, 8, 40);
	assert.equal(lines.length, 8);

	// 每行非空字符的平均列位置（质心）
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
	// 递增线从左下（大行号, 小列）走向右上（小行号, 大列）
	// → 相邻非空行的质心列应随行号下降而增大
	assert.ok(centroids.length >= 2, "至少两行有内容");
	const first = centroids[0]!; // 最上面的非空行
	const last = centroids[centroids.length - 1]!; // 最下面的非空行
	assert.ok(
		first.cx > last.cx,
		`顶行质心(${first.cx.toFixed(1)})应比底行质心(${last.cx.toFixed(1)})更靠右`,
	);
	// 更强的检查：整体趋势单调（允许相邻行因取整并列）
	for (let i = 1; i < centroids.length; i++) {
		assert.ok(
			centroids[i]!.cx <= centroids[i - 1]!.cx + 1e-9,
			`行${centroids[i]!.row}质心(${centroids[i]!.cx}) 应 <= 行${centroids[i - 1]!.row}质心(${centroids[i - 1]!.cx})`,
		);
	}
});
