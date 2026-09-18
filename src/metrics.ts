/**
 * 最小系统指标采集器 —— 纯 Node，无第三方依赖。
 * Linux 上读 /proc；非 Linux 退化为 os.* 可用项。
 */
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";

/** 扇区字节数：/proc/diskstats 的 sectors 单位。不同设备可能不是 512，需按块设备实际值探测。
 *  返回每块盘的 Map（而非单一值），以处理同时挂 512/4K 盘的混合场景。 */
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
				/* 该盘无此属性，忽略 */
			}
		}
	} catch {
		/* 非 Linux 或 /sys 不可读 */
	}
	return sizes;
}

const SECTOR_SIZES = detectSectorSizes();
/** 探测不到时的回退值：psutil/bottom 均把 512 当作 Linux 事实常量。 */
const FALLBACK_SECTOR_SIZE = 512;

function sectorSizeFor(dev: string): number {
	return SECTOR_SIZES.get(dev) ?? FALLBACK_SECTOR_SIZE;
}

export interface Snapshot {
	cpuPct: number;
	memUsed: number;
	memTotal: number;
	memPct: number;
	/** 1/5/15 分钟平均负载（bottom 的 CPU 标题栏展示这三个值） */
	load1: number;
	load5: number;
	load15: number;
	rxBps: number;
	txBps: number;
	/** 累计流量（bottom 的 "All:" 列） */
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
		return { total: 0, busy: 0 }; // 非 Linux / 不可读：退化为零值，不影响扩展加载
	}
}

function readMem(): { used: number; total: number } {
	try {
		const txt = readFileSync("/proc/meminfo", "utf8");
		// 固定 key 查表，避免动态构造正则
		const raw = new Map<string, number>();
		for (const line of txt.split("\n")) {
			const i = line.indexOf(":");
			if (i <= 0) continue;
			const v = Number.parseInt(line.slice(i + 1).trim(), 10);
			if (Number.isFinite(v)) raw.set(line.slice(0, i), v);
		}
		const grab = (k: string) => (raw.get(k) ?? 0) * 1024;
		const total = grab("MemTotal");
		// MemAvailable 比 MemFree 更接近 bottom/htop 口径
		const available = grab("MemAvailable") || grab("MemFree");
		if (total <= 0) return { used: 0, total: os.totalmem() };
		return { used: Math.max(0, total - available), total };
	} catch {
		// 非 Linux 回退到 os.totalmem，used 无可靠来源则记 0
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
		/* 非 Linux：返回零值 */
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
			// 只看物理盘，跳过分区（分区会重复计数）
			if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)$/.test(name))
				continue;
			const r = Number(f[5]); // sectors read
			const w = Number(f[9]); // sectors written
			const ss = sectorSizeFor(name); // 逐盘扇区大小，避免混合盘低估/高估
			if (Number.isFinite(r)) read += r * ss;
			if (Number.isFinite(w)) write += w * ss;
		}
	} catch {
		/* 非 Linux：返回零值 */
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
	// 用单调时钟（performance.now）而非 Date.now()：系统时钟被 NTP/手动回拨或前跳时，
	// Date.now() 会让 dt 变成负数或巨大值，导致速率/CPU% 抖动。只取差值，故基准无所谓。
	let lastTime = performance.now();

	const collect = (): Snapshot => {
		const now = performance.now();
		const dt = Math.max(1, now - lastTime) / 1000;

		const cpu = readCpuTimes();
		const cpuDelta = cpu.total - lastCpu.total;
		const busyDelta = cpu.busy - lastCpu.busy;
		// counter 回绕/重置时 delta 可能非正，此时保持 0 并重建基线
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
			// 累计值是计数器原始读数（不是速率），不受 dt 影响，可直接取用
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
	// 超过 T 就夹住：计数器异常/溢出时会得到 `1e308` 这种值，
	// 走 toFixed 会吐出 20+ 个字符（如 `9.094947017729282e+295T`），
	// 而这段文本会直接进浮动读数框 —— 宽度暴涨会把框整块挤坏。
	if (i === u.length - 1 && v >= 1000) return ">999T";
	return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${u[i]}`;
}

export function fmtRate(bps: number): string {
	return `${fmtBytes(bps)}/s`;
}
