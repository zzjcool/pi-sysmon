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
 * `parseIostat` is still implemented (and tested) per the frozen plan, and is
 * used as the CPU fallback should os.cpus() ever be unusable.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";

const IS_DARWIN = process.platform === "darwin";
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
 * Used memory, following macOS `top`'s PhysMem semantics: pages that are free,
 * inactive or speculative are treated as reclaimable, so
 * `used = total - (free + inactive + speculative)`.
 * (The frozen plan specifies exactly this formula; note it runs higher than
 * top's own "used" figure, which also subtracts the compressor's footprint.)
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
		if (tokens.length < 8) continue;
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

		lastCpu = cpu;
		lastNet = net;
		lastDisk = disk;
		lastTime = now;

		const [l1 = 0, l5 = 0, l15 = 0] = os.loadavg();

		return {
			cpuPct,
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
