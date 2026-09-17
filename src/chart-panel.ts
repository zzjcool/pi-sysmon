/**
 * chart-panel —— 带坐标轴/刻度的 braille 折线图面板（对标 bottom 的观感）。
 *
 * bottom 的做法（已核实源码）：
 *  · braille 2x4 子像素画线（Marker::Braille）
 *  · 百分比图 y 轴固定 0..100.5，标签 "0%" / "100%"
 *  · 动态图（网络/磁盘）y 上限 = 窗口内 max × 1.5（留白，峰值只占约 2/3 高）
 *  · **没有网格线**，只有 x 轴线、y 轴线、y 标签、两个 x 标签（-Ns / 0s）
 *  · 用 box-drawing 画轴线（HORIZONTAL/VERTICAL/BOTTOM_LEFT）
 *
 * 这里在「只能返回 string[]」的渲染器里复刻上述要点。
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderChart } from "./braille.ts";
import type { Snapshot } from "./metrics.ts";
import { fmtBytes, fmtRate } from "./metrics.ts";

export type ThemeLike = {
	fg: (
		c: "dim" | "accent" | "success" | "warning" | "error" | "muted",
		s: string,
	) => string;
};

export interface MetricBlock {
	/** 左侧标题，如 "CPU" */
	name: string;
	values: number[];
	/** 主题色名 */
	color: "success" | "warning" | "accent" | "error";
	/** 固定量程百分比图传 100；动态图传 undefined（用窗口 max × 1.5） */
	fixedMax?: number;
	/** y 标签格式化（百分比图用 v=>`${v.toFixed(0)}%`，动态图用 shortScale） */
	format: (v: number) => string;
}

/** 动态量程：窗口内 max × 1.5（bottom 的留白策略），空数据回退 1 */
export function dynamicMax(values: number[]): number {
	let m = 0;
	for (const v of values) if (Number.isFinite(v) && v > m) m = v;
	return m <= 0 ? 1 : m * 1.5;
}

/**
 * 画一个带 y 轴刻度 + x 轴线 + 时间标签的指标块。
 *
 * 输出形如（H=3 个绘图行 + 1 轴线 + 1 时间标签行）：
 * ```
 *   100% │      ⢀⠤⠔⠒⠉⠉⠒⢄        ⢀⠤⠒⠉
 *    50% │                ⢀⡠⠔⠒⠉
 *     0% │
 *        └──────────────────────────────
 *         -2m                          now
 * ```
 */
export function renderMetricBlock(
	theme: ThemeLike,
	m: MetricBlock,
	width: number,
	plotRows: number,
	windowLabel: string,
): string[] {
	const rows = Math.max(1, plotRows);
	const max = m.fixedMax ?? dynamicMax(m.values);

	// y 轴刻度标签（只标顶端、中点、底端，宽度按最长标签对齐）
	const labelOf = (frac: number) => m.format(max * frac);
	const topLabel = labelOf(1);
	const midLabel = labelOf(0.5);
	const gutter = Math.max(
		topLabel.length,
		midLabel.length,
		m.format(0).length,
		4,
	);
	const axisW = 2; // "│ " 或 "└─"
	// ── 宽度账必须精确，否则 pi 会直接以「Rendered line exceeds terminal width」崩溃退出 ──
	// 绘图行 = gutter + " │"(2) + plotW
	const plotW = Math.max(4, width - gutter - axisW);

	const chart = renderChart(
		[{ label: m.name, values: m.values }],
		plotW,
		rows,
		max,
		{
			stretch: true,
		},
	);

	const dim = (s: string) => theme.fg("dim", s);
	const lines: string[] = [];

	// 绘图行：左侧刻度 + 竖轴线 + braille 曲线
	for (let i = 0; i < rows; i++) {
		// 顶端标 max、底端标 0、中间行若够高则标中点
		let lab = "";
		if (i === 0) lab = topLabel;
		else if (i === rows - 1) lab = m.format(0);
		else if (rows >= 3 && i === Math.floor((rows - 1) / 2)) lab = midLabel;
		const left = dim(lab.padStart(gutter)) + dim(" │");
		const body = theme.fg(m.color, chart[i] ?? "");
		lines.push(truncateToWidth(left + body, width));
	}

	// x 轴线：gutter + " └"(2) + (plotW-1)个─ + 1 个尾空格 = width
	lines.push(
		truncateToWidth(
			" ".repeat(gutter) + dim(" └" + "─".repeat(Math.max(0, plotW - 1))) + " ",
			width,
		),
	);

	// 时间标签行：左端最旧（-window）、右端 now。
	// 用可见宽度算 padding，最后再 truncate 兑底（防尾宽越界导致 pi 崩）。
	const leftLab = `-${windowLabel}`;
	const rightLab = "now";
	const room = width - 1 - visibleWidth(leftLab) - visibleWidth(rightLab);
	const pad = Math.max(1, room);
	lines.push(
		truncateToWidth(dim(` ${leftLab}${" ".repeat(pad)}${rightLab}`), width),
	);

	return lines;
}

/** 顶部摘要行：一眼看到当前读数 + 时间窗。 */
export function renderSummary(
	theme: ThemeLike,
	snap: Snapshot,
	points: number,
	intervalMs: number,
	width: number,
): string {
	const dim = (s: string) => theme.fg("dim", s);
	const secs = Math.round((points * intervalMs) / 1000);
	const win = secs >= 120 ? `${Math.round(secs / 60)}m` : `${secs}s`;
	const line =
		theme.fg("accent", "◆ sysmon ") +
		dim("CPU ") +
		theme.fg("success", `${snap.cpuPct.toFixed(0)}%`) +
		dim("  MEM ") +
		theme.fg("warning", `${snap.memPct.toFixed(0)}% ${fmtBytes(snap.memUsed)}`) +
		dim("  NET ") +
		theme.fg("accent", `↑${fmtRate(snap.txBps)} ↓${fmtRate(snap.rxBps)}`) +
		dim(`  win ${win}`);
	// 按**可见宽度**截断（slice 会把 ANSI 转义也算进去，导致宽度越界崩溃）
	return truncateToWidth(line, width);
}

/** 把若干指标块拼成完整面板。
 *
 * ⚠️ 行数必须**恒定**：本机 tps.ts 的血泪教训——footer/widget 行数一旦变化，
 * 编辑器会整体位移，锚定在屏幕坐标的鼠标选区就失效（表现为「复制不了文字」）。
 * 因此即使尚无数据，也要占满同样多的行，只是内容换成占位符。
 */
export function renderPanel(
	theme: ThemeLike,
	snap: Snapshot | undefined,
	blocks: MetricBlock[],
	width: number,
	plotRows: number,
	points: number,
	intervalMs: number,
): string[] {
	const secs = Math.round((points * intervalMs) / 1000);
	const windowLabel = secs >= 120 ? `${Math.round(secs / 60)}m` : `${secs}s`;

	// 顶部摘要行（无数据时用占位符，但行数不变）
	const head = snap
		? renderSummary(theme, snap, points, intervalMs, width)
		: truncateToWidth(theme.fg("dim", "◆ sysmon  正在采集…"), width);

	const out: string[] = [head];
	for (const b of blocks) {
		// 无数据时传空序列：renderMetricBlock 仍会输出 plotRows+2 行（图形留空），保持高度恒定
		const block = snap ? b : { ...b, values: [] };
		out.push(...renderMetricBlock(theme, block, width, plotRows, windowLabel));
	}
	return out;
}
