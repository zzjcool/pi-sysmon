/**
 * Minimal system metrics collector — pure Node, no third-party dependencies.
 *
 * Sources per platform:
 *   Linux  — /proc (stat, meminfo, net/dev, diskstats)
 *   macOS  — os.cpus() (CPU) + vm_stat/sysctl (mem) + netstat -ib (net) + ioreg (disk)
 *   other  — degrades to zeros / os.* so the extension still loads
 *
 * Why macOS does not just call `iostat` for everything (the obvious recipe):
 * Apple's `iostat` only emits a *rate* (never a cumulative counter) and, to
 * produce its second "current activity" sample, it **sleeps for a full second**
 * (−w default is 1). Both `iostat -c 2` and `iostat -d -K -c 2` therefore block
 * for ~1.03s each, and the collector runs on a 1000ms timer: wiring them into
 * every collect() would stall the render loop ~2s per tick. Instead:
 *   CPU  — os.cpus() cumulative per-core ticks, exactly the /proc/stat model
 *          (busy = user+nice+sys+irq, total = busy+idle). Verified against
 *          iostat's 2nd sample (see metrics.test.ts): the ratios agree.
 *   Disk — `ioreg … IOBlockStorageDriver` exposes genuine cumulative
 *          `Bytes (Read)`/`Bytes (Write)` counters *and* the read/write split
 *          that iostat's MB/s column lacks, at ~20ms per call. This is what
 *          keeps collect()'s counter+differential logic untouched.
 * `parseIostat` stays implemented (and tested): it is the CPU fallback should
 * os.cpus() ever be unusable, and its tested agreement with os.cpus() is the
 * executable evidence for the architecture decision above.
 */
import {
	execFileSync,
	spawn,
	type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";

const IS_DARWIN = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";
/** Every child process is bounded: a wedged command must not hang the collector. */
const EXEC_TIMEOUT_MS = 5000;

/** Run a command and return stdout as text; null when it is missing/fails/times out. */
function execText(file: string, args: string[]): string | null {
	try {
		return execFileSync(file, args, {
			encoding: "utf8",
			timeout: EXEC_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return null; // command absent / non-zero exit / timeout: caller degrades
	}
}

/** Bytes per sector: the unit of "sectors" in /proc/diskstats. Not every device
 *  uses 512, so probe the actual value per block device.
 *  Returns a Map per disk (not a single value) to handle mixed 512/4K setups. */
function detectSectorSizes(): Map<string, number> {
	const sizes = new Map<string, number>();
	try {
		for (const d of readdirSync("/sys/block")) {
			if (d.startsWith("loop") || d.startsWith("ram")) continue;
			try {
				const v = Number(
					readFileSync(`/sys/block/${d}/queue/logical_block_size`, "utf8").trim(),
				);
				if (Number.isFinite(v) && v > 0) sizes.set(d, v);
			} catch {
				/* this disk lacks the attribute; ignore */
			}
		}
	} catch {
		/* non-Linux or /sys unreadable */
	}
	return sizes;
}

const SECTOR_SIZES = detectSectorSizes();
/** Fallback when probing fails: psutil/bottom both treat 512 as the de-facto Linux constant. */
const FALLBACK_SECTOR_SIZE = 512;

function sectorSizeFor(dev: string): number {
	return SECTOR_SIZES.get(dev) ?? FALLBACK_SECTOR_SIZE;
}

export interface Snapshot {
	cpuPct: number;
	/**
	 * CPU package temperature in °C. **0 means unknown** (no readable sensor
	 * on this platform / helper command absent) — the chart layer gates the
	 * temperature curve on history actually containing a >0 reading, so a
	 * platform without a source degrades to the old single-curve CPU block
	 * instead of drawing a misleading line glued to 0°C.
	 */
	cpuTemp: number;
	memUsed: number;
	memTotal: number;
	memPct: number;
	/** 1/5/15 minute load averages (bottom's CPU title bar shows these three) */
	load1: number;
	load5: number;
	load15: number;
	rxBps: number;
	txBps: number;
	/** Cumulative traffic (bottom's "All:" column) */
	rxTotal: number;
	txTotal: number;
	readBps: number;
	writeBps: number;
}

function readCpuTimes(): { total: number; busy: number } {
	if (IS_DARWIN) return readCpuTimesDarwin();
	try {
		const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
		const parts = line.trim().split(/\s+/).slice(1).map(Number);
		const [
			user = 0,
			nice = 0,
			sys = 0,
			idle = 0,
			iowait = 0,
			irq = 0,
			softirq = 0,
			steal = 0,
		] = parts;
		const idleAll = idle + iowait;
		const busy = user + nice + sys + irq + softirq + steal;
		return { total: busy + idleAll, busy };
	} catch {
		return { total: 0, busy: 0 }; // non-Linux / unreadable: degrade to zeros so the extension still loads
	}
}

function readMem(): { used: number; total: number } {
	if (IS_DARWIN) return readMemDarwin();
	try {
		const txt = readFileSync("/proc/meminfo", "utf8");
		// Fixed-key lookup table, avoiding dynamically built regexes
		const raw = new Map<string, number>();
		for (const line of txt.split("\n")) {
			const i = line.indexOf(":");
			if (i <= 0) continue;
			const v = Number.parseInt(line.slice(i + 1).trim(), 10);
			if (Number.isFinite(v)) raw.set(line.slice(0, i), v);
		}
		const grab = (k: string) => (raw.get(k) ?? 0) * 1024;
		const total = grab("MemTotal");
		// MemAvailable matches the bottom/htop convention better than MemFree
		const available = grab("MemAvailable") || grab("MemFree");
		if (total <= 0) return { used: 0, total: os.totalmem() };
		return { used: Math.max(0, total - available), total };
	} catch {
		// Fall back to os.totalmem off Linux; no reliable source for `used`, so report 0
		return { used: 0, total: os.totalmem() };
	}
}

function readNet(): { rx: number; tx: number } {
	if (IS_DARWIN) return readNetDarwin();
	let rx = 0;
	let tx = 0;
	try {
		const lines = readFileSync("/proc/net/dev", "utf8").split("\n").slice(2);
		for (const l of lines) {
			const [iface, rest] = l.split(":") ?? [];
			if (!iface || !rest) continue;
			const name = iface.trim();
			if (
				name === "lo" ||
				name.startsWith("veth") ||
				name.startsWith("docker") ||
				name.startsWith("br-")
			)
				continue;
			const f = rest.trim().split(/\s+/).map(Number);
			rx += Number.isFinite(f[0]) ? (f[0] as number) : 0;
			tx += Number.isFinite(f[8]) ? (f[8] as number) : 0;
		}
	} catch {
		/* non-Linux: return zeros */
	}
	return { rx, tx };
}

function readDisk(): { read: number; write: number } {
	if (IS_DARWIN) return readDiskDarwin();
	let read = 0;
	let write = 0;
	try {
		const lines = readFileSync("/proc/diskstats", "utf8").split("\n");
		for (const l of lines) {
			const f = l.trim().split(/\s+/);
			if (f.length < 14) continue;
			const name = f[2] ?? "";
			// Physical disks only; skip partitions (they would double-count)
			if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)$/.test(name))
				continue;
			const r = Number(f[5]); // sectors read
			const w = Number(f[9]); // sectors written
			const ss = sectorSizeFor(name); // per-disk sector size, avoiding under/over-counting on mixed disks
			if (Number.isFinite(r)) read += r * ss;
			if (Number.isFinite(w)) write += w * ss;
		}
	} catch {
		/* non-Linux: return zeros */
	}
	return { read, write };
}

/** Read one integer-ish text file, or null. Small helper for /sys probing. */
function readTextFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
}

/**
 * Linux CPU temperature, in °C, **without a hardcoded zone name**.
 *
 * `/sys/class/thermal` zone names vary wildly per vendor
 * ("x86_pkg_temp", "soc_thermal", "cpu-thermal"…), so the lookup goes through
 * the **label side** (hwmon `temp*_label` + `temp*_input`) with a preference
 * list, and falls back to plain thermal_zone files for kernels without hwmon.
 * Only CPU-ish labels match — "GPU", "battery", "ambient" sensors are skipped.
 */
const CPU_TEMP_LABEL_RE =
	/(?:^|[_ -])(?:cpu|package|pkg|soc|core|tdie|tctl)(?:[_ -]|$)/i;

function readCpuTempLinux(): number {
	// 1) hwmon: prefer a sensor whose label names the CPU. Matches both
	//    `coretemp` (label "Package id 0" / "Core 0") and ARM SoCs
	//    (`k10temp` / `scpi_sensors`: label "Tdie" / "SoC temperature").
	try {
		const classes = ["hwmon", "thermal"];
		for (const cls of classes) {
			for (const d of readdirSync(`/sys/class/${cls}`)) {
				const base = `/sys/class/${cls}/${d}`;
				if (cls === "hwmon") {
					// temp0 doesn't exist; temp1..tempN
					for (let i = 1; i <= 12; i++) {
						const label = readTextFile(`${base}/temp${i}_label`);
						if (label && CPU_TEMP_LABEL_RE.test(label)) {
							const raw = readTextFile(`${base}/temp${i}_input`);
							const c = Number(raw);
							if (Number.isFinite(c) && c > 0 && c < 150) return c / 1000;
						}
					}
				}
			}
		}
	} catch {
		/* /sys unreadable: fall through */
	}
	// 2) thermal_zone fallback: type must look CPU-ish too, so an
	//    acpitz/ambient zone can't feed a bogus 25°C into the chart.
	try {
		for (const d of readdirSync("/sys/class/thermal")) {
			if (!d.startsWith("thermal_zone")) continue;
			const type = readTextFile(`/sys/class/thermal/${d}/type`);
			if (type && CPU_TEMP_LABEL_RE.test(type)) {
				const raw = readTextFile(`/sys/class/thermal/${d}/temp`);
				const c = Number(raw);
				if (Number.isFinite(c) && c > 0 && c < 150) return c / 1000;
			}
		}
	} catch {
		/* non-Linux: fall through */
	}
	return 0;
}

/**
 * Parse a temperature-reading line from a macOS helper command (`osx-cpu-temp`
 * prints e.g. `61.5°C`, `istats cpu temperature` prints
 * `CPU temperature: 61.50°C`). Pure, exported for offline testing.
 *
 * Returns 0 when no plausible number is found — "unknown", never garbage.
 */
export function parseCpuTempText(text: string): number {
	// Take the first number; both helpers print the °C reading first (any
	// trailing numbers are other sensors / counts).
	const m = /(-?\d+(?:\.\d+)?)/.exec(text);
	if (!m) return 0;
	const c = Number(m[1]);
	// Sanity window: a "CPU temperature" outside 0..150°C is a parse error,
	// never a real reading (helper printing some other unit etc.).
	return Number.isFinite(c) && c > 0 && c < 150 ? c : 0;
}

/**
 * Parse one JSON line from `macmon pipe` and return the average CPU
 * temperature (°C), or 0 = unknown. Pure, exported for offline testing.
 * A >0 return means "trust this"; 0 means the line wasn't usable (truncated
 * mid-line at the read timeout, schema drift, or a junk banner line).
 */
export function parseMacmonCpuTemp(line: string): number {
	if (!line) return 0;
	try {
		const c: unknown = JSON.parse(line)?.temp?.cpu_temp_avg;
		// `typeof` guards both a missing key (undefined) and a schema drift
		// (string "44.1") — only a finite number in the physical window counts.
		if (typeof c === "number" && Number.isFinite(c) && c > 0 && c < 150) return c;
	} catch {
		/* truncated/junk line: 0 = unknown */
	}
	return 0;
}

/**
 * macOS CPU temperature.
 *
 * **Why helper-command probes instead of a system API**: macOS exposes no
 * unprivileged CPU-temperature API — the SMC keys need direct SMC access, and
 * `powermetrics` (the only system tool that reads them) refuses to run without
 * sudo. Helpers are probed in order of trust; if none works this returns 0
 * and the chart degrades to the old single-curve CPU block — declared
 * behaviour, not a bug.
 *
 * 1. `macmon pipe` (brew core, Apple Silicon only): the only one that works
 *    on ARM Macs today. It **streams one JSON line per interval forever**, so
 *    it runs as a single **resident** async child process whose stdout is
 *    parsed line by line into `macmonTemp`; `collect()` only reads that
 *    variable — zero synchronous spawn cost per sample. (An earlier
 *    spawnSync-per-sample design measured ~2.5s of blocking per call, which
 *    froze the TUI.) The child is killed on `session_shutdown`; a crashed
 *    child is lazily restarted on the next `collect()` after a backoff.
 * 2. `osx-cpu-temp` / `istats`: Intel-only in practice — both hard-code the
 *    Intel SMC key `TC0P` with `sp78` decoding, and on Apple Silicon that key
 *    simply doesn't exist, so they print `0.0°C` (lavoiesl/osx-cpu-temp#38,
 *    Chris911/iStats#107, both open). Kept for Intel Macs.
 */
let macmonChild: ChildProcessByStdio<null, Readable, Readable> | undefined;
let macmonTemp = 0;
let macmonBuf = "";
/** `-Infinity` = "never started": the backoff below must not gate the FIRST
 *  spawn (performance.now() starts near 0 in a fresh process, so a 0 initial
 *  value would delay the first macmon start by a full MACMON_RESTART_MS). */
let macmonLastStart = -Infinity;
/** Restart backoff: after a crash, wait before respawning so a broken macmon
 *  installation can't turn every `collect()` into a fork bomb. */
const MACMON_RESTART_MS = 10_000;

function readCpuTempDarwin(): number {
	// 1) macmon (Apple Silicon): the resident child updates `macmonTemp`.
	if (
		macmonChild === undefined &&
		performance.now() - macmonLastStart > MACMON_RESTART_MS
	) {
		macmonLastStart = performance.now();
		try {
			// Not `--interval 1000`: a shorter cadence keeps the reading fresh
			// without any idle cost — the process is resident, nobody polls it.
			macmonChild = spawn("macmon", ["pipe", "--interval", "1000"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			macmonBuf = "";
			macmonChild.stdout.setEncoding("utf8");
			macmonChild.stdout.on("data", (chunk: string) => {
				macmonBuf += chunk;
				// macmon flushes whole JSON lines; split on '\n' and keep the
				// (possibly empty) remainder.
				const lines = macmonBuf.split("\n");
				macmonBuf = lines.pop() ?? "";
				for (const line of lines) {
					const c = parseMacmonCpuTemp(line);
					if (c > 0) macmonTemp = c;
				}
			});
			// EPIPE/exit: remember the last reading (a slow variable) and let the
			// backoff-gated respawn above refresh it.
			macmonChild.on("exit", () => {
				macmonChild = undefined;
			});
			// spawn() itself can throw synchronously (ENOENT when macmon isn't
			// installed) — fall through to the Intel helpers.
			macmonChild.on("error", () => {
				macmonChild = undefined;
			});
		} catch {
			macmonChild = undefined;
		}
	}
	if (macmonTemp > 0) return macmonTemp;
	// The first reading lands ~1s after the child starts; before that (and on
	// Intel Macs / macmon-less machines) fall back to the synchronous helpers.
	// 2) Intel Mac helpers.
	for (const [file, args] of [
		["osx-cpu-temp", []],
		["istats", ["cpu", "temperature"]],
	] as const) {
		const out = execText(file, [...args]);
		if (out === null) continue;
		const c = parseCpuTempText(out);
		if (c > 0) return c;
	}
	return 0;
}

/** Kill the resident macmon child. Called on `session_shutdown` so the
 *  streaming process never outlives the session (pi exits, the child would
 *  otherwise be reparented and keep running). */
export function stopCpuTempDarwin(): void {
	macmonChild?.kill();
	macmonChild = undefined;
	macmonTemp = 0;
	macmonBuf = "";
}

/**
 * One-shot dependency preflight: can each metric group be read on this
 * platform? Returns a per-group verdict so the caller can warn precisely
 * ("temperature unavailable" vs "this platform isn't supported at all").
 *
 * **Why a separate probe instead of reusing the readers**: the resident
 * macmon child only produces its first reading ~1s after spawn, and the
 * /proc readers degrade to zeros rather than throwing, so sampling right
 * after mount can't distinguish "missing source" from "first sample not
 * in yet". This check instead asks "could any source ever answer?" per
 * metric, letting the caller warn the user **at startup** instead of
 * leaving silently flat charts to be discovered sessions later.
 *
 * Pure probing (no resident state, never throws); exported for testing.
 *
 * Group semantics:
 * - `core` — CPU/mem/net/disk charts. True on macOS (system tools) and
 *   Linux (/proc). False on any other platform (Windows: every chart reads 0).
 * - `temp` — CPU temperature: needs macmon / osx-cpu-temp / istats on macOS,
 *   a CPU-ish hwmon/thermal_zone sensor on Linux.
 */
export interface MetricsPreflight {
	/** CPU / memory / network / disk charts are readable. */
	core: boolean;
	/** CPU temperature is readable (its own group: optional helper on macOS). */
	temp: boolean;
}

export function preflightMetrics(): MetricsPreflight {
	if (IS_DARWIN) {
		// Core: sysctl / vm_stat / netstat / ioreg ship with macOS itself — if
		// one is somehow missing the reader degrades, but that's a broken OS;
		// probing all four is noise. One representative (sysctl) is enough.
		const core = whichSync("sysctl");
		// Temp: macmon (Apple Silicon), osx-cpu-temp / istats (Intel).
		let temp = false;
		for (const file of ["macmon", "osx-cpu-temp", "istats"]) {
			if (whichSync(file)) {
				temp = true;
				break;
			}
		}
		return { core, temp };
	}
	if (IS_LINUX) {
		// Core: /proc must be readable. /proc/net/dev is representative (on a
		// sane system stat/meminfo/diskstats live or die with it).
		let core = false;
		try {
			readFileSync("/proc/net/dev", "utf8");
			core = true;
		} catch {
			/* unreadable /proc: core stays false */
		}
		return { core, temp: linuxCpuTempSensorExists() };
	}
	// Other platforms (Windows, FreeBSD…): every reader degrades to zeros —
	// declare both groups dead so the user hears it once at startup.
	return { core: false, temp: false };
}

/** Back-compat alias for the original single-group question. */
export function hasCpuTempSource(): boolean {
	return preflightMetrics().temp;
}

/**
 * Linux: does any CPU-ish temperature sensor exist? Mirrors readCpuTempLinux()'s
 * own sources (hwmon labels, then thermal_zone types) — exists == readable.
 */
function linuxCpuTempSensorExists(): boolean {
	try {
		for (const cls of ["hwmon", "thermal"]) {
			for (const d of readdirSync(`/sys/class/${cls}`)) {
				const base = `/sys/class/${cls}/${d}`;
				if (cls === "hwmon") {
					for (let i = 1; i <= 12; i++) {
						const label = readTextFile(`${base}/temp${i}_label`);
						if (label && CPU_TEMP_LABEL_RE.test(label)) {
							const raw = readTextFile(`${base}/temp${i}_input`);
							if (raw && Number.isFinite(Number(raw))) return true;
						}
					}
				}
			}
		}
	} catch {
		/* /sys unreadable */
	}
	try {
		for (const d of readdirSync("/sys/class/thermal")) {
			if (!d.startsWith("thermal_zone")) continue;
			const type = readTextFile(`/sys/class/thermal/${d}/type`);
			if (type && CPU_TEMP_LABEL_RE.test(type)) {
				const raw = readTextFile(`/sys/class/thermal/${d}/temp`);
				if (raw && Number.isFinite(Number(raw))) return true;
			}
		}
	} catch {
		/* fall through */
	}
	return false;
}

/** `which <cmd>` — is an executable on PATH? */
function whichSync(cmd: string): boolean {
	const out = execText("which", [cmd]);
	return out !== null && out.trim() !== "";
}

export interface Collector {
	collect(): Snapshot;
}

/* ------------------------------------------------------------------ */
/* macOS (darwin) sources — pure parsers, exported for offline testing  */
/* ------------------------------------------------------------------ */

/** Page counters from `vm_stat`, in pages (× pageSize for bytes). */
export interface VmStat {
	pageSize: number;
	free: number;
	active: number;
	inactive: number;
	speculative: number;
	wired: number;
	/** "Pages occupied by compressor" — the compressor's RAM footprint (what
	 *  top's "compressor" figure reports), not "Pages stored in compressor". */
	compressed: number;
}

/** Default page size when `vm_stat`'s header omits "page size of N bytes". */
const FALLBACK_PAGE_SIZE = 4096;

/**
 * Parse `vm_stat` output. The page size is taken from the header line
 * ("page size of 16384 bytes") unless the caller passes one explicitly.
 *
 * Keyed by exact label rather than substring: the output contains both
 * "Pages stored in compressor" (uncompressed size) and "Pages occupied by
 * compressor" (real footprint), and only the latter belongs in `compressed`.
 */
export function parseVmStat(text: string, pageSize?: number): VmStat {
	const header = /page size of\s+(\d+)\s+bytes/i.exec(text);
	const size = pageSize ?? (header ? Number(header[1]) : FALLBACK_PAGE_SIZE);
	const labels: Record<string, keyof Omit<VmStat, "pageSize">> = {
		"Pages free": "free",
		"Pages active": "active",
		"Pages inactive": "inactive",
		"Pages speculative": "speculative",
		"Pages wired down": "wired",
		"Pages occupied by compressor": "compressed",
	};
	const out: VmStat = {
		pageSize: Number.isFinite(size) && size > 0 ? size : FALLBACK_PAGE_SIZE,
		free: 0,
		active: 0,
		inactive: 0,
		speculative: 0,
		wired: 0,
		compressed: 0,
	};
	for (const line of text.split("\n")) {
		const i = line.indexOf(":");
		if (i <= 0) continue;
		const key = labels[line.slice(0, i).trim()];
		if (!key) continue;
		const v = Number.parseInt(line.slice(i + 1).trim(), 10);
		if (Number.isFinite(v)) out[key] = v;
	}
	return out;
}

/**
 * Used memory: pages that are free, inactive or speculative are treated as
 * reclaimable, so `used = total - (free + inactive + speculative)`.
 * (Note this is deliberately NOT top's "used" figure: top counts inactive as
 * used and only subtracts free+purgeable, so this formula runs lower than top.
 * It matches the MemAvailable convention of the Linux path above.)
 */
export function vmStatUsedBytes(v: VmStat, pageSize: number, total: number): number {
	const reclaimable = (v.free + v.inactive + v.speculative) * pageSize;
	return Math.max(0, total - reclaimable);
}

/** Interfaces excluded from traffic totals — same set as the Linux path's
 *  lo / veth* / docker* / br-*, just with macOS's `lo0` name. utun (VPN) and
 *  awdl/bridge carry real traffic and are therefore counted. */
function skipIface(name: string): boolean {
	return (
		name === "lo0" ||
		name.startsWith("veth") ||
		name.startsWith("docker") ||
		name.startsWith("br-")
	);
}

/**
 * Parse `netstat -ib` into cumulative rx/tx byte totals.
 *
 * `netstat -ib` prints one row per interface **plus one per assigned address**,
 * repeating the same counters (with `-` in the error columns). Counting rows
 * blindly multiplies traffic by the number of addresses per interface, so rows
 * are de-duplicated by interface name and the largest reading wins (rows can
 * be observed mid-update; the max never under-counts a monotonic counter).
 *
 * Columns are located from the *right* (… Ipkts Ierrs Ibytes Opkts Oerrs Obytes
 * Coll): the name/mtu/network/address fields on the left are variable-width, so
 * the last seven tokens are the stable part.
 */
export function parseNetstatIb(text: string): { rx: number; tx: number } {
	const perIface = new Map<string, { rx: number; tx: number }>();
	for (const line of text.split("\n")) {
		const tokens = line.trim().split(/\s+/);
		// Name Mtu Network + the 7 trailing counters is the minimum a real row can
		// have. Requiring all 10 keeps a truncated/garbled row from being
		// right-anchored onto the wrong columns and injecting a bogus number.
		if (tokens.length < 10) continue;
		const name = tokens[0] ?? "";
		if (!name || name === "Name" || skipIface(name)) continue;
		const tail = tokens.slice(-7); // Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
		const rx = Number(tail[2]);
		const tx = Number(tail[5]);
		if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
		const prev = perIface.get(name);
		if (prev) {
			prev.rx = Math.max(prev.rx, rx);
			prev.tx = Math.max(prev.tx, tx);
		} else {
			perIface.set(name, { rx, tx });
		}
	}
	let rx = 0;
	let tx = 0;
	for (const v of perIface.values()) {
		rx += v.rx;
		tx += v.tx;
	}
	return { rx, tx };
}

/** CPU counters from an `iostat` sample, in ticks/second (0..100 per CPU). */
export interface IostatCpu {
	us: number;
	ni: number;
	sy: number;
	id: number;
	/** 100 * (us+ni+sy) / (us+ni+sy+id) — the busy fraction of that sample. */
	busyPct: number;
}

/**
 * Parse `iostat` CPU columns, always from the **last** sample block.
 *
 * `iostat -c 2` (the recipe the plan specifies) prints two samples: the first is
 * averaged over system uptime and is therefore useless as an instantaneous
 * reading — only the second reflects "now". The same holds for -c 3, so taking
 * the final block is both correct for -c 2 and robust if a caller asks for more.
 *
 * Columns are located by header name, not fixed offset, because the CPU block
 * sits after a variable number of per-disk column groups. An `ni` (nice) column
 * is optional: Apple's iostat on this machine prints `us sy id`, but older/
 * other builds print `us ni sy id`.
 */
export function parseIostat(text: string): IostatCpu {
	const zero: IostatCpu = { us: 0, ni: 0, sy: 0, id: 0, busyPct: 0 };
	const lines = text.split("\n");
	let header: string[] | null = null;
	let usIdx = -1;
	let niIdx = -1;
	let syIdx = -1;
	let idIdx = -1;
	for (const line of lines) {
		const tokens = line.trim().split(/\s+/);
		const u = tokens.indexOf("us");
		if (u < 0) continue;
		header = tokens;
		usIdx = u;
		// Header order: [us] [ni] sy id …
		niIdx = tokens[u + 1] === "ni" ? u + 1 : -1;
		syIdx = niIdx >= 0 ? u + 2 : u + 1;
		idIdx = niIdx >= 0 ? u + 3 : u + 2;
		break;
	}
	if (!header || usIdx < 0 || idIdx < 0) return zero;
	const num = (tokens: string[], i: number): number => {
		const v = Number(tokens[i]);
		return Number.isFinite(v) ? v : Number.NaN;
	};
	let sample: string[] | null = null;
	for (const line of lines) {
		const tokens = line.trim().split(/\s+/);
		if (tokens.length <= idIdx) continue;
		// A data row starts with a number; this skips the header itself and the
		// blank/separator lines without needing to know how many there are.
		if (!Number.isFinite(Number(tokens[0]))) continue;
		if (Number.isFinite(num(tokens, usIdx)) && Number.isFinite(num(tokens, idIdx))) {
			sample = tokens; // keep scanning: the last valid block wins
		}
	}
	if (!sample) return zero;
	const us = num(sample, usIdx);
	const ni = niIdx >= 0 ? num(sample, niIdx) : 0;
	const sy = num(sample, syIdx);
	const id = num(sample, idIdx);
	const busy = us + ni + sy;
	const total = busy + id;
	return { us, ni, sy, id, busyPct: total > 0 ? (100 * busy) / total : 0 };
}

/**
 * Parse `ioreg -r -c IOBlockStorageDriver -k Statistics -d 1` into cumulative
 * read/written bytes, summed over every block-storage driver.
 *
 * Unlike iostat's MB/s rate column, these `Bytes (Read)` / `Bytes (Write)`
 * values are true monotonic counters with a read/write split — exactly the shape
 * collect()'s `(disk.read - lastDisk.read) / dt` differential expects, so the
 * Linux differencing logic needs no darwin special case.
 * (Caveat: disk images / removable media mount their own IOBlockStorageDriver;
 * ejecting one makes its counters vanish, so the total can step DOWN. The
 * collector's Math.max(0, …) clamp absorbs it as a one-tick rate hole.)
 */
export function parseIoreg(text: string): { read: number; write: number } {
	let read = 0;
	let write = 0;
	for (const m of text.matchAll(/"Bytes \(Read\)"=(\d+)/g)) {
		const v = Number(m[1]);
		if (Number.isFinite(v)) read += v;
	}
	for (const m of text.matchAll(/"Bytes \(Write\)"=(\d+)/g)) {
		const v = Number(m[1]);
		if (Number.isFinite(v)) write += v;
	}
	return { read, write };
}

/* Darwin readers — each degrades to zeros (mem: to os.totalmem()) like the
 * Linux ones, so an absent command never breaks the extension. */

function readCpuTimesDarwin(): { total: number; busy: number } {
	// os.cpus().times are cumulative ticks since boot: the /proc/stat model.
	// iostat is only a fallback because `iostat -c 2` blocks a full second.
	const cpus = os.cpus();
	if (cpus.length > 0) {
		let total = 0;
		let busy = 0;
		for (const c of cpus) {
			const t = c.times;
			const b = t.user + t.nice + t.sys + (t.irq ?? 0);
			busy += b;
			total += b + t.idle;
		}
		if (total > 0) return { total, busy };
	}
	const txt = execText("iostat", ["-c", "2"]);
	if (txt === null) return { total: 0, busy: 0 };
	const c = parseIostat(txt);
	// Report ticks consistent with parseIostat's own denominator so the
	// collector's busy/total ratio reproduces busyPct.
	const total = c.us + c.ni + c.sy + c.id;
	return { total, busy: c.us + c.ni + c.sy };
}

function readMemDarwin(): { used: number; total: number } {
	const totalRaw = execText("sysctl", ["-n", "hw.memsize"]);
	const total = totalRaw === null ? 0 : Number(totalRaw.trim());
	if (!Number.isFinite(total) || total <= 0) return { used: 0, total: os.totalmem() };
	const vmText = execText("vm_stat", []);
	if (vmText === null) return { used: 0, total };
	const vm = parseVmStat(vmText);
	return { used: vmStatUsedBytes(vm, vm.pageSize, total), total };
}

function readNetDarwin(): { rx: number; tx: number } {
	const txt = execText("netstat", ["-ib"]);
	if (txt === null) return { rx: 0, tx: 0 };
	return parseNetstatIb(txt);
}

function readDiskDarwin(): { read: number; write: number } {
	const txt = execText("ioreg", [
		"-r",
		"-c",
		"IOBlockStorageDriver",
		"-k",
		"Statistics",
		"-d",
		"1",
	]);
	if (txt === null) return { read: 0, write: 0 };
	return parseIoreg(txt);
}

export function createCollector(): Collector {
	let lastCpu = readCpuTimes();
	let lastNet = readNet();
	let lastDisk = readDisk();
	// Use the monotonic clock (performance.now) instead of Date.now(): when the
	// system clock is stepped back or forward by NTP/manually, Date.now() makes dt
	// negative or huge, which jitters rates and CPU%. Only differences are used,
	// so the epoch doesn't matter.
	let lastTime = performance.now();

	const collect = (): Snapshot => {
		const now = performance.now();
		const dt = Math.max(1, now - lastTime) / 1000;

		const cpu = readCpuTimes();
		const cpuDelta = cpu.total - lastCpu.total;
		const busyDelta = cpu.busy - lastCpu.busy;
		// When counters wrap/reset the delta can go non-positive; keep 0 and rebuild the baseline
		let cpuPct = 0;
		if (cpuDelta > 0 && busyDelta >= 0) {
			cpuPct = Math.min(100, Math.max(0, (100 * busyDelta) / cpuDelta));
		}

		const net = readNet();
		const disk = readDisk();
		const rxBps = Math.max(0, (net.rx - lastNet.rx) / dt);
		const txBps = Math.max(0, (net.tx - lastNet.tx) / dt);
		const readBps = Math.max(0, (disk.read - lastDisk.read) / dt);
		const writeBps = Math.max(0, (disk.write - lastDisk.write) / dt);

		const { used, total } = readMem();
		const cpuTemp = IS_DARWIN ? readCpuTempDarwin() : readCpuTempLinux();

		lastCpu = cpu;
		lastNet = net;
		lastDisk = disk;
		lastTime = now;

		const [l1 = 0, l5 = 0, l15 = 0] = os.loadavg();

		return {
			cpuPct,
			cpuTemp,
			memUsed: used,
			memTotal: total,
			memPct: total > 0 ? (100 * used) / total : 0,
			load1: l1,
			load5: l5,
			load15: l15,
			rxBps,
			txBps,
			// Cumulative values are raw counter readings (not rates), unaffected by dt, so take them directly
			rxTotal: net.rx,
			txTotal: net.tx,
			readBps,
			writeBps,
		};
	};

	return { collect };
}

export function fmtBytes(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0B";
	const u = ["B", "K", "M", "G", "T"];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < u.length - 1) {
		v /= 1024;
		i++;
	}
	// Clamp at T: a counter glitch/overflow yields values like `1e308`,
	// and toFixed would then spit out 20+ characters (e.g. `9.094947017729282e+295T`).
	// That text goes straight into the floating readout box — a width blowup
	// would wreck the whole box.
	if (i === u.length - 1 && v >= 1000) return ">999T";
	return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${u[i]}`;
}

export function fmtRate(bps: number): string {
	return `${fmtBytes(bps)}/s`;
}
