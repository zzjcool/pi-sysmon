/**
 * Unit tests for state.ts — the on/off precedence rules and command parsing.
 * Run: node --experimental-strip-types --test 'test/state.test.ts'
 *
 * These rules are why the module exists: "which scope wins" is easy to get
 * subtly wrong (one `/sysmon off` leaking into every future session is the bug
 * this refactor fixes), and the handler that consumes them can't be tested
 * without a live pi instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	lastSessionEnabled,
	mergeCfg,
	parseSysmonCommand,
	resolveEnabled,
	SESSION_STATE_KEY,
	type SessionStateLike,
} from "../src/state.ts";

/** Build a well-formed session-state entry the way `/sysmon on|off` writes it. */
const entry = (enabled: boolean): SessionStateLike => ({
	type: "custom",
	customType: SESSION_STATE_KEY,
	data: { enabled },
});

/* ------------------------------------------------------------------ */
/* 1. lastSessionEnabled — reading the session's recorded choice        */
/* ------------------------------------------------------------------ */

test("lastSessionEnabled: no entries ⇒ undefined (\"inherit the global default\")", () => {
	assert.equal(lastSessionEnabled([]), undefined);
});

test("lastSessionEnabled: reads the recorded boolean", () => {
	assert.equal(lastSessionEnabled([entry(false)]), false);
	assert.equal(lastSessionEnabled([entry(true)]), true);
});

test("lastSessionEnabled: a later decision wins over an earlier one", () => {
	// `/sysmon off` then `/sysmon on` in the same session must restore `on`,
	// not the first thing the user typed.
	assert.equal(lastSessionEnabled([entry(true), entry(false), entry(true)]), true);
	assert.equal(lastSessionEnabled([entry(false), entry(true), entry(false)]), false);
});

test("lastSessionEnabled: ignores other extensions' custom entries", () => {
	const other: SessionStateLike[] = [
		{ type: "custom", customType: "someone-else", data: { enabled: false } },
		{ type: "custom", customType: "plan-mode", data: {} },
	];
	assert.equal(lastSessionEnabled(other), undefined);
	assert.equal(lastSessionEnabled([...other, entry(true)]), true);
});

test("lastSessionEnabled: ignores non-custom entries", () => {
	// A message entry that happens to have an `enabled` field must not count.
	const msgs: SessionStateLike[] = [
		{ type: "message", data: { enabled: false } },
		{ type: "thinking_level_change" },
	];
	assert.equal(lastSessionEnabled(msgs), undefined);
});

test("lastSessionEnabled: accepts full pi SessionEntryBase fields", () => {
	// The real `getEntries()` returns complete entries (id / parentId /
	// timestamp), not the minimal shape the other cases build. Lock the field
	// path down so a future move of the payload (e.g. to `details`) fails here
	// instead of silently reading nothing at runtime.
	const real: SessionStateLike = {
		type: "custom",
		customType: SESSION_STATE_KEY,
		data: { enabled: false },
		id: "e7c1",
		parentId: "e7c0",
		timestamp: "2026-01-01T00:00:00.000Z",
	};
	assert.equal(lastSessionEnabled([real]), false);
});

test("lastSessionEnabled: boxed Boolean is not a decision", () => {
	// `typeof` correctly rejects an object; this is the guard that keeps a
	// programmatically-built payload from being misread.
	const boxed: SessionStateLike = {
		type: "custom",
		customType: SESSION_STATE_KEY,
		data: { enabled: new Boolean(false) },
	};
	assert.equal(lastSessionEnabled([boxed]), undefined);
});

/* ------------------------------------------------------------------ */
/* 2. resolveEnabled — the precedence chain                             */
/* ------------------------------------------------------------------ */

test("resolveEnabled: session choice beats the global default", () => {
	assert.equal(
		resolveEnabled({ sessionEnabled: false, forcedOn: false, globalEnabled: true }),
		false,
	);
	assert.equal(
		resolveEnabled({ sessionEnabled: true, forcedOn: false, globalEnabled: false }),
		true,
	);
});

test("resolveEnabled: no session choice ⇒ global default applies", () => {
	assert.equal(
		resolveEnabled({
			sessionEnabled: undefined,
			forcedOn: false,
			globalEnabled: false,
		}),
		false,
	);
	assert.equal(
		resolveEnabled({ sessionEnabled: undefined, forcedOn: false, globalEnabled: true }),
		true,
	);
});

test("resolveEnabled: built-in default is on when nothing is configured", () => {
	// "Default on" is the behavior a fresh config dir has always had: the
	// monitor exists to be visible.
	assert.equal(
		resolveEnabled({
			sessionEnabled: undefined,
			forcedOn: false,
			globalEnabled: undefined,
		}),
		true,
	);
});

test("resolveEnabled: --sysmon forces on over the global default", () => {
	assert.equal(
		resolveEnabled({
			sessionEnabled: undefined,
			forcedOn: true,
			globalEnabled: false,
		}),
		true,
	);
});

test("resolveEnabled: --sysmon does not override an in-session /sysmon off", () => {
	// The flag says "this run, show it"; an explicit `/sysmon off` typed in the
	// session is a later, more specific statement — and silently resurrecting
	// the monitor the user just dismissed would be the worse failure.
	assert.equal(
		resolveEnabled({ sessionEnabled: false, forcedOn: true, globalEnabled: true }),
		false,
	);
	// Same answer when the global default also disagrees with the flag: the
	// session check must be unconditional, not "unless the flag matches global".
	assert.equal(
		resolveEnabled({ sessionEnabled: false, forcedOn: true, globalEnabled: false }),
		false,
	);
});

test("resolveEnabled: --sysmon with no global default is still on", () => {
	assert.equal(
		resolveEnabled({
			sessionEnabled: undefined,
			forcedOn: true,
			globalEnabled: undefined,
		}),
		true,
	);
});

/* ------------------------------------------------------------------ */
/* 3. parseSysmonCommand — argument parsing                             */
/* ------------------------------------------------------------------ */

test("parse: empty / whitespace ⇒ toggle", () => {
	assert.deepEqual(parseSysmonCommand(""), { kind: "toggle" });
	assert.deepEqual(parseSysmonCommand("   "), { kind: "toggle" });
});

test("parse: on / off ⇒ explicit enablement", () => {
	assert.deepEqual(parseSysmonCommand("on"), { kind: "enabled", value: true });
	assert.deepEqual(parseSysmonCommand(" off "), { kind: "enabled", value: false });
});

test("parse: global subcommand, all three shapes", () => {
	assert.deepEqual(parseSysmonCommand("global"), { kind: "global", value: "query" });
	assert.deepEqual(parseSysmonCommand("global on"), { kind: "global", value: true });
	assert.deepEqual(parseSysmonCommand("global  off"), { kind: "global", value: false });
	assert.deepEqual(parseSysmonCommand("global"),
		parseSysmonCommand("  GLOBAL  "));
	assert.deepEqual(parseSysmonCommand("global foo"), { kind: "global", value: "usage" });
});

test("parse: 'globally'/'globalon' are NOT the global subcommand", () => {
	// A bare `startsWith("global")` would swallow these (and `/sysmon globalon`
	// would read as `global on`), which is why the match is token-exact.
	assert.deepEqual(parseSysmonCommand("globally"), { kind: "invalid" });
	assert.deepEqual(parseSysmonCommand("globalon"), { kind: "invalid" });
	assert.deepEqual(parseSysmonCommand("global-off"), { kind: "invalid" });
});

test("parse: case-insensitive, so 'Global on' sets the default (not a toggle)", () => {
	assert.deepEqual(parseSysmonCommand("Global On"), { kind: "global", value: true });
	assert.deepEqual(parseSysmonCommand("ON"), { kind: "enabled", value: true });
	assert.deepEqual(parseSysmonCommand("Chart"), { kind: "mode", value: "chart" });
});

test("parse: modes, including the line/status alias", () => {
	assert.deepEqual(parseSysmonCommand("chart"), { kind: "mode", value: "chart" });
	assert.deepEqual(parseSysmonCommand("line"), { kind: "mode", value: "status" });
	assert.deepEqual(parseSysmonCommand("status"), { kind: "mode", value: "status" });
	assert.deepEqual(parseSysmonCommand("footer"), { kind: "mode", value: "footer" });
});

test("parse: placement", () => {
	assert.deepEqual(parseSysmonCommand("above"), {
		kind: "placement",
		value: "aboveEditor",
	});
	assert.deepEqual(parseSysmonCommand("below"), {
		kind: "placement",
		value: "belowEditor",
	});
});

test("parse: unknown input is rejected, not silently toggled", () => {
	// `/sysmon fobar` used to fall through to the toggle branch — a typo that
	// flips the user's monitor is worse than being told the command is unknown.
	assert.deepEqual(parseSysmonCommand("fobar"), { kind: "invalid" });
	assert.deepEqual(parseSysmonCommand("onn"), { kind: "invalid" });
});

/* ------------------------------------------------------------------ */
/* 4. mergeCfg — the config write patch                                 */
/* ------------------------------------------------------------------ */

test("mergeCfg: /sysmon chart must not clear the global default", () => {
	// The regression this guards: a mode/placement write is a partial patch and
	// must leave the `enabled` key (a different scope) intact.
	const prev = { enabled: false, mode: "chart", placement: "belowEditor" };
	assert.deepEqual(mergeCfg(prev, { mode: "footer" }), {
		enabled: false,
		mode: "footer",
		placement: "belowEditor",
	});
});

test("mergeCfg: an undefined patch value must not clobber the existing key", () => {
	// `{...prev, ...patch}` would, and a future
	// `writeCfg({ mode, enabled: maybeUndefined })` would then silently wipe the
	// global default — the exact cross-scope clobber this split prevents.
	const prev = { enabled: true, mode: "chart" };
	assert.deepEqual(mergeCfg(prev, { enabled: undefined, mode: "line" }), {
		enabled: true,
		mode: "line",
	});
});

test("mergeCfg: unknown keys survive a write (forward/backward compatibility)", () => {
	const prev = { enabled: true, mode: "chart", futureField: { nested: 1 } };
	const next = mergeCfg(prev, { placement: "aboveEditor" });
	assert.deepEqual(next.futureField, { nested: 1 });
	assert.equal(next.placement, "aboveEditor");
});

test("mergeCfg: does not mutate the previous object", () => {
	const prev = { enabled: true, mode: "chart" };
	mergeCfg(prev, { mode: "footer" });
	assert.deepEqual(prev, { enabled: true, mode: "chart" });
});

test("mergeCfg: empty patch and empty prev both work", () => {
	assert.deepEqual(mergeCfg({}, { enabled: false }), { enabled: false });
	assert.deepEqual(mergeCfg({ enabled: false }, {}), { enabled: false });
	assert.deepEqual(mergeCfg({}, {}), {});
});
