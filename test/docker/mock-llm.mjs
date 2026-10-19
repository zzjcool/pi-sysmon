#!/usr/bin/env node
/**
 * 极简 OpenAI-compatible mock LLM —— 专为 pi-sysmon 的 Tokens 图造数据。
 *
 * 为什么不用 pi-legion 的那套 test/mock-llm（TS + scenario 引擎）：
 * 那套的 scenario 全是 subagent 语义，而 pi-sysmon 只需要三件事，
 * 且其中第三件那套恰恰没有：
 *   1. /v1/models、/v1/chat/completions（SSE）基础协议；
 *   2. 末尾带 usage（prompt/completion/cached tokens），让 `↑ ↓ R`、`·`、`⌀` 有数；
 *   3. **按 token 速率节流**。pi-sysmon 的 TPS 来自 message_update 的 delta 文本
 *      （4 字符 ≈ 1 token），而 pi-legion 的 mock 在一个同步循环里 flush 所有 chunk ——
 *      tick 只能看到一个尖峰，TPS 曲线是一条竖线。这里每个 chunk 之间 sleep，
 *      曲线才有形状，`~40t/s` 之类的读数也才是真的。
 *
 * 环境变量（全部可选）：
 *   MOCK_LLM_PORT            监听端口，默认 8765
 *   MOCK_LLM_HOST            监听地址，默认 127.0.0.1
 *   MOCK_TPS                 每秒 token 数（≈ 每秒 chunk 数），默认 40
 *   MOCK_STREAM_SECS         回复流式持续秒数（默认 4）；实际字符数 = TPS×SECS×4，
 *                            上限为 MOCK_REPLY_CHARS。按**时长**定长而不用定长字符数，
 *                            低 TPS 下才不会变成等上两分钟。
 *   MOCK_REPLY_CHARS         回复字符数上限，默认 600
 *   MOCK_CHARS_PER_CHUNK     每 chunk 字符数，默认 4（pi-sysmon 按 4 字符/token 估算）
 *   MOCK_SAY_NO_PAD          设 1 时 MOCK_SAY 的短句不补齐（默认补到目标长度）
 *   MOCK_PROMPT_TOKENS       usage.prompt_tokens，默认 1200
 *   MOCK_CACHE_TOKENS        usage.prompt_tokens_details.cached_tokens，默认 900
 *
 * 内联指令（与 pi-legion 的 mock 一致，方便手测）：
 *   发给模型的消息里写 `MOCK_SAY: 想让它说的话`，回复就是那句话（会按 MOCK_TPS 流式吐）。
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8765);
const HOST = process.env.MOCK_LLM_HOST ?? "127.0.0.1";
const TPS = Math.max(1, Number(process.env.MOCK_TPS ?? 40));
const STREAM_SECS = Math.max(0.5, Number(process.env.MOCK_STREAM_SECS ?? 4));
const REPLY_CHARS_MAX = Math.max(8, Number(process.env.MOCK_REPLY_CHARS ?? 600));
// 按「流式持续时长」定目标长度：TPS=1 时 600 字符要吐 150 秒，回归脚本会等死。
const REPLY_CHARS = Math.max(
	8,
	Math.min(REPLY_CHARS_MAX, Math.round(TPS * STREAM_SECS * 4)),
);
const CHARS_PER_CHUNK = Math.max(1, Number(process.env.MOCK_CHARS_PER_CHUNK ?? 4));
const PROMPT_TOKENS = Math.max(1, Number(process.env.MOCK_PROMPT_TOKENS ?? 1200));
const CACHE_TOKENS = Math.max(0, Number(process.env.MOCK_CACHE_TOKENS ?? 900));

const CHUNK_MS = 1000 / TPS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let requestCount = 0;

/** 默认回复：一段稳定长度的英文，避免 CJK 宽度因素干扰断言。 */
const FILLER =
	"System monitor mock reply. The braille charts are fed by delta text, so every chunk " +
	"counts as a fraction of a token and the tokens-per-second curve moves while this " +
	"message streams. CPU, memory and network samples come from the container's own " +
	"/proc, which makes this a fully self-contained demo of the sysmon panel. ";

function defaultReply() {
	let out = "";
	while (out.length < REPLY_CHARS) out += FILLER;
	return out.slice(0, REPLY_CHARS);
}

/** 从最后一条 user 消息里抽 `MOCK_SAY: ...`，没有就用默认回复。 */
function pickReply(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "user") continue;
		const text = flatten(m.content);
		const hit = text.match(/MOCK_SAY:\s*([^\n]+)/);
		if (!hit) break;
		const said = hit[1].trim();
		// 把 MOCK_SAY 的短句补齐到目标长度：否则流式窗口只有 ~1.5s，
		// 「等流式结束」与「流式中抽帧」就变成跟机器速度赛跑的时序赌博
		// （reviewer 实测：MOCK_TPS=1 下 frame-2 落在流式途中，断言假失败）。
		// MOCK_SAY_NO_PAD=1 可关闭补齐，用于手测短回复。
		if (process.env.MOCK_SAY_NO_PAD === "1" || said.length >= REPLY_CHARS) return said;
		return said + " " + defaultReply().slice(0, Math.max(0, REPLY_CHARS - said.length - 1));
	}
	return defaultReply();
}

function flatten(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : ""))
			.join("\n");
	return "";
}

function chunk(delta, finishReason) {
	return {
		id: "mock-chatcmpl",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "flash",
		choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
	};
}

function usage(text) {
	return {
		prompt_tokens: PROMPT_TOKENS,
		completion_tokens: Math.max(1, Math.ceil(text.length / 4)),
		total_tokens: PROMPT_TOKENS + Math.max(1, Math.ceil(text.length / 4)),
		// pi-ai 读 prompt_tokens_details.cached_tokens → cacheRead，
		// input 再减去 cacheRead —— 这样 `·`/`⌀` 命中率读数才有值。
		prompt_tokens_details: { cached_tokens: Math.min(CACHE_TOKENS, PROMPT_TOKENS - 1) },
	};
}

function writeEvent(res, payload) {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamCompletion(res, reply) {
	let aborted = false;
	res.on("close", () => {
		aborted = true;
	});
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	writeEvent(res, chunk({ role: "assistant", content: "" }));

	// 按码点切块，避免把 surrogate pair 劈开（CJK/emoji 也不会破坏 JSON）。
	const points = Array.from(reply);
	for (let i = 0; i < points.length; i += CHARS_PER_CHUNK) {
		if (aborted) return;
		writeEvent(res, chunk({ content: points.slice(i, i + CHARS_PER_CHUNK).join("") }));
		await sleep(CHUNK_MS);
	}
	if (aborted) return;

	const final = chunk({}, "stop");
	final.usage = usage(reply);
	writeEvent(res, final);
	res.write("data: [DONE]\n\n");
	res.end();
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);

	if (req.method === "GET" && /^\/(v1\/)?models$/.test(url.pathname)) {
		const body = JSON.stringify({
			object: "list",
			data: [{ id: "flash", object: "model", owned_by: "pi-sysmon-mock" }],
		});
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(body);
		return;
	}

	if (req.method === "GET" && /^\/(v1\/)?health$/.test(url.pathname)) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, requests: requestCount, tps: TPS }));
		return;
	}

	if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			let body = {};
			try {
				body = JSON.parse(raw);
			} catch {
				/* 空 body 也照样回一个默认回复 */
			}
			requestCount += 1;
			const reply = pickReply(Array.isArray(body.messages) ? body.messages : []);
			if (body.stream === false) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						id: "mock-chatcmpl",
						object: "chat.completion",
						created: Math.floor(Date.now() / 1000),
						model: "flash",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: reply },
								finish_reason: "stop",
							},
						],
						usage: usage(reply),
					}),
				);
				return;
			}
			// 必须 catch：req.on("end") 是 EventEmitter 回调，返回的 Promise 没人接。
			// Node ≥22 默认 --unhandled-rejections=throw，流式写失败（客户端断开、
			// socket EPIPE）会直接杀掉整个 mock server（scout 静态审查发现）。
			streamCompletion(res, reply).catch((err) => {
				process.stderr.write(`mock-llm: stream aborted: ${err?.message ?? err}\n`);
			});
		});
		return;
	}

	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, HOST, () => {
	process.stdout.write(
		`mock-llm listening on http://${HOST}:${PORT}/v1 ` +
			`(tps=${TPS}, chars=${REPLY_CHARS}, chunk=${CHARS_PER_CHUNK})\n`,
	);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 500).unref();
	});
}
