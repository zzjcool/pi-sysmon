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
	// "unmounted" and "did nothing" apart.
	const ui: string[] = [];
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
			setWidget: (_k: string, w?: unknown) =>
				ui.push(w === undefined ? "widget:off" : "widget:on"),
			setFooter: (f?: unknown) =>
				ui.push(f === undefined ? "footer:off" : "footer:on"),
			setStatus: () => {},
		},
		sessionManager: { getEntries: () => entries },
	} as any;

	factory(api as any);

	const sessionStart = () => events.get("session_start")?.[0]?.({}, ctx);
	const run = (args: string) => commands.get("sysmon")?.(args, ctx);
	const cfg = (): Record<string, unknown> =>
		JSON.parse(readFileSync(configFile, "utf8"));
	const notifies = () => ui.filter((u) => u.startsWith("notify:"));
	return { ctx, entries, ui, sessionStart, run, cfg, notifies };
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
