/**
 * tokens.ts 单元测试 —— node:test + node:assert
 * 运行：node --experimental-strip-types --test 'test/tokens.test.ts'
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

/** 构造 TokenDelta 的快捷方式（kind 不影响估算，用 text 占位） */
const D = (delta: string): TokenDelta => ({ kind: "text", delta });

/* ------------------------------------------------------------------ */
/* 1. estimateDeltaTokens                                               */
/* ------------------------------------------------------------------ */

test("估算: 纯 ASCII ≈ len/4（向上取整）", () => {
	assert.equal(estimateDeltaTokens("abcd"), 1);
	assert.equal(estimateDeltaTokens("abcde"), 2); // ceil(5/4)
	assert.equal(estimateDeltaTokens("a".repeat(400)), 100);
	assert.equal(estimateDeltaTokens("hello world"), 3); // ceil(11/4)
});

test("估算: 纯中文 == 字符数（每字 1 token）", () => {
	assert.equal(estimateDeltaTokens("你好世界"), 4);
	assert.equal(estimateDeltaTokens("中文输出不应该被低估四倍"), 12);
});

test("估算: CJK 各区间（假名/谚文/标点/表意空格）都按 1 token", () => {
	assert.equal(estimateDeltaTokens("こんにちは"), 5); // U+3040-30FF
	assert.equal(estimateDeltaTokens("안녕하세요"), 5); // U+AC00-D7AF
	assert.equal(estimateDeltaTokens("　"), 1); // U+3000 表意空格
	assert.equal(estimateDeltaTokens("。"), 1); // U+3002 CJK 句号
	assert.equal(estimateDeltaTokens("豈"), 1); // U+F900 兼容表意文字
});

test("估算: 中英混合 = ceil(其他/4) + CJK", () => {
	// "ab中文cd" → 其他 4 字符 → 1，CJK 2 → 共 3
	assert.equal(estimateDeltaTokens("ab中文cd"), 3);
});

test("估算: 空串 == 0", () => {
	assert.equal(estimateDeltaTokens(""), 0);
});

test("估算: 纯空白也按 4 字符 1 token，不会崩", () => {
	assert.equal(estimateDeltaTokens("    "), 1);
	assert.equal(estimateDeltaTokens("\n\t\r "), 1);
});

test("估算: emoji / astral 字符不崩溃且结果有限", () => {
	const r = estimateDeltaTokens("🎉🎉🎉🎉");
	assert.ok(Number.isFinite(r));
	// 钉住精确值：4 个 emoji = 4 个**码点** → ceil(4/4)=1。
	// 若实现误按 UTF-16 码元（length）迭代，emoji 会算成 2 ——
	// 只写 `r >= 1` 的话这个回归不会被发现。
	assert.equal(r, 1, "emoji 应按码点计（for..of），不是按 UTF-16 码元");
});

test("估算: 超长字符串（100k 字符）返回有限数", () => {
	const long = "汉字abc".repeat(25000); // 100k 码点
	const r = estimateDeltaTokens(long);
	assert.ok(Number.isFinite(r), "结果必须有限");
	assert.equal(r, Math.ceil(75000 / 4) + 50000); // 2 CJK + 3 ASCII per repeat
});

/* ------------------------------------------------------------------ */
/* 2. TpsMeter                                                          */
/* ------------------------------------------------------------------ */

test("meter: add 后 tick 得到期望 tps", () => {
	const m = createTpsMeter(0);
	m.add(D("a".repeat(400))); // 100 tokens
	const { tps, tokens } = m.tick(1000); // dt = 1000ms
	assert.equal(tokens, 100);
	assert.equal(tps, 100); // 100 tok / 1s
});

test("meter: 注入时钟时 dt 数学精确", () => {
	const m = createTpsMeter(1000);
	m.add(D("a".repeat(400))); // 100 tokens
	const { tps } = m.tick(1250); // dt = 250ms → 100 * 1000 / 250 = 400
	assert.equal(tps, 400);
});

test("meter: tick 清桶 —— 无 add 的第二次 tick 为 0", () => {
	const m = createTpsMeter(0);
	m.add(D("中文"));
	const first = m.tick(100);
	assert.equal(first.tokens, 2);
	const second = m.tick(200);
	assert.equal(second.tokens, 0);
	assert.equal(second.tps, 0);
});

test("meter: 连续两次 tick 都不返回 NaN/Infinity", () => {
	const m = createTpsMeter(0);
	for (let t = 0; t <= 500; t += 100) {
		const r = m.tick(t);
		assert.ok(Number.isFinite(r.tps), `t=${t} tps 必须有限`);
		assert.ok(Number.isFinite(r.tokens));
	}
});

test("meter: dtMs<=0 不除零，仍清桶且不腐化基准", () => {
	const m = createTpsMeter(100);
	m.add(D("a".repeat(40))); // 10 tokens
	// 时钟回拨：dt = -50
	const r1 = m.tick(50);
	assert.equal(r1.tps, 0);
	assert.equal(r1.tokens, 10);
	// 同毫秒重复 tick：dt = 0
	m.add(D("中文"));
	const r2 = m.tick(50);
	assert.equal(r2.tps, 0);
	assert.equal(r2.tokens, 2);
	// 基准应已推进到 50，下一次正常 dt 的数学仍正确
	m.add(D("a".repeat(400))); // 100 tokens
	const r3 = m.tick(150); // dt = 100ms → 1000 tps
	assert.equal(r3.tps, 1000);
});

test("meter: 非有限时钟不除出 NaN/Infinity", () => {
	const m = createTpsMeter(0);
	m.add(D("abcd"));
	const r = m.tick(Number.NaN);
	assert.equal(r.tps, 0);
	assert.equal(r.tokens, 1);
	assert.ok(Number.isFinite(r.tps));
});

test("meter: pending() 反映未关闭桶的累积值", () => {
	const m = createTpsMeter(0);
	assert.equal(m.pending(), 0);
	m.add(D("中文")); // 2
	assert.equal(m.pending(), 2);
	m.add(D("a".repeat(40))); // 10
	assert.equal(m.pending(), 12);
	m.tick(100);
	assert.equal(m.pending(), 0);
});

test("meter: kind 不影响累积（thinking/toolcall 同样计入）", () => {
	const m = createTpsMeter(0);
	m.add({ kind: "thinking", delta: "思考" });
	m.add({ kind: "toolcall", delta: "a".repeat(40) });
	assert.equal(m.pending(), 2 + 10);
});

/* ------------------------------------------------------------------ */
/* 3. fmtTps                                                            */
/*                                                                     */
/* 硬约束：宽度必须有上界（超宽渲染行会让 pi 崩溃退出），               */
/* 且绝不出现科学计数法 / NaN 字样。                                    */
/* ------------------------------------------------------------------ */

const MAX_TITLE_LEN = 16;

// 注意：这里是**紧凑**格式（`t/s`，不是 ` tok/s`）。
// 之前用全写单位（`1.5K tok/s`）时，四图并排的最小块宽（24 列）里
// 整条读数会消失（实测 tps≥1000 就会），所以改成与 y 轴刻度同款的紧凑形。
test("fmtTps: 常规值格式", () => {
	assert.equal(fmtTps(0), "0t/s");
	assert.equal(fmtTps(1), "1t/s");
	assert.equal(fmtTps(999), "999t/s");
	assert.equal(fmtTps(1500), "1.5Kt/s");
	assert.equal(fmtTps(12300), "12.3Kt/s");
	// ≥100K 不再保留小数（再长没意义）
	assert.equal(fmtTps(150_000), "150Kt/s");
});

test("fmtTps: 极端值钳制在 >999Kt/s", () => {
	assert.equal(fmtTps(1e6), ">999Kt/s");
	assert.equal(fmtTps(1e12), ">999Kt/s");
	// 边界：999999 取整后会变成 1000K，必须落回钳制值而不能吐 `1000Kt/s`
	assert.equal(fmtTps(999_999), ">999Kt/s");
});

test("fmtTps: 一位小数的进位不得突破 FMT_TPS_MAX（回归）", () => {
	// 真实踩到的 bug：判断用的是 `k < 100`（进位**前**的值），
	// 但 k=99.95 时 `toFixed(1)` 会进位成 `100.0` —— 共 9 列，
	// 既超出紧凑预算（`FMT_TPS_MAX=8`），也比它刚跨过的那个值更宽（破坏单调性）。
	//
	// 现在改成看**格式化之后**的长度：一位小数放不下就退回整数。
	assert.equal(fmtTps(99950), "100Kt/s", "99.95K 进位后应降为整数形式");
	assert.equal(fmtTps(99999), "100Kt/s");
	// 紧邻的值仍用一位小数（说明不是把整个区间都降级了）
	assert.equal(fmtTps(99949), "99.9Kt/s");
	// 真正的不变式：任何输入都不得超过 FMT_TPS_MAX
	for (let e = 0; e <= 8; e++) {
		for (const m of [1, 1.5, 6.7, 9.99, 99, 99.9, 99.95, 100, 150, 670, 999]) {
			const v = m * 10 ** e;
			if (!Number.isFinite(v)) continue;
			const s = fmtTps(v);
			assert.ok(
				s.length <= FMT_TPS_MAX,
				`fmtTps(${v})="${s}" 超过 ${FMT_TPS_MAX} 列（会让窄块里的读数消失）`,
			);
		}
	}
});

test("fmtTps: 非法输入归零", () => {
	assert.equal(fmtTps(Number.NaN), "0t/s");
	assert.equal(fmtTps(Number.POSITIVE_INFINITY), "0t/s");
	assert.equal(fmtTps(-5), "0t/s");
});

test("fmtTps: 所有输入宽度有界且不含科学计数法/NaN", () => {
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
			`fmtTps(${v})="${s}" 超长 (${s.length})`,
		);
		assert.ok(!s.includes("e+"), `fmtTps(${v})="${s}" 含科学计数法`);
		assert.ok(!s.includes("NaN"), `fmtTps(${v})="${s}" 含 NaN`);
		assert.ok(!s.includes("Infinity"), `fmtTps(${v})="${s}" 含 Infinity`);
	}
});

/* ------------------------------------------------------------------ */
/* 4. 停用/重启用语义（index.ts 的 stop() 排水补丁的纯函数级复现）          */
/* ------------------------------------------------------------------ */

test("meter: 停用期累积的 token 在 stop-drain 时清走，重开后首帧无假尖峰", () => {
	// 这是 index.ts `stop()` 里那行 `tpsTotal += tpsMeter.tick(...).tokens`
	// 的语义复现。实测过的 bug：widget 关闭 30s 期间事件仍在累加，
	// 重新启用后的**第一个 tick** 会把积压全部当成「这一秒的速率」
	// 报出去（实测 6000 tok/s，真实值接近 0）。
	//
	// index.ts 本身不可单测（pi 扩展入口），但语义全在这个 tick 契约上，
	// 所以在这里把完整序列钉死：add → tick → add(停用期) → tick(stop) → add → tick(重开)。
	const m = createTpsMeter(0);
	m.add(D("a".repeat(400))); // ≈100 token，运行期
	const normal = m.tick(1000);
	assert.equal(normal.tokens, 100);
	assert.equal(normal.tps, 100);

	m.add(D("b".repeat(400))); // ≈100 token，落在**停用**期（事件照样来）
	const drain = m.tick(30_000); // stop() 的排水：30s 后才 tick
	assert.equal(drain.tokens, 100, "停用期 token 必须计入总量（由 drain 取走）");

	m.add(D("abcd")); // 重开后只有 1 token
	const first = m.tick(31_000); // 重开后的第一帧
	assert.equal(first.tokens, 1, "旧 token 不得重复计入");
	assert.ok(
		first.tps <= 1,
		`重开首帧速率不应是假尖峰，实际 ${first.tps}（积压未清会得到 ~100）`,
	);
});

test("meter: add 容忍坏输入且永不抛（外部事件无类型保证）", () => {
	// `add()` 的契约是「永不抛」：它跑在 agent-loop 的 await 链上，
	// 抛异常会打断流式主流程。事件侧没有类型保证，所以必须防御。
	const m = createTpsMeter(0);
	assert.doesNotThrow(() => {
		m.add(null as unknown as TokenDelta);
		m.add({ kind: "text", delta: undefined as unknown as string });
		m.add({ kind: "text", delta: 42 as unknown as string });
	});
	assert.equal(m.pending(), 0, "坏输入不应贡献 token");
	assert.equal(estimateDeltaTokens(undefined as unknown as string), 0);
	assert.equal(estimateDeltaTokens(null as unknown as string), 0);
});
