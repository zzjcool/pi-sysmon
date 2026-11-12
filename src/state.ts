/**
 * Enablement scope + command parsing + the startup-notice latch.
 *
 * Three things live here because all are "rules about scopes" that the extension
 * layer (`index.ts`) can only exercise through a live pi instance:
 *   · **which on/off applies** — session choice vs global default vs `--sysmon`;
 *   · **what a `/sysmon …` argument means** — session switch, global default,
 *     display preference, or a typo;
 *   · **which dependency warning is still owed** — a missing temperature sensor
 *     is a hardware fact, so the notice is latched across processes instead of
 *     repeating on every launch.
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

/* ------------------------------------------------------------------ */
/* 5. startupWarning — the once-only dependency notice                  */
/* ------------------------------------------------------------------ */

/**
 * Structural subset of `MetricsPreflight` (`metrics.ts`) the startup notice
 * cares about. Structural so this module stays free of collector imports.
 */
export interface PreflightLike {
	/** Platform basics readable (`/proc` on Linux, `sysctl` on macOS) */
	core: boolean;
	/** A CPU temperature source exists */
	temp: boolean;
}

/** A startup dependency warning plus the id it is latched under. */
export interface StartupWarning {
	/** Stable key written into the config file's `warned` list once shown. */
	id: string;
	message: string;
}

/**
 * Which dependency warning (if any) this session start still owes the user.
 *
 * **Warn once per host, not once per process.** The verdicts are hardware facts
 * (no `hwmon` sensor on this box, macOS without `macmon`), so they cannot fix
 * themselves — the old per-process latch printed the same notice on every
 * single launch, forever. `warned` is the persisted list of ids already shown
 * (from `<configDir>/pi-sysmon.json`); the caller appends the returned id after
 * notifying. The platform is part of the id, so a config dir shared between
 * boxes (or a dual-boot) still warns once per host class instead of going
 * silent on the other one.
 *
 * Precedence: an unsupported platform wins over a missing sensor — when every
 * chart reads 0, the temperature line is not the news.
 *
 * `undefined` = nothing to say (all sources present, or already shown).
 */
export function startupWarning(
	pre: PreflightLike,
	platform: string,
	warned: readonly string[],
): StartupWarning | undefined {
	if (!pre.core) {
		const id = `unsupported:${platform}`;
		if (warned.includes(id)) return undefined;
		return {
			id,
			message: `pi-sysmon: ${platform} is not supported — CPU/memory/network/disk charts will all read 0 (supported: macOS, Linux). Disable with /sysmon global off.`,
		};
	}
	if (!pre.temp) {
		const id = `temp:${platform}`;
		if (warned.includes(id)) return undefined;
		return {
			id,
			message:
				platform === "darwin"
					? "pi-sysmon: CPU temperature unavailable — install macmon (brew install macmon, Apple Silicon) or osx-cpu-temp (Intel). Other charts work normally."
					: "pi-sysmon: CPU temperature unavailable — no CPU sensor found under /sys/class/hwmon or /sys/class/thermal. Other charts work normally.",
		};
	}
	return undefined;
}
