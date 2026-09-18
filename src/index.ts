/**
 * pi-sysmon — bottom-style braille system monitor charts inside pi.
 *
 * By default the charts are hung **below** the editor via ctx.ui.setWidget
 * (`placement: "belowEditor"`); set `PI_SYSMON_PLACEMENT=above` to put them
 * above; footer mode can also replace the entire bottom bar.
 *
 * About the "is there a 10-line cap" question: pi's
 * `InteractiveMode.MAX_WIDGET_LINES = 10` only clips when `setWidget` receives
 * a **string array** (the Array.isArray branch in interactive-mode.js).
 * This project passes a **component factory**, which goes through another
 * branch with no line clipping at all (widgetsAbove in chat-viewport.js is
 * just `{ component, shrink, minSize }`). So panel height is free — but to
 * avoid eating the chat area, widget mode still gets a row budget (see
 * WIDGET_MAX_ROWS).
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

// ThemeLike is imported uniformly from chart-panel.ts, avoiding two diverging definitions
type Mode = "chart" | "status" | "footer";
type UiHost = Pick<ExtensionCommandContext, "hasUI" | "ui">;

const STATUS_KEY = "sysmon";
const WIDGET_KEY = "sysmon-chart";

/**
 * Total row budget for the panel (widget mode only).
 *
 * First, clear up a common misconception: pi's
 * `InteractiveMode.MAX_WIDGET_LINES = 10` only applies to setWidget in the
 * **string array** form (it slices); this project passes a **component
 * factory** and gets no line clipping at all — so it's not a hard limit.
 *
 * Why set one anyway? The taller the panel, the smaller the chat area. Budget by columns:
 * 1 row of charts (3 cols) → 6 plot rows per block, 8 rows total;
 * 2 rows of charts (2 cols) → 6 plot rows per block, 16 rows total;
 * 3 rows of charts (1 col) → 2 plot rows per block, 12 rows total.
 */
const WIDGET_MAX_ROWS = 18;
/** footer mode owns the whole bottom bar and can spread out a bit more */
const FOOTER_MAX_ROWS = 40;

/** History buffer cap (in points). The window actually displayed is decided by the current layout's plot width. */
const STORE_CAP = 4000;

// ── Persistence: on/off state and mode survive restarts (written to <configDir>/pi-sysmon.json) ──
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
		/* read-only filesystem etc.: ignore */
	}
}

/** Metric history (ring buffer) */
function pushCapped(arr: number[], v: number, cap: number) {
	arr.push(v);
	while (arr.length > cap) arr.shift();
}

/** Read an integer env var; returns undefined when outside [min,max] or non-finite */
function envInt(name: string, min: number, max: number): number | undefined {
	const v = Number(process.env[name]);
	if (!Number.isFinite(v) || v < min) return undefined;
	return Math.min(max, Math.floor(v));
}

export default function (pi: ExtensionAPI) {
	const collector = createCollector();
	const intervalMs = envInt("PI_SYSMON_INTERVAL", 500, 60_000) ?? 1000;

	/**
	 * Plot rows per chart block (excluding the 2 border rows).
	 *
	 * Default 6: with time labels embedded in the bottom border and the x-axis
	 * line served by the 0 baseline, chrome dropped from 4 rows to 2, giving the
	 * plot area 2 more rows within the same 8-row total. Together with "ticks no
	 * longer occupy columns", the chart area at 150 cols / 3 blocks went from
	 * 168 cells to 288 (+71%).
	 */
	const chartH = envInt("PI_SYSMON_CHART_HEIGHT", 1, 40) ?? 6;
	/**
	 * Default time window (seconds), aligned with bottom's `default_time_value = 60_000`.
	 *
	 * **Why a fixed window instead of adapting to width**: the window used to be
	 * derived from "how many data points fit the plot area"
	 * (`plotWidthFor(blockW) * 2 / interval`), so on the same machine, changing
	 * the terminal width drifted the x-axis label from `60s` to
	 * `44s`/`84s`/`118s` — the time scale changed with window size, making
	 * comparisons across widths and machines impossible.
	 * Once fixed to bottom's 60s, one second on the chart is always one second.
	 *
	 * Resolution still depends on width (wide terminals give each point more
	 * sub-pixel columns), but that's "how finely it's drawn", not "how long the
	 * horizontal axis represents" — and the latter is what must be comparable.
	 */
	const defaultWindowSecs = envInt("PI_SYSMON_WINDOW", 5, 24 * 3600) ?? 60;
	/**
	 * Sampling point cap (ring buffer capacity).
	 *
	 * Note the relationship with the window: **points = window seconds × 1000 /
	 * sampling interval**. With the window fixed, a smaller interval needs more
	 * points (60s at 500ms = 120 points). A 4× margin is kept so changing
	 * INTERVAL doesn't silently shorten the window.
	 */
	const fixedPoints = envInt("PI_SYSMON_POINTS", 10, STORE_CAP);
	/**
	 * **Scale sampling fraction** for rate charts (Network / Disks), default 1/6.
	 *
	 * The y-axis scale only looks at the most recent slice of the window (this
	 * fraction of it).
	 *
	 * Default **unset** (i.e. `1`) = scale window == display window: the top of
	 * the y axis is the true maximum of these 60s, and any on-screen height can
	 * be read directly off the top tick.
	 *
	 * Set to a value < 1 (e.g. `1/6`) to enable "auto-fallback": the scale only
	 * looks at the last 1/6 of the window, so ~10s after a spike passes the
	 * scale falls back and later data becomes readable again (the old spike
	 * exceeds the scale and is clipped at the top; the top tick then carries a
	 * `+` meaning "at least this much").
	 */
	const scaleWindowFrac = (() => {
		const v = Number(process.env.PI_SYSMON_SCALE_WINDOW);
		return Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined;
	})();
	/**
	 * Whether to show the TPS (LLM token throughput) chart. **On by default** —
	 * the user asked for four charts by default.
	 *
	 * The opposite of Disks: Disks default to off (they only lay out nicely on
	 * wide terminals), while TPS is a standing indicator the user explicitly
	 * requested. To go back to the old three charts: `PI_SYSMON_TOKENS=0`.
	 */
	const showTokens = process.env.PI_SYSMON_TOKENS !== "0";
	/** Whether to show an extra disk I/O block (default off: four blocks side by side is already the default form) */
	const showDisks = process.env.PI_SYSMON_DISKS === "1";
	/**
	 * Where to put the readouts: `title` (default) = border title bar; `box` =
	 * floating box at the top-right corner; `both` = draw both; `none` = draw
	 * neither (curves only).
	 *
	 * Why `title` is the default: the title-bar row exists anyway (it has to
	 * show `CPU`/`Memory`/`Network`), and its bottom padding fills to the right
	 * border with `─` — those filler columns are **pure decoration**, so putting
	 * readouts there costs nothing. The floating box, on the other hand, is
	 * **painted over the top-right corner of the curve** and really covers a
	 * chunk of plot area, so it isn't the default.
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

	/** Whether the chart hangs below or above the editor (chart mode only; default below, can be restored/overridden by the config file) */
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
	// ── TPS metering (LLM token throughput) ──────────────────────────────────
	// The event side only does O(1) accumulation; the sampling side (sample
	// above) closes buckets and computes the rate.
	// The two sides are fully decoupled: no events means 0, dense events are
	// still just one integer addition, so high TPS never slows down streaming
	// rendering (agent-loop's emit is awaited).
	const tpsMeter = createTpsMeter(performance.now());
	let lastTps = 0;
	// Session-cumulative exact token counts (uplink/downlink/cache read), same
	// convention as pi footer.
	// Accumulated from the `usage` of `message_end` — that's the **exact value**
	// reported by the provider, not an estimate from delta text (only the
	// per-frame "rate" needs estimation).
	//
	// "Accumulate" rather than "take the last message's value", because pi
	// footer also sums over all session entries (`addUsageToTotals`), and we
	// need to match it.
	let tokIn = 0;
	let tokOut = 0;
	let tokCacheRead = 0;

	/** Add one assistant message's exact usage into the cumulative totals (guards against duplicates/bad values) */
	const addUsage = (u: unknown): void => {
		if (!u || typeof u !== "object") return;
		const o = u as Record<string, unknown>;
		// Every field goes through Number.isFinite: providers may give null/undefined,
		// and once NaN enters the cumulative values it poisons the title row
		// (wrong width computation → overflow → pi exits).
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
			// TPS is not a /proc metric; it's "output tokens accumulated since the
			// last tick / time".
			// Use performance.now() instead of assuming the interval is exactly
			// intervalMs: setInterval gets delayed under load, and dividing by the
			// nominal interval would systematically overestimate TPS.
			const { tps, tokens } = tpsMeter.tick(performance.now());
			lastTps = tps;
			// `tokens` here is only used to **drain the bucket** (preventing backlog
			// during disabled periods from becoming a fake spike); it no longer feeds
			// any displayed value — cumulative amounts now come from the exact usage
			// of message_end.
			void tokens;
			pushCapped(hist.tps, tps, STORE_CAP);
		} catch {
			snap = undefined;
		}
	}

	function stop() {
		if (timer) clearInterval(timer);
		timer = undefined;
		// Drain the current bucket on stop. Otherwise tokens accumulated while
		// disabled would all be reported as "this second's rate" on the **first
		// tick after re-enabling** — measured: after being off for 30s, re-enabling
		// reported a fake 6000 tok/s spike (the true instantaneous value was ~0).
		// Drained tokens don't enter any displayed value (cumulative amounts have
		// their own exact source).
		tpsMeter.tick(performance.now());
	}

	/*
	 * The block count (CPU/Memory/Network + Tokens on by default + optional
	 * Disks) is no longer hand-computed — it's the length of `buildBlocks`'s
	 * output, taken directly as `blocks.length` in renderPanelFor, avoiding two
	 * ledgers ("block count declared by the layout" vs "blocks actually drawn")
	 * silently drifting apart.
	 */

	/**
	 * Render the whole panel.
	 *
	 * Note: **how many data points are shown no longer depends on width** — it's
	 * computed from the fixed time window (`PI_SYSMON_WINDOW`, default 60s) and
	 * the sampling interval.
	 * Width only affects "how finely those points are drawn" (braille sub-pixel
	 * columns), not "how long the horizontal axis represents". These two must be
	 * decoupled, otherwise changing terminal width changes the time scale and
	 * comparisons across widths and machines become impossible.
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
		// Build the blocks first, then compute the layout from **blocks.length**.
		// The layout used to take a hand-computed
		// `blockCount = 3 + (showTokens?1:0) + ...`, while the actual block count
		// was decided by ifs inside buildBlocks — two independent ledgers. Once
		// they drift, renderPanel **silently drops** the extra blocks (indexed by
		// band*cols+c, out-of-range just yields nothing, no error), drawing an
		// incomplete panel while all tests stay green.
		// Now there's a single source of truth; drift is structurally impossible.
		const blocks = buildBlocks(hist, snap, {
			points,
			showDisks,
			showTokens,
			// Current TPS rate + the session-cumulative exact counts (same convention as pi footer).
			tpsNow: lastTps,
			tokensIn: tokIn,
			tokensOut: tokOut,
			tokensCacheRead: tokCacheRead,
			labelMode,
			// `undefined` is taken over by the `?? DEFAULT_...` inside buildBlocks, so pass it through
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

	/** Shared implementation of the chart component (widget and footer differ only in row budget) */
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

		// footer: replace the whole bottom bar
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
			// Placement switching: no need to restart the session to switch.
			// It gets its own branch because it's orthogonal to mode/on/off,
			// and a re-render is required after switching (setWidget must be called again).
			if (want === "above" || want === "below") {
				placement = want === "below" ? "belowEditor" : "aboveEditor";
				writeCfg({ enabled, mode, placement });
				if (enabled && activeMode === "chart") {
					disable(ctx);
					enabled = enable(ctx);
				}
				ctx.ui.notify(
					`System monitor: ${want === "below" ? "below editor" : "above editor"}`,
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

	// ── TPS data source: LLM streaming deltas ─────────────────────────────
	// Why not read `partial.usage`: it's **unavailable** during streaming.
	// Measured (pi-ai): Anthropic only sends output_tokens in the last
	// `message_delta` of the stream; OpenAI's usage chunk and Google's
	// usageMetadata likewise only arrive in the final chunk.
	// Zero occurrences of usage in `text_delta` events. Per-frame values can only
	// be **estimated** from delta text; exact values are only available at
	// `message_end` (currently unused there).
	//
	// All three kinds count as output tokens (all are billed): body text,
	// thinking, tool-call arguments.
	// `*_end.content` is the full text of the whole block; counting it would
	// **double-count** the deltas already counted, so never touch it.
	pi.on("message_update", (event) => {
		const ev = event.assistantMessageEvent;
		// Write the type guards out in full instead of just checking `"delta" in ev`:
		// the delta fields of the three event types have different semantics, and
		// listing them explicitly ensures TS reminds us when new event types are added.
		if (ev.type === "text_delta") tpsMeter.add({ kind: "text", delta: ev.delta });
		else if (ev.type === "thinking_delta")
			tpsMeter.add({ kind: "thinking", delta: ev.delta });
		else if (ev.type === "toolcall_delta")
			tpsMeter.add({ kind: "toolcall", delta: ev.delta });
	});

	// ── Exact cumulative totals: only take the provider-reported usage at message end ──────────────
	// Why not read it in message_update: usage there is **simply unavailable**
	// during streaming (measured: input/output are both 0 at text_start; values
	// only appear in the last event).
	// The `usage` from `message_end` is the provider's authoritative value, so
	// just accumulate it — and it matches pi footer's convention (summing over
	// session entries).
	pi.on("message_end", (event) => {
		// Only count assistant messages: user messages also trigger message_end,
		// and counting them would double-count the uplink (the prompt text itself
		// is not token usage).
		if (event.message.role !== "assistant") return;
		addUsage(event.message.usage);
	});

	pi.on("session_start", (_e, ctx) => {
		if (enabled || !ctx.hasUI) return;
		const cfg = readCfg();
		if (cfg.mode) mode = cfg.mode; // remember last mode
		if (cfg.placement) placement = cfg.placement; // remember last placement
		if (cfg.enabled === false) return; // don't auto-enable if it was turned off last time
		enabled = enable(ctx);
	});

	pi.on("session_shutdown", () => {
		stop();
		if (activeMode === "status" && lastCtx?.hasUI)
			lastCtx.ui.setStatus(STATUS_KEY, undefined);
		activeMode = undefined;
	});
}
