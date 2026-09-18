/**
 * 指标块的构造 —— 把「历史 + 最新快照」变成 chart-panel 能画的 `MetricBlock[]`。
 *
 * 单独成文件的原因：这是**唯一**决定「每张图显示什么、读数写什么」的地方，
 * 抽出来才能被测试和渲染 harness 直接复用，而不是让它们在别处复制一份再慢慢漂移。
 * 这里不碰 pi API、不碰 TUI，纯数据 → 纯数据。
 */
import {
	percentAxis,
	rateAxis,
	type AxisSpec,
	type MetricBlock,
	type StyledLine,
} from "./chart-panel.ts";
import { fmtBytes, fmtRate, type Snapshot } from "./metrics.ts";
// TPS 的格式化函数住在 token 模块里（那里才是「token 相关」的归属地），
// 这里 import 而不是自己再写一份 —— 同一个量有两份 formatter 迟早漂移。
import { fmtTps } from "./tokens.ts";

/** 需要画成曲线的历史序列（都是数值数组，索引 0 最旧） */
export interface History {
	cpu: number[];
	mem: number[];
	netRx: number[];
	netTx: number[];
	diskR: number[];
	diskW: number[];
	/**
	 * LLM token 吞吐（tok/s），由 pi 的 `message_update` 流式事件估算而来。
	 *
	 * 它不是系统指标（不来自 `/proc`），而是「本 pi 进程与 LLM API 之间的吞吐」，
	 * 所以由 `src/tokens.ts` 的 meter 供给，详见那里的注释。
	 */
	tps: number[];
}

/**
 * 速率图量程取样比例的默认值。
 *
 * `1` = **量程窗 == 显示窗（60s）**，即 y 轴顶端就是这 60 秒里的真实最高值。
 * 这是用户明确要的行为：
 *   「我不需要 + 啊，我就是想要显示最高的地方就可以了，然后 60s 一个窗口」
 * 好处：屏幕上任何一根曲线的高度都能用顶端刻度直接读出来（**刻度永不撒谎**），
 * 不需要溢出标记 `+`。
 *
 * 代价（已知、已被用户明确接受）：一根尖峰会把量程钉住到它滞出 60s 窗口为止，
 * 期间后面的值看起来偏小。此前曾默认用 `1/6`（只看最近 10s）来缓解，
 * 但那反而造成「刻度只报 293KB、屏幕上却有根顶到天的尖峰」的撒谎问题。
 *
 * 想要旧的自动回落行为：设 `PI_SYSMON_SCALE_WINDOW=1/6`（或任意 <1 的比例），
 * 那时溢出标记 `+` 会自动生效来保证刻度仍然不撒谎。
 */
export const DEFAULT_SCALE_WINDOW_FRAC = 1;

export interface BlockOptions {
	/** 每张图显示最近多少个数据点（由布局的绘图宽度算出，见 plotWidthFor） */
	points: number;
	/** 是否额外加一块磁盘 I/O */
	showDisks?: boolean;
	/**
	 * 是否显示 TPS（LLM token 吞吐）图。**默认开**（用户要求默认四图）。
	 *
	 * 它和磁盘图不同：磁盘图默认关（四块并排只在宽终端才好看），
	 * 而 TPS 是用户点名要的常驻指标。
	 */
	showTokens?: boolean;
	/** 当前 TPS 读数（tok/s）。由 `src/tokens.ts` 的 meter 供给，供标题栏显示 */
	tpsNow?: number;
	/**
	 * 会话累计的**上行** token（我们发给模型的提示词），
	 * 取自 `message_end` 的精确 `usage.input`（不是估算）。
	 */
	tokensIn?: number;
	/** 会话累计的**下行** token（模型返回的输出），取自精确 `usage.output` */
	tokensOut?: number;
	/** 会话累计的缓存读取 token（`usage.cacheRead`），显示为 `R…` */
	tokensCacheRead?: number;
	/**
	 * 读数放哪里：`title`（默认）= 边框标题栏；`box` = 右上角浮动框；
	 * `both` = 两者都画；`none` = 都不画。
	 *
	 * 两个位置的数据是分开提供的：`MetricBlock.titleInfo` 给标题栏，
	 * `MetricBlock.legend` 给浮动框。这样两种模式各自都能写最合适的文案
	 * （例如标题栏可以省略 `RX:` 前缀，因为颜色已经区分了 RX/TX）。
	 */
	labelMode?: LabelMode;
	/**
	 * 速率图（Network / Disks / Tokens）的**量程取样比例**，默认 `1`。
	 *
	 * 含义：y 轴量程看**整个窗口**（60s）的最大值，而不是只取最近一小段。
	 * 这样屏幕上任何一根曲线的高度都能直接用顶端刻度读出来（刻度不撒谎）。
	 * 代价：比 10s 更旧的尖峰会被裁顶（画成贴顶平顶）。
	 *
	 * 参照 btop 验证过的做法（`btop_collect.cpp` 的 `net_auto`：
	 * 滞后计数 5 帧后把量程降到「近期均值 × 1.3」，带 10KiB 下限）。
	 * 取「10 秒」而不是 btop 的「5 帧」，是把它换算到本项目的时间尺度：
	 * 5 秒太敏感，正常的短突发刚画上去就被裁顶。
	 *
	 * 传 `1` 可退回「整个窗口取 max」的旧行为。
	 * 百分比图不受影响（量程固定 0..100）。
	 */
	scaleWindowFrac?: number;
}

/** 读数渲染位置 */
export type LabelMode = "title" | "box" | "both" | "none";

/**
 * 图表作为 widget 时挂在编辑器的上方还是下方。
 *
 * 对应 pi 官方的 `setWidget(key, content, { placement })`（`WidgetPlacement`
 * 自 0.8x 起就是公开 API）。只有 `chart` 模式用得上 ——
 * `footer` 模式是替换整个底部（footer 本来就在编辑器下方），`status` 模式只是一个状态行。
 */
export type Placement = "aboveEditor" | "belowEditor";

/**
 * 解析 `PI_SYSMON_PLACEMENT`。
 *
 * **默认（不设）= `belowEditor`**（图表在输入框下方）——
 * 这是用户选的默认：图表贴底，不占聊天区上方的位置。
 *
 * 宽容取值：`above` / `aboveEditor` / `top` 都当“上方”，
 * 其余（含 undefined、拼错的值）一律回退到默认的 `belowEditor` ——
 * 与 `PI_SYSMON_LABEL` / `PI_SYSMON_MODE` 的容错方式一致：
 * 配错一个环境变量不应该让整个扩展不工作。
 *
 * 注意旧版本默认是 `aboveEditor`，所以 `PI_SYSMON_PLACEMENT=above`
 * 是升级后保持旧观感的开关。
 */
export function parsePlacement(v: string | undefined): Placement {
	const s = (v ?? "").trim().toLowerCase();
	return s === "above" || s === "aboveeditor" || s === "top"
		? "aboveEditor"
		: "belowEditor";
}

/**
 * 会话累计输出 token 的短格式（`1.2M` / `345K` / `1200`）。
 *
 * 不进图表刻度，所以不用定宽；但必须有上界，否则一场极长会话的累计值
 * 会把标题行撑破（宽度越界 = pi 崩溃退出）。进制用 1000（token 是十进制量纲）。
 */
/**
 * 格式化一个 token 计数。
 *
 * **刻意逐字对齐 pi footer 的 `formatTokens`**（`dist/modes/interactive/components/footer.js`）：
 * 这样图上的 `↑5.7k ↓11` 与 pi 底部那行 `↑5.7k ↓11 R640` 数字完全一致，可互相对照。
 * 包括**小写 `k`** —— 大写 `K` 既与宿主不一致，也会和 `fmtTps` 的 `Kt/s` 混淆。
 *
 * 唯一与 pi 不同的是**加了上界钳制**：本仓库的铁律是任何渲染行超宽就让 pi
 * 崩溃退出，所以极端值必须收口（pi 那边没有上限，会一路长到 `1000000M`）。
 */
export function fmtTokensTotal(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n >= 1e9) return ">999M";
	if (n >= 1e7) return `${Math.round(n / 1e6)}M`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return Math.floor(n).toString();
}

/** 取数组尾部 n 个元素（不足则全取） */
export function tail(arr: number[], n: number): number[] {
	return n >= arr.length ? arr : arr.slice(arr.length - n);
}

/**
 * TPS 图的 y 轴 —— 与 `rateAxis` 算法相同（量程 = 最大值 × 1.5、只标顶端一个值、
 * 定宽 `RATE_GUTTER` 列），但**单位是 token 而不是字节**。
 *
 * 为什么不直接用 `rateAxis`：它硬编码了 1024 进制和 `B/KB/MB` 后缀，
 * 拿它画 tok/s 会输出 `2.2KB`（1500 tok/s）这种错单位的刻度 ——
 * 图上写着 KB，实际是 token，比没刻度还糟。
 *
 * 1K = 1000（不是 1024）：token 计数是十进制量纲，
 * 而且 API 账单里的 token 数也是十进制（`total_tokens`），不应用二进制换算。
 *
 * 刻度下限：`MIN_TPS_SCALE`。没有它的话，空闲期一个 1 tok/s 的尾点会把量程钉到 1.5，
 * 下一句回复 200 tok/s 就直接顶格。有下限则从 10 tok/s 起步，曲线仍然接近贴底，
 * 但不会因为一个噪声点就压缩整个量程。
 */
/**
 * TPS 图量程下限（tok/s）。没有它的话，空闲期一个 1 tok/s 的尾点会把量程钉到 1.5，
 * 下一句回复 200 tok/s 就直接顶格；有下限则从 10 tok/s 起步。
 */
export const MIN_TPS_SCALE = 10;

/**
 * TPS 图的刻度列宽。
 *
 * 比 `RATE_GUTTER`（5）宽，因为单位是 `tok/s` —— 光单位就 5 列，
 * 再塞数字就必然超宽。宽到 8 列才能装下 `1.5Kt/s` 这种带单位的刻度。
 *
 * 和 `RATE_GUTTER` 一样是**恒定宽**：刻度标签宽度一变，
 * 叠印宽度就跟着变 → 绘图区左边界逐帧左右跳（ARCHITECTURE 坑 6）。
 */
export const TPS_GUTTER = 8;

/**
 * TPS 图的 y 轴。
 *
 * 算法与 `rateAxis` 一致（量程 = 最大值 × 1.5、只标顶端一个值、定宽右对齐），
 * 但**单位是 token 而不是字节**。
 *
 * 为什么不直接用 `rateAxis`：它硬编码了 1024 进制和 `B/KB/MB` 后缀 ——
 * 拿它画 tok/s 会输出 `2.2KB`（实际是 1500 tok/s）这种错单位的刻度。
 * 图上写着 KB 而实际是 token，比没有刻度更糟。
 *
 * 进制用 **1000** 而非 1024：token 是十进制量纲，API 账单里的 `total_tokens` 也是十进制。
 */
export function tokenAxis(dataMax: number): AxisSpec {
	// NaN/Infinity/负数先落回 0：否则 `Math.max` 会把 NaN 一路带到刻度文字里，
	// 再往下就是 NaN 坐标 → 越界崩溃（见 ARCHITECTURE.md 坑 4）。
	const dm = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
	// 量程 = 最大值 × 1.5（峰值落在轴高约 2/3 处，与 rateAxis 同口径）；
	// 空数据/极小值用下限，避免量程为 0（图会直接贴顶）。
	const top = Math.max(dm * 1.5, MIN_TPS_SCALE);
	// 定宽右对齐：所有分支都必须恰好返回 TPS_GUTTER 列。
	const fit = (v: number): string => {
		let s: string;
		if (v >= 1e6)
			s = ">999Kt/s"; // 极端值：给个上界，绝不输出科学计数法
		else if (v >= 1000) {
			const k = (v / 1000).toFixed(1);
			s = `${k}Kt/s`;
			// 放不下就降精度（`100.5K` → `101K`），而不是截断出 `100.5Kt/` 这种残串。
			if (s.length > TPS_GUTTER) {
				// 取整后可能得 1000（如 v=999999 → `1000K`），必须落回钳制值：
				// 否则刻度会写 `1000Kt/s`，与上面的 `>999Kt/s` 口径自相矛盾
				// （而且 `1000K` 读着像 1M，却还带 K 后缀）。
				const n = Math.round(v / 1000);
				s = n >= 1000 ? ">999Kt/s" : `${n}Kt/s`;
			}
		} else {
			s = `${v.toFixed(0)}t/s`;
		}
		return s.padStart(TPS_GUTTER);
	};
	return { labels: [fit(top)], max: top };
}

/** 时间窗口的解析结果 */
export interface WindowSpec {
	/** 应该取多少个数据点画图 */
	points: number;
	/** x 轴左端标签显示的时长（秒） */
	windowSecs: number;
}

/**
 * 解析「该显示多长的历史」。
 *
 * **这是横轴时间尺度的唯一来源。** 抽成纯函数的理由是它曾经是一个真 bug：
 * 以前在原地按「绘图区能装多少点」反推窗口（`plotWidthFor(blockW) * 2 / interval`），
 * 结果同一台机器上改个终端宽度，x 轴标签就从 `60s` 漂到 `44s`/`84s`/`118s` ——
 * 时间尺度随窗口尺寸变化，跨宽度、跨机器都没法对比。
 * 而且那段逻辑写在组件闭包里，没有测试能碰到它（渲染 harness 还各自抄了一遗，
 * 导致改了一处另一处照旧漂移）。现在只有这一份，且可单测。
 *
 * 两个关键行为：
 *  1. **默认按时间取点，不按宽度**（对齐 bottom 的 `default_time_value = 60_000`）；
 *  2. **标签永远显示配置的窗口长度**（启动 3 秒也显示 `60s`）——
 *     以前这里会按已攒点数缩成 `3s`，导致启动期横轴时长一直变，
 *     看的人没法把“现在这一段”和“满窗口”对比。配合右对齐渲染
 *     （`stretch: false`，数据从右侧长出来），`60s` 这个读数才是诚实的：
 *     3 秒的数据就只占右边 1/20 宽度，而不是被拉伸冒充 60 秒。
 */
export function resolveWindow(opts: {
	/** 目标窗口时长（秒） */
	windowSecs: number;
	/** 采样间隔（毫秒）—— 窗口换算成点数时要用 */
	intervalMs: number;
	/** 显式指定的点数（PI_SYSMON_POINTS），设了就忽略窗口秒数 */
	fixedPoints?: number;
	/**
	 * 目前缓冲区里实际有多少点。
	 * @deprecated 不再用它缩短窗口时长（那会使横轴刻度漂移）。
	 * 保留参数是为了不改动现有调用点；传入值被忽略。
	 */
	available?: number;
}): WindowSpec {
	const points =
		opts.fixedPoints ??
		Math.max(2, Math.round((opts.windowSecs * 1000) / opts.intervalMs));
	// 窗口时长**不随已攒历史变化**：刻度必须稳定。
	// 之前用 `min(points, available)` 是为了“不让标签谎报”，
	// 但那让启动期的横轴一直在长（3s→14s→30s→60s）。
	// 真正诚实的做法是**按时间比例渲染**（数据从右边长出来、一秒的屏宽恒定），
	// 而不是把刻度改成当前已有的时长。
	//
	// 时长必须由**实际点数**反推，而不是直接返回 `windowSecs`：
	// `PI_SYSMON_POINTS` 可显式改点数，那时真实窗口就是 `points` 个采样间隔，
	// 与 `windowSecs` 无关（否则 `POINTS=200` 会谎报 `60s`）。
	return { points, windowSecs: (points * opts.intervalMs) / 1000 };
}

/**
 * 构造各指标块。`snap === undefined`（采集失败/尚未采集）时仍然返回结构完整的块，
 * 只是没有读数、曲线为空 —— 行数因此保持恒定。
 */
export function buildBlocks(
	hist: History,
	snap: Snapshot | undefined,
	opts: BlockOptions,
): MetricBlock[] {
	const points = Math.max(1, Math.floor(opts.points));
	// 读数位置开关：默认 `title`（标题栏），也就是只填 titleInfo、不填 legend。
	// 这里统一决定，避免每个块里各写一遗 `labelMode` 判断而漏掉某个块。
	const mode: LabelMode = opts.labelMode ?? "title";
	const wantTitle = mode === "title" || mode === "both";
	const wantBox = mode === "box" || mode === "both";
	/** 按开关取舍：不要的那一份直接置空，renderBlock/renderPanel 会自然跳过 */
	const at = (title: StyledLine | undefined): StyledLine | undefined =>
		wantTitle ? title : undefined;
	const ab = (box: StyledLine[]): StyledLine[] => (wantBox ? box : []);
	// 速率图的量程取样点数：由**目标窗口**折算，与当前已经攒了多少点无关。
	// 用绝对点数而非比例，是因为比例会随启动初期的短数组得到越来越长的量程窗，
	// 使恢复耗时飘忽（实测会从 10s 漂到 18s）。
	const rateScalePts = Math.max(
		1,
		Math.round(points * (opts.scaleWindowFrac ?? DEFAULT_SCALE_WINDOW_FRAC)),
	);

	const blocks: MetricBlock[] = [
		{
			// 名字与 bottom 的边框标题一致
			name: "CPU",
			color: "success",
			// 标题栏读数（按重要度降序，窄块时从尾部丢）：
			// 当前占用率 → 1/5/15 分钟负载（后者的格式对齐 bottom 的 `CPU ─ 1.52 1.71 2.26`）
			titleInfo: at(
				snap
					? [
							{ text: `${snap.cpuPct.toFixed(0)}%`, color: "success" },
							{
								text: `  ${snap.load1.toFixed(2)} ${snap.load5.toFixed(2)} ${snap.load15.toFixed(2)}`,
								color: "muted",
							},
						]
					: undefined,
			),
			series: [{ values: tail(hist.cpu, points) }],
			// 供 `PI_SYSMON_LABEL=box` 使用的浮动读数框（内容与标题栏有重叠，
			// 因为两种模式只启用其一，不必为避免重复而牺牲信息量）
			legend: ab(snap ? [[{ text: `AVG ${snap.cpuPct.toFixed(0)}%` }]] : []),
			windowPoints: points,
			axis: () => percentAxis(),
		},
		{
			name: "Memory",
			color: "warning",
			// 用户点名要的：把 `30G/62G` 直接接在标题栏的百分比后面
			titleInfo: at(
				snap
					? [
							{ text: `${snap.memPct.toFixed(0)}%`, color: "warning" },
							{
								text: `  ${fmtBytes(snap.memUsed)}/${fmtBytes(snap.memTotal)}`,
								color: "muted",
							},
						]
					: undefined,
			),
			series: [{ values: tail(hist.mem, points) }],
			legend: ab(
				snap
					? [
							[
								{ text: `RAM ${snap.memPct.toFixed(0)}% ` },
								{ text: `${fmtBytes(snap.memUsed)}/${fmtBytes(snap.memTotal)}` },
							],
						]
					: [],
			),
			windowPoints: points,
			axis: () => percentAxis(),
		},
		{
			name: "Network",
			color: "accent",
			// 顺序是**瞬时速率在前、累计总流量在后**，因为标题栏宽度不够时
			// 是**从尾部丢**，所以后面的会先被藏起来。
			// 速率变化是这张图的主体（曲线画的也是它），放前面保证任何宽度都在；
			// 总流量是背景信息，窄块时先舍它。
			// Σ = 累计（∑）。同理 ↓=RX 用 accent、↑=TX 用 warning，
			// 与图里两条曲线同色，所以不用额外文字区分方向。
			titleInfo: at(
				snap
					? [
							{ text: `↓${fmtRate(snap.rxBps)}`, color: "accent" },
							{ text: " ", color: "muted" },
							{ text: `↑${fmtRate(snap.txBps)}`, color: "warning" },
							// Σ 那一段**拆成三小段**，而不是一整块。
							//
							// 原因：标题栏是「逐段累积，放不下就 break」，所以**段的粒度
							// 决定了能不能部分显示**。原来 `  Σ↓79G ↑128G` 是一个 14 字符段，
							// 要么全进要么全丢 —— 四图改造后每块变窄（150 列时只有 38 列，
							// roomForInfo≈23），整个 Σ 就被一起丢掉了（实测 Σ 要到 164 列
							// 才重新出现，而三图时 124 列就行）。拆开后 150 列下能保住
							// `Σ↓79G`，信息不再是非黑即白。
							{ text: "  Σ", color: "muted" },
							{ text: `↓${fmtBytes(snap.rxTotal)}`, color: "accent" },
							{ text: ` ↑${fmtBytes(snap.txTotal)}`, color: "warning" },
						]
					: undefined,
			),
			// RX/TX 画在同一张图里但各占一色（对齐 bottom 的蓝/黄双线）
			series: [
				{ values: tail(hist.netRx, points), color: "accent" },
				{ values: tail(hist.netTx, points), color: "warning" },
			],
			// 单行（浮框只放累计流量，它是图上唯一看不到的信息）——
			// 两行浮框 legendH=4 会在默认 plotRows=4 时溢出绘图区而被整块丢掉。
			legend: ab(
				snap
					? [
							[
								{ text: "Σ " },
								{ text: `↓${fmtBytes(snap.rxTotal)}`, color: "accent" },
								{ text: " " },
								{ text: `↑${fmtBytes(snap.txTotal)}`, color: "warning" },
							],
						]
					: [],
			),
			scaleWindowPoints: rateScalePts,
			windowPoints: points,
			axis: (dataMax) => rateAxis(dataMax),
		},
	];

	// TPS（LLM token 吞吐）—— 默认开，是用户点名要的常驻第四图。
	// 它排在最后：这样前三个位置（CPU/Memory/Network）既有的索引与文档不变，
	// 而“默认四图”仍然成立。
	if (opts.showTokens !== false) {
		// 曲线只画**下行（output）速率**，而读数把两个方向都列出来。
		//
		// 为什么不画两条曲线（像 Network 的 RX/TX）：两个方向的**时间形状根本不同**。
		// 实测一次真实调用：上行 input = 5671 tokens（**一次性整块**上传），
		// 下行 output = 11 tokens（**逐字流式**），比例约 516:1。
		// 画在同一根 y 轴上，input 会把量程顶到 5671，output 被压成 0.2% 高度、
		// 完全看不见 —— 这正是用户之前抱怨过的「尖峰钉死量程」的极端版。
		// 所以：曲线给唯一有意义的连续量（output 速率），
		// 两个方向的**累计量**放标题栏 —— 它们本来就不是速率，不该上速率轴。
		//
		// 读数口径**逐字对齐 pi footer**（`↑input ↓output RcacheRead`，会话累计），
		// 这样图上的数字与 pi 底部那行可以直接对照。
		// 顺序按重要度降序（窄块时从尾部丢）：当前速率 → 上行 → 下行 → 缓存读。
		const cur = opts.tpsNow ?? 0;
		const tokIn = opts.tokensIn ?? 0;
		const tokOut = opts.tokensOut ?? 0;
		const tokR = opts.tokensCacheRead ?? 0;
		// `~` 只加在**速率**上：它是从 delta 文本估算的，不是计量。
		// 累计值来自 `message_end` 的精确 `usage`，所以不加 `~` ——
		// 这个区分本身就是给用户的信息（哪个数字可信）。
		const curTxt = `~${fmtTps(cur)}`;
		// 分段构造：`↑`/`↓`/`R` 与 pi footer 同字同序。
		// 用 muted 给累计值：它们是背景信息，不该和曲线的 accent 抢眼。
		const ioSegs: StyledLine = [];
		if (tokIn > 0) ioSegs.push({ text: `  \u2191${fmtTokensTotal(tokIn)}` });
		if (tokOut > 0) ioSegs.push({ text: ` \u2193${fmtTokensTotal(tokOut)}` });
		if (tokR > 0) ioSegs.push({ text: ` R${fmtTokensTotal(tokR)}` });
		blocks.push({
			name: "Tokens",
			color: "accent",
			// 与其他块一致：拿不到快照（如非 Linux 上采集失败）时就不写读数。
			// TPS 本身不依赖 /proc，但这个不变式（无快照 ⇒ 无读数）值得保留。
			titleInfo: at(
				snap ? [{ text: curTxt, color: "accent" }, ...ioSegs] : undefined,
			),
			series: [{ values: tail(hist.tps, points) }],
			legend: ab([[{ text: curTxt }]]),
			scaleWindowPoints: rateScalePts,
			windowPoints: points,
			// 用 token 单位的刻度（不能复用 rateAxis：它会把 tok/s 标成 KB）
			axis: (dataMax) => tokenAxis(dataMax),
		});
	}

	if (opts.showDisks) {
		blocks.push({
			name: "Disks",
			color: "error",
			titleInfo: at(
				snap
					? [
							{ text: `R ${fmtRate(snap.readBps)}`, color: "accent" },
							{ text: " ", color: "muted" },
							{ text: `W ${fmtRate(snap.writeBps)}`, color: "error" },
						]
					: undefined,
			),
			series: [
				{ values: tail(hist.diskR, points), color: "accent" },
				{ values: tail(hist.diskW, points), color: "error" },
			],
			legend: ab(
				snap
					? [
							[{ text: "R: " }, { text: fmtRate(snap.readBps), color: "accent" }],
							[{ text: "W: " }, { text: fmtRate(snap.writeBps), color: "error" }],
						]
					: [],
			),
			scaleWindowPoints: rateScalePts,
			windowPoints: points,
			axis: (dataMax) => rateAxis(dataMax),
		});
	}
	return blocks;
}
