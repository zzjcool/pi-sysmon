/**
 * Integration tests for the extension layer (`src/index.ts`) — the paths the
 * pure-function tests in `state.test.ts` can't reach: the `session_start`
 * reconcile, the `/sysmon …` handler, and the config file's write scope.
 *
 * Why a stubbed pi API rather than a live one: these behaviors are exactly the
 * ones that silently regress (session-scoped off leaking globally, headless
 * `/sysmon global` not persisting). Driving them through real pi would need a
 * terminal; stubbing `ExtensionAPI` + `ExtensionCommandContext` keeps it a unit
 * test while still exercising the real handler code, the real `state.ts`, and
 * the real config file I/O.
 *
 * Run: node --experimental-strip-types --test 'test/extension.test.ts'
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

/** ANSI codes injected by the fake theme — stripping them again is the test
 * side of "assert on what's actually visible". */
const stripAnsi = (s: string): string =>
	s.replace(/\x1b\[[0-9;]*m/g, "");

// The config path is read from the env at call time, so each test can point the
// extension at a throwaway config dir instead of the developer's real one.
let configDir = "";
let configFile = "";
beforeEach(() => {
	if (configDir) rmSync(configDir, { recursive: true, force: true });
	configDir = mkdtempSync(join(tmpdir(), "sysmon-test-"));
	configFile = join(configDir, "pi-sysmon.json");
	process.env.PI_CODING_AGENT_DIR = configDir;
});

type AnyFn = (...a: any[]) => any;

/**
 * Minimal stand-in for pi's `ExtensionAPI`, recording everything the extension
 * registers plus the entries `pi.appendEntry` would persist.
 *
 * Imported lazily: `src/index.ts` reads `PI_CODING_AGENT_DIR` inside functions,
 * but the module-level imports of the pi packages should only happen once the
 * fixture exists. `loadExtension()` also sidesteps the ESM module cache pinning
 * a stale extension instance across tests.
 */
async function loadExtension(flags: Record<string, unknown> = {}) {
	const factory = (await import("../src/index.ts")).default;
	const commands = new Map<string, AnyFn>();
	const events = new Map<string, AnyFn[]>();
	const entries: any[] = [];
	const api = {
		registerFlag: () => {},
		registerTool: () => {},
		registerEntryRenderer: () => {},
		registerCommand: (n: string, o: any) => commands.set(n, o.handler),
		on: (n: string, h: AnyFn) =>
			events.set(n, [...(events.get(n) ?? []), h]),
		getFlag: (n: string) => flags[n],
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({
				type: "custom",
				customType,
				data,
				id: `e${entries.length}`,
				parentId: null,
				timestamp: new Date().toISOString(),
			});
		},
	};
	// UI effects are recorded as a log so assertions can tell "mounted",
	// "unmounted" and "did nothing" apart. Widget/footer **factories** are also
	// captured, so tests can instantiate the real component (with a stubbed
	// tui/theme) and exercise render/handleMouse directly.
	const ui: string[] = [];
	const widgets: unknown[] = [];
	const footers: unknown[] = [];
	let hasUI = true;
	const ctx = {
		get hasUI() {
			return hasUI;
		},
		set hasUI(v: boolean) {
			hasUI = v;
		},
		ui: {
			notify: (m: string) => ui.push(`notify:${m}`),
			setWidget: (_k: string, w?: unknown) => {
				ui.push(w === undefined ? "widget:off" : "widget:on");
				widgets.push(w);
			},
			setFooter: (f?: unknown) => {
				ui.push(f === undefined ? "footer:off" : "footer:on");
				footers.push(f);
			},
			setStatus: () => {},
		},
		sessionManager: { getEntries: () => entries },
	} as any;

	factory(api as any);

	const sessionStart = () => events.get("session_start")?.[0]?.({}, ctx);
	const sessionShutdown = () => events.get("session_shutdown")?.[0]?.();
	const run = (args: string) => commands.get("sysmon")?.(args, ctx);
	const cfg = (): Record<string, unknown> =>
		JSON.parse(readFileSync(configFile, "utf8"));
	const notifies = () => ui.filter((u) => u.startsWith("notify:"));
	// The most recently mounted widget factory (undefined after an unmount).
	const lastWidget = () => widgets.at(-1) as AnyFn | undefined;
	// Fake theme **with ANSI escape codes** — same reason as layout.test.ts's
	// ansiTheme: width bugs (string surgery counting escape bytes) are exposed
	// exactly when ANSI is present, and every width assertion below uses
	// visibleWidth() so a plain .length would silently stop measuring visible
	// cells. The codes are unique per color so `stripAnsi` stays trivial.
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
	const ansiTheme = { fg: (c: string, s: string) => (s.trim() === "" ? s : `${ANSI[c] ?? ""}${s}\x1b[0m`) };
	// A tui stub whose `mode` can be flipped after mounting — that lets tests
	// reproduce pi's `switchTuiMode` (component object reused, factory NOT
	// re-run) and prove no stale chip rectangle survives the switch.
	const makeTui = (mode: string) => ({ requestRender: () => {}, mode });
	// Instantiate the most recently mounted factory (widget or footer) with a
	// controllable tui and the ANSI theme.
	const instantiate = (f: AnyFn | undefined, tui: { requestRender(): void; mode: string }) => {
		assert.ok(f, "expected a mounted factory");
		return f(tui, ansiTheme) as {
			render(width: number): string[];
			handleMouse?(ev: unknown): unknown;
			dispose(): void;
		};
	};
	const mount = (tuiMode: string) => instantiate(lastWidget(), makeTui(tuiMode));
	const mountFooter = (tuiMode: string) =>
		instantiate(footers.at(-1) as AnyFn | undefined, makeTui(tuiMode));
	return { ctx, entries, ui, sessionStart, sessionShutdown, run, cfg, notifies, lastWidget, mount, mountFooter, makeTui, instantiate, ansiTheme };
}

/* ------------------------------------------------------------------ */
/* session_start — which on/off a session begins with                   */
/* ------------------------------------------------------------------ */

test("fresh session with no config starts ON (mounted)", async () => {
	const h = await loadExtension();
	await h.sessionStart();
	assert.ok(h.ui.includes("widget:on"), h.ui.join(", "));
});

test("fresh session inherits `enabled:false` from the config as global default", async () => {
	const h = await loadExtension();
	await h.run("global off"); // writes config + this session's entry
	// A different session (no entries of its own) must start off.
	const fresh = await loadExtension();
	await fresh.sessionStart();
	assert.ok(!fresh.ui.includes("widget:on"), fresh.ui.join(", "));
});

test("resume: the session's own entry beats the global default", async () => {
	const h = await loadExtension();
	await h.run("global off"); // global default off
	h.entries.push({
		type: "custom",
		customType: "sysmon-state",
		data: { enabled: true },
	});
	await h.sessionStart();
	assert.ok(h.ui.includes("widget:on"), h.ui.join(", "));
});

test("--sysmon forces ON even when the global default is off", async () => {
	const a = await loadExtension();
	await a.run("global off");
	const h = await loadExtension({ sysmon: true });
	await h.sessionStart();
	assert.ok(h.ui.includes("widget:on"), h.ui.join(", "));
});

test("session_start reconciles idempotently (remounts a widget the host dropped)", async () => {
	// `/reload` and `/new` call resetExtensionUI, so the widget can be gone
	// while the extension still thinks it is mounted. Starting twice must not
	// leave the monitor unmounted — and the second start must genuinely tear
	// down and re-mount, not short-circuit on a stale `enabled === true`
	// (which is the bug this pins: a `if (!enabled)` guard would make the
	// second mount a no-op and leave the panel invisible).
	const h = await loadExtension();
	await h.sessionStart();
	const afterFirst = h.ui.length;
	await h.sessionStart();
	const secondPass = h.ui.slice(afterFirst);
	assert.deepEqual(
		secondPass,
		["widget:off", "widget:on"],
		"second start must unmount then remount, not skip",
	);
});

/* ------------------------------------------------------------------ */
/* /sysmon on|off — session scope only                                  */
/* ------------------------------------------------------------------ */

test("/sysmon off is session-scoped and never writes the config file", async () => {
	const h = await loadExtension();
	await h.sessionStart();
	await h.run("off");
	assert.ok(h.ui.includes("widget:off"));
	assert.ok(
		h.entries.some(
			(e) => e.customType === "sysmon-state" && e.data?.enabled === false,
		),
	);
	// The whole point of the refactor: turning it off must not create/edit the
	// global default.
	assert.ok(!existsSync(configFile), "config file must not be created");
});

test("/sysmon toggle flips state and records it in the session", async () => {
	const h = await loadExtension();
	await h.sessionStart(); // starts on
	await h.run(""); // toggle → off
	assert.ok(h.ui.includes("widget:off"));
	await h.run(""); // toggle → on
	assert.ok(h.ui.lastIndexOf("widget:on") > h.ui.lastIndexOf("widget:off"));
});

/* ------------------------------------------------------------------ */
/* /sysmon global on|off — global default, applied immediately too       */
/* ------------------------------------------------------------------ */

test("/sysmon global off writes the default and applies it to this session", async () => {
	const h = await loadExtension();
	await h.sessionStart();
	await h.run("global off");
	assert.equal(h.cfg().enabled, false);
	assert.ok(h.ui.includes("widget:off"), "must apply to the current session");
	assert.ok(
		h.entries.some(
			(e) => e.customType === "sysmon-state" && e.data?.enabled === false,
		),
		"must record the session choice so /resume restores it",
	);
});

test("/sysmon global off preserves mode/placement (merge, not overwrite)", async () => {
	const h = await loadExtension();
	await h.sessionStart();
	await h.run("chart"); // establishes mode/placement in the file
	await h.run("below");
	await h.run("global off");
	const c = h.cfg();
	assert.equal(c.enabled, false);
	assert.equal(c.mode, "chart");
	assert.equal(c.placement, "belowEditor");
});

test("/sysmon global (no arg) reports the default without writing", async () => {
	const h = await loadExtension();
	await h.run("global");
	assert.ok(h.notifies().some((n) => /default for new sessions/.test(n)));
	assert.ok(!existsSync(configFile));
});

test("/sysmon global foo is a usage error, not a silent write", async () => {
	const h = await loadExtension();
	await h.run("global foo");
	assert.ok(h.notifies().some((n) => /Usage: \/sysmon global/.test(n)));
	assert.ok(!existsSync(configFile));
});

/* ------------------------------------------------------------------ */
/* headless + typo paths                                                */
/* ------------------------------------------------------------------ */

test("headless /sysmon global off still persists the default and the session choice", async () => {
	// `pi -p "/sysmon global off"` has no UI. The file and the session entry must
	// still be written — otherwise a later `/resume` would re-resolve the choice
	// from a global default that may have changed since.
	const h = await loadExtension();
	h.ctx.hasUI = false;
	await h.run("global off");
	assert.equal(h.cfg().enabled, false);
	assert.ok(
		h.entries.some(
			(e) => e.customType === "sysmon-state" && e.data?.enabled === false,
		),
	);
	assert.ok(
		h.notifies().some((n) => /no UI to update/.test(n)),
		"must not claim it applied to this session: " + h.notifies().join(" | "),
	);
});

test("headless /sysmon off is a no-op: the session switch only drives the UI", async () => {
	// Deliberate asymmetry with `/sysmon global`: `on|off` toggles a *display*, so
	// with no display there is nothing to do (and nothing to record — the session
	// choice exists to restore what a UI showed). Only `/sysmon global on|off` is
	// meaningful headless.
	const h = await loadExtension();
	h.ctx.hasUI = false;
	await h.run("off");
	assert.ok(
		!h.entries.some((e) => e.customType === "sysmon-state"),
		"headless toggle must not record a session choice",
	);
	assert.ok(!existsSync(configFile), "and must not create the config file");
	assert.deepEqual(h.ui, [], "and must not touch the UI");
});

test("an unknown subcommand is rejected with usage instead of toggling", async () => {
	const h = await loadExtension();
	await h.sessionStart();
	await h.run("fobar");
	assert.ok(h.notifies().some((n) => /Usage:/.test(n)));
	assert.ok(
		!h.entries.some((e) => e.customType === "sysmon-state"),
		"a typo must not record a choice",
	);
});

test("/sysmon chart switches mode and mounts without clearing the global default", async () => {
	const h = await loadExtension();
	await h.sessionStart();
	await h.run("global off");
	await h.run("chart");
	assert.equal(h.cfg().enabled, false, "mode switch must not clear `enabled`");
	assert.ok(h.ui.includes("widget:on"));
});

/* ------------------------------------------------------------------ */
/* Fullscreen chip — click to toggle chart ⇄ line                       */
/* ------------------------------------------------------------------ */

/** A left press/click at component-local (x,y) with the given bounds */
const mouse = (
	type: string,
	x: number | undefined,
	y: number | undefined,
	width: number | undefined,
	height: number | undefined,
	button = "left",
) => ({ type, button, x, y, width, height });

test("fullscreen chart: chip row renders, press+click on the chip toggles to line mode", async () => {
	const h = await loadExtension();
	await h.sessionStart(); // fresh session defaults to chart mode, mounted
	let comp = h.mount("fullscreen");
	try {
		const W = 100;
		const lines = comp.render(W);
		// Exactly one trailing row carries the chip, right-aligned. The chip
		// position is derived from the **rendered text** (indexOf), never from
		// the hit-rect math it is supposed to verify — otherwise moving the
		// rectangle would move the assertion along with it (mutation-verified:
		// an off-by-one in the rect used to pass these tests green).
		const chipRow = stripAnsi(lines.at(-1) ?? "");
		const chipX0 = chipRow.indexOf("[line]");
		assert.ok(chipX0 >= 0, `chip row: ${JSON.stringify(lines.at(-1))}`);
		assert.equal(
			visibleWidth(lines.at(-1) ?? ""),
			W,
			"chip row must be padded to the full width",
		);
		assert.ok(
			chipX0 >= W - "[line]".length - 1,
			`chip must be right-aligned: ${JSON.stringify(chipRow)}`,
		);
		// ...and no other row does
		assert.ok(!lines.slice(0, -1).some((l) => l.includes("[line]")));
		const chipY = lines.length - 1;

		// press claims the gesture (pi only synthesizes click for a component
		// that handled the press); click performs the toggle.
		assert.deepEqual(
			comp.handleMouse?.(mouse("press", chipX0 + 1, chipY, W, lines.length)),
			{ handled: true },
		);
		assert.deepEqual(
			comp.handleMouse?.(mouse("click", chipX0 + 1, chipY, W, lines.length)),
			{ handled: true },
		);
		assert.equal(h.cfg().mode, "status", "click must write the new mode (internal name for line)");
		assert.equal(
			h.cfg().enabled,
			undefined,
			"toggle must never write the global `enabled` default",
		);
		assert.equal(h.ui.at(-1), "widget:on", "toggle remounts the widget");
	} finally {
		comp.dispose();
	}

	// The remounted widget is a line-mode component: exactly 1 row, chip [chart].
	comp = h.mount("fullscreen");
	try {
		const lines = comp.render(100);
		assert.equal(lines.length, 1, "line mode must stay exactly 1 row");
		const x0 = stripAnsi(lines[0] ?? "").indexOf("[chart]");
		assert.ok(x0 >= 0, `chip: ${JSON.stringify(lines[0])}`);
		// Clicking the chip flips back to chart (anchored to rendered text)
		comp.handleMouse?.(mouse("press", x0, 0, 100, 1));
		assert.deepEqual(
			comp.handleMouse?.(mouse("click", x0, 0, 100, 1)),
			{ handled: true },
		);
		assert.equal(h.cfg().mode, "chart");
	} finally {
		comp.dispose();
	}
});

test("fullscreen chip hit-testing: boundaries and bad events never leak", async () => {
	const h = await loadExtension();
	await h.sessionStart();
	const comp = h.mount("fullscreen");
	try {
		const W = 100;
		const lines = comp.render(W);
		const chipY = lines.length - 1;
		// Anchored to the **rendered chip**, not the rect math (see first test)
		const chipX0 = stripAnsi(lines.at(-1) ?? "").indexOf("[line]");
		assert.ok(chipX0 >= 0);
		const hm = (ev: unknown) => comp.handleMouse?.(ev);

		// Left edge hits; one column left of the chip does not
		assert.deepEqual(hm(mouse("press", chipX0, chipY, W, lines.length)), {
			handled: true,
		});
		assert.equal(hm(mouse("press", chipX0 - 1, chipY, W, lines.length)), undefined);
		// Rightmost chip column hits; one column past it does not
		assert.deepEqual(hm(mouse("press", W - 1, chipY, W, lines.length)), {
			handled: true,
		});
		assert.equal(hm(mouse("press", W, chipY, W, lines.length)), undefined);
		// The row above the chip does not hit (protects text selection there)
		assert.equal(hm(mouse("press", W - 3, chipY - 1, W, lines.length)), undefined);
		// Missing/invalid coordinates or bounds → no hit, no throw
		assert.equal(hm(mouse("press", undefined, chipY, W, lines.length)), undefined);
		assert.equal(hm(mouse("press", W - 3, undefined, W, lines.length)), undefined);
		assert.equal(hm(mouse("press", W - 3, chipY, undefined, undefined)), undefined);
		// Wrong button / wrong event type → not ours
		assert.equal(hm(mouse("press", W - 3, chipY, W, lines.length, "right")), undefined);
		assert.equal(hm(mouse("move", W - 3, chipY, W, lines.length)), undefined);
		assert.equal(hm(mouse("release", W - 3, chipY, W, lines.length)), undefined);
	} finally {
		comp.dispose();
	}
});

test("regular mode: no chip, no toggle, no config write — zero side effects", async () => {
	const h = await loadExtension();
	await h.sessionStart();
	const comp = h.mount("regular");
	try {
		const lines = comp.render(100);
		assert.ok(!lines.some((l) => l.includes("[line]") || l.includes("[chart]")),
			"regular mode must not render a chip");
		const before = h.ui.length;
		assert.equal(
			comp.handleMouse?.(mouse("press", 97, lines.length - 1, 100, lines.length)),
			undefined,
		);
		assert.equal(
			comp.handleMouse?.(mouse("click", 97, lines.length - 1, 100, lines.length)),
			undefined,
		);
		assert.equal(h.ui.length, before, "no widget churn");
		assert.ok(!existsSync(configFile), "no config write in regular mode");
	} finally {
		comp.dispose();
	}
});

test("fullscreen→regular switch: stale chip rectangle is not hit-testable (pi reuses the component, no re-render)", async () => {
	// pi's switchTuiMode moves the **same component object** into the new
	// renderer without re-running the factory, so between the switch and the
	// next render the chip rectangle from the last fullscreen frame is still
	// in memory. The handler must re-read tui.mode per event, otherwise a
	// click in that window toggles the mode in regular mode — breaking the
	// "regular mode zero side effects" contract.
	const h = await loadExtension();
	await h.sessionStart();
	const tui = h.makeTui("fullscreen");
	const comp = h.instantiate(h.lastWidget(), tui);
	try {
		const lines = comp.render(100);
		const chipY = lines.length - 1;
		const chipX0 = stripAnsi(lines.at(-1) ?? "").indexOf("[line]");
		assert.ok(chipX0 >= 0);
		// Sanity: while still fullscreen, the chip is hit-testable
		assert.deepEqual(
			comp.handleMouse?.(mouse("press", chipX0, chipY, 100, lines.length)),
			{ handled: true },
		);
		// Now flip the mode to regular **without re-rendering** (this is what
		// the one-frame window looks like), and click where the chip used to be.
		tui.mode = "regular";
		assert.equal(
			comp.handleMouse?.(mouse("click", chipX0, chipY, 100, lines.length)),
			undefined,
			"stale rectangle must not be hit-testable after the switch",
		);
		assert.ok(!existsSync(configFile), "no config write through the stale window");
	} finally {
		comp.dispose();
	}
});

test("fullscreen line mode: exactly 1 row at any width, chip borrows columns from the text", async () => {
	const h = await loadExtension();
	await h.sessionStart();
	await h.run("line");
	const comp = h.mount("fullscreen");
	try {
		for (const w of [200, 100, 40, 20, 8, 7, 6, 3, 1]) {
			const lines = comp.render(w);
			assert.equal(lines.length, 1, `w=${w}: line mode must be exactly 1 row`);
			if (w >= "[chart]".length) {
				assert.ok(
					(lines[0] ?? "").includes("[chart]"),
					`w=${w}: chip must be visible: ${JSON.stringify(lines[0])}`,
				);
			}
			// Never render wider than the viewport (overflow makes pi exit).
			// visibleWidth, not .length: the ANSI theme makes raw .length count
			// escape bytes, which would silently stop measuring visible cells.
			assert.ok(
				visibleWidth(lines[0] ?? "") <= w,
				`w=${w}: row too wide (${visibleWidth(lines[0] ?? "")})`,
			);
		}
		// The chip disappears below its own width, and the rectangle must go
		// with it: a click at the position the chip used to occupy must not hit.
		comp.render(6);
		assert.equal(
			comp.handleMouse?.(mouse("click", 0, 0, 6, 1)),
			undefined,
			"chip below minimum width: click must not hit a stale rect",
		);
		// Non-finite / negative widths must clamp instead of throwing or
		// overflowing (NaN reaching `" ".repeat()` would throw RangeError).
		for (const w of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0, 1.7]) {
			const lines = comp.render(w);
			assert.equal(lines.length, 1, `w=${w}: still exactly 1 row`);
			assert.ok(
				visibleWidth(lines[0] ?? "") <= 1,
				`w=${w}: clamped row must be at most 1 cell`,
			);
		}
	} finally {
		comp.dispose();
	}
});

test("fullscreen chart: the chip row is paid for out of the row budget", async () => {
	// The frozen contract: fullscreen gets exactly ONE extra row (the chip),
	// that row is taken out of the chart budget (so the total stays within
	// WIDGET_MAX_ROWS), and the body shrinks by one row wherever the layout
	// can actually spare one. At narrow widths with many bands the budget
	// rounding absorbs the subtraction (floor((maxRows-1)/bands) and
	// floor(maxRows/bands) can land on the same plotRows), so the honest
	// assertion is fsRows === regRows OR fsRows === regRows + 1 — never more,
	// and never over budget. A regression here (budget subtraction dropped,
	// or the chip row doubled) used to pass every test green — this pins it.
	const h = await loadExtension();
	await h.sessionStart();
	const fs = h.mount("fullscreen");
	const reg = h.mount("regular");
	try {
		for (const w of [20, 40, 80, 96, 150, 220]) {
			const fsRows = fs.render(w).length;
			const regRows = reg.render(w).length;
			assert.ok(
				fsRows === regRows || fsRows === regRows + 1,
				`w=${w}: fullscreen must be regular's rows +0 or +1 (chip), got fs=${fsRows} reg=${regRows}`,
			);
			assert.ok(
				fsRows <= 18,
				`w=${w}: total rows must stay within WIDGET_MAX_ROWS (got ${fsRows})`,
			);
		}
		// And the chip is only on the fullscreen rendering
		assert.ok(stripAnsi(fs.render(80).at(-1) ?? "").includes("[line]"));
		assert.ok(!stripAnsi(reg.render(80).at(-1) ?? "").includes("[line]"));
	} finally {
		fs.dispose();
		reg.dispose();
	}
});

test("fullscreen chart with a binding row budget: the chip row must be paid for, not added on top", async () => {
	// With the default chartH=6 the budget (18) is never the binding
	// constraint (min(chartH, budget-2) always picks chartH), so a dropped
	// budget subtraction is invisible at defaults — mutation-verified. Only
	// when the budget actually binds (chartH large enough) does
	// `maxRows - (fs ? 1 : 0)` observably shrink the body by one row. That is
	// the exact contract this test pins, using PI_SYSMON_CHART_HEIGHT=30 and
	// three blocks (one band) so the budget binds.
	process.env.PI_SYSMON_CHART_HEIGHT = "30";
	process.env.PI_SYSMON_TOKENS = "0";
	process.env.PI_SYSMON_MODE = "chart";
	const h = await loadExtension();
	try {
		await h.sessionStart();
		const fs = h.mount("fullscreen");
		const reg = h.mount("regular");
		try {
			const fsRows = fs.render(150).length;
			const regRows = reg.render(150).length;
			assert.equal(
				fsRows,
				regRows,
				`binding budget: fullscreen total must equal regular total (chip paid for out of the budget); got fs=${fsRows} reg=${regRows}`,
			);
			assert.ok(fsRows <= 18, `must stay within WIDGET_MAX_ROWS (got ${fsRows})`);
			assert.ok(
				stripAnsi(fs.render(150).at(-1) ?? "").includes("[line]"),
				"the chip row must still be there",
			);
		} finally {
			fs.dispose();
			reg.dispose();
		}
	} finally {
		delete process.env.PI_SYSMON_CHART_HEIGHT;
		delete process.env.PI_SYSMON_TOKENS;
		delete process.env.PI_SYSMON_MODE;
	}
});

test("fullscreen footer: chip renders, click toggles to the line widget and cleans up the footer surface", async () => {
	const h = await loadExtension();
	await h.sessionStart();
	await h.run("footer");
	const comp = h.mountFooter("fullscreen");
	try {
		const W = 100;
		const lines = comp.render(W);
		const chipY = lines.length - 1;
		const chipX0 = stripAnsi(lines.at(-1) ?? "").indexOf("[line]");
		assert.ok(chipX0 >= 0, `footer chip: ${JSON.stringify(lines.at(-1))}`);
		assert.ok(
			visibleWidth(lines.at(-1) ?? "") <= W,
			"footer chip row must not overflow",
		);
		// Clicking the footer chip switches to line mode — and because footer
		// and widget are different mount surfaces, the footer must be cleared
		// while the widget is mounted (no double mount).
		assert.deepEqual(
			comp.handleMouse?.(mouse("press", chipX0, chipY, W, lines.length)),
			{ handled: true },
		);
		assert.deepEqual(
			comp.handleMouse?.(mouse("click", chipX0, chipY, W, lines.length)),
			{ handled: true },
		);
		assert.equal(h.cfg().mode, "status", "footer chip must toggle to line");
		const tail = h.ui.slice(-3);
		assert.ok(
				tail.includes("footer:off") && tail.includes("widget:on"),
				`cross-surface cleanup expected footer:off + widget:on, got ${JSON.stringify(tail)}`,
			);
	} finally {
		comp.dispose();
	}
});

/* ------------------------------------------------------------------ */
/* Context-window usage (◔N%) — fed by ctx.getContextUsage()           */
/* ------------------------------------------------------------------ */

test("context usage: chart title shows ◔N% from getContextUsage(), degraded on null/throw/absent", async () => {
	// The reading must come from pi's own ledger (the same number the built-in
	// footer shows), refreshed per sample. Three degradation paths are pinned:
	//   1. `percent: null` (post-compaction window) ⇒ no ◔ at all (not ◔0%);
	//   2. a throwing/absent getContextUsage on the host ⇒ same absence,
	//      and system sampling must keep working;
	//   3. session_shutdown drops the remembered ctx.
	// The fake ctx in loadExtension doesn't implement getContextUsage, so it is
	// grafted on per test.
	let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	const h = await loadExtension();
	h.ctx.getContextUsage = () => {
		if (!usage) throw new Error("boom");
		return usage;
	};
	await h.sessionStart();
	// sessionStart is idempotent (unmount→remount) **and re-samples**, so it is
	// also the refresh point between readings below: the first sample ran before
	// `usage` was armed, so re-drive it per assertion. Mounting the widget
	// factory each time gives a component that reads the live ctxPct.
	const renderTitle = async (): Promise<string> => {
		await h.sessionStart();
		const comp = h.mount("regular");
		try {
			return stripAnsi(
				comp.render(160).find((l: string) => l.includes("Tokens")) ?? "",
			);
		} finally {
			comp.dispose();
		}
	};
	// Normal reading: 12345/200000 = 6.17% → ◔6%
	usage = { tokens: 12_345, contextWindow: 200_000, percent: 6.1725 };
	assert.match(await renderTitle(), /◔6%/);
	// High fill takes the warning tier (pi footer thresholds)
	usage = { tokens: 150_000, contextWindow: 200_000, percent: 75 };
	assert.match(await renderTitle(), /◔75%/);
	// Post-compaction: percent null ⇒ absent, never ◔0%
	usage = { tokens: null, contextWindow: 200_000, percent: null };
	assert.ok(!(await renderTitle()).includes("◔"));
	// Host throws ⇒ degrade, sampling continues (the panel still renders)
	usage = undefined;
	const threw = await renderTitle();
	assert.ok(!threw.includes("◔"), threw);
	assert.ok(threw.includes("Tokens"), "panel must survive a throwing host");
	// Shutdown clears the remembered ctx: a later render must not resurrect
	// a stale reading even if usage becomes available again through it.
	await h.sessionShutdown();
	usage = { tokens: 12_345, contextWindow: 200_000, percent: 50 };
	const after = h.mount("regular");
	try {
		const t = stripAnsi(after.render(160).find((l: string) => l.includes("Tokens")) ?? "");
		assert.ok(!t.includes("◔"), "session_shutdown must drop the remembered ctx");
	} finally {
		after.dispose();
	}
});
