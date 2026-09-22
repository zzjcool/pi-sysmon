/**
 * Unit tests for metrics.ts — the macOS (darwin) collection paths.
 *
 * Why this file exists: `metrics.ts` used to read only /proc, so on macOS every
 * counter silently degraded to 0 (`cpuPct`/`memUsed`/`rxBps`/`readBps` all 0) and
 * the charts drew flat lines. The darwin path is therefore built around **pure
 * parser functions** that take command output as a string: the exact output that
 * matters (`vm_stat`, `netstat -ib`, `iostat`, `ioreg`) is captured as fixtures
 * below, so the parsing is verified off-line and does not need the real commands
 * (or macOS) to run. A couple of darwin-only smoke tests then confirm the live
 * wiring end to end.
 *
 * Run: node --experimental-strip-types --test 'test/metrics.test.ts'
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { fsyncSync, openSync, closeSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCollector,
	parseIoreg,
	parseIostat,
	parseNetstatIb,
	parseVmStat,
	vmStatUsedBytes,
} from "../src/metrics.ts";

const isDarwin = process.platform === "darwin";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Fixtures — trimmed but byte-accurate copies of real command output   */
/* ------------------------------------------------------------------ */

/** `vm_stat` on Apple Silicon (16 KiB pages), including the header line that
 *  carries the page size and both pages/counts and unrelated "Pages …" rows. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4430.
Pages active:                                 751091.
Pages inactive:                               749576.
Pages speculative:                               615.
Pages throttled:                                   0.
Pages wired down:                             207285.
Pages purgeable:                               28758.
"Translation faults":                    12817858289.
Pages copy-on-write:                       372446011.
Pages stored in compressor:                   825948.
Pages occupied by compressor:                 331661.
Decompressions:                               16520194.
Compressions:                                 28164832.
`;

/** `netstat -ib` — the shape that bites: one row per interface *plus* one row per
 *  address (same counters, errors shown as `-`), plus interfaces we skip. */
const NETSTAT_IB = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                      34015897     0 28790372335 34015897     0 28790372335     0
lo0        16384 127           localhost       34015897     - 28790372335 34015897     - 28790372335     -
en0        1500  <Link#14>   f2:ae:70:4b:66:79 63307213     0 51277090577 41595030     0 16701331635     0
en0        1500  zzjs-macboo fe80:e::1c2f:441d 63307213     - 51277090577 41595030     - 16701331635     -
en0        1500  192.168.8     192.168.8.118   63307213     - 51277090577 41595030     - 16701331635     -
awdl0      1500  <Link#16>   76:3d:d5:12:1d:f2   468613     0  627369265   331649     0  107570014     0
utun1      1380  <Link#19>                            0     0          0   146609     0   29703870     0
docker0    1500  <Link#99>                            0     0          0        0     0          0     0
br-abc123  1500  <Link#98>                            0     0          0        0     0          0     0
veth1234   1500  <Link#97>                            0     0          0        0     0          0     0
`;

/** `iostat -c 2`: device columns first, then the CPU block, then load. */
const IOSTAT_LOAD = `              disk0               disk5       cpu    load average
    KB/t  tps  MB/s     KB/t  tps  MB/s  us sy id   1m   5m   15m
   12.47   58  0.71    44.09    0  0.00   6  3 91  1.00 2.00 3.00
  204.20   81 16.21     0.00    0  0.00   9  3 89  1.10 2.10 3.10
`;

/** `iostat -C -d -c 2`: no load-average columns at all. */
const IOSTAT_NOLOAD = `              disk0               disk5       cpu
    KB/t  tps  MB/s     KB/t  tps  MB/s  us sy id
   12.47   58  0.71    44.09    0  0.00   6  3 91
   10.00    2  0.02     0.00    0  0.00  12  6 82
`;

/** A 4-column CPU block (`us ni sy id`) — must not break the loader. */
const IOSTAT_NICE = `              disk0       cpu    load average
    KB/t  tps  MB/s  us ni sy id   1m   5m   15m
   12.47   58  0.71  6  1  3 90  1.00 2.00 3.00
   10.00    2  0.02  1  1  2 96  1.10 2.10 3.10
`;

/** `ioreg -r -c IOBlockStorageDriver -k Statistics -d 1` — two drivers. */
const IOREG = `+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x100000a28, registered, matched, active, busy 0 (14 ms), retain 7>
    {
      "IOClass" = "IOBlockStorageDriver"
      "Statistics" = {"Operations (Write)"=909,"Latency Time (Write)"=0,"Bytes (Read)"=3394316288,"Errors (Write)"=0,"Total Time (Read)"=101046443060,"Latency Time (Read)"=0,"Retries (Read)"=0,"Errors (Read)"=0,"Total Time (Write)"=1232071199,"Bytes (Write)"=4335616,"Operations (Read)"=23043,"Retries (Write)"=0}
      "IOMatchedAtBoot" = Yes
    }

+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x1000009b5, registered, matched, active, busy 0 (91 ms), retain 8>
    {
      "IOClass" = "IOBlockStorageDriver"
      "Statistics" = {"Operations (Write)"=199308717,"Bytes (Read)"=1594539950080,"Errors (Write)"=0,"Bytes (Write)"=2001819619328,"Operations (Read)"=82290967}
      "IOMatchedAtBoot" = Yes
    }
`;

/* ------------------------------------------------------------------ */
/* 1. parseVmStat — page counts + page size discovery                   */
/* ------------------------------------------------------------------ */

test("parseVmStat: reads the six page counters and the header's page size", () => {
	const v = parseVmStat(VM_STAT);
	assert.equal(v.pageSize, 16384);
	assert.equal(v.free, 4430);
	assert.equal(v.active, 751091);
	assert.equal(v.inactive, 749576);
	assert.equal(v.speculative, 615);
	assert.equal(v.wired, 207285);
	// "Pages occupied by compressor" (the compressor's RAM footprint), not
	// "Pages stored in compressor" (the uncompressed size) — the former is what
	// top's "compressor" figure reflects.
	assert.equal(v.compressed, 331661);
});

test("parseVmStat: an explicit pageSize overrides the header", () => {
	assert.equal(parseVmStat(VM_STAT, 4096).pageSize, 4096);
});

test("parseVmStat: falls back to 4096 when the page-size header is absent", () => {
	const v = parseVmStat("Pages free: 10.\nPages active: 20.\n");
	assert.equal(v.pageSize, 4096);
	assert.equal(v.free, 10);
	assert.equal(v.active, 20);
	assert.equal(v.inactive, 0);
});

test("parseVmStat: tolerates empty / junk input", () => {
	const v = parseVmStat("");
	assert.equal(v.free, 0);
	assert.equal(v.compressed, 0);
	assert.equal(v.pageSize, 4096);
});

/* ------------------------------------------------------------------ */
/* 2. vmStatUsedBytes — the frozen used-memory formula                  */
/* ------------------------------------------------------------------ */

test("vmStatUsedBytes: used = total - (free + inactive + speculative) * pageSize", () => {
	const v = parseVmStat(VM_STAT);
	const total = 34359738368; // sysctl -n hw.memsize on a 32 GiB Mac
	// (4430 + 749576 + 615) * 16384 = 12363710464
	assert.equal(vmStatUsedBytes(v, v.pageSize, total), total - 12363710464);
});

test("vmStatUsedBytes: clamps to 0 when the reclaimable pages exceed total", () => {
	const v = parseVmStat(VM_STAT);
	assert.equal(vmStatUsedBytes(v, v.pageSize, 1024), 0);
});

/* ------------------------------------------------------------------ */
/* 3. parseNetstatIb — per-interface de-duplication                     */
/* ------------------------------------------------------------------ */

test("parseNetstatIb: sums each interface once, skipping lo0 and virtual bridges", () => {
	// en0 appears 3× (Link + 2 addresses) → counted once; awdl0 and utun1 are real
	// traffic and stay; lo0/docker0/br-/veth are excluded like Linux's lo/veth/docker/br-.
	const { rx, tx } = parseNetstatIb(NETSTAT_IB);
	assert.equal(rx, 51277090577 + 627369265);
	assert.equal(tx, 16701331635 + 107570014 + 29703870);
});

test("parseNetstatIb: when an interface repeats itself, the max row wins", () => {
	const txt = `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
eth9 1500 <Link#1> 1 0 100 2 0 50 0
eth9 1500 10.0.0.1   1 - 500 2 - 90 -
`;
	// Rows can differ mid-update; taking the max never under-counts.
	assert.deepEqual(parseNetstatIb(txt), { rx: 500, tx: 90 });
});

test("parseNetstatIb: empty/garbage input yields zeros, and `-` error columns still parse", () => {
	assert.deepEqual(parseNetstatIb(""), { rx: 0, tx: 0 });
	assert.deepEqual(parseNetstatIb("garbage\n1 2 3\n"), { rx: 0, tx: 0 });
	const dashed = `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
en1 1500 fe80::1 5 - 1234 6 - 4321 -
`;
	assert.deepEqual(parseNetstatIb(dashed), { rx: 1234, tx: 4321 });
});

/* ------------------------------------------------------------------ */
/* 4. parseIostat — CPU from the *second* sample                        */
/* ------------------------------------------------------------------ */

test("parseIostat: uses the 2nd sample (the 1st is the since-boot average)", () => {
	const c = parseIostat(IOSTAT_LOAD);
	assert.equal(c.us, 9);
	assert.equal(c.sy, 3);
	assert.equal(c.id, 89);
	assert.equal(c.ni, 0);
	assert.ok(Math.abs(c.busyPct - (100 * 12) / 101) < 1e-9);
});

test("parseIostat: works without load-average columns", () => {
	const c = parseIostat(IOSTAT_NOLOAD);
	assert.equal(c.us, 12);
	assert.equal(c.sy, 6);
	assert.equal(c.id, 82);
	assert.ok(Math.abs(c.busyPct - 18) < 1e-9);
});

test("parseIostat: tolerates an optional ni column", () => {
	const c = parseIostat(IOSTAT_NICE);
	assert.equal(c.us, 1);
	assert.equal(c.ni, 1);
	assert.equal(c.sy, 2);
	assert.equal(c.id, 96);
	assert.ok(Math.abs(c.busyPct - 4) < 1e-9);
});

test("parseIostat: junk input degrades to zeros instead of throwing", () => {
	assert.deepEqual(parseIostat(""), { us: 0, ni: 0, sy: 0, id: 0, busyPct: 0 });
	assert.deepEqual(parseIostat("no cpu here\n1 2 3\n"), {
		us: 0,
		ni: 0,
		sy: 0,
		id: 0,
		busyPct: 0,
	});
});

/* ------------------------------------------------------------------ */
/* 5. parseIoreg — cumulative disk bytes                                */
/* ------------------------------------------------------------------ */

test("parseIoreg: sums Bytes (Read)/Bytes (Write) across every driver", () => {
	const d = parseIoreg(IOREG);
	assert.equal(d.read, 3394316288 + 1594539950080);
	assert.equal(d.write, 4335616 + 2001819619328);
});

test("parseIoreg: no drivers → zeros", () => {
	assert.deepEqual(parseIoreg(""), { read: 0, write: 0 });
});

/* ------------------------------------------------------------------ */
/* 6. Live smoke tests (darwin only)                                    */
/* ------------------------------------------------------------------ */

test("darwin: a live collector reports real memory instead of zeros", { skip: !isDarwin }, async () => {
	const c = createCollector();
	await sleep(1100); // let the rate baselines settle
	const s = c.collect();
	assert.ok(s.memTotal > 0, `memTotal ${s.memTotal}`);
	assert.ok(s.memUsed > 0, `memUsed ${s.memUsed}`);
	assert.ok(s.memPct > 0 && s.memPct <= 100, `memPct ${s.memPct}`);
	// memTotal must come from hw.memsize, not a /proc fallback.
	assert.equal(s.memTotal, Number(execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).trim()));
});

test("darwin: cumulative network counters are non-zero and monotonic", { skip: !isDarwin }, async () => {
	const c = createCollector();
	await sleep(200);
	const a = c.collect();
	await sleep(200);
	const b = c.collect();
	assert.ok(a.rxTotal > 0, `rxTotal ${a.rxTotal}`);
	assert.ok(b.rxTotal >= a.rxTotal);
	assert.ok(b.txTotal >= a.txTotal);
});

test("darwin: cpuPct lands in 0..100 and reacts to induced load", { skip: !isDarwin }, async () => {
	const c = createCollector();
	await sleep(1100);
	const idle = c.collect();
	assert.ok(idle.cpuPct >= 0 && idle.cpuPct <= 100, `cpuPct ${idle.cpuPct}`);

	// Two spinning children for ~1.5s: enough busy ticks that a 0% reading would
	// mean the counter path is broken, on any core count.
	const code = "const t=Date.now();while(Date.now()-t<1500);";
	const procs = [0, 1].map(() => spawn(process.execPath, ["-e", code], { stdio: "ignore" }));
	await sleep(900);
	const busy = c.collect();
	await Promise.all(procs.map((p) => new Promise((r) => p.on("exit", r))));
	assert.ok(busy.cpuPct > 0, `cpuPct under load ${busy.cpuPct}`);
	assert.ok(busy.cpuPct <= 100, `cpuPct under load ${busy.cpuPct}`);
});

test("darwin: induced disk writes show up as writeBps", { skip: !isDarwin }, async () => {
	const c = createCollector();
	await sleep(300);
	c.collect(); // establish the cumulative baseline
	const f = join(tmpdir(), `sysmon-disk-${process.pid}.bin`);
	const fd = openSync(f, "w");
	try {
		writeSync(fd, Buffer.alloc(16 * 1024 * 1024, 7));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		execFileSync("sync", []);
	} catch {
		/* sync is best-effort */
	}
	// ioreg updates promptly, but allow a few ticks in case the driver batches.
	let writeBps = 0;
	for (let i = 0; i < 5 && writeBps <= 0; i++) {
		await sleep(200);
		writeBps = c.collect().writeBps;
	}
	unlinkSync(f);
	assert.ok(writeBps > 0, `writeBps ${writeBps}`);
});

test("darwin: os.cpus() counters and iostat's 2nd sample agree", { skip: !isDarwin }, async () => {
	// The CPU path uses os.cpus() because `iostat -c 2` blocks for a full second
	// (its default -w 1) and would stall the render loop every tick. This pin says
	// the two sources measure the same thing, so the substitution is sound.
	const sum = () => {
		let total = 0;
		let busy = 0;
		for (const cpu of os.cpus()) {
			const t = cpu.times;
			const b = t.user + t.nice + t.sys + (t.irq ?? 0);
			total += b + t.idle;
			busy += b;
		}
		return { total, busy };
	};
	const a = sum();
	const iostatPct = parseIostat(
		execFileSync("iostat", ["-c", "2"], { encoding: "utf8", timeout: 5000 }),
	).busyPct;
	const b = sum();
	const osPct = (100 * (b.busy - a.busy)) / (b.total - a.total);
	assert.ok(
		Math.abs(osPct - iostatPct) < 15,
		`os.cpus ${osPct.toFixed(1)}% vs iostat ${iostatPct.toFixed(1)}%`,
	);
});
