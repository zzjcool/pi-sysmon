/**
 * 流式 token 估算器 —— 纯函数、零依赖、不分配对象（热路径）。
 *
 * 背景：pi 在流式过程中只发 `message_update` 增量事件（text_delta /
 * thinking_delta / toolcall_delta），精确 usage 只在消息结束时才拿到，
 * 所以每帧的 token 数必须由增量文本估算。
 *
 * 估算口径：ASCII/其他字符按 4 字符 ≈ 1 token（与 pi-ai 的 chars/4
 * 启发式一致），CJK/假名/谚文等宽字符按 1 字符 ≈ 1 token —— 不做这个
 * 区分会把中文输出低估约 4 倍。
 */

export type DeltaKind = "text" | "thinking" | "toolcall";

export interface TokenDelta {
	kind: DeltaKind;
	delta: string;
}

/** 判断一个码点是否属于"每字符约 1 token"的 CJK/宽字符区段。
 *  用区间比较而非正则：热点路径每 delta 调用一次，区间比较零分配、
 *  且避免正则在大字符串上的回溯开销。 */
function isCjkCodePoint(cp: number): boolean {
	return (
		(cp >= 0x3000 && cp <= 0x303f) || // CJK 标点、表意空格
		(cp >= 0x3040 && cp <= 0x30ff) || // 平/片假名
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
		(cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
		(cp >= 0xf900 && cp <= 0xfaff) // CJK 兼容表意文字
	);
}

/** 估算单个 delta 文本的 token 数。单趟遍历、零分配、永不抛。
 *  空串 / 非字符串 / 算出非有限值时一律返回 0 —— 这个值会直接进图表，
 *  NaN 会把纵轴刻度带崩。 */
export function estimateDeltaTokens(delta: string): number {
	if (typeof delta !== "string" || delta.length === 0) return 0;
	let cjk = 0;
	let other = 0;
	for (const ch of delta) {
		const cp = ch.codePointAt(0) ?? 0;
		if (isCjkCodePoint(cp)) cjk++;
		else other++;
	}
	const est = Math.ceil(other / 4) + cjk;
	return Number.isFinite(est) ? est : 0;
}

export interface TpsMeter {
	/** 累积一个 delta。O(1)，同步，永不抛。 */
	add(d: TokenDelta): void;
	/** 关闭当前桶；返回窗口期速率并重置。 */
	tick(nowMs: number): { tps: number; tokens: number };
	/** 当前（未关闭）桶里已累积的 token 数。 */
	pending(): number;
}

/** 创建一个 tps 计量器。nowMs 是不透明毫秒时钟（生产里调用方传
 *  performance.now()），内部只用差值，绝不关心基准。 */
export function createTpsMeter(nowMs: number = Date.now()): TpsMeter {
	let last = nowMs;
	let pendingTokens = 0;

	return {
		add(d: TokenDelta): void {
			// delta 可能来自外部事件，防御性包住：估算失败也要能继续
			try {
				pendingTokens += estimateDeltaTokens(d?.delta ?? "");
			} catch {
				/* 估算异常不应影响流式主流程 */
			}
		},
		tick(now: number): { tps: number; tokens: number } {
			const dtMs = now - last;
			last = now; // 时钟回拨也推进基准：否则会累积出一个虚假的大窗口
			const tokens = pendingTokens;
			pendingTokens = 0;
			// dtMs<=0（时钟回拨/同毫秒重复 tick）或非有限值时绝不能除零，
			// 但仍要清桶 —— 不然下一帧会把旧 token 重复计入
			if (!Number.isFinite(dtMs) || dtMs <= 0) return { tps: 0, tokens };
			const tps = (tokens * 1000) / dtMs;
			return { tps: Number.isFinite(tps) ? tps : 0, tokens };
		},
		pending(): number {
			return pendingTokens;
		},
	};
}

/**
 * 把速率格式化成图表标题用的**紧凑**形式：`635t/s` / `12.3Kt/s`。
 *
 * 宽度有硬上界 —— 本仓库有血的教训：任何渲染行超过终端宽度会让 pi
 * 直接抛异常退出（见 fmtBytes 的 ">999T" 钳制先例）。所以钳死，
 * 且绝不输出科学计数法。
 *
 * 为什么是紧凑形式而不是全写单位（`635 tok/s`）：后者在四图并排的
 * 最小块宽（24 列）下放不下 —— `roomForInfo = 24 - 6 - 7 - 1 = 10` 列，
 * 而 `~12.3K tok/s` 是 12 列，于是**整条读数会消失**，屏幕上只剩一个
 * 光秃秃的 `┌ Tokens ─────┐`（实测 tps≥1000 时就会这样）。
 *
 * `t/s` 与图上 y 轴刻度（`blocks.ts` 的 `tokenAxis`）完全同款，一致且省 3 列，
 * 这样 `~12.3Kt/s`（9 列）在 24 列的块里也放得下。
 *
 * 进制用 1000，与 `tokenAxis` / API 账单口径一致。
 */
export function fmtTps(tps: number): string {
	if (!Number.isFinite(tps) || tps <= 0) return "0t/s";
	if (tps >= 1e6) return ">999Kt/s";
	if (tps >= 1000) {
		const k = tps / 1000;
		// 优先一位小数（`12.3K`）；但**判断得看格式化之后的结果**，不能拿 k 跟 100 比：
		// k=99.95 时 `toFixed(1)` 会进位成 `100.0`（9 列），反而比整数形式 `100K`
		// 更长，而且比自己刚跨过的那个值还宽 —— 既不单调又破坏紧凑预算。
		// 这是本仓库惯用的「降精度而不是截断」：一位小数放不下就退回整数。
		const one = `${k.toFixed(1)}Kt/s`;
		if (one.length <= FMT_TPS_MAX) return one;
		const n = Math.round(k);
		// 取整后可能到 1000（tps=999999 → `1000K`），必须落回钳制值：
		// 不能吐 `1000Kt/s`（读着像 1M 却带 K 后缀，与 >999Kt/s 口径矛盾）。
		return n >= 1000 ? ">999Kt/s" : `${n}Kt/s`;
	}
	return `${Math.floor(tps)}t/s`;
}

/**
 * `fmtTps` 输出的宽度上界。
 *
 * 8 列这个数字不是拍的：四图并排时最小块宽是 24 列（`MIN_BLOCK_W`），
 * 标题栏 `┌ Tokens ─ ` + 读数 + ` ─┐` 的可用空间恰好容下 8 列读数。
 * 再多 1 列就会把整条读数挤掉（实测过：全写单位 `~12.3K tok/s` 就是这样消失的）。
 */
export const FMT_TPS_MAX = 8;
