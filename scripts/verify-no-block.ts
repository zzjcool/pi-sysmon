/**
 * Manual timing proof for the nan0 fix — run with:
 *   node --experimental-strip-types scripts/verify-no-block.ts
 *
 * Drives the real collector (real commands, no seam) for ~10s at a 250ms
 * cadence — 4x the production rate — and asserts that NO SINGLE collect()
 * blocks the JS thread for >= 100ms. Before the fix, every collect() ran
 * `spawnSync(netstat -ib)` and blocked ~5000ms on a nan0-wedged host; the
 * whole point of the async sampler is that a wedged child costs zero main
 * thread time. Prints per-call max/avg and the network readings observed.
 */
import { createCollector, stopCpuTempDarwin } from "../src/metrics.ts";

const BUDGET_MS = 100; // a single collect() must never reach this
const TICK_MS = 250; // 4x the production 1s cadence
const ROUNDS = 40; // ~10s at 250ms
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const collector = createCollector();
let max = 0;
let sum = 0;
let readings = 0;
let spikes = 0; // collect() calls over budget

console.log(`collect() x${ROUNDS} @ ${TICK_MS}ms — budget ${BUDGET_MS}ms/call`);
for (let i = 0; i < ROUNDS; i++) {
	const t0 = performance.now();
	const s = collector.collect();
	const ms = performance.now() - t0;
	max = Math.max(max, ms);
	sum += ms;
	if (s.rxTotal > 0 || s.txTotal > 0) readings++;
	// The phantom the safeRate guard exists for: whole-boot traffic in one tick.
	if (s.rxBps > 10e9 || s.txBps > 10e9) spikes++;
	if (ms >= BUDGET_MS) {
		console.error(
			`FAIL: collect #${i} blocked ${ms.toFixed(1)}ms (>= ${BUDGET_MS}ms) — ` +
				`the sampler is doing synchronous work again`,
		);
		stopCpuTempDarwin();
		process.exit(1);
	}
	await sleep(TICK_MS);
}
stopCpuTempDarwin();

console.log(`max ${max.toFixed(1)}ms  avg ${(sum / ROUNDS).toFixed(1)}ms  budget ${BUDGET_MS}ms`);
console.log(`network readings landed: ${readings}/${ROUNDS} ticks`);
console.log(`rate spikes (>10GB/s): ${spikes}`);
if (spikes > 0) {
	console.error("FAIL: first-tick rate spike leaked through the safeRate guard");
	process.exit(1);
}
console.log("PASS: no collect() call blocked the main thread past the budget");
