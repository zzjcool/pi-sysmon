/**
 * pi-sysmon —— 在 pi 里显示 bottom 风格的 braille 系统监控图。
 *
 * 默认用 ctx.ui.setWidget 把图表挂在编辑器**下方**（`placement: "belowEditor"`），
 * 想放上方就设 `PI_SYSMON_PLACEMENT=above`；也可以用 footer 模式替换整个底部。
 * `chart` 与 `line` 两种模式都是 widget，所以两者都跟随 `above`/`below`
 * （`/sysmon line` 以前走 `setStatus`，被钉死在底部，那是 bug，已改）。
 *
 * 关于「有没有 10 行上限」：pi 的 `InteractiveMode.MAX_WIDGET_LINES = 10` 只在
 * `setWidget` 收到 **字符串数组** 时才裁剪（interactive-mode.js 的 Array.isArray 分支）。
 * 本项目传的是**组件工厂**，走的是另一条分支，没有任何行数裁剪（widgetsAbove 在
 * chat-viewport.js 里只是 `{ component, shrink, minSize }`）。所以面板高度是自由的，
 * 但为了不吃掉聊天区，仍然给 widget 模式一个行数预算（见 WIDGET_MAX_ROWS）。
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	computeLayout,
	renderPanel,
	renderStyledLine,
	type StyledLine,
	type ThemeLike,
} from "./chart-panel.ts";
import {
	buildBlocks,
	parseMode,
	parsePlacement,
	plainLineSegs,
	resolveWindow,
	type History,
	type LabelMode,
	type Mode,
	type Placement,
} from "./blocks.ts";
import { createTpsMeter } from "./tokens.ts";
import { createCollector, type Snapshot } from "./metrics.ts";

// ThemeLike 统一从 chart-panel.ts 导入，避免两处定义不一致。
// `Mode` 与 `Placement` 归 blocks.ts（那里有对应的 `parseMode`/`parsePlacement`），
// 这里 re-export 给旧调用点用。
/**
 * 能用 UI 的宿主。名字沿用 setStatus 时代（当时还要拿它清状态行），
 * 现在它只用来挂 widget/footer。
 */
type UiHost = Pick<ExtensionCommandContext, "hasUI" | "ui">;

const WIDGET_KEY = "sysmon-chart";

/**
 * 面板总行数预算（仅 widget 模式）。
 *
 * 先澄清一个常见误解：pi 的 `InteractiveMode.MAX_WIDGET_LINES = 10` 只对
 * **字符串数组**形态的 setWidget 生效（会 slice）；本项目传的是**组件工厂**，
 * 没有任何行数裁剪 —— 所以这不是硬限制。
 *
 * 那为什么还要设？因为面板越高，聊天区越小。按列数分摊：
 * 1 行摆图（3 列）→ 每块 6 个绘图行，共 8 行；
 * 2 行摆图（2 列）→ 每块 6 个绘图行，共 16 行；
 * 3 行摆图（1 列）→ 每块 2 个绘图行，共 12 行。
 */
const WIDGET_MAX_ROWS = 18;
/** footer 模式占有整个底部，可以铺得开一些 */
const FOOTER_MAX_ROWS = 40;

/** 历史缓冲区上限（点数）。实际显示的窗口由当前布局的绘图宽度决定。 */
const STORE_CAP = 4000;

// ── 持久化：开关与模式跨重启保留（写 <configDir>/pi-sysmon.json）──
function configPath(): string {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(dir, "pi-sysmon.json");
}
interface Cfg {
	enabled?: boolean;
	mode?: Mode;
	placement?: Placement;
}
/**
 * 从配置文件里取模式名。
 *
 * 与 `parseMode` 分开的原因：`parseMode` 会把未知值回退成 `chart`，
 * 而这里的 `undefined` 有独立含义 —— 「配置里没写 mode」，
 * 此时应该保留 `PI_SYSMON_MODE` 设的初始值，而不是被“回退值”覆盖成 chart。
 * 所以这里只做「是不是已知模式名」的判定，**映射仍然只有 `parseMode` 一份**
 * （写两遍 switch 就是本仓库反复批判的双账本）。
 */
function cfgMode(v: unknown): Mode | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim().toLowerCase();
	return t === "chart" || t === "line" || t === "status" || t === "footer"
		? parseMode(t)
		: undefined;
}

function readCfg(): Cfg {
	try {
		const raw: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
		if (typeof raw !== "object" || raw === null) return {};
		const o = raw as Record<string, unknown>;
		const c: Cfg = {};
		if (typeof o.enabled === "boolean") c.enabled = o.enabled;
		const m = cfgMode(o.mode);
		if (m) c.mode = m;
		if (o.placement === "aboveEditor" || o.placement === "belowEditor")
			c.placement = o.placement;
		return c;
	} catch {
		return {};
	}
}
function writeCfg(c: Cfg) {
	try {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), `${JSON.stringify(c, null, 2)}\n`, "utf8");
	} catch {
		/* 只读文件系统等：忽略 */
	}
}

/** 指标历史（环形缓冲） */
function pushCapped(arr: number[], v: number, cap: number) {
	arr.push(v);
	while (arr.length > cap) arr.shift();
}

/** 读一个环境变量整数，超出 [min,max] 或非有限值时返回 undefined */
function envInt(name: string, min: number, max: number): number | undefined {
	const v = Number(process.env[name]);
	if (!Number.isFinite(v) || v < min) return undefined;
	return Math.min(max, Math.floor(v));
}

export default function (pi: ExtensionAPI) {
	const collector = createCollector();
	const intervalMs = envInt("PI_SYSMON_INTERVAL", 500, 60_000) ?? 1000;

	/**
	 * 每块图的绘图行数（不含那 2 行边框）。
	 *
	 * 默认 6：时间标签嵌进下边框、x 轴线由 0 基线兼任后，chrome 从 4 行降到 2 行，
	 * 同样 8 行的总高里绘图区多了 2 行。配合「刻度不再占列」，
	 * 150 列/3 块时的图表面积从 168 格提到 288 格（+71%）。
	 */
	const chartH = envInt("PI_SYSMON_CHART_HEIGHT", 1, 40) ?? 6;
	/**
	 * 默认时间窗口（秒），对齐 bottom 的 `default_time_value = 60_000`。
	 *
	 * **为什么固定窗口而不按宽度自适应**：以前是拿「绘图区能装多少个数据点」
	 * 反推窗口（`plotWidthFor(blockW) * 2 / interval`），结果同一台机器上
	 * 改个终端宽度，x 轴标签就从 `60s` 漂到 `44s`/`84s`/`118s` ——
	 * 时间尺度随窗口大小变化，跨宽度、跨机对比都不可能。
	 * 固定成 bottom 的 60s 后，图上的一秒永远是一秒。
	 *
	 * 分辨率仍然与宽度有关（宽终端每点多占几个子像素列），
	 * 但那是「画得细不细」，不影响「横轴代表多久」——这才是可比较的。
	 */
	const defaultWindowSecs = envInt("PI_SYSMON_WINDOW", 5, 24 * 3600) ?? 60;
	/**
	 * 采样点数上限（环形缓冲的容量）。
	 *
	 * 注意与窗口的关系：**点数 = 窗口秒数 × 1000 / 采样间隔**。
	 * 窗口固定后，间隔越小需要的点数越多（500ms 时 60s 要 120 点）。
	 * 留 4 倍余量，保证改 INTERVAL 时窗口不会被默默截短。
	 */
	const fixedPoints = envInt("PI_SYSMON_POINTS", 10, STORE_CAP);
	/**
	 * 速率图（Network / Disks）的**量程取样比例**，默认 1/6。
	 *
	 * y 轴量程只看最近这么长一段（占窗口的比例）。
	 *
	 * 默认**不设**（即 `1`）= 量程窗 == 显示窗，y 轴顶端就是这 60s 里的真实最高值，
	 * 屏幕上任何高度都能用顶端刻度直接读出来。
	 *
	 * 设为小于 1 的值（如 `1/6`）可开启「自动回落」：量程只看最近 1/6 窗口，
	 * 尖峰过去约 10s 后量程就回落，后面的数据能重新看清（但旧尖峰会超出量程被裁顶，
	 * 此时顶端刻度会带 `+` 表示“至少这么多”）。
	 */
	const scaleWindowFrac = (() => {
		const v = Number(process.env.PI_SYSMON_SCALE_WINDOW);
		return Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined;
	})();
	/**
	 * 是否显示 TPS（LLM token 吞吐）图。**默认开** —— 用户要求默认四图。
	 *
	 * 与 Disks 相反：Disks 默认关（只在宽终端摆得好看），
	 * 而 TPS 是用户点名要的常驻指标。想要回到旧的三图：`PI_SYSMON_TOKENS=0`。
	 */
	const showTokens = process.env.PI_SYSMON_TOKENS !== "0";
	/** 是否额外显示磁盘 I/O 一块（默认关：四块并排已经是默认形态） */
	const showDisks = process.env.PI_SYSMON_DISKS === "1";
	/**
	 * 读数放哪里：`title`（默认）= 边框标题栏；`box` = 右上角浮动框；
	 * `both` = 两者都画；`none` = 都不画（只要曲线）。
	 *
	 * 默认 `title` 的理由：标题栏那一行本来就存在（要写 `CPU`/`Memory`/`Network`），
	 * 而且底部还用 `─` 填充到右边框 —— 那段填充列是**纯装饰**，
	 * 拿来放读数等于零成本。浮动框则是**覆盖在曲线右上角**画的，
	 * 会真的遮掉一块绘图区，所以不做默认。
	 */
	const labelMode: LabelMode = (() => {
		const v = process.env.PI_SYSMON_LABEL;
		return v === "box" || v === "both" || v === "none" || v === "title"
			? v
			: "title";
	})();

	let mode: Mode = parseMode(process.env.PI_SYSMON_MODE);

	/** 图表/文字行挂编辑器下方还是上方（chart 与 line 都生效；默认下方） */
	let placement: Placement = parsePlacement(process.env.PI_SYSMON_PLACEMENT);

	const hist: History = {
		cpu: [],
		mem: [],
		netRx: [],
		netTx: [],
		diskR: [],
		diskW: [],
		tps: [],
	};
	// ── TPS 计量（LLM token 吞吐）──────────────────────────────────
	// 事件侧只做 O(1) 累加，采样侧（上面的 sample）才出桶算速率。
	// 两边完全解耦：没有事件时就是 0，事件密集时也只是一个整数加法，
	// 不会因为 TPS 高而拖慢流式渲染（agent-loop 的 emit 是 await 的）。
	const tpsMeter = createTpsMeter(performance.now());
	let lastTps = 0;
	// 会话累计的精确 token 计数（上行/下行/缓存读），口径同 pi footer。
	// 从 `message_end` 的 `usage` 累加 —— 那是 provider 报的**精确值**，
	// 不是从 delta 文本估算的（只有每帧「速率」才需要估算）。
	//
	// 用「累加」而不是「取最后一个 message 的值」是因为 pi footer 也是
	// 扫全部 session entries 求和（`addUsageToTotals`），要与之对得上。
	let tokIn = 0;
	let tokOut = 0;
	let tokCacheRead = 0;

	/** 把一条 assistant 消息的精确 usage 计入累计（防重/防坏值） */
	const addUsage = (u: unknown): void => {
		if (!u || typeof u !== "object") return;
		const o = u as Record<string, unknown>;
		// 每个字段都过一遍 Number.isFinite：provider 可能给 null/undefined，
		// 而 NaN 一旦进累计值就会污染标题行（宽度算错 → 越界 → pi 退出）。
		const n = (v: unknown) =>
			typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
		tokIn += n(o.input);
		tokOut += n(o.output);
		tokCacheRead += n(o.cacheRead);
	};

	let enabled = false;
	let activeMode: Mode | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let snap: Snapshot | undefined;

	function sample() {
		try {
			snap = collector.collect();
			pushCapped(hist.cpu, snap.cpuPct, STORE_CAP);
			pushCapped(hist.mem, snap.memPct, STORE_CAP);
			pushCapped(hist.netRx, snap.rxBps, STORE_CAP);
			pushCapped(hist.netTx, snap.txBps, STORE_CAP);
			pushCapped(hist.diskR, snap.readBps, STORE_CAP);
			pushCapped(hist.diskW, snap.writeBps, STORE_CAP);
			// TPS 不是 /proc 指标，而是「从上个 tick 到现在累积的输出 token / 时间」。
			// 用 performance.now() 而不是假定间隔恰好是 intervalMs：
			// setInterval 在系统忙时会被推迟，按名义间隔除会系统性高估 TPS。
			const { tps, tokens } = tpsMeter.tick(performance.now());
			lastTps = tps;
			// 这里的 tokens 只用于**排空桶**（防止停用期积压变成假尖峰），
			// 不再计入任何显示值 —— 累计量现在走 message_end 的精确 usage。
			void tokens;
			pushCapped(hist.tps, tps, STORE_CAP);
		} catch {
			snap = undefined;
		}
	}

	function stop() {
		if (timer) clearInterval(timer);
		timer = undefined;
		// 关闭时把当前桶倒掉。否则关闭期间累积的 token 会在**重新启用后的第一个 tick**
		// 全部当成「这一秒的速率」报出去 —— 实测关闭 30s 后重新打开会报出
		// 6000 tok/s 的假尖峰（真实瞬时值接近 0）。
		// 倒掉的 token 不进入任何显示值（累计量另有精确来源）。
		tpsMeter.tick(performance.now());
	}

	/*
	 * 块数（CPU/Memory/Network + Tokens 默认开 + Disks 可选）不再手算 ——
	 * 它是 `buildBlocks` 的输出长度，在 renderPanelFor 里直接取 `blocks.length`，
	 * 避免“布局声明的块数”与“实际画出的块数”两个账本悄悄漂移。
	 */

	/**
	 * 渲染整块面板。
	 *
	 * 注意：**显示多少个数据点不再依赖宽度** —— 它由固定时间窗口
	 * （`PI_SYSMON_WINDOW`，默认 60s）与采样间隔算出。
	 * 宽度只影响「把这些点画得多细」（braille 子像素列数），
	 * 不影响「横轴代表多久」。这两件事必须拆开，否则换个终端宽度
	 * 时间尺度就变了，跨宽度、跨机器都没法对比。
	 */
	function renderPanelFor(
		theme: ThemeLike,
		width: number,
		maxRows: number,
	): string[] {
		const { points, windowSecs } = resolveWindow({
			windowSecs: defaultWindowSecs,
			intervalMs,
			fixedPoints,
			available: hist.cpu.length,
		});
		// 先构造块，再用 **blocks.length** 算布局。
		// 以前布局用的是一个手算的 `blockCount = 3 + (showTokens?1:0) + ...`，
		// 而实际块数由 buildBlocks 内部的 if 决定 —— 两个独立账本，
		// 一旦漂移，renderPanel 会**静默丢弃**多出来的块（按 band*cols+c 索引，
		// 越界就取不到，不报错），画出残缺面板而所有测试仍然绿。
		// 现在只有一个真相来源，漂移在结构上不可能。
		const blocks = buildBlocks(hist, snap, {
			points,
			showDisks,
			showTokens,
			// 当前 TPS 速率 + 会话累计的三个精确计数（同 pi footer 口径）。
			tpsNow: lastTps,
			tokensIn: tokIn,
			tokensOut: tokOut,
			tokensCacheRead: tokCacheRead,
			labelMode,
			// `undefined` 会被 buildBlocks 里的 `?? DEFAULT_...` 接管，直接传即可
			scaleWindowFrac,
		});
		const layout = computeLayout(width, chartH, blocks.length, maxRows);
		return renderPanel(theme, blocks, width, layout, windowSecs);
	}

	/**
	 * `line` 模式（`/sysmon line`）的一行文字 —— 返回**带色片段**，
	 * 由调用方交给 `renderStyledLine` 渲染成定宽单行。
	 *
	 * 为什么不再在这里拼字符串：那版实现把「数据选择」和「渲染」揉在一起，
	 * 既没有 token 读数，也没法复用图表那套宽字符/ANSI 精确算宽。
	 * 现在数据在 `blocks.ts` 的 `plainLineSegs`（可单测），渲染在 chart-panel。
	 */
	const plainLine = (width: number): StyledLine =>
		plainLineSegs(
			{
				snap,
				tpsNow: lastTps,
				tokensIn: tokIn,
				tokensOut: tokOut,
				tokensCacheRead: tokCacheRead,
			},
			width,
		);

	/**
	 * 所有模式的公共组件骨架：装定时器、逐帧采样、可 dispose。
	 *
	 * 三种模式（chart / line / footer）只差一个 `render(width)`，
	 * 所以骨架必须只有一份 —— 以前 `line` 用的是 `setInterval(push)`、
	 * 图表用的是组件工厂里自己的 `setInterval`，两套 timer 的管理方式
	 * （谁在什么时候 `stop()`、`timer` 变量指向谁）迟早会漂移。
	 * 现在只有这一处碰 `timer`。
	 */
	function makeSampled(render: (theme: ThemeLike, width: number) => string[]) {
		return (tui: { requestRender(): void }, theme: ThemeLike) => {
			// 重建组件时先停掉可能存在的旧 timer：
			// `setWidget` 每次都会调工厂，而 `stop()` 清理的是模块级的 `timer`，
			// 不先停就会出现两个 `setInterval` 同时跑（双倍采样 + 双倍渲染）。
			stop();
			const localTimer = setInterval(() => {
				sample();
				tui.requestRender();
			}, intervalMs);
			timer = localTimer;
			return {
				// dispose 必须幂等且**只能清自己的那个 timer**：pi 替换/移除 widget
				// 时会叫 dispose（那时模块级 `timer` 可能已经指向新组件的 timer 了，
				// 直接 `stop()` 会把新组件的 timer 误杀）。清完再把模块级别名收回，
				// 使 `timer` 永远不会指向一个已被清掉的句柄。
				//
				// 不靠“dispose 一定会被调”来防泄漏：pi 在会话销毁/替换时确实会调
				// （`agent-session-runtime.js` 的 `dispose()`/`teardownCurrent()` →
				// `beforeSessionInvalidate` → `resetExtensionUI` → `clearExtensionWidgets`
				// → `widget.dispose?.()`），而且 `stop()`/`disable()` 已经先清一次；
				// 这里只是把“旧组件晚于新组件工厂被 dispose”的窗口也封住。
				// （实测：`/new` 替换会话后图表仍在刷新，无陈旧 timer 泄漏。）
				dispose: () => {
					clearInterval(localTimer);
					if (timer === localTimer) timer = undefined;
				},
				invalidate() {},
				render: (width: number) => render(theme, width),
			};
		};
	}

	/** 图表组件（widget 与 footer 只差行数预算） */
	const makeChart = (maxRows: number) =>
		makeSampled((theme, width) => renderPanelFor(theme, width, maxRows));

	/**
	 * `line` 模式的组件：恒 1 行，内容随宽度自适应。
	 *
	 * 用 `setWidget` 而不是 `setStatus` 是为了**跟随 placement**：
	 * `setStatus` 的内容由 pi 内建 footer 渲染，位置固定在底部；
	 * 而 widget 能落到编辑器上方或下方，与图表模式的 `/sysmon above|below` 一致。
	 * 这样「`/sysmon below` 之后 line 也应该在下面」这条期望才成立。
	 */
	const makeLine = () =>
		makeSampled((theme, width) => {
			// **必须以布局给的 `width` 为准**：它才是这一帧可用的列数，
			// 渲染得比它宽就是越界，而越界会让 pi 直接退出（铁律）。
			// 不能用 `process.stdout.columns` 兜底 —— 那是**终端全宽**，
			// 而 widget 的实际可用宽度可以更窄（容器留白/同排其他 widget），
			// 真走到那个回退反而是往越界方向跑。`renderStyledLine` 自己
			// 会把非有限值钳成 1，所以这里只需处理 floor。
			return [renderStyledLine(theme, plainLine(width), width)];
		});

	function enable(ctx: UiHost): boolean {
		if (!ctx.hasUI) return false;
		stop();
		sample();
		activeMode = mode;

		if (mode === "status") {
			// 用 widget 而非 `setStatus`：widget 的 `placement` 能跟随图表模式
			// （`/sysmon above|below`）落到编辑器上方或下方，而 `setStatus` 的内容
			// 永远被钉在 pi 内建 footer 里 —— 那就是「位置和图表对不上」的根因。
			//
			// 行数也一致（恒 1 行），所以不会造成编辑器位移。
			ctx.ui.setWidget(WIDGET_KEY, makeLine(), { placement });
			return true;
		}

		if (mode === "chart") {
			ctx.ui.setWidget(WIDGET_KEY, makeChart(WIDGET_MAX_ROWS), {
				placement,
			});
			return true;
		}

		// footer：整块底部替换
		ctx.ui.setFooter(makeChart(FOOTER_MAX_ROWS));
		return true;
	}

	function disable(ctx: UiHost) {
		stop();
		const was = activeMode;
		activeMode = undefined;
		if (!ctx.hasUI || was === undefined) return;
		// chart 与 status(line) 都用同一个 widget key（互斥，不会同时存在），
		// 所以两者的清理是同一条语句 —— 不要写成两个看起来不同却等价的 else-if。
		if (was === "status" || was === "chart")
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		else ctx.ui.setFooter(undefined);
	}

	pi.registerFlag("sysmon", {
		description: "Enable the system monitor",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("sysmon", {
		description: "System monitor: /sysmon [chart|line|footer|on|off|above|below]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const want = String(args ?? "").trim();
			// 位置切换：切换时不用重新开一次会话。
			// 单开一条分支是因为它跟 mode/on/off 正交，
			// 而且切完要重新 render 一次（setWidget 得重新调用）。
			if (want === "above" || want === "below") {
				placement = want === "below" ? "belowEditor" : "aboveEditor";
				writeCfg({ enabled, mode, placement });
				// **chart 与 status(line) 都用 placement**（status 现在也是 widget，
				// 不再是钉在 footer 里的 setStatus），所以两者都要重挂一次。
				// 只判 chart 会让「/sysmon above」后 line 仍然留在原位 ——
				// 那正是「位置和图表对不上」的另一个入口。
				if (enabled && (activeMode === "chart" || activeMode === "status")) {
					disable(ctx);
					enabled = enable(ctx);
				}
				ctx.ui.notify(
					`System monitor: ${want === "below" ? "编辑器下方" : "编辑器上方"}`,
					"info",
				);
				return;
			}
			const map: Record<string, Mode> = {
				chart: "chart",
				line: "status",
				status: "status",
				footer: "footer",
			};
			const newMode = map[want];
			let explicit: boolean | undefined;
			if (want === "on") explicit = true;
			else if (want === "off") explicit = false;

			// 显式点模式名 = **幂等的「切到这个模式并打开」**，不是切换开关。
			// 旧逻辑在「已经是这个模式」时会落到下面的 `target = !enabled` 分支
			// 而把监控**关掉**（`/sysmon line` 在 line 模式下报 “off (remembered)”），
			// 与 README 里「line = 一行文字模式」的语义直接矛盾。
			if (newMode) explicit = true;

			if (enabled && newMode && newMode !== activeMode) {
				disable(ctx);
				mode = newMode;
				enabled = enable(ctx);
				writeCfg({ enabled, mode, placement });
				ctx.ui.notify(`System monitor: ${mode}`, "info");
				return;
			}
			if (newMode) mode = newMode;

			const target = explicit ?? !enabled;
			if (target) {
				enabled = enable(ctx);
				if (enabled) {
					writeCfg({ enabled: true, mode, placement });
					ctx.ui.notify(`System monitor: ${mode} (${intervalMs}ms)`, "info");
				}
			} else {
				disable(ctx);
				enabled = false;
				writeCfg({ enabled: false, mode, placement });
				ctx.ui.notify("System monitor off (remembered)", "info");
			}
		},
	});

	// ── TPS 数据来源：LLM 流式增量 ──────────────────────────────
	// 为什么不看 `partial.usage`：它在流式期间**不可用**。
	// 实测（pi-ai）：Anthropic 只在流的最后一个 `message_delta` 才给 output_tokens，
	// OpenAI 的 usage chunk / Google 的 usageMetadata 同样都在末块。
	// `text_delta` 事件里 0 处 usage。逐帧只能用 delta 文本**估算**，
	// 精确值只能在 `message_end` 拿（目前不用）。
	//
	// 这三类都算输出 token（都是计费的）：正文、思考、工具调用参数。
	// `*_end.content` 是整块全文，计入会与已计的 delta **双重计数**，所以绝不碰。
	pi.on("message_update", (event) => {
		const ev = event.assistantMessageEvent;
		// 类型守卫写全，而不是只判 `"delta" in ev`：三种事件的 delta 字段语义不同，
		// 显式列出才能在将来新增事件类型时被 TS 提醒。
		if (ev.type === "text_delta") tpsMeter.add({ kind: "text", delta: ev.delta });
		else if (ev.type === "thinking_delta")
			tpsMeter.add({ kind: "thinking", delta: ev.delta });
		else if (ev.type === "toolcall_delta")
			tpsMeter.add({ kind: "toolcall", delta: ev.delta });
	});

	// ── 精确累计：只在消息结束时取 provider 报的 usage ──────────────
	// 为什么不在 message_update 里取：那里的 usage 在流式期间**根本不可用**
	// （实测：text_start 时 input/output 都是 0，要等最后一个事件才有值）。
	// `message_end` 拿到的 `usage` 是 provider 的权威值，直接累加即可，
	// 而且与 pi footer 的口径（扫 session entries 求和）一致。
	pi.on("message_end", (event) => {
		// 只算 assistant 消息：user 消息也会触发 message_end，
		// 算进去会把上行重复计数（提示词文本本身不是 token 用量）。
		if (event.message.role !== "assistant") return;
		addUsage(event.message.usage);
	});

	pi.on("session_start", (_e, ctx) => {
		if (enabled || !ctx.hasUI) return;
		const cfg = readCfg();
		if (cfg.mode) mode = cfg.mode; // 记住上次模式
		if (cfg.placement) placement = cfg.placement; // 记住上次位置
		if (cfg.enabled === false) return; // 上次关了就不再自开
		enabled = enable(ctx);
	});

	pi.on("session_shutdown", () => {
		stop();
		activeMode = undefined;
	});
}
