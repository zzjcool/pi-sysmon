/**
 * pi-sysmon 图表模式 —— 用 braille 折线图在 pi 里展示 CPU/内存/网络历史。
 *
 * 默认用 ctx.ui.setWidget 把图表挂在编辑器上方（pi 限制 widget 最多 10 行）。
 * 也可用 footer 模式替换整个底部（无行数上限）。
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	renderPanel as renderChartPanel,
	type MetricBlock,
	type ThemeLike,
} from "./chart-panel.ts";
import {
	createCollector,
	fmtBytes,
	fmtRate,
	type Snapshot,
} from "./metrics.ts";

// ThemeLike 统一从 chart-panel.ts 导入，避免两处定义不一致（Theme 是 class，dim 只是颜色名）
type Mode = "chart" | "status" | "footer";
type UiHost = Pick<ExtensionCommandContext, "hasUI" | "ui">;

const STATUS_KEY = "sysmon";
const WIDGET_KEY = "sysmon-chart";

// ── 持久化：开关与模式跨重启保留（写 <configDir>/pi-sysmon.json）──
function configPath(): string {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(dir, "pi-sysmon.json");
}
interface Cfg {
	enabled?: boolean;
	mode?: Mode;
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

/** 指标历史（环形缓冲，按最长窗口截断） */
interface History {
	cpu: number[];
	mem: number[];
	netRx: number[];
	netTx: number[];
	diskR: number[];
	diskW: number[];
}

function pushCapped(arr: number[], v: number, cap: number) {
	arr.push(v);
	while (arr.length > cap) arr.shift();
}

export default function (pi: ExtensionAPI) {
	const collector = createCollector();
	const intervalMs = (() => {
		const v = Number(process.env.PI_SYSMON_INTERVAL);
		return Number.isFinite(v) && v >= 500 ? v : 1000;
	})();
	// 历史点数：默认按终端宽度自适应（约每字符 2 个 braille 子像素列），
	// 这样数据能恰好填满图表，且 x 轴的时间窗口保持稳定（不会因数据量变化而漂移）。
	const maxPoints = (() => {
		const v = Number(process.env.PI_SYSMON_POINTS);
		if (Number.isFinite(v) && v >= 10) return Math.min(4000, Math.floor(v));
		const cols = process.stdout.columns || 120;
		// 减去左侧标签宽度(13)与留白，乘 2（braille 每字符 2 列子像素）
		return Math.max(60, Math.min(4000, (cols - 14) * 2));
	})();
	const chartH = (() => {
		const v = Number(process.env.PI_SYSMON_CHART_HEIGHT);
		return Number.isFinite(v) && v >= 1 && v <= 6 ? v : 3;
	})();

	let mode: Mode = (() => {
		const m = process.env.PI_SYSMON_MODE;
		return m === "status" || m === "footer" || m === "chart" ? m : "chart";
	})();

	const hist: History = {
		cpu: [],
		mem: [],
		netRx: [],
		netTx: [],
		diskR: [],
		diskW: [],
	};
	let enabled = false;
	let activeMode: Mode | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let snap: Snapshot | undefined;
	let lastCtx: UiHost | undefined;

	function sample() {
		try {
			snap = collector.collect();
			pushCapped(hist.cpu, snap.cpuPct, maxPoints);
			pushCapped(hist.mem, snap.memPct, maxPoints);
			pushCapped(hist.netRx, snap.rxBps, maxPoints);
			pushCapped(hist.netTx, snap.txBps, maxPoints);
			pushCapped(hist.diskR, snap.readBps, maxPoints);
			pushCapped(hist.diskW, snap.writeBps, maxPoints);
		} catch {
			snap = undefined;
		}
	}

	function stop() {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	/** 带左侧标签的图表块：标签打在中间行，其余行补空格。 */
	/** 渲染整块图表面板（带坐标轴/刻度/时间标签，供 widget / footer 共用）。 */
	function renderPanel(theme: ThemeLike, width: number): string[] {
		// 各指标块：百分比图固定量程，网络用动态量程（max × 1.5 留白）
		const netTotal = hist.netTx.map((v, i) => v + (hist.netRx[i] ?? 0));
		const blocks: MetricBlock[] = [
			{
				name: "CPU",
				values: hist.cpu,
				color: "success",
				fixedMax: 100,
				format: (v) => `${v.toFixed(0)}%`,
			},
			{
				name: "MEM",
				values: hist.mem,
				color: "warning",
				fixedMax: 100,
				format: (v) => `${v.toFixed(0)}%`,
			},
			{
				name: "NET",
				values: netTotal,
				color: "accent",
				format: (v) => fmtRate(v),
			},
		];
		return renderChartPanel(
			theme,
			snap,
			blocks,
			width,
			chartH,
			maxPoints,
			intervalMs,
		);
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
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					stop();
					const localTimer = setInterval(() => {
						sample();
						tui.requestRender();
					}, intervalMs);
					timer = localTimer;
					return {
						dispose: () => clearInterval(localTimer),
						invalidate() {},
						render: (width: number) => renderPanel(theme, width),
					};
				},
				{ placement: "aboveEditor" },
			);
			return true;
		}

		// footer：整块底部替换（无行数上限）
		ctx.ui.setFooter((tui, theme) => {
			stop();
			const localTimer = setInterval(() => {
				sample();
				tui.requestRender();
			}, intervalMs);
			timer = localTimer;
			return {
				dispose: () => clearInterval(localTimer),
				invalidate() {},
				render: (width: number) => renderPanel(theme, width),
			};
		});
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
		description: "System monitor: /sysmon [chart|line|footer|on|off]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const want = String(args ?? "").trim();
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
				writeCfg({ enabled, mode });
				ctx.ui.notify(`System monitor: ${mode}`, "info");
				return;
			}
			if (newMode) mode = newMode;

			const target = explicit ?? !enabled;
			if (target) {
				enabled = enable(ctx);
				if (enabled) {
					writeCfg({ enabled: true, mode });
					ctx.ui.notify(`System monitor: ${mode} (${intervalMs}ms)`, "info");
				}
			} else {
				disable(ctx);
				enabled = false;
				writeCfg({ enabled: false, mode });
				ctx.ui.notify("System monitor off (remembered)", "info");
			}
		},
	});

	pi.on("session_start", (_e, ctx) => {
		if (enabled || !ctx.hasUI) return;
		const cfg = readCfg();
		if (cfg.mode) mode = cfg.mode; // 记住上次模式
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
