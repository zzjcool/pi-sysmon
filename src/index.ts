/**
 * pi-sysmon — bottom-style braille system monitor charts inside pi.
 *
 * By default the charts are hung **below** the editor via ctx.ui.setWidget
 * (`placement: "belowEditor"`); set `PI_SYSMON_PLACEMENT=above` to put them
 * above; footer mode can also replace the entire bottom bar.
 * Both `chart` and `line` modes are widgets, so both follow `above`/`below`
 * (`/sysmon line` used to go through `setStatus`, pinned to the bottom —
 * that was a bug, now fixed).
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
	ContextUsage,
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
import { createTpsMeter, hitRate } from "./tokens.ts";
import { createCollector, type Snapshot } from "./metrics.ts";
import {
	lastSessionEnabled,
	mergeCfg,
	parseSysmonCommand,
	resolveEnabled,
	SESSION_STATE_KEY,
} from "./state.ts";

// ThemeLike is imported uniformly from chart-panel.ts, avoiding two diverging definitions.
// `Mode` and `Placement` live in blocks.ts (which owns the matching
// `parseMode`/`parsePlacement`) and are re-exported here for legacy call sites.
/**
 * Structural stand-in for pi's `ExtensionContext` — but only the fields this
 * extension actually reads. `getContextUsage` is optional: the fake ctx in
 * tests doesn't implement it, and the whole reading degrades to "unknown"
 * (◔ segment simply absent) rather than crashing.
 */
type CtxUsageHost = {
	getContextUsage(): ContextUsage | undefined;
};

/**
 * A host that can use the UI. The name dates back to the setStatus era (when
 * it was also needed to clear the status line); now it's only used to mount
 * widgets/footers.
 */
type UiHost = Pick<ExtensionCommandContext, "hasUI" | "ui">;

const WIDGET_KEY = "sysmon-chart";

/**
 * Structural stand-in for the tui object pi hands to component factories.
 *
 * Deliberately **not** imported from pi-tui: the factory only ever calls
 * `requestRender()` and reads `mode`, and a structural type keeps this
 * extension decoupled from pi-tui's exact TUI interface (and from its
 * version). `mode` is optional because the factory may be invoked with any
 * object that merely *quacks* like a tui (tests, older hosts).
 */
type TuiLike = { requestRender(): void; mode?: string };

/**
 * Structural stand-in for pi-tui's `TuiMouseEvent` (same reasoning as
 * TuiLike: only the fields needed for hit-testing are declared; all optional
 * so a partial event from a stubbed host can't crash the handler).
 */
type MouseEv = {
	type?: string;
	button?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
};

/**
 * The clickable chip that toggles chart ↔ line in fullscreen mode.
 *
 * Pure ASCII on purpose: wide glyphs (★/⇄/emoji) would break the cell-width
 * bookkeeping this renderer is built on, and hover highlighting is out —
 * tmux/zellij only enable ?1002h (press/release), never move events, so the
 * chip must read as clickable without any hover feedback.
 */
const CHIP_CHART_TO_LINE = "[line]";
const CHIP_LINE_TO_CHART = "[chart]";
// Hit rectangles are sized from the **actual text length** of the chip being
// shown (`[line]`=6, `[chart]`=7), so the clickable area matches the rendered
// glyphs exactly — a shared max() would make the rect one column wider than
// the shorter chip.
const CHIP_CHART_W = CHIP_CHART_TO_LINE.length;
const CHIP_LINE_W = CHIP_LINE_TO_CHART.length;

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
 *
 * Fullscreen mode adds exactly 1 chip row **on top of this budget** — the
 * chart body subtracts it (`maxRows - 1` when `fs`) so the total stays ≤ 18,
 * and regular mode (`fs=false`) renders byte-identical rows to before.
 */
const WIDGET_MAX_ROWS = 18;
/** footer mode owns the whole bottom bar and can spread out a bit more */
const FOOTER_MAX_ROWS = 40;

/** History buffer cap (in points). The window actually displayed is decided by the current layout's plot width. */
const STORE_CAP = 4000;

// ── Persistence: **display preferences** and the **global on/off default** live in
// <configDir>/pi-sysmon.json; the per-session on/off choice lives in the session file ──
//
// Why the split (this used to be a single global `enabled`): a global `on/off`
// answers "what should every new session start with?", while `/sysmon off` is
// almost always a statement about *this* session. Conflating them meant one
// `/sysmon off` here silently turned the monitor off in every other session and
// in every future run. So:
//   · `enabled` in the file  = global default, written **only** by `/sysmon global on|off`
//   · `mode` / `placement`   = display preferences, keep writing the file
//     (otherwise every new session would need its charts re-selected)
//   · `/sysmon on|off`       = session choice, written as a session entry
function configPath(): string {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(dir, "pi-sysmon.json");
}
interface Cfg {
	/** Global **default** for sessions that never touched the switch (not "the current state") */
	enabled?: boolean;
	mode?: Mode;
	placement?: Placement;
}

type WritePatch = Partial<Cfg>;

/**
 * Merge a patch into the config file.
 *
 * `mergeCfg` (pure, tested) owns the merge rule; this only does the I/O. The
 * read-modify-write is deliberate: a plain overwrite with a partial object
 * would drop whichever of `enabled`/`mode`/`placement` this caller didn't set
 * (e.g. `/sysmon chart` clearing the global default).
 */
function writeCfg(patch: WritePatch) {
	try {
		let prev: Record<string, unknown> = {};
		try {
			const raw: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
			if (typeof raw === "object" && raw !== null)
				prev = raw as Record<string, unknown>;
		} catch {
			/* no file yet (or unreadable): start from scratch */
		}
		const next = mergeCfg(prev, patch);
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
	} catch {
		/* read-only filesystem etc.: ignore */
	}
}
/**
 * Read the mode name from the config file.
 *
 * Why this is separate from `parseMode`: `parseMode` falls back to `chart`
 * for unknown values, while `undefined` here has its own meaning — "no mode
 * written in the config" — in which case the initial value from
 * `PI_SYSMON_MODE` should be kept instead of being overwritten by the
 * fallback. So this only answers "is it a known mode name"; **the mapping
 * itself still lives in exactly one place, `parseMode`** (writing the switch
 * twice is the double-ledger this repo keeps criticizing).
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

	let mode: Mode = parseMode(process.env.PI_SYSMON_MODE);

	/** Whether the charts/text line hang below or above the editor (applies to both chart and line; default below) */
	let placement: Placement = parsePlacement(process.env.PI_SYSMON_PLACEMENT);

	const hist: History = {
		cpu: [],
		cpuTemp: [],
		mem: [],
		netRx: [],
		netTx: [],
		diskR: [],
		diskW: [],
		tps: [],
		sessHit: [],
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
	/**
	 * **Instantaneous** cache hit rate of the most recent assistant turn (0..100).
	 *
	 * `undefined` means "no measurable prompt has been reported yet" — it is
	 * deliberately *not* initialised to 0. A real 0% (everything missed the
	 * cache — expensive and worth showing in red) and "we have no idea yet" are
	 * different states, and collapsing them would make the title bar claim a 0%
	 * hit rate before the first reply even arrives.
	 */
	let lastHit: number | undefined;
	/**
	 * **Context-window usage** in percent (0..100), refreshed every sample from
	 * pi's own `ctx.getContextUsage()` — the same number pi's built-in footer
	 * shows, so the two readouts can be cross-checked.
	 *
	 * `undefined` = unknown (no model yet, or the post-compaction window where
	 * pi itself reports `percent: null` until the next LLM response): the `◔N%`
	 * segment is simply absent, the same way `·N%` is absent before the first
	 * measurable prompt. Deliberately **not** re-derived from our own token
	 * totals — pi's estimate accounts for system prompt, tool results, and
	 * compaction boundaries; re-deriving it here would be a second ledger
	 * guaranteed to drift.
	 */
	let ctxPct: number | undefined;
	/** The most recent event context with `getContextUsage()` — see sample(). */
	let usageHost: CtxUsageHost | undefined;

	/** Add one assistant message's exact usage into the cumulative totals (guards against duplicates/bad values) */
	const addUsage = (u: unknown): void => {
		if (!u || typeof u !== "object") return;
		const o = u as Record<string, unknown>;
		// Every field goes through Number.isFinite: providers may give null/undefined,
		// and once NaN enters the cumulative values it poisons the title row
		// (wrong width computation → overflow → pi exits).
		const n = (v: unknown) =>
			typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
		// This turn's own prompt-token counts, kept before they're folded into the
		// session totals: the instantaneous rate must come from **this** turn's
		// `usage`, not from the running sums (a cumulative ratio would barely
		// move and would hide a cache-missing turn for a long time).
		const inNow = n(o.input);
		const rNow = n(o.cacheRead);
		tokIn += inNow;
		tokOut += n(o.output);
		tokCacheRead += rNow;
		// Only overwrite when this turn actually carried prompt tokens: a message
		// with no measurable prompt (e.g. a continuation that only streams output)
		// tells us nothing about the current hit rate, so the previous turn's
		// reading is kept instead of being clobbered with a meaningless 0%.
		// That "keep the last known value" semantics is also why `lastHit` starts
		// as `undefined` rather than 0 (see the declaration).
		if (inNow + rNow > 0) lastHit = hitRate(rNow, inNow);
	};

	// Whether the monitor is *currently* mounted. Session-scoped: decided in
	// `session_start` (session entry → `--sysmon` → global default) and rewritten
	// by `/sysmon on|off`. The config file's `enabled` is a **default for new
	// sessions**, never the current state — reading it back here would make one
	// session's choice leak into the next.
	let enabled = false;
	let activeMode: Mode | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let snap: Snapshot | undefined;
	/**
	 * The host the panel is currently mounted on, remembered so a chip click
	 * can re-run the exact same switch path as `/sysmon chart|line` without
	 * the component factory holding a stale `ctx` closure (the factory's ctx
	 * could belong to an already-torn-down session; this variable is written
	 * by enable()/disable(), the same ledger that owns activeMode).
	 */
	let host: UiHost | undefined;

	function sample() {
		try {
			// Context usage first: pi recomputes it per call, and it's O(entries) —
			// reading it once per sample (1 Hz by default) is exactly the sampling
			// cadence this block already runs at. Wrapped defensively: a throwing
			// host (old pi without the method, stubbed tests) degrades to "unknown",
			// never kills system sampling.
			try {
				const u = usageHost?.getContextUsage();
				// `percent: null` (post-compaction) must map to `undefined` (unknown),
				// never to 0 — "91% a second ago" collapsing to "0%" after a compaction
				// would look like a reset that never happened.
				ctxPct =
					u && typeof u.percent === "number" && Number.isFinite(u.percent)
						? u.percent
						: undefined;
			} catch {
				ctxPct = undefined;
			}
			snap = collector.collect();
			pushCapped(hist.cpu, snap.cpuPct, STORE_CAP);
			pushCapped(hist.cpuTemp, snap.cpuTemp, STORE_CAP);
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
			// Session-cumulative hit rate, **recomputed here** from the running
			// totals instead of kept in its own accumulator: one less ledger to
			// drift, and the curve is naturally a staircase (it only moves when a
			// message_end lands) — see the History.sessHit comment.
			pushCapped(
				hist.sessHit,
				hitRate(tokCacheRead, tokIn),
				STORE_CAP,
			);
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
		/** Whether the `↑`/`↓`/`R` token totals may be shown — footer mode only (see BlockOptions.showTokenTotals). */
		showTokenTotals: boolean,
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
			// Last turn's instantaneous hit rate. `hitNow` is left `undefined` while
			// no cache reads have happened at all: `buildBlocks` already gates the
			// `·`/`⌀` readouts and the second curve on `tokR > 0`, so a session that
			// never touches the cache degrades to the old single-curve Tokens block
			// without any special casing here.
			hitNow: tokCacheRead > 0 ? lastHit : undefined,
			// Context-window usage — same "unknown ⇒ absent" degradation as hitNow.
			ctxPct,
			// Cumulative token counters: only footer mode replaces pi's own footer
			// (and its `↑ ↓ R` reading) — widget modes sit next to it, where showing
			// the same numbers twice is pure noise.
			showTokenTotals,
			labelMode,
			// `undefined` is taken over by the `?? DEFAULT_...` inside buildBlocks, so pass it through
			scaleWindowFrac,
		});
		const layout = computeLayout(width, chartH, blocks.length, maxRows);
		return renderPanel(theme, blocks, width, layout, windowSecs);
	}

	/**
	 * One line of text for `line` mode (`/sysmon line`) — returns **colored
	 * segments**, which the caller hands to `renderStyledLine` to render into a
	 * fixed-width single row.
	 *
	 * Why the string is no longer assembled here: that version of the
	 * implementation mixed "data selection" and "rendering" together, had no
	 * token readouts, and couldn't reuse the chart's exact wide-char/ANSI width
	 * accounting. Now data lives in `blocks.ts`'s `plainLineSegs` (unit-testable),
	 * and rendering lives in chart-panel.
	 */
	const plainLine = (width: number): StyledLine =>
		plainLineSegs(
			{
				snap,
				tpsNow: lastTps,
				tokensIn: tokIn,
				tokensOut: tokOut,
				tokensCacheRead: tokCacheRead,
				// Same gating as the chart path above, so both modes show a hit rate
				// (or neither does) — never a `·0%` on the line while the chart omits it.
				hitNow: tokCacheRead > 0 ? lastHit : undefined,
				// Context-window usage — same value, same degradation as the chart path.
				ctxPct,
			},
			width,
		);

	// Chip hit rectangle in component-local coordinates, refreshed by every
	// render(width). handleMouse is only wired up when this is set (fullscreen
	// render happened); a regular-mode render clears it, so no stale rectangle
	// survives a fullscreen→regular switch.
	let chipRect: { x: number; y: number; w: number } | undefined;

	/**
	 * Hit-test + dispatch for the chip, shared by all three modes.
	 *
	 * pi only synthesizes a `click` for the component that returned
	 * `{handled:true}` on the matching `press`, so both must be claimed inside
	 * the chip rectangle. Outside it, `undefined` is returned — pi's fallback
	 * (drag text selection) stays completely untouched.
	 */
	/**
	 * Hit-test + dispatch for the chip, shared by all three modes.
	 *
	 * pi only synthesizes a `click` for the component that returned
	 * `{handled:true}` on the matching `press`, so both must be claimed inside
	 * the chip rectangle. Outside it, `undefined` is returned — pi's fallback
	 * (drag text selection) stays completely untouched.
	 *
	 * `fullscreenNow` re-reads the tui Proxy per **event** (same live check as
	 * render): `chipRect` is only refreshed on render, and pi reuses this very
	 * component object across tuiMode switches without re-running the factory,
	 * so right after a fullscreen→regular switch a one-frame window exists where
	 * the stale rectangle would still be hit-testable. Reading the mode here
	 * (not trusting the last render) closes that window — regular mode stays
	 * zero-side-effect no matter when the event arrives.
	 */
	function handleChipMouse(
		tui: TuiLike,
		ev: MouseEv,
	): { handled: true } | undefined {
		if (tui.mode !== "fullscreen") return undefined;
		if (ev.type !== "press" && ev.type !== "click") return undefined;
		if (ev.button !== "left") return undefined;
		const r = chipRect;
		if (!r) return undefined;
		// Defend against partial events (stub hosts, older pi): a missing
	// coordinate/size means "can't prove a hit" → treat as outside.
		const x = ev.x;
		const y = ev.y;
		if (x === undefined || y === undefined) return undefined;
		const h = ev.height ?? 0;
		// No separate `x >= (ev.width ?? 0)` guard: the chip rectangle is
		// right-aligned to the **rendered** width, so `x >= r.x + r.w` already
		// rejects every column at/after the rectangle's right edge — a width
		// guard can only fire on columns the rect test already rejects (the
		// two conditions are provably redundant; mutation testing caught the
		// original pair surviving as dead code).
		// `y >= h` is NOT redundant: the rectangle's row comes from the last
	// render while `ev.height` comes from the event, and pi's layout can lag
	// one frame behind the component's row count after a reflow — that guard
		// is what drops clicks aimed at rows the host doesn't think exist.
		if (
			x < r.x ||
			x >= r.x + r.w ||
			y !== r.y ||
			y >= h
		)
			return undefined;
		if (ev.type === "click") toggleMode();
		return { handled: true };
	}

	/**
	 * The single funnel for mode switching — the chip click goes through the
	 * exact same path as `/sysmon chart|line` (`mode = next; writeCfg;
	 * applyEnabled`), so persistence scope can't drift between the two entries.
	 *
	 * Only chart ↔ line: footer has no line-mode counterpart to toggle into
	 * (and the chip is what a footer user clicked, so landing in line mode is
	 * exactly what they asked for).
	 *
	 * Never writes the config's `enabled` field: that is the global default,
	 * writable by `/sysmon global on|off` only. applyEnabled records this
	 * session's choice as a session entry, same as the command handler does.
	 */
	function toggleMode() {
		const h = host;
		if (!h) return; // nothing mounted → nothing to toggle
		mode = mode === "status" ? "chart" : "status";
		writeCfg({ mode, placement });
		applyEnabled(true, h);
	}

	/**
	 * Shared component skeleton for all modes: installs the timer, samples each
	 * frame, is disposable.
	 *
	 * The three modes (chart / line / footer) differ only in `render(width)`,
	 * so the skeleton must exist exactly once — `line` used to run its own
	 * `setInterval(push)` while the charts ran their own `setInterval` inside
	 * the component factory; two timer-management styles (who calls `stop()`
	 * when, which timer the `timer` variable points at) would drift sooner or
	 * later. Now this is the only place that touches `timer`.
	 *
	 * `extraRow` is an optional constant trailing row (the chip row in
	 * fullscreen mode). It lives in the skeleton — not inside render — so
	 * regular mode is byte-identical to before (no row appended, no handler
	 * touched) and the row-count contract is owned in one place.
	 */
	function makeSampled(
		render: (theme: ThemeLike, width: number, fs: boolean) => string[],
		extraRow?: (theme: ThemeLike, width: number, fs: boolean) => string,
	) {
		return (tui: TuiLike, theme: ThemeLike) => {
			// When rebuilding a component, first stop any old timer that may still
			// exist: `setWidget` calls the factory every time, while `stop()` clears
			// the module-level `timer` — without this, two `setInterval`s would run
			// simultaneously (double sampling + double rendering).
			stop();
			const localTimer = setInterval(() => {
				sample();
				tui.requestRender();
			}, intervalMs);
			timer = localTimer;
			return {
				// dispose must be idempotent and **only clear its own timer**: pi calls
				// dispose when replacing/removing a widget (by then the module-level
				// `timer` may already point at the new component's timer, and a blind
				// `stop()` would kill the new component's timer by mistake). After
				// clearing, take the module-level alias back so `timer` never points
				// at an already-cleared handle.
				//
				// Leak prevention doesn't rely on "dispose will definitely be
				// called": pi does call it on session teardown/replacement
				// (`agent-session-runtime.js`'s `dispose()`/`teardownCurrent()` →
				// `beforeSessionInvalidate` → `resetExtensionUI` →
				// `clearExtensionWidgets` → `widget.dispose?.()`), and
				// `stop()`/`disable()` already clear once first; this also closes the
				// window where "the old component is disposed later than the new
				// component's factory runs".
				// (Measured: after `/new` replaced the session, the charts kept
				// refreshing — no stale timer leak.)
				dispose: () => {
					clearInterval(localTimer);
					if (timer === localTimer) timer = undefined;
				},
				invalidate() {},
				render: (width: number) => {
					// The mode check **must live inside render**, not in the factory:
					// pi's tui is a Proxy forwarding to the current renderer, and
					// switchTuiMode swaps the renderer while reusing this very
					// component object (the factory is not re-run). Reading `tui.mode`
					// here sees the *current* mode every frame.
				const fs = tui.mode === "fullscreen";
				const lines = render(theme, width, fs);
				if (fs && extraRow) {
					const row = extraRow(theme, width, fs);
					// A chart-mode extra row (y=-1 sentinel from chipRow) is appended
					// below the panel, so its local y is the body row count; a
					// line-mode extra row IS the body (fs body returns []), and its
					// chipRect already carries y=0.
					if (chipRect && chipRect.y < 0) chipRect.y = lines.length;
					lines.push(row);
				} else {
					chipRect = undefined;
				}
				return lines;
			},
				// Returning `undefined` in regular mode (or for hits outside the
				// chip) leaves pi's fallback behavior — drag text selection over the
				// panel — completely untouched.
				handleMouse: (ev: MouseEv) => handleChipMouse(tui, ev),
			};
		};
	}

	/**
	 * The trailing chip row for chart/footer mode: a right-aligned `[line]`
	 * chip on its own row. This is the **only** allowed row-count change:
	 * fullscreen takes 1 row out of the existing maxRows budget (makeChart
	 * subtracts it), so the total never exceeds the budget and regular mode is
	 * untouched. For a given width the row count is constant — the row exists in
	 * fullscreen regardless of data, so the editor never shifts.
	 */
	const chipRow = (theme: ThemeLike, width: number): string => {
		const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
		// Right-align: pad on the left. At widths narrower than the chip itself
		// the chip is dropped entirely — never render an overflowing row
		// (overflow makes pi exit outright; iron rule #1).
		if (w < CHIP_CHART_W) {
			chipRect = undefined;
			return renderStyledLine(theme, [], w);
		}
		chipRect = { x: w - CHIP_CHART_W, y: -1 /* resolved by the skeleton to the appended row index */, w: CHIP_CHART_W };
		return renderStyledLine(
			theme,
			[
				{ text: " ".repeat(w - CHIP_CHART_W) },
				{ text: CHIP_CHART_TO_LINE, color: "muted" },
			],
			w,
		);
	};

	/** The chart component (widget and footer differ only in row budget — and in whether the token totals are shown) */
	const makeChart = (maxRows: number, showTokenTotals: boolean) =>
		makeSampled(
			// The chip row's cost comes out of the **row budget**, not the
			// constant: fullscreen subtracts 1 so panel + chip stays within
			// maxRows, while regular mode (fs=false) gets the identical budget
			// and therefore byte-identical rows to before this feature.
			(theme, width, fs) =>
				renderPanelFor(
					theme,
					width,
					maxRows - (fs ? 1 : 0),
					showTokenTotals,
				),
			(theme, width) => chipRow(theme, width),
		);

	/**
	 * The component for `line` mode: always 1 row, content adapts to width.
	 *
	 * `setWidget` instead of `setStatus` is used to **follow placement**:
	 * `setStatus` content is rendered by pi's built-in footer, pinned at the
	 * bottom; a widget, on the other hand, can land above or below the editor,
	 * matching chart mode's `/sysmon above|below`.
	 * That's what makes the expectation "after `/sysmon below`, line should also
	 * be at the bottom" hold.
	 */
	const makeLine = () =>
		makeSampled(
			(theme, width, fs) => {
				// **Must use the `width` given by the layout**: that's the number of
				// columns actually available this frame; rendering wider is out of
				// bounds, and out of bounds makes pi exit outright (the iron rule).
				// Never fall back to `process.stdout.columns` — that's the **full
				// terminal width**, while a widget's actual usable width can be narrower
				// (container padding / other widgets in the same row), so hitting that
				// fallback actually runs toward overflowing. `renderStyledLine` itself
				// clamps non-finite values to 1, so this only needs to handle the floor.
				//
				// Fullscreen: the body returns **zero rows** — the single row is
				// produced by extraRow below (text + chip in one line), so the mode
				// stays at exactly 1 row and the editor never shifts.
				if (fs) return [];
				return [renderStyledLine(theme, plainLine(width), width)];
			},
			// Fullscreen: line mode stays **exactly 1 row**. The chip borrows its
			// columns from the text: `plainLine` gets `width - chip` and goes
			// through plainLineSegs's existing "drop whole groups, never split a
			// number" degradation, then the chip is appended and the whole row is
			// padded to width by renderStyledLine.
			(theme, width, _fs) => {
				const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
				if (w <= CHIP_LINE_W) {
					// Extremely narrow: show only the chip, or nothing at all when even
					// the chip doesn't fit — never overflow.
					if (w === CHIP_LINE_W) {
						chipRect = { x: 0, y: 0, w: CHIP_LINE_W };
						return renderStyledLine(
							theme,
							[{ text: CHIP_LINE_TO_CHART, color: "muted" }],
							w,
						);
					}
					chipRect = undefined;
					return renderStyledLine(theme, [], w);
				}
				const bodyW = w - CHIP_LINE_W;
				chipRect = { x: bodyW, y: 0, w: CHIP_LINE_W };
				// Body and chip are rendered **as two fixed-width strings and
				// concatenated**: rendering them as one segment list would let
				// renderStyledLine's truncation eat the chip whenever the kept
				// body groups exceed bodyW (plainLineSegs always keeps its first
				// group even when it alone overflows the budget). Rendering the
				// body at exactly bodyW truncates the body — never the chip.
				const body = renderStyledLine(theme, plainLine(bodyW), bodyW);
				const chip = renderStyledLine(
					theme,
					[{ text: CHIP_LINE_TO_CHART, color: "muted" }],
					CHIP_LINE_W,
				);
				return body + chip;
			},
		);

	function enable(ctx: UiHost): boolean {
		if (!ctx.hasUI) return false;
		stop();
		sample();
		// Cross-surface cleanup: footer and widget are two **different** mount
		// surfaces (setFooter vs setWidget), and the mode-change path below mounts
		// unconditionally without a leading disable() — so switching footer →
		// chart/line would leave the footer mounted next to the widget (both live,
		// both sampling; measured: `/sysmon footer` then `/sysmon chart` never
		// emitted "footer:off"). The same widget key already self-cleans on the
		// widget↔widget switches (setWidget replaces under one key), so only the
		// surface we are NOT mounting onto needs this explicit clear. chipRect
		// is cleared too: the freshly mounted component hasn't rendered yet, so a
		// click arriving before its first render must not hit a stale rectangle.
		const was = activeMode;
		activeMode = mode;
		host = ctx;
		chipRect = undefined;
		if (was === "footer" && mode !== "footer") ctx.ui.setFooter(undefined);
		if (was !== undefined && was !== "footer" && mode === "footer")
			ctx.ui.setWidget(WIDGET_KEY, undefined);

		if (mode === "status") {
			// Use a widget instead of `setStatus`: a widget's `placement` can
			// follow chart mode (`/sysmon above|below`) above or below the editor,
			// while `setStatus` content is forever pinned inside pi's built-in
			// footer — that was the root cause of "the position doesn't match the
			// charts".
			//
			// The row count is also consistent (always 1 row), so the editor
			// doesn't shift.
			ctx.ui.setWidget(WIDGET_KEY, makeLine(), { placement });
			return true;
		}

		if (mode === "chart") {
			// Widget mode sits next to pi's own footer (which shows ↑/↓/R), so the
			// totals are off — no duplicate readings.
			ctx.ui.setWidget(WIDGET_KEY, makeChart(WIDGET_MAX_ROWS, false), {
				placement,
			});
			return true;
		}

		// footer: replace the whole bottom bar. pi's own footer (and its
		// `↑ ↓ R` token readout) vanishes with it, so the totals go ON here.
		ctx.ui.setFooter(makeChart(FOOTER_MAX_ROWS, true));
		return true;
	}

	function disable(ctx: UiHost) {
		stop();
		const was = activeMode;
		activeMode = undefined;
		host = undefined;
		chipRect = undefined;
		if (!ctx.hasUI || was === undefined) return;
		// chart and status(line) share the same widget key (mutually exclusive,
		// never both present), so cleanup for both is the same statement — don't
		// write it as two else-ifs that look different but are equivalent.
		if (was === "status" || was === "chart")
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		else ctx.ui.setFooter(undefined);
	}

	// `--sysmon` (registered below) means "this run, force the monitor on".
	// Default `false` so an unset flag never *disables* the monitor — off-ness is
	// expressed by the global default / `/sysmon off`, never by flag absence.
	pi.registerFlag("sysmon", {
		description: "Force the system monitor on for this run (overrides the global default)",
		type: "boolean",
		default: false,
	});

	/**
	 * Adopt `want` as this session's choice and reconcile the UI with it.
	 *
	 * The single place `/sysmon on|off`, `/sysmon global on|off`, placement and
	 * mode switches all funnel through, so "which scope gets written" can't drift
	 * between them. Returns whether the UI was actually reconciled (false on a
	 * headless host), which callers use to keep their notification honest.
	 *
	 * The session entry is written **before** the UI step and **regardless of
	 * `hasUI`**: the entry is what `/resume` reads back, so a headless
	 * `pi -p "/sysmon global off"` must still pin this session's state rather than
	 * leaving it to be re-resolved from a global default that may change later.
	 */
	const applyEnabled = (want: boolean, ctx: UiHost) => {
		// Session entry, **not** the config file: `/resume` of this session
		// restores this choice, while other/new sessions keep the global default.
		pi.appendEntry(SESSION_STATE_KEY, { enabled: want });
		// No host to reconcile: report that honestly so callers don't notify "this
		// session" when nothing was (or could be) mounted/unmounted.
		if (!ctx.hasUI) {
			enabled = false;
			return false;
		}
		if (want) {
			enabled = enable(ctx);
			return enabled;
		}
		disable(ctx);
		enabled = false;
		return true;
	};

	pi.registerCommand("sysmon", {
		description:
			"System monitor: /sysmon [chart|line|footer|on|off|above|below|global on|off]",
		handler: async (args, ctx) => {
			const cmd = parseSysmonCommand(String(args ?? ""));

			// ── `/sysmon global on|off` — the **persistent default for new sessions** ──
			// A subcommand rather than a second top-level command: same object as
			// `/sysmon on|off`, only aimed at a different scope; a separate name would
			// invite "which one is the real switch?".
			// Deliberately **before** the hasUI guard: it writes a file and a session
			// entry, so it must also work headless (`pi -p "/sysmon global off"`).
			if (cmd.kind === "global") {
				if (cmd.value === "query") {
					const cur = readCfg().enabled ?? true;
					ctx.ui.notify(
						`System monitor: default for new sessions is ${cur ? "on" : "off"}`,
						"info",
					);
					return;
				}
				if (cmd.value === "usage") {
					ctx.ui.notify("Usage: /sysmon global on|off", "warning");
					return;
				}
				const on = cmd.value;
				writeCfg({ enabled: on }); // 1. default for every future session
				// 2. and this one, immediately: "off by default from now on" that left
				//    the charts running would read as a broken command. This also
				//    records the session entry, so the choice survives `/resume`.
				//    `applyEnabled` writes that entry even when there is no UI to
				//    reconcile, so `pi -p "/sysmon global off"` pins this session too.
				const applied = applyEnabled(on, ctx);
				const state = on ? "on" : "off";
				ctx.ui.notify(
					applied
						? `System monitor: global default ${state} (this session and new ones)`
						: `System monitor: global default ${state} for new sessions (no UI to update here)`,
					"info",
				);
				return;
			}

			// Everything below here drives the UI (mount / unmount / re-layout), so it
			// is meaningless without one. Only `/sysmon global` above is expected to
			// do useful work headless (`pi -p "/sysmon global off"`).
			if (!ctx.hasUI) return;

			// Placement switching: no need to restart the session to switch.
			// It gets its own branch because it's orthogonal to mode/on/off, and a
			// re-render is required (setWidget must be called again).
			if (cmd.kind === "placement") {
				placement = cmd.value;
				// Display preference → global. Note `enabled` is deliberately absent
				// from every patch: this handler never writes the global on/off.
				writeCfg({ mode, placement });
				// **Both chart and status(line) use placement** (status is a widget too
				// now, no longer a setStatus pinned in the footer), so a mounted panel
				// must be rebuilt once. `enable()` already stops the old timer and
				// replaces the widget under the same key, so there is no separate
				// `disable()` to call first. Going through `applyEnabled` also keeps the
				// invariant "mounted state is recorded in the session entry".
				if (enabled && (activeMode === "chart" || activeMode === "status"))
					applyEnabled(true, ctx);
				ctx.ui.notify(
					`System monitor: ${cmd.value === "belowEditor" ? "below editor" : "above editor"}`,
					"info",
				);
				return;
			}

			if (cmd.kind === "invalid") {
				ctx.ui.notify(
					"Usage: /sysmon [chart|line|footer|on|off|above|below|global on|off]",
					"warning",
				);
				return;
			}

			// Explicitly naming a mode = **idempotent "switch to this mode and turn
			// on"**, not a toggle.
			// The old logic, when "already in this mode", fell into the
			// `target = !enabled` branch below and turned the monitor **off**
			// (`/sysmon line` in line mode reported "off (remembered)"),
			// directly contradicting the README's "line = single-line text mode"
			// semantics.
			if (cmd.kind === "mode") {
				mode = cmd.value;
				// Display preference → global.
				writeCfg({ mode, placement });
				// Re-mount unconditionally: `enable()` swaps the widget (and its
				// renderer) under the same key, which is exactly what a mode change
				// needs; a leading `disable()` would only add a blank frame.
				applyEnabled(true, ctx);
				ctx.ui.notify(`System monitor: ${mode}`, "info");
				return;
			}

			const target = cmd.kind === "enabled" ? cmd.value : !enabled;
			if (target) {
				if (applyEnabled(true, ctx)) {
					// Report **after** the mount: `applyEnabled` may have failed
					// (headless host) and announcing an interval that isn't sampling
					// would be a lie.
					ctx.ui.notify(`System monitor: ${mode} (${intervalMs}ms)`, "info");
				}
			} else {
				applyEnabled(false, ctx);
				ctx.ui.notify("System monitor off (this session)", "info");
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
	// ── Context-usage source: remember a ctx that can answer getContextUsage ──
	// Every handler receives essentially the same context object (backed by the
	// live agent session), so remembering the latest one keeps the reading live
	// across `/new` and `/resume` without any extra bookkeeping. `session_start`
	// and `message_end` are the natural refresh points; `session_shutdown` clears
	// it so a stale session's number can't linger into the next one.
	const rememberCtx = (ctx: CtxUsageHost): void => {
		usageHost = ctx;
	};

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
	pi.on("message_end", (event, ctx) => {
		// Only count assistant messages: user messages also trigger message_end,
		// and counting them would double-count the uplink (the prompt text itself
		// is not token usage).
		if (event.message.role !== "assistant") return;
		addUsage(event.message.usage);
		// message_end fires on every turn boundary — the context usage estimate
		// moves exactly then (the new assistant usage is what it's computed
		// from), so refresh the remembered ctx here too even though sample() reads
		// it per tick anyway. Cheap (an assignment), and it keeps the reading live
		// even before the next sample lands.
		rememberCtx(ctx);
	});

	pi.on("session_start", (_e, ctx) => {
		// Fresh session ⇒ fresh context ledger (model may differ, entries reset).
		rememberCtx(ctx);
		// Display preferences and the global on/off default come from the file.
		const cfg = readCfg();
		if (cfg.mode) mode = cfg.mode; // remember last mode
		if (cfg.placement) placement = cfg.placement; // remember last placement
		if (!ctx.hasUI) return;

		// The on/off decision is session-scoped: a choice recorded in **this**
		// session's entries beats the global default, so `/resume` restores what
		// the user set back then — while a brand-new session (no entries) starts
		// from the global default. `--sysmon` forces it on for this run only.
		const want = resolveEnabled({
			sessionEnabled: lastSessionEnabled(ctx.sessionManager.getEntries()),
			forcedOn: pi.getFlag("sysmon") === true,
			globalEnabled: cfg.enabled,
		});
		// Reconcile the UI with `want` **idempotently**: tear down first, then mount
		// if wanted. Written this way rather than as
		// `if (want && !enabled) / else if (!want && enabled)` because it doesn't
		// depend on `enabled` matching reality — the host may already have disposed
		// the widget (`/reload` / `/new` call `resetExtensionUI`), and `disable()`
		// is a no-op when nothing is mounted (`activeMode === undefined`).
		disable(ctx);
		enabled = false;
		if (want) enabled = enable(ctx);
	});

	pi.on("session_shutdown", () => {
		stop();
		activeMode = undefined;
		// Drop the remembered ctx with the session: its getContextUsage() reads the
		// dying session's entries, and keeping it would freeze the last reading
		// (or worse, resurrect it) in whatever session mounts the monitor next.
		usageHost = undefined;
		ctxPct = undefined;
	});
}
