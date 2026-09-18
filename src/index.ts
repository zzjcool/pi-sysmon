/**
 * pi-sysmon —— 在 pi 里显示 bottom 风格的 braille 系统监控图。
 *
 * 默认用 ctx.ui.setWidget 把图表挂在编辑器**下方**（`placement: "belowEditor"`），
 * 想放上方就设 `PI_SYSMON_PLACEMENT=above`；也可以用 footer 模式替换整个底部。
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
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { computeLayout, renderPanel, type ThemeLike } from "./chart-panel.ts";
import {
	buildBlocks,
	parsePlacement,
	resolveWindow,
	type History,
	type LabelMode,
	type Placement,
} from "./blocks.ts";
import { createTpsMeter } from "./tokens.ts";
import {
	createCollector,
	fmtBytes,
	fmtRate,
	type Snapshot,
} from "./metrics.ts";

// ThemeLike 统一从 chart-panel.ts 导入，避免两处定义不一致
type Mode = "chart" | "status" | "footer";
type UiHost = Pick<ExtensionCommandContext, "hasUI" | "ui">;

const STATUS_KEY = "sysmon";
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
function readCfg(): Cfg {
	try {
		const raw: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
		if (typeof raw !== "object" || raw === null) return {};
		const o = raw as Record<string, unknown>;
		const c: Cfg = {};
		if (typeof o.enabled === "boolean") c.enabled = o.enabled;
		if (o.mode === "chart" || o.mode === "status" || o.mode === "footer")
			c.mode = o.mode;
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

	let mode: Mode = (() => {
		const m = process.env.PI_SYSMON_MODE;
		return m === "status" || m === "footer" || m === "chart" ? m : "chart";
	})();

	/** 图表挂编辑器下方还是上方（仅 chart 模式生效；默认下方，可由配置文件恢复/覆盖） */
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
	let lastCtx: UiHost | undefined;

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

	const plainLine = (s: Snapshot, width: number): string => {
		const cpu = `CPU ${s.cpuPct.toFixed(0)}%`;
		const mem = `MEM ${s.memPct.toFixed(0)}% ${fmtBytes(s.memUsed)}`;
		const net = `NET ↑${fmtRate(s.txBps)} ↓${fmtRate(s.rxBps)}`;
		const tiers = [[cpu, mem, net], [cpu, mem], [cpu]];
		for (const parts of tiers) {
			const line = parts.join("  ");
			if (visibleWidth(line) <= Math.max(24, Math.floor(width / 2))) return line;
		}
		return cpu;
	};

	/** 图表组件的公共实现（widget 与 footer 只差行数预算） */
	function makeChart(maxRows: number) {
		return (tui: { requestRender(): void }, theme: ThemeLike) => {
			stop();
			const localTimer = setInterval(() => {
				sample();
				tui.requestRender();
			}, intervalMs);
			timer = localTimer;
			return {
				dispose: () => clearInterval(localTimer),
				invalidate() {},
				render: (width: number) => renderPanelFor(theme, width, maxRows),
			};
		};
	}

	function enable(ctx: UiHost): boolean {
		if (!ctx.hasUI) return false;
		stop();
		sample();
		activeMode = mode;
		lastCtx = ctx;

		if (mode === "status") {
			const push = () => {
				sample();
				ctx.ui.setStatus(
					STATUS_KEY,
					snap ? plainLine(snap, process.stdout.columns || 80) : "sysmon …",
				);
			};
			ctx.ui.setStatus(STATUS_KEY, "sysmon …");
			timer = setInterval(push, intervalMs);
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
		if (was === "status") ctx.ui.setStatus(STATUS_KEY, undefined);
		else if (was === "chart") ctx.ui.setWidget(WIDGET_KEY, undefined);
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
				if (enabled && activeMode === "chart") {
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
		if (activeMode === "status" && lastCtx?.hasUI)
			lastCtx.ui.setStatus(STATUS_KEY, undefined);
		activeMode = undefined;
	});
}
