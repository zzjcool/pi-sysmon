/**
 * Enablement scope + command parsing.
 *
 * Two things live here because both are "rules about scopes" that the extension
 * layer (`index.ts`) can only exercise through a live pi instance:
 *   · **which on/off applies** — session choice vs global default vs `--sysmon`;
 *   · **what a `/sysmon …` argument means** — session switch, global default,
 *     display preference, or a typo.
 * Pure functions, no pi API / fs / state (same reason `blocks.ts` is split out).
 */
import { parseMode, type Mode, type Placement } from "./blocks.ts";

/** Custom session-entry key holding the session-scoped on/off choice. */
export const SESSION_STATE_KEY = "sysmon-state";

/**
 * Structural subset of pi's `CustomEntry` (`{ type, customType, data }`) this
 * module reads. Structural so tests can build fakes while the real
 * `SessionEntry` union still satisfies it.
 */
export interface SessionStateLike {
	type: string;
	customType?: string;
	data?: unknown;
	/** Real entries carry these too (`SessionEntryBase`); accepted so callers can pass real entries. */
	id?: string;
	parentId?: string | null;
	timestamp?: string;
}

/**
 * The on/off explicitly recorded on the current branch, or `undefined` when the
 * session never touched the switch — i.e. **"inherit the global default"**,
 * deliberately distinct from an explicit `false`.
 *
 * Scans backwards so the newest entry wins (a session may contain `/sysmon off`
 * … `/sysmon on`). Malformed payloads are skipped, not read as `false`: one bad
 * write must not pin a session forever, nor shadow an older valid decision.
 */
export function lastSessionEnabled(
	entries: readonly SessionStateLike[],
): boolean | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e || e.type !== "custom" || e.customType !== SESSION_STATE_KEY)
			continue;
		const d = e.data;
		if (
			d !== null &&
			typeof d === "object" &&
			typeof (d as { enabled?: unknown }).enabled === "boolean"
		)
			return (d as { enabled: boolean }).enabled;
	}
	return undefined;
}

/**
 * Precedence: **session choice > `--sysmon` > global default > built-in default
 * (on)**.
 *
 * `--sysmon` means "this run, show the monitor regardless of the file" — that's
 * all it's for. But a `/sysmon off` typed inside the session is a later, more
 * specific statement about *this* session, so it wins over the flag.
 *
 * Built-in default is **on**: a fresh config dir has always started enabled.
 */
export function resolveEnabled(opts: {
	sessionEnabled: boolean | undefined;
	forcedOn: boolean;
	globalEnabled: boolean | undefined;
}): boolean {
	if (opts.sessionEnabled !== undefined) return opts.sessionEnabled;
	if (opts.forcedOn) return true;
	return opts.globalEnabled ?? true;
}

/** What a `/sysmon <args>` invocation asks for. */
export type SysmonCommand =
	| { kind: "toggle" }
	| { kind: "enabled"; value: boolean }
	| { kind: "mode"; value: Mode }
	| { kind: "placement"; value: Placement }
	/** `value` is `true`/`false` to set the default, `"query"` to report it, `"usage"` for a bad argument */
	| { kind: "global"; value: boolean | "query" | "usage" }
	| { kind: "invalid" };

/**
 * Parse the raw argument string for `/sysmon`.
 *
 * Values are matched **case-insensitively** and unknown input is reported as
 * `invalid` instead of falling through to `toggle` (the old behavior made
 * `/sysmon fobar` silently toggle, and `/sysmon Global on` toggle rather than
 * set the default). `global` is matched as an exact token or `global <arg>`
 * only — a bare prefix match would swallow typos like `globally`.
 *
 * The internal mode name is `status`; `line` is the user-facing alias
 * (`parseMode` owns that mapping, so it isn't duplicated here).
 */
export function parseSysmonCommand(args: string): SysmonCommand {
	const want = args.trim().toLowerCase();

	if (want === "global") return { kind: "global", value: "query" };
	if (want.startsWith("global ")) {
		const sub = want.slice("global ".length).trim();
		if (sub === "on") return { kind: "global", value: true };
		if (sub === "off") return { kind: "global", value: false };
		return { kind: "global", value: "usage" };
	}

	if (want === "") return { kind: "toggle" };
	if (want === "on") return { kind: "enabled", value: true };
	if (want === "off") return { kind: "enabled", value: false };
	if (want === "above") return { kind: "placement", value: "aboveEditor" };
	if (want === "below") return { kind: "placement", value: "belowEditor" };
	if (want === "chart" || want === "line" || want === "status" || want === "footer")
		return { kind: "mode", value: parseMode(want) };

	return { kind: "invalid" };
}

/**
 * Merge a write patch into the existing config object.
 *
 * Read-modify-write, because a plain overwrite with a partial object drops
 * whichever of `enabled` / `mode` / `placement` the caller didn't set (e.g.
 * `/sysmon chart` clearing the global default). Keys whose patch value is
 * `undefined` are left alone — otherwise a future
 * `writeCfg({ mode, enabled: maybeUndefined })` would silently wipe the value,
 * which is exactly the cross-scope clobber this split exists to prevent.
 * Unknown keys survive so another version's fields aren't destroyed.
 */
export function mergeCfg(
	prev: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const next = { ...prev };
	for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
	return next;
}
