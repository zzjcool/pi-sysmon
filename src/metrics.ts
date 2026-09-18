/**
 * Minimal system metrics collector — pure Node, no third-party dependencies.
 * Reads /proc on Linux; degrades to whatever os.* offers elsewhere.
 */
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";

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
