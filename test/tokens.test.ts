/**
 * Unit tests for tokens.ts — node:test + node:assert
 * Run: node --experimental-strip-types --test 'test/tokens.test.ts'
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	estimateDeltaTokens,
	createTpsMeter,
	fmtTps,
	FMT_TPS_MAX,
	type TokenDelta,
} from "../src/tokens.ts";

/** Shortcut to build a TokenDelta (kind doesn't affect estimation, use "text") */
const D = (delta: string): TokenDelta => ({ kind: "text", delta });

/* ------------------------------------------------------------------ */
/* 1. estimateDeltaTokens                                               */
/* ------------------------------------------------------------------ */

test("estimate: pure ASCII ≈ len/4 (rounded up)", () => {
	assert.equal(estimateDeltaTokens("abcd"), 1);
	assert.equal(estimateDeltaTokens("abcde"), 2); // ceil(5/4)
	assert.equal(estimateDeltaTokens("a".repeat(400)), 100);
	assert.equal(estimateDeltaTokens("hello world"), 3); // ceil(11/4)
});

test("estimate: pure Chinese == character count (1 token per char)", () => {
	assert.equal(estimateDeltaTokens("你好世界"), 4);
	assert.equal(estimateDeltaTokens("中文输出不应该被低估四倍"), 12);
});

test("estimate: every CJK range (kana/hangul/punctuation/ideographic space) counts as 1 token", () => {
	assert.equal(estimateDeltaTokens("こんにちは"), 5); // U+3040-30FF
	assert.equal(estimateDeltaTokens("안녕하세요"), 5); // U+AC00-D7AF
	assert.equal(estimateDeltaTokens("　"), 1); // U+3000 表意空格
	assert.equal(estimateDeltaTokens("。"), 1); // U+3002 CJK 句号
	assert.equal(estimateDeltaTokens("豈"), 1); // U+F900 兼容表意文字
});

test("estimate: mixed CJK/ASCII = ceil(others/4) + CJK", () => {
	// "ab中文cd" → 4 other chars → 1, CJK 2 → 3 total
	assert.equal(estimateDeltaTokens("ab中文cd"), 3);
});

test("estimate: empty string == 0", () => {
	assert.equal(estimateDeltaTokens(""), 0);
});

test("estimate: pure whitespace also counts 4 chars as 1 token, no crash", () => {
	assert.equal(estimateDeltaTokens("    "), 1);
	assert.equal(estimateDeltaTokens("\n\t\r "), 1);
});

test("estimate: emoji / astral characters don't crash and produce finite results", () => {
	const r = estimateDeltaTokens("🎉🎉🎉🎉");
	assert.ok(Number.isFinite(r));
	// Pin the exact value: 4 emoji = 4 **code points** → ceil(4/4)=1.
	// If the implementation iterated UTF-16 code units (length), emoji would
	// count as 2 — a test that only asserted `r >= 1` would miss that regression.
	assert.equal(r, 1, "emoji must be counted by code point (for..of), not UTF-16 code units");
});

test("estimate: very long string (100k chars) returns a finite number", () => {
	const long = "汉字abc".repeat(25000); // 100k code points
	const r = estimateDeltaTokens(long);
	assert.ok(Number.isFinite(r), "result must be finite");
	assert.equal(r, Math.ceil(75000 / 4) + 50000); // 2 CJK + 3 ASCII per repeat
});

/* ------------------------------------------------------------------ */
/* 2. TpsMeter                                                          */
/* ------------------------------------------------------------------ */

test("meter: tick after add returns the expected tps", () => {
	const m = createTpsMeter(0);
	m.add(D("a".repeat(400))); // 100 tokens
	const { tps, tokens } = m.tick(1000); // dt = 1000ms
	assert.equal(tokens, 100);
	assert.equal(tps, 100); // 100 tok / 1s
});

test("meter: dt math is exact with an injected clock", () => {
	const m = createTpsMeter(1000);
	m.add(D("a".repeat(400))); // 100 tokens
	const { tps } = m.tick(1250); // dt = 250ms → 100 * 1000 / 250 = 400
	assert.equal(tps, 400);
});

test("meter: tick clears the bucket — a second tick with no add is 0", () => {
	const m = createTpsMeter(0);
	m.add(D("中文"));
	const first = m.tick(100);
	assert.equal(first.tokens, 2);
	const second = m.tick(200);
	assert.equal(second.tokens, 0);
	assert.equal(second.tps, 0);
});

test("meter: two consecutive ticks never return NaN/Infinity", () => {
	const m = createTpsMeter(0);
	for (let t = 0; t <= 500; t += 100) {
		const r = m.tick(t);
		assert.ok(Number.isFinite(r.tps), `t=${t} tps must be finite`);
		assert.ok(Number.isFinite(r.tokens));
	}
});

test("meter: dtMs<=0 doesn't divide by zero, still drains the bucket and doesn't corrupt the base", () => {
	const m = createTpsMeter(100);
	m.add(D("a".repeat(40))); // 10 tokens
	// Clock rollback: dt = -50
	const r1 = m.tick(50);
	assert.equal(r1.tps, 0);
	assert.equal(r1.tokens, 10);
	// Repeated tick at the same millisecond: dt = 0
	m.add(D("中文"));
	const r2 = m.tick(50);
	assert.equal(r2.tps, 0);
	assert.equal(r2.tokens, 2);
	// The base should have advanced to 50; the math for the next normal dt stays correct
	m.add(D("a".repeat(400))); // 100 tokens
	const r3 = m.tick(150); // dt = 100ms → 1000 tps
	assert.equal(r3.tps, 1000);
});

test("meter: non-finite clock never produces NaN/Infinity", () => {
	const m = createTpsMeter(0);
	m.add(D("abcd"));
	const r = m.tick(Number.NaN);
	assert.equal(r.tps, 0);
	assert.equal(r.tokens, 1);
	assert.ok(Number.isFinite(r.tps));
});

test("meter: pending() reflects the accumulation of the unclosed bucket", () => {
	const m = createTpsMeter(0);
	assert.equal(m.pending(), 0);
	m.add(D("中文")); // 2
	assert.equal(m.pending(), 2);
	m.add(D("a".repeat(40))); // 10
	assert.equal(m.pending(), 12);
	m.tick(100);
	assert.equal(m.pending(), 0);
});

test("meter: kind doesn't affect accumulation (thinking/toolcall count too)", () => {
	const m = createTpsMeter(0);
	m.add({ kind: "thinking", delta: "思考" });
	m.add({ kind: "toolcall", delta: "a".repeat(40) });
	assert.equal(m.pending(), 2 + 10);
});

/* ------------------------------------------------------------------ */
/* 3. fmtTps                                                            */
/*                                                                     */
/* Hard constraints: width must have an upper bound (an overly wide    */
/* rendered line makes pi crash and exit), and scientific notation /   */
/* "NaN" must never appear.                                            */
/* ------------------------------------------------------------------ */

const MAX_TITLE_LEN = 16;

// Note: this is the **compact** format (`t/s`, not ` tok/s`).
// With the spelled-out unit (`1.5K tok/s`), the whole reading would
// vanish in the narrowest block width (24 cols) of a 4-up layout
// (measured: it disappears at tps≥1000), so it was changed to the
// compact form matching the y-axis ticks.
test("fmtTps: normal values", () => {
	assert.equal(fmtTps(0), "0t/s");
	assert.equal(fmtTps(1), "1t/s");
	assert.equal(fmtTps(999), "999t/s");
	assert.equal(fmtTps(1500), "1.5Kt/s");
	assert.equal(fmtTps(12300), "12.3Kt/s");
	// ≥100K drops the decimal (any longer is pointless)
	assert.equal(fmtTps(150_000), "150Kt/s");
});

test("fmtTps: extreme values clamp to >999Kt/s", () => {
	assert.equal(fmtTps(1e6), ">999Kt/s");
	assert.equal(fmtTps(1e12), ">999Kt/s");
	// Boundary: 999999 rounds up to 1000K — must fall back to the clamp,
	// never emit `1000Kt/s`
	assert.equal(fmtTps(999_999), ">999Kt/s");
});

test("fmtTps: rounding at one decimal must not exceed FMT_TPS_MAX (regression)", () => {
	// A real bug we hit: the check used `k < 100` (the value **before** rounding),
	// but at k=99.95 `toFixed(1)` rounds up to `100.0` — 9 columns,
	// both over the compact budget (`FMT_TPS_MAX=8`) and wider than the value
	// it just crossed (breaking monotonicity).
	//
	// Now it looks at the length **after formatting**: if one decimal doesn't
	// fit, it falls back to an integer.
	assert.equal(fmtTps(99950), "100Kt/s", "99.95K must drop to integer form after rounding up");
	assert.equal(fmtTps(99999), "100Kt/s");
	// The adjacent value still uses one decimal (so we didn't degrade the whole range)
	assert.equal(fmtTps(99949), "99.9Kt/s");
	// The real invariant: no input may exceed FMT_TPS_MAX
	for (let e = 0; e <= 8; e++) {
		for (const m of [1, 1.5, 6.7, 9.99, 99, 99.9, 99.95, 100, 150, 670, 999]) {
			const v = m * 10 ** e;
			if (!Number.isFinite(v)) continue;
			const s = fmtTps(v);
			assert.ok(
				s.length <= FMT_TPS_MAX,
				`fmtTps(${v})="${s}" exceeds ${FMT_TPS_MAX} columns (the reading would vanish in narrow blocks)`,
			);
		}
	}
});

test("fmtTps: invalid inputs become zero", () => {
	assert.equal(fmtTps(Number.NaN), "0t/s");
	assert.equal(fmtTps(Number.POSITIVE_INFINITY), "0t/s");
	assert.equal(fmtTps(-5), "0t/s");
});

test("fmtTps: all inputs are width-bounded and contain no scientific notation / NaN", () => {
	for (const v of [
		0,
		1,
		999,
		1500,
		1e6,
		1e12,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-5,
	]) {
		const s = fmtTps(v);
		assert.ok(
			s.length <= MAX_TITLE_LEN,
			`fmtTps(${v})="${s}" is too long (${s.length})`,
		);
		assert.ok(!s.includes("e+"), `fmtTps(${v})="${s}" contains scientific notation`);
		assert.ok(!s.includes("NaN"), `fmtTps(${v})="${s}" contains NaN`);
		assert.ok(!s.includes("Infinity"), `fmtTps(${v})="${s}" contains Infinity`);
	}
});

/* ------------------------------------------------------------------ */
/* 4. Disable/reenable semantics (a pure-function-level reproduction    */
/*    of index.ts's stop() drain patch)                                 */
/* ------------------------------------------------------------------ */

test("meter: tokens accumulated while disabled are drained at stop-drain, no fake spike on the first frame after re-enable", () => {
	// This reproduces the semantics of the line
	// `tpsTotal += tpsMeter.tick(...).tokens` in index.ts's `stop()`.
	// A bug we measured: while the widget is closed for 30s events keep
	// accumulating, and the **first tick** after re-enabling reports the
	// whole backlog as "this second's rate" (measured 6000 tok/s when the
	// true rate was near 0).
	//
	// index.ts itself isn't unit-testable (it's the pi extension entry),
	// but the semantics live entirely in this tick contract, so we pin the
	// full sequence here: add → tick → add(disabled) → tick(stop) → add → tick(reenabled).
	const m = createTpsMeter(0);
	m.add(D("a".repeat(400))); // ≈100 tokens, while running
	const normal = m.tick(1000);
	assert.equal(normal.tokens, 100);
	assert.equal(normal.tps, 100);

	m.add(D("b".repeat(400))); // ≈100 tokens, arrives **while disabled** (events keep coming)
	const drain = m.tick(30_000); // stop()'s drain: tick only after 30s
	assert.equal(drain.tokens, 100, "disabled-period tokens must be counted in the total (taken by the drain)");

	m.add(D("abcd")); // only 1 token after re-enable
	const first = m.tick(31_000); // first frame after re-enable
	assert.equal(first.tokens, 1, "old tokens must not be counted twice");
	assert.ok(
		first.tps <= 1,
		`first frame after re-enable must not be a fake spike, got ${first.tps} (uncleared backlog would give ~100)`,
	);
});

test("meter: add tolerates bad input and never throws (external events have no type guarantee)", () => {
	// `add()`'s contract is "never throw": it runs on the agent-loop's await
	// chain, and throwing would break the streaming main flow. The event side
	// has no type guarantee, so it must be defensive.
	const m = createTpsMeter(0);
	assert.doesNotThrow(() => {
		m.add(null as unknown as TokenDelta);
		m.add({ kind: "text", delta: undefined as unknown as string });
		m.add({ kind: "text", delta: 42 as unknown as string });
	});
	assert.equal(m.pending(), 0, "bad input must not contribute tokens");
	assert.equal(estimateDeltaTokens(undefined as unknown as string), 0);
	assert.equal(estimateDeltaTokens(null as unknown as string), 0);
});
