/**
 * chart-panel / blocks 的布局与安全测试。
 *
 * 这里最重要的不是"排版好不好看"，而是**两条会让 pi 崩掉或错位的硬约束**：
 *  1. 任何一行的可见宽度都不能超过终端宽度 —— 超了 pi 会抛
 *     "Rendered line exceeds terminal width" 并**直接退出**（tui-main-screen.js:485）；
 *  2. 同一个宽度下，面板行数必须恒定 —— 行数变化会让编辑器上下位移，
 *     破坏锚定在屏幕坐标的鼠标选区（表现为"复制不了文字"）。
 *
 * 所以下面有对 8..220 全宽度、多个高度与块数组合的**扫描测试**，
 * 而不是只测几个"看起来正常"的宽度。
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
 * 测试用：显式开启「自动回落」的旧默认比例（量程窗 = 显示窗的 1/6）。
 *
 * 现在 `DEFAULT_SCALE_WINDOW_FRAC` 是 `1`（量程窗 == 显示窗，20s → 62s），
 * 所以测自动回落的用例必须显式传这个值才能进入子窗口分支。
 */
const DEFAULT_SCALE_WINDOW_FRAC_OPT_IN = 1 / 6;
import { fmtBytes, type Snapshot } from "../src/metrics.ts";

/**
 * 带 ANSI 的假主题。**故意加转义序列** —— 宽度越界这类 bug 恰恰只在有 ANSI 时暴露
 * （用 `slice`/`padEnd` 做字符串手术会把转义符算进长度）。
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
/** 无 ANSI 的纯文本主题，便于断言字符位置 */
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

/** 造一段有起伏的历史（避免全 0 让图形退化成一条线，掩盖坐标 bug） */
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
	};
}

/* ------------------------------------------------------------------ */
/* 1. 列数断点                                                         */
/* ------------------------------------------------------------------ */

test("chooseColumns: count=4 时 ≥96 用 4 列，48..95 用 2 列（消灭 3+1 空位）", () => {
	// 旧逻辑上限 3 列，4 块（showDisks）在宽终端下摆成 3+1，
	// 第 4 格是一整行空白。新逻辑：count>=4 且宽度装得下 4 块时用 4 列。
	assert.equal(chooseColumns(95, 4), 2);
	assert.equal(chooseColumns(96, 4), 4);
	assert.equal(chooseColumns(220, 4), 4);
	assert.equal(chooseColumns(72, 4), 2);
	assert.equal(chooseColumns(47, 4), 1);
});

test("chooseColumns: count=3 行为不变（回归）", () => {
	// 3 块的断点必须与原实现逐点一致：≥72 → 3 列，48..71 → 2 列，<48 → 1 列
	assert.equal(chooseColumns(72, 3), 3);
	assert.equal(chooseColumns(96, 3), 3);
	assert.equal(chooseColumns(150, 3), 3);
	assert.equal(chooseColumns(48, 3), 2);
	assert.equal(chooseColumns(47, 3), 1);
	// 不传 count 时默认 3：保护所有老的单参数调用方
	for (let w = 40; w <= 220; w += 7) {
		assert.equal(chooseColumns(w), chooseColumns(w, 3), `w=${w}`);
	}
});

test("computeLayout: count=4 在 ≥96 时是 4×1 单组，无空位", () => {
	// 96 列：4 块正好摆一排（每块 24 列），共 6+2=8 行
	const l96 = computeLayout(96, 6, 4, 18);
	assert.equal(l96.cols, 4);
	assert.equal(l96.bands, 1);
	assert.equal(l96.plotRows, 6);
	assert.equal(l96.totalRows, 8);
	// 150 列同理，且列宽之和严格等于总宽
	const l150 = computeLayout(150, 6, 4, 18);
	assert.equal(l150.cols, 4);
	assert.equal(l150.bands, 1);
	assert.equal(l150.totalRows, 8);
	assert.equal(
		l150.widths.reduce((a, b) => a + b, 0),
		150,
		JSON.stringify(l150.widths),
	);
	// 72 列：以前会摆 3 列（3+1 空位），现在摆 2×2，共 2×(6+2)=16 行
	const l72 = computeLayout(72, 6, 4, 18);
	assert.equal(l72.cols, 2);
	assert.equal(l72.bands, 2);
	assert.equal(l72.totalRows, 16);
});

test("computeLayout: count=4 全宽度 totalRows ≤ maxRows 且 plotRows ≥ 2", () => {
	// 预算契约：4 块、任何宽度下都不超行数预算，绘图行不低于 MIN_PLOT_ROWS。
	// 4×1 / 2×2 / 1×4 三种摆法都要覆盖，所以扫整个宽度区间。
	for (let w = 1; w <= 220; w++) {
		const l = computeLayout(w, 6, 4, 18);
		assert.ok(l.totalRows <= 18, `w=${w}: totalRows=${l.totalRows} > 18`);
		assert.ok(l.plotRows >= 2, `w=${w}: plotRows=${l.plotRows} < 2`);
	}
});

test("chooseColumns: 断点严格按宽度，且是纯函数", () => {
	assert.equal(chooseColumns(MIN_BLOCK_W * 3 - 1), 2);
	assert.equal(chooseColumns(MIN_BLOCK_W * 3), 3);
	assert.equal(chooseColumns(MIN_BLOCK_W * 2 - 1), 1);
	assert.equal(chooseColumns(MIN_BLOCK_W * 2), 2);
	assert.equal(chooseColumns(MIN_BLOCK_W - 1), 1);
	assert.equal(chooseColumns(500), 3);
	// 纯函数：同样的输入永远同样的输出（列数不能随数据抖动）
	for (const w of [50, 60, 90, 120]) {
		assert.equal(chooseColumns(w), chooseColumns(w));
	}
});

test("computeLayout: 列宽之和严格等于总宽（既不越界也不留缝）", () => {
	for (let w = 1; w <= 300; w++) {
		for (const count of [3, 4]) {
			const l = computeLayout(w, 4, count, 18);
			const sum = l.widths.reduce((a, b) => a + b, 0);
			assert.equal(sum, w, `width=${w} count=${count} sum=${sum}`);
			assert.equal(l.widths.length, l.cols);
			assert.equal(l.bands, Math.ceil(count / l.cols));
			// 余数分给靠前的块 → 宽度单调不增
			for (let i = 1; i < l.widths.length; i++) {
				assert.ok((l.widths[i] ?? 0) <= (l.widths[i - 1] ?? 0));
			}
		}
	}
});

test("computeLayout: 行数 = 组数 × (绘图行 + 4) 且绘图行不低于下限", () => {
	for (let w = 1; w <= 300; w += 7) {
		for (const chartH of [1, 2, 4, 6]) {
			const l = computeLayout(w, chartH, 3, 18);
			assert.ok(l.plotRows >= 1);
			assert.equal(l.totalRows, l.bands * (l.plotRows + BLOCK_CHROME_ROWS));
		}
	}
});

/* ------------------------------------------------------------------ */
/* 2. 刻度（对齐 bottom）                                              */
/* ------------------------------------------------------------------ */

test("percentAxis: 只标顶端 `100%`，量程固定", () => {
	// 改成只标一个值（用户要求：「0% 可以不用限制，就顶部显示最大的就可以」）。
	// 0% 的位置就是底部基线，本身已一目了然，而且在叠印刻度下会与曲线打架。
	const a = percentAxis();
	assert.deepEqual(a.labels, ["100%"]);
	// 量程仍固定 100.5（不随数据变，不同时间可直接对比）；
	// 用 100.5 而不是 100 是 bottom 的做法，让 100% 那格不被切掉。
	assert.equal(a.max, 100.5);
	// 不管传什么 dataMax，量程都不能变（百分比图是固定量程）
	assert.equal(percentAxis().max, a.max);
});

test("rateAxis: 只标顶端一个值，带单位且定宽 5 列", () => {
	// 单标签 = 量程上限（max×1.5）。
	const a = rateAxis(100_000); // 100 KB/s → upper = 150 000 < 1 MiB → K 单位
	assert.equal(a.max, 150_000);
	assert.equal(a.labels.length, 1, "只应有一个顶端刻度");
	// 必须带单位：否则屏幕上一个光秃秃的 `150.0` 看不出是 B 还是 MB
	assert.ok(a.labels[0]?.includes("KB"), JSON.stringify(a.labels[0]));
	// 定宽：叠印宽度稳定，不逐帧抖动
	assert.equal(a.labels[0]?.length, RATE_GUTTER, JSON.stringify(a.labels[0]));
});

test("rateAxis: 单位随量程切换 B/K/M/G，且总带单位", () => {
	const one = (dm: number) => rateAxis(dm).labels[0] ?? "";
	assert.ok(one(100).includes("B"), one(100));
	assert.ok(one(10 * 1024).includes("KB"), one(10 * 1024));
	assert.ok(one(10 * 1024 ** 2).includes("MB"), one(10 * 1024 ** 2));
	assert.ok(one(10 * 1024 ** 3).includes("GB"), one(10 * 1024 ** 3));
	// 空数据：不能塔成 `0.0`，给个最小可用量程
	const a = rateAxis(0);
	assert.equal(a.max, 1.5);
	assert.ok(a.labels[0]?.includes("B"), a.labels[0]);
	// 非零值不受影响（量程仍是 max×1.5）
	assert.equal(rateAxis(1).max, 1.5);
	assert.equal(rateAxis(10).max, 15);
});
test("rateAxis: 含 NaN / Infinity / 负数 的输入不产生 NaN 量程与 NaN 标签", () => {
	for (const bad of [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		-5,
	]) {
		const a = rateAxis(bad);
		assert.ok(Number.isFinite(a.max) && a.max > 0, `max=${a.max} for ${bad}`);
		for (const l of a.labels) {
			assert.ok(!l.includes("NaN"), `标签里出现 NaN：${l}（输入 ${bad}）`);
			assert.ok(
				!l.includes("Infinity"),
				`标签里出现 Infinity：${l}（输入 ${bad}）`,
			);
		}
	}
});

test("plotWidthFor: 绘图区拿到整个内宽（刻度不再占列）", () => {
	// 旧几何：`│` + gutter(4) + `│` + 曲线 → plotW = bw - 2 - 1 - 5。
	// 新几何：刻度**叠印**在曲线左侧，不再占列 → plotW = bw - 2。
	// 这就是「图表利用率变大」的来源（50 列块从 42 提到 48 列）。
	for (let w = MIN_BLOCK_W; w <= 120; w++) {
		const p = plotWidthFor(w);
		assert.ok(p >= 1);
		assert.equal(p, Math.max(6, w) - 2, `bw=${w}`);
		// 与 blockMetrics 必须一致（两处共用一份账）
		assert.equal(p, blockMetrics(w, RATE_GUTTER).plotW, `bw=${w}`);
	}
	// 利用率确实比旧几何高：旧公式是 bw-8，新公式是 bw-2，恒多 6 列
	for (const bw of [24, 30, 50, 60, 100]) {
		assert.equal(plotWidthFor(bw) - (bw - 8), 6, `bw=${bw} 应比旧几何多 6 列`);
	}
});

test("blockMetrics: 太窄时不叠刻度（宁可没刻度也不把曲线挤扁）", () => {
	// 叠印需要「刻度宽度 + 留点空间给曲线」，不够就整块不画刻度
	for (let w = 6; w <= 60; w++) {
		const m = blockMetrics(w, RATE_GUTTER);
		assert.ok(m.plotW >= 1, `bw=${w}`);
		assert.equal(m.plotW, Math.max(6, w) - 2, `bw=${w}`);
		// 不画刻度时必须是因为宽度真不够，而不是别的原因
		if (!m.showAxis) {
			assert.ok(
				m.plotW < Math.max(10, RATE_GUTTER + 4),
				`bw=${w} 没理由不画刻度（plotW=${m.plotW}）`,
			);
		}
	}
});

/* ------------------------------------------------------------------ */
/* 3. 硬约束：宽度不越界 + 行数恒定（全宽度扫描）                        */
/* ------------------------------------------------------------------ */

test("扫描: 任意宽度下每行可见宽度 <= 终端宽度（越界会让 pi 退出）", () => {
	const hist = fakeHist(200);
	const snap = fakeSnap();
	// count 必须由 **blocks.length** 导出，不能手算。
	// 曾经这里写的是 `const count = showDisks ? 4 : 3`，而 Tokens 默认开，
	// 于是 showDisks=false 的分支是「4 块渲染进 3 格网格」—— 第 4 块
	// 永远不会被 renderPanel 索引到，**静默丢弃**。
	// 结果是：本仓库最重要的崩溃防线（越界 = pi 退出）对 Tokens 块
	// 一次都没验证过，测试却在绿。用 blocks.length 就没有这种双账本。
	const variants = [
		{},
		{ showTokens: false },
		{ showDisks: true },
		{ showTokens: false, showDisks: true },
	] as const;
	// 非零读数：`fmtTps(0)="0 tok/s"` 会走短分支，测不到长读数越界
	const readings = { tpsNow: 12345, tpsTotal: 1234567 };
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
				// 行数必须等于布局声明的行数（否则编辑器会位移）
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

test("扫描: 任意宽度下行数等于布局声明的行数（行数必须恒定）", () => {
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

test("行数恒定: 有数据 / 无数据返回同样的行数（否则编辑器会位移）", () => {
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
		// 无数据时也不能越界（空路径是最容易漏测的分支）
		for (const line of noData) assert.ok(visibleWidth(line) <= w, `width=${w}`);
	}
});

/* ------------------------------------------------------------------ */
/* 4. 边框闭合与标签可辨识性                                            */
/* ------------------------------------------------------------------ */

test("每块都是一个闭合的框：上边框 ┌┐、下边框 └┘ 且各角对齐", () => {
	const layout = computeLayout(150, 4, 4, 18);
	const lines = renderPanel(
		plainTheme,
		buildBlocks(fakeHist(120), fakeSnap(), { points: 80 }),
		150,
		layout,
		60,
	);
	// 断言要跟**声明的列数**走，不能写死 3：四图默认下
	// 150 列是 4×1 布局（cols=4），写死 3 会让这条测试在 4 图时
	// 不小心变成“扫掉最后一块也能过”的假绿测试。
	// 宽度也不能用 `w * cols`：`evenSplit` 把余数分给靠前的块，
	// 各列不一定等宽（4 列分 150 → 38/38/37/37），所以要求和。
	const totalW = layout.widths.reduce((a, b) => a + b, 0);
	assert.equal(totalW, 150, "列宽之和必须等于总宽");
	assert.equal((lines[0] ?? "").length, totalW);
	assert.ok((lines[0] ?? "").startsWith("┌"));
	assert.ok((lines[0] ?? "").includes("┐┌"));
	assert.ok((lines[0] ?? "").endsWith("┐"));
	const last = lines[lines.length - 1] ?? "";
	assert.ok(last.startsWith("└"), last);
	assert.ok(last.endsWith("┘"), last);
	// 下边框与边框的角必须落在同一列
	assert.equal(lines[0]?.indexOf("┐"), last.indexOf("┘"));
});

test("下边框上方不应多出一条横线（回归）", () => {
	// 我把 x 轴线改成「下边框兼任」时，忘了删绘图区最后一行那条 0 基线，
	// 于是绘图区末行 `│───…───│` 紧贴下边框 `└──…──┘`，
	// 看上去就是**下方多了一条线**（用户实际看图反馈的）。
	//
	// 该不变式：除了上/下边框那一行，绘图行里不应出现连续的长横线。
	// （曲线本身是 braille，不会产生 `─`；`─` 只属于边框/分隔装饰。）
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
			// 逐块检查：绘图行（除首行上边框、末行下边框）不应有 ≥3 个连续 `─`
			for (let band = 0; band < layout.bands; band++) {
				for (let c = 0; c < layout.cols; c++) {
					const lo = c * bw;
					const inner = layout.plotRows; // 绘图行数
					// 该块的绘图行区间：跳过该组的上边框（第 0 行）与下边框（最后一行）
					const start = band * (inner + BLOCK_CHROME_ROWS) + 1;
					for (let r = start; r < start + inner; r++) {
						const seg = (lines[r] ?? "").slice(lo, lo + bw);
						assert.ok(
							!/─{3,}/.test(seg),
							`w=${w} h=${h} 块(${band},${c}) 行 ${r} 出现多余横线：${JSON.stringify(seg)}`,
						);
					}
				}
			}
		}
	}
});

test("每块标题里带指标名（解决『不知道哪个图是什么』）", () => {
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
	// CPU 的标题栏应带 1/5/15 分钟负载（对齐 bottom）
	assert.ok(head.includes("1.23 4.56 7.89"), head);
});

test("y 轴刻度与 x 时间标签都渲染出来", () => {
	const layout = computeLayout(150, 4, 4, 18);
	const lines = renderPanel(
		plainTheme,
		buildBlocks(fakeHist(120), fakeSnap(), { points: 80 }),
		150,
		layout,
		60,
	);
	const all = lines.join("\n");
	assert.ok(all.includes("100%"), "缺 y 轴上限刻度");
	assert.ok(all.includes("0%"), "缺 y 轴 0 刻度");
	assert.ok(/─/.test(all), "缺 x 轴线");
	assert.ok(all.includes("0s"), "缺 x 轴右端时间标签");
});

test("窄块自动降级：放不下刻度时丢刻度保曲线，且仍不越界", () => {
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
		// 标题名只有块宽足够时才保得住："CPU" 要 3 列，再加上 `┌ `、
		// 至少 1 列 fill 与 `┐`，最少需要 7 列（“CPU”+边框 4 列）。
		// 比这更窄时只能展示部分名字（或者完全放不下），不能硬声称名字一定在。
		if (w >= 8) assert.ok((lines[0] ?? "").includes("CPU"), `w=${w} 丢了标题`);
		// 不管多窄，边框都必须闭合：这是“哪张图”的最后依据
		assert.ok((lines[0] ?? "").startsWith("┌"), `w=${w} 缺左上角`);
		assert.ok((lines[0] ?? "").endsWith("┐"), `w=${w} 缺右上角`);
	}
});

test("浮动读数框：`PI_SYSMON_LABEL=box` 时才显示，且过窄则整块隐藏", () => {
	const hist = fakeHist(120);
	// 显式指定 box 模式 —— 默认已是 `title`（读数在边框标题栏），
	// 所以测浮动框必须自己开，不能依赖默认值。
	const blocks = () =>
		buildBlocks(hist, fakeSnap(), { points: 80, labelMode: "box" });
	// 很宽 → 显示 AVG 框
	const wide = renderPanel(
		plainTheme,
		blocks(),
		150,
		computeLayout(150, 4, 4, 18),
		60,
	).join("\n");
	assert.ok(wide.includes("AVG"), "宽终端应显示 CPU 浮动读数框");
	// 很窄 → 不显示，且不能留下孤立的框线
	const narrow = renderPanel(
		plainTheme,
		blocks(),
		24,
		computeLayout(24, 3, 1, 18),
		60,
	).join("\n");
	assert.ok(!narrow.includes("AVG"), "窄终端不该显示浮动读数框");
});

test("Network 读数展示累计总流量（回归：它曾经从来不显示）", () => {
	// 曾经的 bug：Network 的浮框**从来没渲染出来过**，两个原因叠加：
	//  1. 宽度规则要求「留 40% 曲线」，而它的文字最长（两行 RX/TX）；
	//  2. 高度规则 `legendH + 1 <= rows`，两行浮框 legendH=4、默认绘图区 4 行。
	// 现在默认把读数放在**边框标题栏**（`PI_SYSMON_LABEL=title`）：
	// 那一行的 `─` 填充本就是纯装饰，拿来放读数零成本、也不遮曲线。
	const hist = fakeHist(120);
	const snap = fakeSnap({
		rxTotal: 129.8 * 1024 ** 3,
		txTotal: 178.9 * 1024 ** 3,
	});

	// ① 默认（title）模式：速率与累计流量都在标题栏，且**速率在前、总流量在后**
	const net = buildBlocks(hist, snap, { points: 80 }).find(
		(b) => b.name === "Network",
	);
	assert.ok(net, "应有 Network 块");
	const titleText = (net.titleInfo ?? []).map((s) => s.text).join("");
	assert.ok(
		titleText.includes("Σ"),
		`标题栏应含累计流量（Σ），实际：${JSON.stringify(titleText)}`,
	);
	assert.ok(
		/130G/.test(titleText) && /179G/.test(titleText),
		`应含 RX/TX 累计值（fmtBytes 会取整为 130G/179G）：${JSON.stringify(titleText)}`,
	);
	// 顺序关键：**速率在前、总流量在后**。因为标题栏宽度不够时从尾部丢，
	// 所以总流量会先被舍掉，而速率（图的主体）任何宽度下都保留。
	assert.ok(
		titleText.indexOf("K/s") < titleText.indexOf("Σ"),
		`瞬时速率应排在总流量之前，实际：${JSON.stringify(titleText)}`,
	);
	assert.deepEqual(net.legend, [], "title 模式下不应再画浮动框");

	// ② 默认模式下要真的渲染到屏幕上。
	// 速率排首位（且已含单位），在常见宽度下都应能看到；
	// 总流量是次要信息，只在块够宽时出现。
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
		assert.ok(/[↓↑]\d/.test(txt), `w=${w} 时 Network 速率未渲染`);
	}
	// 块够宽时总流量也要在
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
			`w=${w} 时 Network 累计总流量未渲染`,
		);
	}

	// ③ box 模式：浮框里同样要有累计流量
	const boxNet = buildBlocks(hist, snap, {
		points: 80,
		labelMode: "box",
	}).find((b) => b.name === "Network");
	const boxText = (boxNet?.legend ?? [])
		.map((l) => l.map((s) => s.text).join(""))
		.join("|");
	assert.ok(
		boxText.includes("Σ"),
		`box 模式浮框应含累计流量：${JSON.stringify(boxText)}`,
	);
});

/* ------------------------------------------------------------------ */
/* 读数位置（PI_SYSMON_LABEL）                                          */
/* ------------------------------------------------------------------ */

test("labelMode: title / box / both / none 四种模式行为正确", () => {
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
	// 不传 labelMode 时默认就是 title
	const def = buildBlocks(hist, snap, { points: 40 });
	assert.ok(
		def.every((x) => (x.titleInfo?.length ?? 0) > 0),
		"默认应是 title 模式",
	);
	assert.ok(
		def.every((x) => (x.legend?.length ?? 0) === 0),
		"默认不应画浮动框",
	);
});

test("title 模式：读数在边框标题栏里，行数与 none 模式完全相同（零成本）", () => {
	// 关键卖点：读数进标题栏不增加任何行、不遮曲线。
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
		assert.equal(withLabel.length, noLabel.length, `w=${w}: 行数变了`);
		assert.equal(withLabel.length, layout.totalRows, `w=${w}`);
		for (const l of withLabel) assert.ok(visibleWidth(l) <= w, `w=${w} 越界`);
	}
});

test("title 模式：读数按重要度降序，窄块丢次要信息但边框始终闭合", () => {
	// titleInfo 是**片段数组**，窄块时从尾部逐段丢弃。
	// 重要度顺序是「瞬时速率 > 累计总流量」：曲线画的是速率（图的主体），
	// 且速率排在前面，所以窄块先丢的是总流量。
	const net = buildBlocks(fakeHist(60), fakeSnap(), { points: 40 }).find(
		(b) => b.name === "Network",
	);
	assert.ok(net, "应有 Network 块");
	const all = (net.titleInfo ?? []).map((s) => s.text).join("");
	assert.ok(/[↓↑]/.test(all), `首段应是瞬时速率，实际 ${JSON.stringify(all)}`);
	assert.ok(
		all.indexOf("K/s") < all.indexOf("Σ"),
		`速率应在总流量之前，实际 ${JSON.stringify(all)}`,
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
		// 边框必须闭合：读数再怎么放不下，也不能把 `┐` 挤掉
		assert.ok(head.startsWith("┌"), `bw=${bw}: 缺左上角`);
		assert.ok(head.endsWith("┐"), `bw=${bw}: 缺右上角 ${JSON.stringify(head)}`);
		assert.equal(visibleWidth(head), bw, `bw=${bw}: 标题行宽度不对`);
		assert.ok(head.includes("Network"), `bw=${bw}: 丢了块名`);
		// 速率排首位 → 只要放得下一段就是它
		if (bw >= 34) {
			assert.ok(/[↓↑]\d/.test(head), `bw=${bw}: 应含瞬时速率`);
		}
	}
	// 总流量在宽块里要出现（宽度够才加，窄块先舍）
	const wide = renderPanel(
		plainTheme,
		[net],
		100,
		{ cols: 1, bands: 1, widths: [100], plotRows: 4, totalRows: 8 },
		60,
	);
	assert.ok((wide[0] ?? "").includes("Σ"), "宽块应含累计总流量");
});

test("浮动读数框：显示时必须是完整闭合的框，且不与 x 轴线重叠", () => {
	// 扫描宽度，凡是渲染出 AVG 的，都检查框的两个角都在、且下边框行号 < 轴线行号
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
		// 找出 AVG 所在行，它上面一行应是 ┌...┐，下面一行应是 └...┘
		const idx = lines.findIndex((l) => l.includes("AVG"));
		assert.ok(idx >= 1, `w=${w}: AVG 出现在第 0 行，没有上边框`);
		const top = lines[idx - 1] ?? "";
		const bottom = lines[idx + 1] ?? "";
		assert.ok(top.includes("┌") && top.includes("┐"), `w=${w}: 浮动框缺上边框`);
		assert.ok(
			bottom.includes("└") && bottom.includes("┘"),
			`w=${w}: 浮动框缺下边框`,
		);
		// 浮动框下边框不能压在 x 轴线的 └ 上（那是渲染坏了的观感）。
		// x 轴线以 `└─…─│` 结尾（横线接到右边框），浮动框下边框以 `└─…─┘` 结尾，
		// 用这个差异区分两者，否则会把浮动框自己的下边框误认为轴线。
		const axisRow = lines.findIndex((l) => /└─+│/.test(l));
		if (axisRow >= 0)
			assert.ok(idx + 1 < axisRow, `w=${w}: 浮动框下边框与 x 轴线重叠`);
	}
});

test("y 刻度行位置用 floor（对齐 ratatui 的整数除法，不是 round）", () => {
	// 实测依据：bottom 抓帧 Network 块、plotRows=8、4 个刻度，
	// 刻度落在 plot 行 {0, 2, 4, 7}（0KB 在底行 7、886.8 在顶行 0）。
	// ratatui 的 `render_y_labels` 里是 `i*(h-1)/(n-1)`（u16 除法 → floor）。
	// 若改成 Math.round，得到 {0,2,5,7} —— 第三个刻度差 1 行。
	// 所以这里用真实的 4 刻度块（Network）把行号钉死。
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
		// 量程 1000 → 4 个刻度：0.0 / 500.0 / 1000.0 / 1500.0，都是 5 字符宽
		series: [{ values: [0, 100, 500, 900, 200, 700] }],
		legend: [],
		axis: () => ({ labels: ["  0.0", "500.0", "1000.", "1500."], max: 1000 }),
	};
	const lines = renderPanel(plainTheme, [block], 60, layout, 60);
	// block 行 0 = 上边框，行 1..plotRows = plot
	const rowOf = (s: string) =>
		lines.findIndex((l, i) => i >= 1 && i <= plotRows && l.includes(s));
	const plotIdx = (s: string) => rowOf(s) - 1; // 转成 plot 内 0-based 行号
	assert.equal(plotIdx("1500."), 0, "最大刻度应在 plot 首行");
	assert.equal(plotIdx("  0.0"), 7, "零刻度应在 plot 末行");
	// floor: i=2 → dy=floor(2*7/3)=4 → y=7-4=3
	assert.equal(
		plotIdx("1000."),
		3,
		"floor 公式下 1000. 应在 plot 行 3（round 会得到行 2）",
	);
	// floor: i=1 → dy=floor(7/3)=2 → y=5
	assert.equal(plotIdx("500.0"), 5, "floor 公式下 500.0 应在 plot 行 5");
});

test("健壮性: 零块 / 负宽度 / NaN 宽度都不崩且不越界", () => {
	// renderPanel / computeLayout 是导出函数，任何调用方都可能传坏值。
	// 以前负宽度会让 `" ".repeat(-2)` 抛 RangeError，
	// 零块则会被 `Math.max(1, count)` 掩盖成「有一块」的假布局。
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
	// 负宽度 + 有块：不能抛异常
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

test("健壮性: 非 ASCII 文本不破坏宽度账（CJK/组合符/零宽/全角/emoji）", () => {
	// 单元格模型的不变量是「每个 cell 恰好占一个显示列」，等价于
	// `row.length === visibleWidth(rowText)`。而 `visibleWidth` 按
	// `get-east-asian-width` 算，与「字符数」在三种情况下不等（均已实测）：
	//   · 宽字符（CJK/emoji/全角空格）→ visibleWidth 2，字符数 1 → 不补占位则行**变宽** → pi 退出
	//   · 组合/零宽字符 → visibleWidth 0 → 不并入前格则后续内容相对边框**左移**
	// 本项目自己的文本全是 ASCII，但这三类必须防住，否则调用方传中文就会崩。
	const hist = fakeHist(60);
	const weird = [
		"处理器 CPU", // CJK（visibleWidth 2）
		"e\u0301\u0301 combining", // 组合附加符（visibleWidth 0）
		"zero\u200bwidth", // 零宽空格（visibleWidth 0）
		"full\u3000space", // 全角空格（visibleWidth 2）
		"emoji🙂test", // 表情（visibleWidth 2，代理对）
		"\u200bstart", // 开头就是零宽：没有可并入的前格，应丢弃而不是虚增列
		"µs−x", // 微/减号等 ambiguous 字符（visibleWidth 1，应保持 1）
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
			// 不越界（越界 = pi 抛异常退出）
			for (const [i, l] of lines.entries()) {
				assert.ok(
					visibleWidth(l) <= w,
					`文本 ${JSON.stringify(name)} w=${w} line ${i}: ${visibleWidth(l)} > ${w}`,
				);
			}
			// 行数恒定（非 ASCII 也不能改变行数）
			assert.equal(
				lines.length,
				layout.totalRows,
				`文本 ${JSON.stringify(name)} w=${w}`,
			);
			// 边框必须仍然闭合：非 ASCII 不得把角字符挤掉。
			// 注意不能用「最后一行 endsWith ┘」—— 3 块摆 2 列时右下角是**空位**，
			// 最后一行天然是空白。改为逐块检查其**左侧**单元格的边框闭合。
			//
			// 另一个陷阱：不能用 `String.slice(0, w0)` 切块！含 CJK 的字符串里
			// 一个码点占 2 显示列，`slice` 数的是码点，切出来的子串宽度会大于 w0，
			// 于是 `endsWith("┐")` 误报失败。这里按**显示列**累积切。
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
				`文本 ${JSON.stringify(name)} w=${w}: 首块宽度不对`,
			);
			assert.ok(
				head0.endsWith("┐"),
				`文本 ${JSON.stringify(name)} w=${w}: 首块右上角丢失 ${JSON.stringify(head0)}`,
			);
			// 最后一组的首块下边框应闭合（若该格被占用）
			const tail0 = firstBlock(lines[lines.length - 1] ?? "");
			assert.ok(
				tail0.endsWith("┘") || tail0.trim() === "",
				`文本 ${JSON.stringify(name)} w=${w}: 末块下边框异常 ${JSON.stringify(tail0)}`,
			);
		}
	}
});

test("健壮性: fmtBytes 对溢出值不吐超长字符串（否则撑破浮动框）", () => {
	// 计数器异常时可能拿到 1e308 这种值；走 toFixed 会产生 20+ 字符，
	// 而这段文本直接进浮动读数框 → 宽度暴涨把框挤坏。
	for (const big of [1e21, 1e308, Number.MAX_VALUE]) {
		const s = fmtBytes(big);
		assert.ok(s.length <= 6, `fmtBytes(${big}) = ${s}（过长）`);
	}
	assert.equal(fmtBytes(1e308), ">999T");
	// 正常值不受影响
	assert.equal(fmtBytes(0), "0B");
	assert.equal(fmtBytes(1536), "1.5K");
	assert.equal(fmtBytes(Number.NaN), "0B");
	assert.equal(fmtBytes(Number.POSITIVE_INFINITY), "0B");
});

test("tokenAxis: 所有量级下标签恒为 TPS_GUTTER 列且带 token 单位", () => {
	// 与 rateAxis 的定宽测试同款约束，但 tokenAxis 是**新代码**，必须自己验：
	//  1. 每个分支都必须恰好 TPS_GUTTER 列 —— 宽度一变，叠印区就变，
	//     绘图区左边界会逐帧左右跳（ARCHITECTURE 坑 6）。
	//  2. 单位必须是 token，**绝不能出现 KB/MB**：那正是复用 rateAxis 会造成的
	//     错单位 bug（1500 tok/s 会显示成 `2.2KB`）。
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
					`dm=${dm} → ${JSON.stringify(l)} 应恰好 ${TPS_GUTTER} 列`,
				);
				assert.ok(!l.includes("KB"), `dm=${dm} 不得出现字节单位: ${l}`);
				assert.ok(!l.includes("NaN"), `dm=${dm}: ${l}`);
				assert.ok(!l.includes("e+"), `dm=${dm}: ${l}`);
			}
		}
	}
	// 必须真的是 token 单位
	assert.ok(tokenAxis(1500).labels[0]?.includes("t/s"));
});

test("tokenAxis: 降精度回退不得吐 `1000Kt/s`（与 >999K 口径一致）", () => {
	// 真实踩到的 bug：`fit()` 在一位小数放不下时会降精度取整，
	// 但没处理取整后得 1000 的情况 —— 于是 `tokenAxis(666666)` 输出 `1000Kt/s`，
	// 与它自己的 `>999Kt/s` 钳制口径自相矛盾（而且 `1000K` 读着像 1M 却带 K 后缀）。
	//
	// 注意触发窗口很窄：需要 max = dm×1.5 落在 [999500, 1e6)。
	// 原来那条「全量级扫描」的乘数集恰好跳过了这个窗口，所以没抓住 ——
	// 这也是为什么要单独钉一条，而不是只靠扫描。
	for (const dm of [666666, 666333, 666667, 999999, 666600]) {
		const l = tokenAxis(dm).labels[0] ?? "";
		assert.ok(
			!l.includes("1000K"),
			`dm=${dm} 不得输出 1000K：${JSON.stringify(l)}`,
		);
		assert.equal(l.length, TPS_GUTTER, `dm=${dm}: ${JSON.stringify(l)}`);
	}
	// 降精度分支本身要能正常工作（不是只把它绕过去）
	assert.equal(tokenAxis(100_000).labels[0], " 150Kt/s");
});

test("tokenAxis: 量程下限 MIN_TPS_SCALE 与坏输入不崩", () => {
	// 下限的作用：空闲期一个 1 tok/s 的尾点不应把量程钉到 1.5，
	// 否则下一句 200 tok/s 的回复直接顶格。
	assert.equal(tokenAxis(0).max, MIN_TPS_SCALE);
	assert.equal(tokenAxis(1).max, MIN_TPS_SCALE, "1×1.5 < 10 → 下限接管");
	assert.equal(tokenAxis(100).max, 150, "正常值：max×1.5");
	// NaN/Infinity/负数必须先落回 0，否则会算出 NaN 坐标 → 越界崩溃
	for (const bad of [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		-5,
	]) {
		const a = tokenAxis(bad);
		assert.equal(a.max, MIN_TPS_SCALE, `tokenAxis(${bad}).max`);
		assert.ok(Number.isFinite(a.max));
		assert.equal(a.labels.length, 1, "只标顶端一个值");
		assert.equal(a.labels[0]?.length, TPS_GUTTER);
	}
});

test("fmtTokensTotal: 量级边界与宽度上界（对齐 pi footer）", () => {
	// 格式**逐字对齐** pi footer 的 `formatTokens`，包括**小写 k** ——
	// 这样图上的 `↑5.7k` 与 pi 底部那行可以直接对照。
	assert.equal(fmtTokensTotal(0), "0");
	assert.equal(fmtTokensTotal(999), "999");
	assert.equal(fmtTokensTotal(1500), "1.5k");
	assert.equal(fmtTokensTotal(5671), "5.7k");
	assert.equal(fmtTokensTotal(12345), "12k");
	assert.equal(fmtTokensTotal(1.2e6), "1.2M");
	assert.equal(fmtTokensTotal(1e9), ">999M");
	// 宽度上界：它是标题栏读数，越界会让 pi 退出
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
		assert.ok(s.length <= 7, `fmtTokensTotal(${v})="${s}" 过长`);
		assert.ok(!s.includes("e+"), `含科学计数法: ${s}`);
		assert.ok(!s.includes("NaN") && !s.includes("Infinity"), `坏值: ${s}`);
	}
});

test("buildBlocks: Tokens 块接线正确（上下行都显示，口径同 pi footer）", () => {
	// 只断言块名是不够的：若 series 串到了别的历史数组（如 hist.cpu），
	// 或者读数参数忘了传（恒 0），块名测试照样绿。
	const h = fakeHist(50);
	const tok = buildBlocks(h, fakeSnap(), {
		points: 30,
		tpsNow: 250,
		tokensIn: 5671,
		tokensOut: 11,
		tokensCacheRead: 640,
	}).find((b) => b.name === "Tokens");
	assert.ok(tok, "默认应有 Tokens 块（PI_SYSMON_TOKENS 默认开）");
	assert.deepEqual(
		tok.series[0]?.values,
		h.tps.slice(-30),
		"series 必须读 hist.tps，不能串到别的序列",
	);
	const title = (tok.titleInfo ?? []).map((s) => s.text).join("");
	// 速率的真伪：估算值帯 `~`，且用紧凑形式（`250t/s` 而非 `250 tok/s`）——
	// 全写单位在 24 列块里会让整条读数消失。
	assert.ok(
		title.startsWith("~250t/s"),
		`速率读数应带 ~ 并用紧凑形式：${JSON.stringify(title)}`,
	);
	// 上行/下行必须都出现（用户提的问题：只有一个方向）
	assert.ok(title.includes("\u2191"), `应含上行：${title}`);
	assert.ok(title.includes("\u2193"), `应含下行：${title}`);
	// 数字对齐 pi footer 的 formatTokens（小写 k）
	assert.ok(title.includes("5.7k"), `↑5671 应格式化为 5.7k：${title}`);
	assert.ok(title.includes("R640"), `缓存读应显示为 R640：${title}`);
	// 累计值是 provider 报的精确值，**不应**带 `~`
	const ioOnly = title.slice(title.indexOf("\u2191"));
	assert.ok(!ioOnly.includes("~"), `累计值不应带 ~（它们是精确值）：${ioOnly}`);
	assert.ok((tok.scaleWindowPoints ?? 0) > 0, "Tokens 是速率图，应有量程窗");
});

test("buildBlocks: Tokens 累计值随宽度逐段降级（窄块先丢缓存读）", () => {
	// 按重要度降序：速率 → 上行 → 下行 → 缓存读。
	// 验证降级真的按这个顺序发生，而不是“要么全有要么全无”。
	//
	// 阈值是**实测**的（四图 4×1，块宽 = 列宽 - 0）：
	//   24–27 列 只能放速率
	//   28–31 列 加速率+上行
	//   32–36 列 再去+下行
	//   37+ 列   四个都在
	// （四图 96 列时每块刚好 24 列，所以窄端确实只能看到速率 ——
	//  这是有意的优先级，不是 bug。）
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
	// 不受宽度限制时四段全在
	assert.ok(
		all.includes("\u2191") && all.includes("\u2193") && all.includes("R"),
		all,
	);

	const shown = (w: number): string => {
		const blocks = mkReading();
		const lines = renderPanel(
			plainTheme,
			blocks,
			w,
			computeLayout(w, 6, 4, 18),
			60,
		);
		const head = lines[0] ?? "";
		const i = head.lastIndexOf("Tokens");
		return head.slice(
			head.lastIndexOf("\u250c", i),
			head.indexOf("\u2510", i) + 1,
		);
	};
	// 块宽 24（四图最小）→ 保住速率（最重要的那项）
	const narrow = shown(96);
	assert.ok(narrow.includes("t/s"), `最窄处至少保住速率：${narrow}`);
	assert.ok(!narrow.includes("\u2191"), `最窄处上行本来就该让位：${narrow}`);
	// 块宽 28 – 31 → 上行出现
	assert.ok(shown(112).includes("\u2191"), shown(112));
	assert.ok(
		!shown(112).includes("\u2193"),
		`块宽 28 还不该有下行：${shown(112)}`,
	);
	// 块宽 32+ → 下行出现
	assert.ok(shown(128).includes("\u2193"), shown(128));
	// 块宽 37+ → 缓存读出现
	assert.ok(shown(150).includes("R640"), shown(150));
});

test("Tokens 读数在最小块宽下仍可见（回归）", () => {
	// 实测过的 bug：用全写单位 `~12.3K tok/s`（12 列）时，
	// 四图并排的最小块宽（24 列）里 roomForInfo 只有 10 列，
	// 于是**整条读数消失**，屏幕上只剩 `┌ Tokens ────────────┐`。
	// 速率 ≥1000 tok/s 时就会触发（`~635 tok/s` 恰好 10 列只是运气好）。
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
		// 标题栏里必须能看到当前速率读数（带 `~`），而不是空框
		assert.ok(
			head.includes("~") && head.includes("t/s"),
			`tpsNow=${tpsNow} 时读数不应消失：${JSON.stringify(head)}`,
		);
	}
});

test("rateAxis: 标签宽度恒为 5 —— 既不参差也不逐帧抖动绘图区左边界", () => {
	// 这里盯着两个实测过的真问题（由 oracle advisor 的 guter 抖动顾虑引出）：
	//  1. 「同一帧内参差」：`scaled*1.5` 跨过 1000 时比其它标签多一位
	//     （dataMax=670 → `1005.0` 是 6 列，其余是 5 列）。
	//  2. 「跨帧抖动」：`renderBlock` 的 gutter 取自「最长标签」，
	//     所以网络峰值在 670 附近波动时，绘图区左边界会逐帧左右跳一格。
	// 两者巳由「降精度而不是截断」的 fit() 修掉：所有标签必须恰好 5 列。
	const bad: string[] = [];
	for (let e = 0; e <= 15; e++) {
		for (const m of [1, 1.5, 6.7, 9.99, 2.5, 5, 8.8, 670, 999]) {
			const dm = m * 10 ** e;
			if (!Number.isFinite(dm)) continue;
			for (const l of rateAxis(dm).labels)
				if (l.length !== RATE_GUTTER) bad.push(`dm=${dm} -> ${JSON.stringify(l)}`);
		}
	}
	assert.deepEqual(bad, [], `存在宽度不等于 ${RATE_GUTTER} 的标签`);

	// 关键回归：600..800 是原先会抖动的区间（1005/1020 那次跨位）
	const widths = new Set<number>();
	for (let dm = 600; dm <= 800; dm++)
		for (const l of rateAxis(dm).labels) widths.add(l.length);
	assert.deepEqual(
		[...widths],
		[RATE_GUTTER],
		"600..800 区间 gutter 宽度发生了变化",
	);

	// 归一必须是「降精度」而不是「截断」：不能出现 `1005.` 这种残缺串
	for (const dm of [670, 680, 999]) {
		for (const l of rateAxis(dm).labels) {
			assert.ok(!l.trimEnd().endsWith("."), `出现截断产物：${JSON.stringify(l)}`);
		}
	}
});

/* ------------------------------------------------------------------ */
/* 横轴时间窗口（曾经随终端宽度漂移的 bug）                              */
/* ------------------------------------------------------------------ */

test("自动量程：显式开启子窗口时，尖峰回落会标 `+`（回归）", () => {
	// 用户问：「为什么网络图中间达到 10MB/s，过一会最大值又变成几百 KB 了，
	// 都没等到这个 10MB 的时间移除时间窗口」。
	//
	// 这是自动回落（上一个测试）的**必然副作用**：量程只看最近 1/6 窗口，
	// 所以尖峰发生 ~10s 后量程已回落，但尖峰**还在 60s 显示窗里**。
	// 绘制时超量程的值会被 clamp 到顶（braille 的 `Math.min(top, raw)`），
	// 那根尖峰就变成一根顶到天的直线。
	//
	// 如果顶端刻度不标记，读图的人会以为「最高就到几百 KB」，
	// 而屏幕上明明有根顶到天的尖峰 —— 刻度在撒谎。
	// 所以溢出时顶端刻度加 `+`（读作“至少这么多”）。
	//
	// 注：现在默认量程窗 == 显示窗，不会溢出，所以 `+` 只在**显式开启
	// 子窗口**（`PI_SYSMON_SCALE_WINDOW<1`）时才可能出现；下面的用例都显式传值。
	const POINTS = 60;
	const SPIKE = 10 * 1024 * 1024;
	// age=25：尖峰在 25s 前发生，**仍在 60s 窗内**，但已超出 10s 量程窗
	const mk = (age: number): History => {
		const h: History = {
			cpu: [],
			mem: [],
			netRx: [],
			netTx: [],
			diskR: [],
			diskW: [],
			tps: [],
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
		// 显式 opt-in 子窗口：只有这样才能造出「尖峰还在显示窗内、但已超出量程窗」
		// 的溢出场景（默认量程窗 == 显示窗时不可能溢出）。
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
		// 必须按**固定宽度**切片取刻度，不能 trim：
		// `rateAxis` 的标签是右对齐定宽的（`" 15MB"` 有前导空格），
		// trim 会把前导空格吃掉，宽度就比不准了。
		// 而且曲线是叠印在同一行的，所以只能截取刻度那几列。
		return (lines[1] ?? "").slice(1, 1 + RATE_GUTTER);
	};
	// 尖峰刚发生：量程尚未回落，包得住它 → **不应**标 `+`
	assert.ok(
		!label(0).trim().endsWith("+"),
		`尖峰当下不应标 +：${JSON.stringify(label(0))}`,
	);
	// 尖峰已滑出量程窗但在显示窗内：量程包不住 → **必须**标 `+`
	for (const age of [20, 25, 40, 59]) {
		const l = label(age);
		assert.ok(
			l.trim().endsWith("+"),
			`尖峰在 ${age}s 前（仍在窗内但超出量程窗）时顶端刻度应标 +，实际：${JSON.stringify(l)}`,
		);
		// 关键：`+` 是**替换**最后一个字符，不是追加 —— 标签宽度必须不变，
		// 否则叠印宽度逐帧变化，绘图区左边界会跟着跳一格（坑 6）。
		assert.equal(
			l.length,
			RATE_GUTTER,
			`加 + 后必须仍占满 ${RATE_GUTTER} 列，实际：${JSON.stringify(l)}`,
		);
	}
});

test("parsePlacement: 默认下方（belowEditor），显式 above 才回上方", () => {
	// pi 官方的 `setWidget(key, content, { placement })` 支持
	// "aboveEditor" / "belowEditor"（0.8x 起，见 dist/core/extensions/types.d.ts）。
	// 这里只管解析环境变量：宽容取值，配错不报错。
	//
	// **默认 = belowEditor**（用户指定的：图表放输入框下方）。
	// 所以默认值与所有非法值都回退到下方，只有显式写“上方”的词才回上方。
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
			`${JSON.stringify(v)} 应解析/回退为下方`,
		);
	// 只有明确表示“上方”的取值才回上方（旧版默认就是这个，是升级保观的开关）
	for (const v of ["above", "ABOVE", " above ", "aboveEditor", "top"])
		assert.equal(parsePlacement(v), "aboveEditor", `"${v}" 应解析为上方`);
});

test("resolveWindow: 默认 60s 窗口，且**不依赖宽度**（回归）", () => {
	// 曾经的 bug：窗口是按「绘图区能装多少点」反推的
	// （plotWidthFor(blockW) * 2 / interval），于是同一台机器上
	// 100/120/150/200 列分别得到 52s/64s/84s/118s —— 时间尺度随窗口尺寸变化，
	// 跨宽度、跨机器都没法对比。现在固定为 bottom 的 60s。
	const base = { windowSecs: 60, intervalMs: 1000 };
	// 不传 available（模拟历史已攒够）：任何宽度下都必须是 60 points / 60s
	for (const available of [60, 200, 5000]) {
		const w = resolveWindow({ ...base, available });
		assert.equal(w.points, 60, `available=${available}`);
		assert.equal(w.windowSecs, 60, `available=${available}`);
	}
	// 接口上根本没有宽度参数 —— 这条断言用类型系统就能保证，
	// 这里再明确一次意图：时间尺度不得成为宽度的函数。
	assert.equal(
		Object.keys(resolveWindow({ ...base }))
			.sort()
			.join(","),
		"points,windowSecs",
	);
});

test("resolveWindow: 采样间隔与窗口联动（点数 = 秒数 × 1000 / 间隔）", () => {
	// 500ms 采样时 60s 窗口需要 120 点；间隔越大需要的点越少。
	assert.equal(resolveWindow({ windowSecs: 60, intervalMs: 500 }).points, 120);
	assert.equal(resolveWindow({ windowSecs: 60, intervalMs: 1000 }).points, 60);
	assert.equal(resolveWindow({ windowSecs: 60, intervalMs: 2000 }).points, 30);
	// 自定义窗口
	assert.equal(resolveWindow({ windowSecs: 30, intervalMs: 1000 }).points, 30);
	assert.equal(resolveWindow({ windowSecs: 300, intervalMs: 1000 }).points, 300);
});

test("resolveWindow: 窗口时长从第一秒就固定（不随已攒历史缩水）", () => {
	// 用户反馈：「时间不是一开始就是 60s 固定的」。
	// 以前这里用 `min(points, available)` 把标签按实际点数缩成 `3s`/`14s`/`30s`，
	// 结果启动期横轴时长一直在变，看的人没法把“现在这一段”和“满窗口”对比。
	// 现在刻度**始终**是配置的窗口长度，而数据按时间比例从右侧长出来
	// （靠 MetricBlock.windowPoints 定位，一秒的屏宽恒定）。
	for (const available of [0, 1, 5, 14, 30, 59, 60, 200]) {
		const spec = resolveWindow({ windowSecs: 60, intervalMs: 1000, available });
		assert.equal(spec.points, 60, `available=${available}: 取点数应固定`);
		assert.equal(
			spec.windowSecs,
			60,
			`available=${available}: 窗口时长应恒为 60s（不能缩成 ${available}s）`,
		);
	}
	// 自定义窗口同理
	for (const available of [0, 3, 300]) {
		assert.equal(
			resolveWindow({ windowSecs: 300, intervalMs: 1000, available }).windowSecs,
			300,
		);
	}
});

test("resolveWindow: 时长由实际点数反推（PI_SYSMON_POINTS 时不能谎报）", () => {
	// 若直接返回 `windowSecs`，`PI_SYSMON_POINTS=200` 会谎报 `60s`
	// —— 实际画的是 200 个 1s 采样 = 200s。所以时长必须由点数反推。
	const spec = resolveWindow({
		windowSecs: 60,
		intervalMs: 1000,
		fixedPoints: 200,
		available: 500,
	});
	assert.equal(spec.points, 200);
	assert.equal(spec.windowSecs, 200, "200 个 1s 采样 = 200s，不能报 60s");
	// 间隔不同时也对：120 点 × 500ms = 60s
	const fast = resolveWindow({ windowSecs: 60, intervalMs: 500 });
	assert.equal(fast.points, 120);
	assert.equal(fast.windowSecs, 60);
});

/* ------------------------------------------------------------------ */
/* 自动量程的回降（用户反馈：尖峰过去后高度降不下来）                      */
/* ------------------------------------------------------------------ */

/** 取某块在第 plot 行顶端的 y 刻度文字 */
function topTick(lines: string[]): number {
	const row = lines[1] ?? "";
	const seg = row.replace(/^│/, "").split("│")[0] ?? "";
	return Number.parseFloat(seg.trim());
}

test("自动量程：默认（量程窗 == 显示窗）下顶端刻度永不带 `+`（回归）", () => {
	// 用户要求：「我不需要 + 啊，我就是想要显示最高的地方就可以了，然后 60s 一个窗口」。
	// 即 y 轴顶端 = 这 60s 里的真实最高值。如此则**不可能溢出**：
	// 绘制时的 clamp（braille 的 `Math.min(top, raw)`）自然不会触发。
	//
	// 这条不变式把两件事钉死在一起：
	//   默认比例 == 1  且  刻度上的高度都能直接读出来（不会“屏幕上有尖峰、刻度只报小值”）。
	assert.equal(DEFAULT_SCALE_WINDOW_FRAC, 1, "默认量程窗必须等于显示窗");

	const POINTS = 60;
	const MB = 1024 * 1024;
	// 扫全部尖峰位置 × 多种幅度：任何一根都不应让刻度带 `+`
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
			// 按**固定宽度**切片取刻度（右对齐定宽，带前导空格；曲线叠印在同一行）
			const tick = (lines[1] ?? "").slice(1, 1 + RATE_GUTTER);
			assert.ok(
				!tick.includes("+"),
				`age=${age}s mult=${mult}× 时不应出现溢出标记：${JSON.stringify(tick)}`,
			);
			assert.equal(tick.length, RATE_GUTTER);
		}
	}
});

test("自动量程：尖峰过去后量程会回落（回归）", () => {
	// 用户反馈：「这会最大比较大，那等这个大的过去了，高度还是这么高，
	// 不会自动变小，导致后面的值看起来都很小」。
	// 根因：量程取的是**整个显示窗口**的最大值，一个尖峰会把它钉住
	// 到该点滚出窗口为止（60s 窗口就是整整 60 秒）。
	// 修法：量程只看**最近的 scaleWindowPoints 个点**（默认窗口的 1/6）。
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
		// 显式 opt-in：自动回落已不是默认行为（见 DEFAULT_SCALE_WINDOW_FRAC）
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
	assert.ok(before < 3, `平静时应是小量程，实际 ${before}`);

	for (let i = 0; i < 3; i++) push(100e6);
	const during = top();
	assert.ok(during > 100, `突发时应量程拉大，实际 ${during}`);

	// 突发过去 12 秒（> 10s 量程窗）→ 量程必须回落
	for (let i = 0; i < 12; i++) push(1e6);
	const after = top();
	assert.ok(
		after < during / 10,
		`尖峰过去 12s 后量程应大幅回落：突发中 ${during} → 现在 ${after}`,
	);
	// 回落后的量程应与平静时同档（基线能重新看清）
	assert.ok(after < 3, `回落幅度不够（${after}），基线仍会被压扁`);
});

test("自动量程：恢复耗时固定，不随已运行多久而变", () => {
	// 比例式（scaleWindowFrac × 当前数组长度）会让启动初期量程窗很短、
	// 跑久了又变长，恢复耗时飘忽（实测 10s↔18s）。
	// 改成按**目标窗口**折算的绝对点数后就稳定了。
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
		return -1; // 30s 内没回落（不应该发生）
	};
	const results = [5, 20, 59, 60, 200].map(recoverSecs);
	assert.ok(
		results.every((r) => r > 0),
		`有情况没回落：${results}`,
	);
	assert.deepEqual(
		[...new Set(results)].length,
		1,
		`恢复耗时应固定，实际得到 ${JSON.stringify(results)}`,
	);
});

test("自动量程：百分比图不受影响（量程固定 0..100）", () => {
	const blocks = buildBlocks(fakeHist(120), fakeSnap(), { points: 60 });
	const cpu = blocks.find((b) => b.name === "CPU");
	const mem = blocks.find((b) => b.name === "Memory");
	assert.equal(cpu?.scaleWindowPoints, undefined, "CPU 不应设量程窗");
	assert.equal(mem?.scaleWindowPoints, undefined, "Memory 不应设量程窗");
	assert.equal(cpu?.axis(999, 4).max, 100.5, "CPU 量程应固定");
	assert.equal(mem?.axis(999, 4).max, 100.5, "Memory 量程应固定");
	// 速率图才设
	for (const n of ["Network"]) {
		const b = blocks.find((x) => x.name === n);
		assert.ok((b?.scaleWindowPoints ?? 0) > 0, `${n} 应有量程窗`);
	}
});

test("自动量程：窗口设为整个窗口（frac=1）时退回旧行为", () => {
	// 逃生口：想回到「全窗口 max」的旧行为时传 1
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
	// frac=1 → 全窗口 max，尖峰仍在窗口内 → 量程仍然很大
	assert.ok(topWith(1) > 100, `frac=1 应保持大量程，实际 ${topWith(1)}`);
	// 默认（1/6）→ 已回落
	assert.ok(topWith(1 / 6) < 3, `默认应已回落，实际 ${topWith(1 / 6)}`);
});

test("自动量程：回降过程平滑，不允许单帧整图跳变（回归）", () => {
	// 第一版修法用的是**硬窗口**（只看最后 N 点、段内不加权），
	// 结果尖峰退出段的那一帧量程从 143 直接跳到 1.4（实测 100 倍跳变），
	// 图会「啪」地弹一下 —— 这是把一个 bug 换成了另一个。
	// 现在段内叠二次衰减权（新点 1 → 段尾 0），退化变得连续。
	const hist: History = {
		cpu: [],
		mem: [],
		netRx: [],
		netTx: [],
		diskR: [],
		diskW: [],
		tps: [],
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
	// 逐帧跳变不应是「整图弹一下」。用**基线高度变化**衡量（那才是用户看到的）：
	// 硬窗口是 66 个百分点（从 1% 直接跳到 67%），三次衰减把变化分散到多帧，
	// 最大单帧约 44pp，视觉上是连续缩放。
	// 注意 topTick 的单位是 MB/s，而基线是 1MB/s，所以高度% = 1/tick*100。
	const heights = trail.map((s) => (1 / s) * 100);
	for (let i = 1; i < heights.length; i++) {
		const d = Math.abs((heights[i] ?? 0) - (heights[i - 1] ?? 0));
		assert.ok(
			d < 55,
			`第 ${i} 帧基线高度跳变 ${d.toFixed(0)} 个百分点，接近硬窗口的 66pp（应平滑）`,
		);
	}
	// 关键回归：不允许出现「硬窗口」那个 100x 的整图跳变
	for (let i = 1; i < trail.length; i++) {
		const prev = trail[i - 1] ?? 0;
		const cur = trail[i] ?? 0;
		if (prev <= 0 || cur <= 0) continue;
		const ratio = Math.max(prev / cur, cur / prev);
		assert.ok(
			ratio < 10,
			`第 ${i} 帧量程跳变 ${ratio.toFixed(1)}x，像硬窗口（应为平滑回降）`,
		);
	}
	// 且确实降下来了（不是“平滑地一直很高”）
	assert.ok(
		(trail[trail.length - 1] ?? 1e9) < 5,
		`最终应回落到小量程，实际 ${trail[trail.length - 1]}`,
	);
	// 单调不增（回降过程不应反弹）
	for (let i = 1; i < trail.length; i++) {
		assert.ok(
			(trail[i] ?? 0) <= (trail[i - 1] ?? 0) + 1e-9,
			`第 ${i} 帧量程反弹：${trail[i - 1]} → ${trail[i]}`,
		);
	}
});

/* ------------------------------------------------------------------ */
/* 5. blocks.ts 的构造逻辑                                              */
/* ------------------------------------------------------------------ */

test("buildBlocks: 默认 4 块（含 Tokens），showDisks 时 5 块，名字稳定", () => {
	const h = fakeHist(50);
	// 默认组合 = CPU/Memory/Network/Tokens（Tokens 默认开，见 PI_SYSMON_TOKENS）
	assert.deepEqual(
		buildBlocks(h, fakeSnap(), { points: 30 }).map((b) => b.name),
		["CPU", "Memory", "Network", "Tokens"],
	);
	// Disks 是可选的第 5 块，追加在最后（不影响前四块的索引）
	assert.deepEqual(
		buildBlocks(h, fakeSnap(), { points: 30, showDisks: true }).map(
			(b) => b.name,
		),
		["CPU", "Memory", "Network", "Tokens", "Disks"],
	);
	// 显式关掉 Tokens 应回到旧的三图形态
	assert.deepEqual(
		buildBlocks(h, fakeSnap(), { points: 30, showTokens: false }).map(
			(b) => b.name,
		),
		["CPU", "Memory", "Network"],
	);
});

test("buildBlocks: 每块至少一条曲线；Network 有 RX/TX 两条且颜色不同", () => {
	const blocks = buildBlocks(fakeHist(50), fakeSnap(), { points: 30 });
	for (const b of blocks) assert.ok(b.series.length >= 1, `${b.name} 没有曲线`);
	const net = blocks.find((b) => b.name === "Network");
	assert.equal(net?.series.length, 2);
	assert.notEqual(net?.series[0]?.color, net?.series[1]?.color);
});

test("buildBlocks: 曲线长度受 points 限制（不把整个历史都塞进去）", () => {
	const h = fakeHist(500);
	const blocks = buildBlocks(h, fakeSnap(), { points: 40 });
	for (const b of blocks)
		for (const s of b.series)
			assert.ok(s.values.length <= 40, `${b.name}: ${s.values.length}`);
});

test("buildBlocks: 无快照时不崩且结构完整（行数恒定的前提）", () => {
	const blocks = buildBlocks(fakeHist(10), undefined, { points: 20 });
	// 默认四块（含 Tokens）—— 无快照时行数必须与有快照时完全一致
	assert.equal(blocks.length, 4);
	for (const b of blocks) {
		assert.equal(b.titleInfo, undefined);
		assert.deepEqual(b.legend, []);
		assert.ok(b.axis(100, 4).labels.length >= 1);
	}
});

/**
 * 回归：让 renderBlock 在**声明宽度恰好等于实际栅格列数**时也成立。
 * 这条盯的是「renderPanel 里 join 出来的行长度」与 layout.widths 的对应关系 ——
 * 一旦某块内部多写了一个字符，并排拼接就会把后一块整体右移。
 */
test("并排拼接：每块贡献的宽度恰好等于 layout.widths[i]", () => {
	const layout = computeLayout(150, 4, 4, 18);
	const widths = layout.widths;
	const blocks: MetricBlock[] = buildBlocks(fakeHist(120), fakeSnap(), {
		points: 80,
	});
	// 直接检查拼接后的行里，第 i 块的边框列位置是否符合 widths 的累加
	const lines = renderPanel(plainTheme, blocks, 150, layout, 60);
	const border0 = lines[0] ?? "";
	let acc = 0;
	for (let i = 0; i < widths.length; i++) {
		const w = widths[i] ?? 0;
		// 每块上边框在该区间内首尾必须是 ┌ 和 ┐
		assert.equal(border0[acc], "┌", `block ${i} start at ${acc}`);
		assert.equal(border0[acc + w - 1], "┐", `block ${i} end at ${acc + w - 1}`);
		acc += w;
	}
	assert.equal(acc, 150);
});

/* ------------------------------------------------------------------ */
/* 4. line 模式（/sysmon line）：内容 + 宽度硬约束                     */
/* ------------------------------------------------------------------ */

/** 把带色片段拼成纯文本（丢掉颜色），便于断言内容 */
const segsText = (segs: StyledLine): string => segs.map((s) => s.text).join("");

test("plainLineSegs: 含 token 读数（速率 + 会话累计），且与图表同口径", () => {
	const segs = plainLineSegs(
		{
			snap: fakeSnap(),
			tpsNow: 1234,
			tokensIn: 5671,
			tokensOut: 89,
			tokensCacheRead: 2700,
		},
		200,
	);
	const text = segsText(segs);
	assert.match(text, /CPU 37%/);
	assert.match(text, /MEM 52%/);
	assert.match(text, /NET/);
	// 旧实现完全没有 token —— 这条就是回归防线
	assert.match(text, /TOK/);
	assert.match(text, /~1\.2Kt\/s/); // fmtTps(1234)
	assert.match(text, /↑5\.7k/); // 与 pi footer 的 formatTokens 同口径（小写 k）
	assert.match(text, /↓89/);
	assert.match(text, /R2\.7k/);
});

test("plainLineSegs: 无快照时仍输出 token 行（非 Linux 上唯一有意义的指标）", () => {
	const segs = plainLineSegs({ tpsNow: 42 }, 200);
	const text = segsText(segs);
	assert.match(text, /TOK/);
	assert.match(text, /~42t\/s/);
	// 没有系统快照就不该编造 CPU/MEM 读数
	assert.doesNotMatch(text, /CPU/);
});

test("扫描: line 模式任意宽度下渲染宽度恰好等于声明宽度（越界会让 pi 退出）", () => {
	for (const w of Array.from({ length: 220 }, (_, i) => i + 1)) {
		for (const theme of [ansiTheme, plainTheme]) {
			const segs = plainLineSegs(
				{
					snap: fakeSnap(),
					tpsNow: 12345,
					tokensIn: 1234567,
					tokensOut: 987654,
					tokensCacheRead: 543210,
				},
				w,
			);
			const line = renderStyledLine(theme, segs, w);
			assert.equal(
				visibleWidth(line),
				w,
				`w=${w}: 渲染宽度 ${visibleWidth(line)} ≠ ${w}`,
			);
		}
	}
});

test("扫描: 宽字符/零宽字符片段端到端不越界、不把宽字符切半", () => {
	// 这条盯的是「plainLineSegs 的预算口径」与「renderStyledLine 的实际渲染口径」
	// 目前必须一致（目前是巧合级的：数据全 ASCII）。直接把含 CJK/emoji/组合字符
	// 的片段喂进渲染器扫宽度，把这条口径钉死。
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

test("扫描: line 模式极端/非有限宽度不抛异常且不越界", () => {
	// `renderStyledLine` 对非有限宽度有防御分支（钳到 1），这条把它钉住。
	// 0/负数/NaN/Infinity 都必须得到一个有限宽度的行。
	for (const w of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
		const line = renderStyledLine(
			ansiTheme,
			plainLineSegs({ snap: fakeSnap() }, w),
			w,
		);
		const lw = visibleWidth(line);
		assert.ok(Number.isFinite(lw), `w=${w} 产出宽度非有限`);
		assert.ok(lw >= 1, `w=${w} 产出宽度 ${lw} < 1`);
		assert.doesNotMatch(line, /NaN|undefined/, `w=${w}`);
	}
});

test("扫描: line 模式极窄宽度不抛异常且不越界", () => {
	// 终端被压到 1 列时也必须稳定（补空格到 w 列、不越界、不产生 NaN 字符）
	for (const w of [1, 2, 3, 5, 8, 12, 20]) {
		const line = renderStyledLine(
			ansiTheme,
			plainLineSegs({ snap: fakeSnap() }, w),
			w,
		);
		assert.equal(visibleWidth(line), w, `w=${w}`);
	}
});

test("plainLineSegs: 宽度不够时只丢整段，结果永远是完整段的拼接（不切碎数字）", () => {
	const opts = {
		snap: fakeSnap(),
		tpsNow: 12345,
		tokensIn: 1234567,
		tokensOut: 987654,
		tokensCacheRead: 543210,
	};
	const full = segsText(plainLineSegs(opts, 500));
	// 先找到四个段的边界：每段的起点文本
	const marks = ["CPU ", "MEM ", "NET ", "TOK "];
	// 对每个宽度：结果必须是 full 的前缀（去尾空格），且在某个「段边界」上结束
	for (let w = 1; w <= 120; w++) {
		const text = segsText(plainLineSegs(opts, w)).trimEnd();
		assert.ok(
			full.startsWith(text),
			`w=${w}: 不是前缀 —— ${JSON.stringify(text)}`,
		);
		// 结尾不可能停在一个不完整的 token 数字上（如 `↑1.2M` 中间）
		assert.doesNotMatch(
			text,
			/(?:↑|↓|R)[0-9.]*$/,
			`w=${w}: 结尾是半截数字 —— ${JSON.stringify(text)}`,
		);
	}
	// 临界点：TOK 段能放下时，它前面的 NET 段必须完整（不会出现 TOK 挤掉 NET）
	const withTok = segsText(plainLineSegs(opts, 120));
	assert.match(withTok, /TOK /);
	assert.match(withTok, /NET /);
	assert.ok(
		withTok.indexOf("NET ") < withTok.indexOf("TOK "),
		"NET 必须排在 TOK 之前（重要度降序）",
	);
	// 四个段的相对顺序固定
	const idx = marks.map((m) => full.indexOf(m));
	for (let i = 1; i < idx.length; i++)
		assert.ok(
			(idx[i] ?? -1) > (idx[i - 1] ?? -1),
			`段顺序错：${marks.join(" → ")}`,
		);
});

test("扫描: line 模式任意宽度都保留第一个段（空行会让人以为扩展挂了）", () => {
	// 有快照时第一个段是 CPU、没快照时是 TOK —— 两者都不能空。
	const withSnap = { snap: fakeSnap() };
	const noSnap = {};
	for (let w = 1; w <= 220; w++) {
		assert.match(segsText(plainLineSegs(withSnap, w)), /CPU/, `w=${w}`);
		assert.match(segsText(plainLineSegs(noSnap, w)), /TOK/, `w=${w} (无快照)`);
	}
});

test("segsWidth: 与 visibleWidth 口径一致（宽字符按 2 列）", () => {
	assert.equal(segsWidth([{ text: "abc" }]), 3);
	assert.equal(segsWidth([{ text: "你好" }]), 4);
	assert.equal(segsWidth([{ text: "a" }, { text: "你" }, { text: "b" }]), 4);
});

test("plainLineSegs: 非有限宽度不得退化成「全部放得下」", () => {
	// 回归：`Math.max(1, Math.floor(NaN))` 仍是 NaN，而 `预算 > NaN` 恒为 false，
	// 会让整个行被返回给调用方 —— 一旦调用方信任这个预算就会越界（pi 退出）。
	const opts = { snap: fakeSnap(), tpsNow: 12345, tokensIn: 1234567 };
	for (const w of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
		const text = segsText(plainLineSegs(opts, w)).trimEnd();
		assert.match(text, /CPU/, `w=${w} 必须仍保留第一段`);
		assert.doesNotMatch(text, /TOK /, `w=${w} 不得退化成完整行 —— ${text}`);
	}
});
