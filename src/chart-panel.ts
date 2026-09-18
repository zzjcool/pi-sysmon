/**
 * chart-panel —— 把指标画成 **bottom 风格**的带框图，并按终端宽度响应式排成多列。
 *
 * 本文件的排版规则**逐条对齐 bottom 的实际输出**，依据来自 three 处实证：
 *  1. ratatui 的 chart.rs（bottom 用的绘图组件）：轴线/刻度的布局算法；
 *  2. bottom 源码 `src/canvas/components/time_series/base.rs`：Block 边框 + title_top、
 *     x 标签 `["-Ns", "0s"]`、legend 的 hidden_legend_constraints；
 *  3. 把 `btm` 跑在受控宽度下抓帧（50/72/100/150 列）逐字符核对。
 *
 * bottom 的单张图长这样（150 列、3 列并排时的真实抓帧）：
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
 * 要点：标题**嵌在上边框里**；y 刻度只有两三个；x 轴线左端是 `└` 且**不延伸到 y 轴那一列**；
 * 时间标签行没有竖线；浮动读数框是**覆盖画在绘图区右上角**的，空间不够就整块消失。
 *
 * 本项目与 bottom 的两处**有意偏离**（都在下文就近注明理由）：
 *  · 宽度不够时**降级成 4 列 / 2 列 / 1 列**（列数随块数 3/4 自适应），而不是像 bottom 那样把几张图硬挤到 16 列宽；
 *  · 浮动框的显隐阈值用「是否放得下 + 至少留 2 列曲线」判定，而不是 bottom 那套
 *    按比例算的阈值 —— 那套阈值是按 40+ 列宽的图校准的，套到我们 20~30 列的图上会永远不显示。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderChartGlyphs } from "./braille.ts";

/**
 * 主题色名。取值来自 pi 的 `ThemeColor`（theme.d.ts），这里只声明本文件用到的子集。
 * 注意 `Theme.fg(color, text)` 的签名是 `fg(color: ThemeColor, text: string): string`。
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

/** 一段带颜色的文本 */
export interface Seg {
	text: string;
	color?: ThemeColor;
}

/** 一条由若干带色片段组成的行（浮动框内容用） */
export type StyledLine = Seg[];

/** 图里的一条曲线 */
export interface BlockSeries {
	values: number[];
	/** 该曲线独占的格子用这个颜色；缺省用块主色。多曲线同格时取靠前的序列 */
	color?: ThemeColor;
}

/** y 轴规格：标签（**索引 0 在底部**，与 ratatui 一致）+ 量程上限 */
export interface AxisSpec {
	labels: string[];
	max: number;
}

export interface MetricBlock {
	/** 边框标题里的名字，如 "CPU" / "Memory" / "Network" */
	name: string;
	/** 曲线数据（可多条，画在同一张图里） */
	series: BlockSeries[];
	/** 主色：边框、标题、y 刻度、时间标签、未指定颜色的曲线都用它 */
	color: ThemeColor;
	/**
	 * 标题栏里的读数片段，渲染成 `┌ NAME ─ <片段...> ────┐`。
	 *
	 * 数组顺序 = **重要度从高到低**：块宽不够时从尾部逐段丢弃，
	 * 所以最重要的读数（当前值）要放前面，细节（如负载均值、累计流量）放后面。
	 * 分成片段（而不是一个长字符串）就是为了能这样按段取舍，
	 * 而不是“整块放不下就啥也不显示”。
	 */
	titleInfo?: StyledLine;
	/** 浮动读数框的内容行（不含边框）；空数组或放不下则不显示 */
	legend?: StyledLine[];
	/**
	 * 量程取样**点数**（>0 时生效）：y 轴量程只看最后这么多的点。
	 * 缺省 = 整个可见窗口。
	 *
	 * **为什么需要它**：量程若取整个窗口的最大值，一个尖峰会把它钉住到该点
	 * 滚出窗口为止（60s 窗口就是整整 60 秒）—— 期间后面的数据全被压成贴底的线，
	 * 用户看到的就是「高度降不下来」。让量程只看最近一段，尖峰过去后量程就回落。
	 *
	 * 用**绝对点数**而不是比例：比例得乘「当前数组长度」，而启动初期数组还很短，
	 * 于是同样的比例会得到越来越长的量程窗，恢复耗时飘忽不定（实测 10s↔18s）。
	 * 点数由 `buildBlocks` 按**目标窗口**算好（与当前已攒多少无关）。
	 *
	 * 段内还会叠一个**三次衰减权**（新点 1 → 段尾 0）。这不只是为了好看 ——
	 * 硬截断会在尖峰退出段的那一帧让整个量程**瞬间跳变**（实测 143→1.4，100 倍），
	 * 图会“啪”地弹一下；三次衰减把单帧跳变压到 2.7 倍，10 秒内平滑降下来。
	 *
	 * 代价：比这段更旧的峰值会被裁顶（画成贴顶平顶）。
	 * 渲染层已有 clamp（`braille.ts` 的 `Math.min(top, raw)`），不会越界。
	 * 这是终端图表通用的 off-scale 语义：宁可旧尖峰贴顶，也不要后面的数据看不见。
	 *
	 * 注意它仍然是一个**纯函数**（只依赖本帧数据），不引入跨帧隐藏状态 ——
	 * 这样渲染 harness 与全宽度扫描断言依然可复现。
	 */
	scaleWindowPoints?: number;
	/** 刻度规格生成器。dataMax = 量程取样段内的最大值，plotRows = 绘图行数（供抽稀判断） */
	axis: (dataMax: number, plotRows: number) => AxisSpec;
	/**
	 * 整个 x 轴代表的**目标点数**（窗口秒数 × 1000 / 采样间隔）。
	 *
	 * 用来把曲线按**时间比例**定位：一个点占 `plotWidth*2 / windowPoints` 个子像素列。
	 * 关键是这个比例**不随已攒多少点而变** —— 所以「一秒」的屏幕宽度恒定，
	 * 左下角的 `60s` 标签才是诚实的（刚启动 3 秒时数据只占右侧 1/20 宽，
	 * 而不是被拉伸冒充满窗口）。
	 *
	 * 缺省（undefined）= 旧的拉伸铺满行为。
	 */
	windowPoints?: number;
}

/* ------------------------------------------------------------------ */
/* 响应式布局                                                          */
/* ------------------------------------------------------------------ */

/**
 * 单块最小可用宽度。
 *
 * 刻度画在**绘图区内侧**后不再占用独占列，所以宽度的下限只需盖住
 * 「边框 2 + 一点点绘图区」；数字刻度本身仍需能叠在图上（叠不下就不画）。
 */
export const MIN_BLOCK_W = 24;

/** 单块的最小绘图区列数（字符列）。低于此值就不画 y 刻度了 */
const MIN_PLOT_W = 10;

/**
 * 每块固定开销行数：上边框 + 下边框 = 2 行（绘图行数另算）。
 *
 * 从 4 降到 2：x 轴线与时间标签以前各占一行，现在
 * 时间标签直接**嵌进下边框**（与标题嵌上边框对称），x 轴线由
 * 绘图区最后一行兼作（就是 0 基线本身）。
 */
export const BLOCK_CHROME_ROWS = 2;

/**
 * 单块内部宽度分配的结果。
 *
 * 抽成独立纯函数的原因是：**两处消费方必须用同一份账** ——
 * `renderBlock` 用它决定画多宽，`index.ts` 用它反推切多少个数据点。
 * 以前这两边各写一份近似公式，一旦窄块触发降级，两边的账会差好几列。
 */
export interface BlockMetrics {
	/**
	 * y 刻度文字叠在绘图区左侧时占的列数（仅用于判断“叠不叠得下”，
	 * **不再从绘图区里扣掉**）。
	 */
	gutter: number;
	/**
	 * 是否在绘图区左侧叠印 y 刻度。
	 *
	 * 以前叫 `showAxis`（是否画 y 轴竖线）；现在刻度是**叠在图上**的，
	 * 没有独立竖线，这个标志的含义就是「刻印与否」。
	 */
	showAxis: boolean;
	/** 曲线可用列数 = 块宽 - 左右边框 */
	plotW: number;
}

/**
 * 给定块宽与刻度规格，算出内部宽度分配。
 *
 * **刻度不再从绘图区里扣列**：以前是
 * `│` + gutter(刻度列) + `│` + 曲线，刻度独占 5 列（4 列数字 + 1 列竖线）；
 * 现在刻度文字**叠印在曲线的左侧几列上**，绘图区就拿到整个内宽。
 * 这是「图表利用率」提升的主要来源。
 *
 * 能不能叠由 `MIN_PLOT_W` 把关：绘图区太窄就不叠刻度（宁可没刻度，
 * 也不要为了刻度把曲线挤成一条线）。
 */
export function blockMetrics(
	blockWidth: number,
	rawGutter: number,
): BlockMetrics {
	const w = Math.max(6, Math.floor(blockWidth));
	const plotW = Math.max(1, w - 2);
	const gutter = Math.max(0, Math.floor(rawGutter));
	// 叠印刻度需要足够宽度：刻度本身 + 留点空间让曲线可见
	const showAxis = plotW >= Math.max(MIN_PLOT_W, gutter + 4);
	return { gutter, showAxis, plotW };
}

/**
 * 给定块宽算出**保守估计**的绘图区列数，供「该切多少个数据点」使用。
 *
 * 按最宽的刻度（rateAxis 的 5 列）估 —— 这是有意保守：估窄了只是少取几个点，
 * 曲线自然右对齐、不会错位；估宽了则会把窗口标签报得比实际画出来的长。
 */
export function plotWidthFor(blockWidth: number): number {
	return blockMetrics(blockWidth, RATE_GUTTER).plotW;
}

/**
 * x 轴左端的时间窗标签。
 *
 * bottom 这一格是固定格式的 `<window>s`（如 `60s`），因为它只提供 60s~10m 的窗口。
 * 本项目的窗口大小由 `PI_SYSMON_POINTS` 决定，可能长到几十分钟甚至几小时，
 * 所以长窗口换算成 m/h —— 否则 `4000s` 这种 5 字符标签会把边框挤掉。
 */
export function fmtWindowLabel(secs: number): string {
	const s = Math.max(0, Math.round(secs));
	if (s < 120) return `${s}s`;
	if (s < 7200) return `${Math.round(s / 60)}m`;
	return `${Math.round(s / 3600)}h`;
}

/**
 * rateAxis 的标签宽度（`0KB` / `119.9` 右对齐到 5 列）。
 *
 * 导出是为了让测试能引用**同一个常量**而不是写死 5 —— 否则改了实现而测试仍对着
 * 旧值断言，就会测试通过但界面抖动。
 */
export const RATE_GUTTER = 5;

/**
 * 绘图行数下限。1 行绘图区把任何曲线都压成一条直线（实测 72 列时就是如此），
 * 还不如占高一点换来能看出趋势的图 —— 这条下限优先于行数预算。
 */
export const MIN_PLOT_ROWS = 2;

/**
 * 按宽度与**块数**决定列数。对宽度是**纯函数**（绝不依赖数据）——
 * 否则列数/行数会随数据抖动，触发「行数变化导致编辑器位移」的老问题。
 *
 * 为什么需要块数：3 块时老逻辑在 ≥96 列下摆成 3+1（第 4 格整行留白）；
 * 4 块时（showDisks）≥96 列应摆成真正的 4×1（8 行），48..95 摆 2×2，<48 叠放。
 * 原则是**绝不选一个会留下半空组的列数**（能摆满整网格时才用该列数）。
 * 默认 `count = 3`，所以老的单参数调用方行为完全不变。
 */
export function chooseColumns(width: number, count = 3): number {
	if (count >= 4 && width >= MIN_BLOCK_W * 4) return 4;
	if (count === 3 && width >= MIN_BLOCK_W * 3) return 3;
	if (width >= MIN_BLOCK_W * 2) return 2;
	return 1;
}

export interface Layout {
	/** 列数 */
	cols: number;
	/** 分几行摆（3 张图 2 列时 = 2 行） */
	bands: number;
	/** 每块的宽度，长度 = cols；余数分给靠前的块，总和恰好 = width */
	widths: number[];
	/** 每块的绘图行数 */
	plotRows: number;
	/** 整个面板的总行数 */
	totalRows: number;
}

/**
 * 完整布局计算：列数 + 列宽分配 + 绘图行数。
 *
 * 行数在高宽度时只由 `chartH` 决定；在窄终端（1 列、多张图叠放）下会按
 * `maxRows` 预算自动压扁，避免几张图把整个屏幕吃掉。
 */
export function computeLayout(
	width: number,
	chartH: number,
	count: number,
	maxRows: number,
): Layout {
	// 防涛：`renderPanel` 是导出函数，任何调用方都可能传 0/负数/NaN。
	// 负数宽度会让下面的 `widths` 出现负值，进而在 `" ".repeat(-2)` 抛 RangeError。
	const safeW = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
	const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	// 零块：显式返回空布局，而不是靠 `Math.max(1, 0)` 的副作用假装有一块
	if (safeCount === 0) {
		return { cols: 0, bands: 0, widths: [], plotRows: 0, totalRows: 0 };
	}

	const cols = Math.min(chooseColumns(safeW, safeCount), safeCount);
	const bands = Math.ceil(safeCount / cols);

	// 宽度分配：先均分，余数给靠前的块。总和严格等于 width（否则拼接会越界或留缝）
	const base = Math.floor(safeW / cols);
	const rem = safeW - base * cols;
	const widths = Array.from(
		{ length: cols },
		(_, i) => base + (i < rem ? 1 : 0),
	);

	// 高度预算：每行摆 bands 块，每块 chrome 恒 4 行，剩下的才是绘图行。
	// 下限 MIN_PLOT_ROWS 优先于预算 —— 预算只用来*防止*多变高，不用来把图压成一条线。
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
/* 单元格模型                                                          */
/* ------------------------------------------------------------------ */

/**
 * 一行被表示成「定宽单元格数组」。
 *
 * 为什么不直接拼字符串：浮动读数框要**覆盖**画在绘图行上，
 * 而绘图行里混着 ANSI 转义序列 —— 用 `slice`/`padEnd` 做字符串手术会把转义符算进长度，
 * 直接触发 pi 的「Rendered line exceeds terminal width」崩溃（见 ARCHITECTURE.md 的坑 1）。
 * 先铺成单元格、覆盖、再统一染色，宽度账天然精确，只有最后一步才生成 ANSI。
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
 * 把带色文本段变成单元格行。
 *
 * 这里负责维护整个单元格模型的**核心不变量**：
 *
 * > 每个 cell 恰好占一个显示列：`row.length === visibleWidth(这一行的文本)`
 *
 * `renderBlock` 内部所有对齐（`putRight` 右对齐刻度/时间标签、边框落在 `w-1`）
 * 都建立在这条不变量上。而 `visibleWidth` 是按 `get-east-asian-width` 算的，
 * 它和「字符数」在三种情况下不等，所以必须逐类处理（实测值）：
 *
 * | 类别 | 例 | visibleWidth | 字符数 | 处理 |
 * | --- | --- | --- | --- | --- |
 * | 常规（含 box/braille） | `─` `⣿` `‑` | 1 | 1 | 一个 cell |
 * | 宽字符 | `你` `🙂` `\u3000` | 2 | 1 | 字符 + 1 个空占位 cell |
 * | 组合/零宽 | `e\u0301` `\u200b` | 0（整个串）/ 0 | — | 并入前一个 cell |
 *
 * 不处理宽字符会让行**变宽**（可见宽度 > 声明宽度）→ pi 抛异常退出；
 * 不处理零宽字符会让行**变窄**（后续内容相对边框左移）→ 边框错位。
 * 本项目自己的文本全是 ASCII，但 `block.name` / `titleInfo` / `legend`
 * 是调用方给的，不能假设。
 */
function segsToRow(segs: StyledLine): Row {
	const row: Row = [];
	for (const s of segs) {
		for (const ch of s.text) {
			const vw = visibleWidth(ch);
			if (vw === 0) {
				// 组合字符（如 e + 声调）与零宽字符不占列。
				// 把它们并入前一个 cell：既保留字符本身，又不让列数虚增。
				// 开头的零宽字符没有可并入的对象，直接丢弃（它本来就不可见）。
				const prev = row.at(-1);
				if (prev) prev.ch += ch;
				continue;
			}
			const cell: Cell = { ch, color: s.color };
			row.push(cell);
			// 宽字符占 vw 个显示列，补 vw-1 个空占位 cell 把列数对齐。
			// 用循环而不是硬编码 `=== 2`，这样 pi-tui 将来把某个
			// ambiguous 字符改判成更宽时也不会突然越界。
			for (let k = 1; k < vw; k++) row.push({ ...cell, ch: "" });
		}
	}
	return row;
}

/** 把单元格行染成最终字符串；**纯空格段不加 ANSI**，避免刷屏式转义序列 */
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
		// 纯空格（含宽字符的占位 cell）不染色，否则每行都拖一大串转义序列
		const meaningful = text.trim() !== "";
		out += first.color && meaningful ? theme.fg(first.color, text) : text;
		i = j;
	}
	return out;
}

/** 在 row 的 offset 处覆盖写入 cells（越界部分被忽略） */
function overlay(row: Row, offset: number, cells: Row) {
	for (let i = 0; i < cells.length; i++) {
		const at = offset + i;
		const c = cells[i];
		if (at >= 0 && at < row.length && c) row[at] = c;
	}
}

/**
 * 按显示宽度截断一个单元格行，**不会把宽字符从它的占位 cell 上切开**。
 *
 * 为什么不能用 `row.slice(0, n)`：`segsToRow` 把宽字符拆成「字符 cell + 空占位 cell」，
 * 而占位 cell 与字符 cell 是**一体**的（少了占位就会多占一列）。
 * `slice(0, 9)` 这种硬切会把最后一个宽字符的占位留在外面，
 * 于是返回 9 个 cell 但实际渲染 10 列 —— 不变量破了，
 * 后面的 `┐` 就被挤出边界（`w=14` 的 `超级长的名字` 就是这样丢的右边框）。
 *
 * 所以这里以「字符」为单位累积，放不下整个字符就整体不要。
 */
function truncateRow(row: Row, maxCells: number): Row {
	if (row.length <= maxCells) return row;
	const out: Row = [];
	let room = Math.max(0, maxCells);
	let i = 0;
	while (i < row.length) {
		const c = row[i];
		if (!c) break;
		// 一个完整「字符」= 1 个非空 cell + 紧随的若干空占位 cell
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
 * 把一条带色文本渲染成**恰好 width 列**的单行字符串（超出用 `…` 截断，不足补空格）。
 *
 * 存在的理由：`line` 模式（`/sysmon line`）要跟图表共用同一套宽度与配色纪律，
 * 而「自己拼字符串 + padEnd」正是本仓库踩过的坑 —— 多字节字符会被算错列宽，
 * 一旦某行超过终端宽度 pi 就抛异常退出。这里复用图表内部的单元格模型
 * （`segsToRow` / `truncateRow` / `paint`），于是：
 *  · 宽字符（CJK/emoji）按显示列计宽并保留占位 cell；
 *  · 截断不会把宽字符从它的占位 cell 上切开；
 *  · 纯空格段不染色（避免每帧刷一大堆转义序列）。
 *
 * 返回的是**已经含 ANSI** 的字符串，可直接交给 `setWidget` 的组件渲染。
 */
export function renderStyledLine(
	theme: ThemeLike,
	segs: StyledLine,
	width: number,
): string {
	const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
	const row = truncateRow(segsToRow(segs), w);
	// 补空格：行数恒定 + 行宽恒定，编辑器才不会上下位移（ARCHITECTURE 坑 2）
	while (row.length < w) row.push({ ch: " " });
	return paint(theme, row);
}

/** 一条带色行的显示宽度（用 pi-tui 的 `visibleWidth`，宽字符/ANSI 口径与渲染一致） */
export function segsWidth(segs: StyledLine): number {
	let n = 0;
	for (const s of segs) n += visibleWidth(s.text);
	return n;
}

/* ------------------------------------------------------------------ */
/* 刻度规格                                                            */
/* ------------------------------------------------------------------ */

/**
 * 百分比图：只在**顶端**标 `100%`。
 *
 * 以前对齐 bottom `percent.rs` 标两个（`0%` 在底、`100%` 在顶）。
 * 现在刻度是**叠在绘图区上**的，底部那个 `0%` 会紧贴着 0 基线、和曲线打架；
 * 而 0% 这个信息其实由底部基线本身就表达得很清楚。
 * 所以只保留顶端值 —— 它告诉图上沿是多少，这是基线上看不出来的。
 * 量程仍固定 `0..100.5`（不随数据变，不同时间可直接对比）。
 */
export function percentAxis(): AxisSpec {
	return { labels: ["100%"], max: 100.5 };
}

const KIBI = 1024;
const MEBI = 1024 ** 2;
const GIBI = 1024 ** 3;
const TEBI = 1024 ** 4;

/**
 * 速率图的刻度 —— 逐行复刻 bottom `network_graph.rs: adjust_network_data_point`
 * （Linear 分支）：量程 = max × 1.5，按量程选 K/M/G/T 单位，
 * 标签固定 4 个 `0<unit>` / `0.5×` / `1×` / `1.5×`，每个右对齐到 5 列。
 */
export function rateAxis(dataMax: number): AxisSpec {
	// 非有限值（NaN/Infinity）必须先落回 0：否则 `NaN <= 0` 为 false，
	// 会一路算出 `max: NaN` 和 "NaN" 标签，再往下就是 NaN 坐标 → 越界。
	// 坐标系里的任何 NaN 都是灾难（见 ARCHITECTURE.md 的坑 4）。
	const dm = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
	// 空数据（dm=0）：不能直接让四个标签都塌成 `0.0`。
	// 刻度现在是**叠印在绘图区上**的，四个 `0.0` 叠在图上比旧版（刻度在独立列）
	// 更乱。给出一个最小可用量程（1 单位），标签就是 `0.0/0.5/1.0/1.5`，
	// 图仍是平线但刻度至少读得通。
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
	// 定宽归一：所有标签都恰好 `RATE_GUTTER` 列。
	//
	// 不这么做会同时踩两个坑（都实测过）：
	//  1. **同一帧内参差**：`scaled*1.5` 跨过 1000 时比其它标签多一位
	//     （dataMax=670 → `1005.0` 是 6 列而其余是 5 列），
	//     刻度列右边缘对不齐，看着像渲染错位。
	//  2. **跨帧抖动**：`renderBlock` 用「最长标签」算叠印宽度，
	//     所以网络峰值在 670 附近波动时，叠印区域会**逐帧左右跳一格**，
	//     这种闪烁比刻度难看多了。
	//
	// 归一策略是**降精度而不是截断**：先试一位小数，放不下就退回整数。
	// 截断会得到 `1005.` 这种残缺字符串；降精度只是少一位小数，
	// 而刻度本来就是粗略量程，读数不受影响。
	// 只有一个顶端标签，所以把**单位缀在数值后面**（如 `1.2K` / `150B`）。
	// 这是必须的：否则屏幕上只剩一个光秃秃的 `150.0`，看不出是 B/s 还是 MB/s。
	// 定宽仍按 `RATE_GUTTER`，这样叠印宽度稳定、不会逐帧抖动。
	const fitWithUnit = (v: number): string => {
		const unit = `${prefix}B`;
		const one = v.toFixed(1);
		// 先试一位小数，放不下就退回整数；单位始终保留
		if (one.length + unit.length <= RATE_GUTTER)
			return `${one}${unit}`.padStart(RATE_GUTTER);
		const zero = v.toFixed(0);
		if (zero.length + unit.length <= RATE_GUTTER)
			return `${zero}${unit}`.padStart(RATE_GUTTER);
		// 极端量程：只保留单位，数值截高位
		return `${zero.slice(0, Math.max(1, RATE_GUTTER - unit.length))}${unit}`;
	};
	// 只在**顶端**标一个值（量程上限），不再标 0 / 中点 / 1.5×。
	//
	// 为什么不标 `0B`：0 的位置就是绘图区底部的基线，本身已经一目了然；
	// 而刻度现在是叠在曲线上的，底部的 `0B` 反而会和曲线/基线挤在一起。
	// 顶端值才是图上看不出来的信息（“上沿代表多少”）。
	return {
		labels: [fitWithUnit(scaled * 1.5)],
		max: upper,
	};
}

/** 抽稀后仍保留的标签下标（按原始下标）。首尾两个标签一定保留：它们是量程的语义。
 *
 * 这里用 floor 与 ratatui 的 `i*(h-1)/(n-1)` 保持一致。
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
/* 单块渲染                                                            */
/* ------------------------------------------------------------------ */

/**
 * 画一个 bottom 风格的带框指标块，返回**恰好 `plotRows + 4` 行**。
 *
 * 宽度恒等式（每行都恰好 `width` 个单元格）：
 * ```text
 * 标题行 = "┌ " + name + " ─ " + info + " " + fill + "┐"      = width
 * 绘图行 = "│" + 刻度(gutter) + "│" + 曲线(plotW) + "│"        = width
 * 轴线行 = "│" + 空格(gutter) + "└" + "─"(plotW) + "│"         = width
 * 时间行 = "│" + 左标签(gutter+1) + 右标签(plotW) + "│"         = width
 * 下边行 = "└" + "─"(width-2) + "┘"                            = width
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
	// 量程的取样范围：默认整个可见窗口；设了 scaleWindowPoints 就只看最后那段，
	// 并在段内叠一个二次衰减权（见 scaleRolloff 的注释）。
	// 至少取 1 个点（否则量程会变成 0，图直接贴顶）。
	const scalePts =
		Number.isFinite(block.scaleWindowPoints) &&
		(block.scaleWindowPoints as number) > 0
			? Math.floor(block.scaleWindowPoints as number)
			: Number.POSITIVE_INFINITY;
	const rolloff = scalePts !== Number.POSITIVE_INFINITY;
	for (const s of block.series) {
		const n = s.values.length;
		const span = Math.max(1, scalePts);
		const from = Math.max(0, n - span);
		// 只有量程窗**真的是显示窗口的子区间**时才做二次衰减。
		// `span >= n`（整窗口取 max，或启动初期历史还不够一个窗）时用纯 max：
		//   ① `PI_SYSMON_SCALE_WINDOW=1` 这个退路必须**精确**等于旧行为；
		//   ② 整窗口根本没有“内部边界”，点是从左边缘自然滚出去的，无需平滑。
		const smooth = rolloff && span < n;
		for (let i = from; i < n; i++) {
			const v = s.values[i];
			if (v === undefined || !Number.isFinite(v) || v <= 0) continue;
			// ageIdx = 0 是最新的点。权重按**三次幂**衰减到段尾为 0：
			// 新点权重恒为 1 → 量程永远 >= 当前值，不会欠量程；
			// 段尾权重为 0 → 尖峰**离开段时量程已经先降完了**，不会出现跳变。
			//
			// 幂次是量出来的（10s 窗、100x 尖峰、3 点宽突发）：
			//   硬截断 → 单帧跳 100x（整图“啪”地弹一下）
			//   一次方 → 跳 10x（段尾还残留 1/span）
			//   二次方 → 跳 4x
			//   三次方 → 跳 2.7x，且 7 帧就回落到位  ← 取它
			//   四次方 → 跳 2.6x（边际收益很小），但回落更“生硬”
			// 三次方在「平滑」与「及时回落」之间最好；2.7x 的残余跳变只发生在
			// 量程已经降到基线附近几帧，视觉上基线己接近顶部，感知不到。
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

	// 溢出检测：可见数据里有点超出量程时，它会被截到顶（braille 里 clamp 到 top）。
	//
	// 为什么必须检测：量程是「最近 1/6 窗口」算的（用户要求的自动回落），
	// 所以一根 10MB/s 尖峰发生 ~10s 后，量程已经回落到基线的几百 KB，
	// 但**这根尖峰还在 60s 的显示窗口里** —— 它会被截到顶。
	// 此时顶端刻度若不标记，读图的人会以为「最高就到几百 KB」，
	// 而屏幕上明明有一根顶到天的尖峰：刻度在撒谎。
	let overflow = false;
	for (const s of block.series) {
		for (const v of s.values) {
			if (Number.isFinite(v) && v > axisMax) {
				overflow = true;
				break;
			}
		}
		if (overflow) break;
	}

	// 宽度分配：刻度不再占列，但 `gutter` 仍用来判断叠印是否放得下
	const { showAxis, plotW } = blockMetrics(w, rawGutter);

	const color = block.color;

	// 边框用中性的 `borderMuted`（darkGray）而不是 `border`（blue）：
	// 三张图并排时，三个高饱和色的**大方框**会比曲线本身还抢眼，
	// 而且 bottom 的边框就是中性的。指标色只用在「标题名 + 曲线 + 读数」上，
	// 既保留「一眼看出哪张图」的能力，又不刷屏。
	const edge: ThemeColor = "borderMuted";
	const axis: ThemeColor = "muted";

	// ── 上边框 + 标题（bottom 的 title_top 效果）──
	// 边框本体中性色，名字用指标色 —— 这就是「一眼看出哪张图是什么」的关键。
	const nameSegs: StyledLine = [{ text: block.name, color }];
	let head: Row;
	{
		// 必须用**显示宽度**而不是 `.length`：`.length` 数的是码点，
		// 而 CJK/emoji 占 2 列。用 `.length` 会低估标题占宽 → fill 算多 →
		// 最后把右边框 `┐` 切掉（测试里的 `处理器 CPU` 就是这样暴露的）。
		const nameW = visibleWidth(block.name);
		// 行布局：`┌␣name␣─␣info␣` + fill×`─` + `┐`
		// 已用固定列 = 1(┌) + 1(␣) + nameW + 1(␣) + 1(─) + 1(␣) + infoW + 1(␣)
		// 再留 1 列 `┐`，剩下的才是 fill。
		const FIXED_NO_INFO = 4; // ┌␣ + name 后空格 + ┐
		const FIXED_WITH_INFO = 7; // ┌␣ + ␣─␣ + info 后空格 + ┐
		const roomForInfo = Math.max(0, w - nameW - FIXED_WITH_INFO - 1);

		// 逐段累积，放不下就停 —— 这样窄块下至少能留下最重要的那段读数
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
		// 用 `─` 填满到右边框（bottom 的 `title_top` 就是这个观感），而不是留空白
		const fill = Math.max(
			1,
			w - nameW - (useInfo ? infoCells.length + FIXED_WITH_INFO : FIXED_NO_INFO),
		);
		head.push(...Array.from({ length: fill }, () => ({ ch: "─", color: edge })), {
			ch: "┐",
			color: edge,
		});
		// 标题比块宽还长时（长名字 + 窄块）：
		// 确保右边的 `┐` 永远存活 —— 边框闭合比显示完整标题重要。
		// 做法是把标题名本身截短到「块宽 - 已用的装饰列」，而不是直接切整行尾巴
		// （直接切尾巴会把名字切掉，连“这是哪张图”都看不出来）。
		if (head.length > w) {
			const prefix = 2; // "┌ "
			const suffix = 3; // 至少 1 个 fill 加上 "┐"，再加一点缓冲
			const nameRoom = Math.max(0, w - prefix - suffix);
			// 用 truncateRow（而不是 slice）保证不把宽字符切一半
			const namePart = truncateRow(
				segsToRow([{ text: block.name, color }]),
				nameRoom,
			);
			// 先算好要填多少个 `─`，让 `┐` **落在最后一列**。
			// 不能先拼完再靠 `while (head.length < w) push(" ")` 补 ——
			// 那会把 `┐` 挤在中间、尾巴拖一堆空白（w=6 时就是 `┌ C─┐ `）。
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

	// ── 绘图行 ──
	const glyphs = renderChartGlyphs(
		block.series.map((s) => ({ label: block.name, values: s.values })),
		plotW,
		rows,
		axisMax,
		// 按时间比例定位（windowPoints 设了时）：一秒的屏宽恒定，
		// 这样左下角 `60s` 标签才诚实；没设则退回拉伸铺满。
		block.windowPoints && block.windowPoints > 0
			? { slots: block.windowPoints }
			: { stretch: true },
	);

	// y 刻度位置：对齐 ratatui —— dy = i*(plotH-1)/(n-1)，画在 plotBottom - dy。
	// 必须是 **floor**（整数除法），不能 Math.round：ratatui 的 `render_y_labels` 里是
	// `i as u16 * (graph_area.height - 1) / (labels_len - 1)`，u16 除法向下取整。
	// 实测验证（bottom 抓帧 Network 块、plotH=8、4 个刻度）：
	//   floor → dy={0,2,4,7} 与抓帧完全一致；round → dy={0,2,5,7} 第三个刻度差 1 行。
	// 我最初写成 round，就是靠这个抓帧对出来的。
	const kept = keptIndexes(spec.labels.length, rows);
	const tickAt = new Map<number, string>();
	if (showAxis) {
		const n = spec.labels.length;
		for (let i = 0; i < n; i++) {
			if (!kept.has(i)) continue;
			// 单个标签时**贴顶**而不是贴底。
			// 通用公式 `rows-1 - floor(i*(rows-1)/(n-1))` 在 n=1 时退化成 `rows-1`（底部），
			// 而唯一的那个标签是「量程上限」，语义上就该在顶端。
			const dy = n <= 1 ? 0 : Math.floor((i * (rows - 1)) / (n - 1));
			const y = n <= 1 ? 0 : rows - 1 - dy;
			if (y >= 0 && y < rows) {
				const lab = spec.labels[i] ?? "";
				// 溢出时给**顶端刻度**加 `+`（如 `293KB` → `293K+`，读作“至少这么多”）。
				// 必须**保持字符长度不变**：`rawGutter` 是由原标签算的，
				// 叠印宽度一变，绘图区左边界就跟着跳一格（见 ARCHITECTURE 的坑 6）。
				tickAt.set(
					y,
					overflow && y === 0 && lab.length >= 2 ? `${lab.slice(0, -1)}+` : lab,
				);
			}
		}
	}

	const plotTop = 0; // 绘图行在 lines 里的起始下标
	for (let r = 0; r < rows; r++) {
		const row = blank(w);
		row[0] = { ch: "│", color: edge };
		row[w - 1] = { ch: "│", color: edge };
		// 曲线：逐格取色（网格线是每格独立的，所以按格而不是按行染色）。
		// 绘图区现在占满内宽（左边界在 col 1），刻度稍后叠在上面。
		const gl = glyphs[r];
		for (let c = 0; c < plotW; c++) {
			const g = gl?.[c];
			if (!g || g.char === " ") continue;
			const series = g.series >= 0 ? block.series[g.series] : undefined;
			row[1 + c] = { ch: g.char, color: series?.color ?? color };
		}
		// 0 基线**不再单独铺一条 `─`**。
		//
		// 以前（刻度/轴线各占独立行时）这里铺横线是为了画出 x 轴；
		// 但改成「下边框兼任 x 轴」后，下边框本身就是一条 `─`，
		// 再在绘图区最后一行铺一条 `─` 就变成**上下两条平行横线**，
		// 观感上像多出一条线（右侧用户反馈“看着下方多了一条线”）。
		//
		// 现在 0 的位置由**下边框**表达（它是绘图区的下沿），无需额外横线。
		// 曲线的 0 值点落在绘图区最后一行、紧贴下边框，语义仍然清楚。
		// y 刻度**叠印**在绘图区左侧（不再独占列）。
		// 叠在曲线之上：刻度是参考信息，偶尔遮住一小段曲线可接受；
		// 反过来（曲线盖刻度）会让刻度读数不可信。
		if (showAxis) {
			const label = tickAt.get(r);
			if (label) {
				const cells = segsToRow([{ text: label, color: axis }]);
				overlay(row, 1, cells);
			}
		}
		lines.push(row);
	}

	// ── 浮动读数框：覆盖画在绘图区右上角（bottom 的 legend TopRight）──
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
		// 显隐规则：只要「放得下 + 不与 x 轴线/0% 基线相撞」就画。
		//
		// 历史上这里有一条更严的宽度规则「至少留 40% 曲线可见」，
		// 叠加下面那条高度规则后把 Network 的浮框**永久挡掉**了
		// （它的读数文字最长、又是两行）。而「覆盖右上角曲线」本来就是浮框的
		// 设计意图（bottom 的 legend 就是 overlay，不预留空间），
		// 没有理由要求留白，所以宽度只要放得下即可。
		//
		// 真正不能碰的是**纵向**：0% 基线在绘图区最后一行，
		// 浮框若铺满所有绘图行，它的下边框会与基线叠成一条双横线，
		// 看起来像渲染坏了。所以要求浮框下面**至少还留一行** ——
		// 即 `legendH - 1 < rows - 1`，等价于 `legendH < rows`。
		//
		// 注意这条规则本身没错，当初之所以把 Network 坑死，是因为它的浮框
		// 是两行（legendH=4）而默认绘图区正好 4 行 —— 解决办法是把它的读数
		// 压成一行（速率已在标题栏里，浮框只放累计流量），而不是放宽这条规则。
		if (legendW <= plotW && legendH < rows) {
			const plotLeft = 1;
			const plotRight = plotLeft + plotW;
			const lx = plotRight - legendW;
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

	// ── 下边框（时间标签嵌在里面，与标题嵌上边框对称）──
	// 左端最旧、右端 now。为了不把边框切碎，两端的标注与横线之间各留一个空格：
	//   `└ 60s ────────────── 0s ┘`
	// 以前时间标签单独占一行（否则没地方放），现在嵌进边框省下整整一行，
	// 那一行还给绘图区。
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
		// 嵌下来要的列数：边框 1 + 左空格 1 + 左标签 + 左空格 1
		//   + 右空格 1 + 右标签 + 右空格 1 + 边框 1（中间至少 0 个 `─`）
		// 即 L + R + 6；两个标签都有空格包着才不像“贴着边框”。
		const need = leftLabel.length + rightLabel.length + 6;
		if (w >= need) {
			// 左端：`└ 60s `
			row[1] = { ch: " ", color: edge };
			for (let i = 0; i < leftLabel.length; i++)
				row[2 + i] = { ch: leftLabel[i] ?? " ", color: axis };
			row[2 + leftLabel.length] = { ch: " ", color: edge };
			// 右端：` 0s ┘`（标签结束于 w-2，留给 `┘` 前一个空格）
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
/* 面板拼接                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把若干块排成多列面板。
 *
 * 拼接纪律：每块内部已经保证**行数恒定**且**每行恰好 blockW 个单元格**，
 * 所以这里可以直接横向拼接（边框相接，与 bottom 的 `┐┌` 一致，不用空隙），
 * 最后再逐行 `truncateToWidth(line, width, "", true)` 兜底
 * —— 兜底必须显式传 `ellipsis=""`，否则 `truncateToWidth` 会追加 `...` 把宽度账算坏。
 */
export function renderPanel(
	theme: ThemeLike,
	blocks: MetricBlock[],
	width: number,
	layout: Layout,
	windowSecs: number,
): string[] {
	// 零块 / 零行布局：显式返回空，不靠后续循环的副作用
	if (blocks.length === 0 || layout.bands === 0 || layout.cols === 0) return [];
	// 防涛：调用方传 0/负数时，下面的 `" ".repeat` 与 `truncateToWidth` 都会炸
	const safeW = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;

	const { cols, widths, plotRows } = layout;
	const blockLines = blocks.map((b, i) => {
		const w = widths[i % cols] ?? widths[0] ?? safeW;
		return renderBlock(theme, b, w, plotRows, windowSecs);
	});

	// 补齐：块数不足时补空白（保持网格形状与总行数不变）
	const cellH = plotRows + BLOCK_CHROME_ROWS;
	const cells: string[][][] = [];
	for (let band = 0; band < layout.bands; band++) {
		const rowCells: string[][] = [];
		for (let c = 0; c < cols; c++) {
			const b = blockLines[band * cols + c];
			const w = Math.max(0, Math.floor(widths[c] ?? safeW));
			// 空位画空白，不画空框：空框看起来像一张坏掉的图，比留白更容易让人误判
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
	// 兕底截断：显式传 `ellipsis=""` —— `truncateToWidth` 默认会追加 `...`，
	// 那会把宽度账算坏（多出 3 列，而 pad=true 又截不回去）。
	return out.map((line) => truncateToWidth(line, safeW, "", true));
}
