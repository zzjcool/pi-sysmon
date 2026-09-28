/**
 * perf bench — measures where chart-mode time actually goes.
 *
 * Run: node --experimental-strip-types scripts/bench-perf.mjs
 * (macOS; darwin paths are the slow ones worth measuring)
 */
import { performance } from "node:perf_hooks";
import { createCollector } from "../src/metrics.ts";
import { buildBlocks } from "../src/blocks.ts";
import {
	computeLayout,
	renderPanel,
	renderBlock,
} from "../src/chart-panel.ts";

const N = Number(process.argv[2] ?? 20);
const W = Number(process.argv[3] ?? 150);
const theme = {
	fg: (color, text) => text, // plain: exclude ANSI work? no — paint still runs; fg is the color fn
};

function bench(name, fn, n = N) {
	// warmup
	fn();
	const t0 = performance.now();
	for (let i = 0; i < n; i++) fn();
	const ms = (performance.now() - t0) / n;
	console.log(`${name.padEnd(42)} ${ms.toFixed(2)} ms/op`);
	return ms;
}

console.log(`— import cost / first-sample —`);
const t0 = performance.now();
const c = createCollector();
console.log(`createCollector() (incl. baseline reads)   ${(performance.now() - t0).toFixed(2)} ms`);

let snap = c.collect();
bench("collect() #1 (cold)", () => {}, 1);
const t1 = performance.now();
snap = c.collect();
console.log(`collect() #2 (warm darwin path)           ${(performance.now() - t1).toFixed(2)} ms`);

console.log(`\n— render pipeline at ${W} cols —`);
// history: 60s @1s
const pts = 60;
const hist = {
	cpu: Array.from({ length: pts }, (_, i) => 20 + 10 * Math.sin(i / 5)),
	cpuTemp: Array.from({ length: pts }, () => 55),
	mem: Array.from({ length: pts }, (_, i) => 50 + 5 * Math.cos(i / 7)),
	netRx: Array.from({ length: pts }, (_, i) => 1e5 * (1 + Math.sin(i))),
	netTx: Array.from({ length: pts }, (_, i) => 5e4 * (1 + Math.cos(i / 2))),
	diskR: Array.from({ length: pts }, () => 1e4),
	diskW: Array.from({ length: pts }, () => 2e4),
	tps: Array.from({ length: pts }, (_, i) => 50 * (1 + Math.sin(i / 3))),
	sessHit: Array.from({ length: pts }, () => 80),
};
for (let i = 0; i < 4000 - pts; i++) {
	// fill to cap-ish
	hist.cpu.push(30);
	hist.netRx.push(1e5);
	hist.netTx.push(5e4);
	hist.mem.push(55);
	hist.tps.push(60);
	hist.sessHit.push(80);
	hist.cpuTemp.push(50);
	hist.diskR.push(1e4);
	hist.diskW.push(2e4);
}

const opts = { points: pts, showTokens: true, labelMode: "title" };

let blocks = buildBlocks(hist, snap, opts);
const layout = computeLayout(W, 6, blocks.length, 18);
bench("buildBlocks (4 blocks, tail slice)", () => {
	blocks = buildBlocks(hist, snap, opts);
});

bench("computeLayout", () => computeLayout(W, 6, blocks.length, 18));

let panel;
bench(`renderPanel @${W}c (4 blocks)`, () => {
	panel = renderPanel(theme, blocks, W, layout, 60);
});

// isolate renderBlock
bench("renderBlock CPU (1 block @36c)", () => {
	renderBlock(theme, blocks[0], 36, 6, 60);
});
bench("renderBlock Network (2 series @36c)", () => {
	renderBlock(theme, blocks[2], 36, 6, 60);
});

// braille cost inside renderBlock: renderChartGlyphs is the bulk
import { renderChartGlyphs } from "../src/braille.ts";
const netSeries = blocks[2].series.map((s) => ({ label: "n", values: s.values }));
bench("renderChartGlyphs (2 series, 72 subW x 24 subH)", () => {
	renderChartGlyphs(netSeries, 34, 6, 5000, { slots: 60 });
});

// CPU temp series makes CPU block 2 series too
const cpuSeries = blocks[0].series.map((s) => ({ label: "c", values: s.values }));
bench("renderChartGlyphs (1 series)", () => {
	renderChartGlyphs(cpuSeries, 34, 6, 5000, { slots: 60 });
});
