#!/usr/bin/env bash
# 确定性 TUI 回归：mock LLM + tmux 抓帧 + 明文断言 + PNG 取证。
#
# 在容器内跑（镜像里已有 tmux / python3-PIL / CJK 字体）：
#   bash test/docker/verify-tui-visual.sh
#
# 流程：起 mock LLM（随机端口）→ 隔离 pi home（packages=[/plugin]）→ tmux 起 pi →
#      等面板出现 → 送一句话 → 抓「流式中」与「流式结束」两帧 → 断言 → 渲染 PNG。
#
# 断言锚点（来源见 src/blocks.ts / chart-panel.ts）：
#   · 块名 CPU / Memory / Network / Tokens —— 标题栏 `┌ CPU ─ … ┐`。「插件真加载了」
#     的唯一可信证据（本项目历史上真发生过「单测全绿但真机不显示」）。
#   · 底边框 `└ 60s ─…─ 0s ┘` —— 纯 ASCII、不依赖 /proc 可读。
#   · 标题栏 `~Nt/s`（带 `~`）—— 只有真在流 delta 时非零。注意 Y 轴刻度是**裸**的
#     `40t/s`，不带 `~` 就是假的。
#   · `◔N%` / `·N%` / `⌀N%` —— 都在插件标题栏里；`·`/`⌀` 需要 mock 返回 cached_tokens。
#   · 可见宽度 ≤ 列数 —— pi 某行超宽会直接崩溃退出。
#   · 行数恒定 + 面板仍在刷新 —— 前者防抖动，后者防「卡死被当成稳定」。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib-mock-home.sh
. "$HERE/lib-mock-home.sh"

PLUGIN_ROOT="${PLUGIN_ROOT:-/plugin}"
if [ ! -d "$PLUGIN_ROOT/src" ]; then
	echo "FAIL: 找不到 $PLUGIN_ROOT/src —— 需挂载仓库或用 PLUGIN_ROOT 指向仓库根"
	echo "  本地:  make -C test/docker tui-visual"
	exit 1
fi
command -v tmux >/dev/null 2>&1 || {
	echo "FAIL: 需要 tmux（本脚本设计为在 test/docker 镜像内跑）"
	exit 1
}

ART="${TUI_ARTIFACTS_DIR:-$PLUGIN_ROOT/test/tui/artifacts}/$(date +%Y%m%d-%H%M%S)-$$"
# /plugin 可能是只读挂载（README 推荐 ro）：默认产物目录会写失败，给出可操作的提示。
mkdir -p "$ART" 2>/dev/null || {
	echo "FAIL: 无法写产物目录 $ART（/plugin 只读？）"
	echo "  解法: TUI_ARTIFACTS_DIR=/tmp/artifacts bash $0"
	exit 1
}
COLS="${TUI_COLS:-140}" ROWS="${TUI_ROWS:-40}"
PI_HOME="${PI_HOME_DIR:-/tmp/pi-sysmon-verify-home}"
SESSION="sysmon-qa-$$" # 带 pid：两个 verify 并行跑时不撞 tmux session

cleanup() {
	# 只杀本脚本创建的 session。`tmux kill-server` 是 server 级操作，
	# 在宿主跑会连带杀掉用户其它 tmux 会话（reviewer 实测）。
	tmux kill-session -t "$SESSION" 2>/dev/null || true
	if [ -n "${MOCK_PID:-}" ]; then kill "$MOCK_PID" 2>/dev/null || true; fi
	return 0
}
trap cleanup EXIT

plain() { sed 's/\x1b\[[0-9;:?]*[A-Za-z]//g; s/\x1b\][^\x07]*\x07//g'; }

# 抓当前屏明文（不含 ANSI）
frame_plain() { tmux capture-pane -p -t "$SESSION" -e | plain; }

# 「结构」= 去掉 ANSI、去掉所有非 ASCII（曲线是盲文/块元素）、把数字归一化成 N。
# 为什么不用 `sed 's/[]▁…]//g'`（旧实现）：多字节字面量在 UTF-8 locale 下会
# "Invalid collation character" 直接失败并输出空串，两侧都是空 → 判定恒真，
# 「等结构稳定」变成空操作（reviewer 在 LANG=C.UTF-8 下实测）。
# 同时归一化数字：CPU% / 内存字节 / 时间戳每秒都在变，否则永远不收敛。
skeleton() { LC_ALL=C sed 's/\x1b\[[0-9;:?]*[A-Za-z]//g' | LC_ALL=C tr -d '\200-\377' | sed 's/[0-9][0-9.]*/N/g'; }

# 等面板出现：boot 屏 ~2s 就两帧相同，但插件块要到 ~4s 才渲染。
wait_panel() {
	local frame=""
	for _ in $(seq 1 60); do
		sleep 0.5
		frame=$(frame_plain)
		case "$frame" in
		*"CPU"*) case "$frame" in *"Memory"*) return 0 ;; esac ;;
		esac
	done
	printf '%s\n' "$frame" >"$ART/timeout.ansi"
	return 1
}

# 等「结构」连续两帧一致。注意返回值语义：0=收敛，1=未收敛。
wait_shape() { # wait_shape <输出文件> [最多轮数]
	local out="$1" tries="${2:-20}" prev="" cur="" n=0
	for _ in $(seq 1 "$tries"); do
		sleep 0.6
		cur=$(tmux capture-pane -p -t "$SESSION" -e)
		n=$((n + 1))
		if [ -n "$prev" ] && [ "$(printf '%s' "$cur" | skeleton)" = "$(printf '%s' "$prev" | skeleton)" ]; then
			printf '%s\n' "$cur" >"$out"
			return 0
		fi
		prev="$cur"
	done
	printf '%s\n' "$cur" >"$out"
	return 1
}

# 活性检查：面板必须仍在刷新。卡死（chunk 不再更新）恰好是最容易「收敛」的状态，
# 单靠结构稳定会把卡死判成健康 —— 所以必须配一条「原始帧必须变化」的断言。
assert_alive() {
	local a b
	a=$(tmux capture-pane -p -t "$SESSION" -e)
	sleep 1.3
	b=$(tmux capture-pane -p -t "$SESSION" -e)
	[ "$a" != "$b" ]
}

# ── 1. mock LLM（随机端口，避免残留进程串台）─────────────────────────────
PORT=$(free_port)
MOCK_ENTRY="$PLUGIN_ROOT/test/docker/mock-llm.mjs"
[ -f "$MOCK_ENTRY" ] || MOCK_ENTRY=/opt/mock/mock-llm.mjs
MOCK_LLM_PORT="$PORT" \
	MOCK_TPS="${MOCK_TPS:-40}" \
	MOCK_REPLY_CHARS="${MOCK_REPLY_CHARS:-600}" \
	node "$MOCK_ENTRY" >/tmp/mock-llm.log 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 40); do
	curl -sf -m2 "http://127.0.0.1:$PORT/v1/models" >/dev/null && break
	sleep 0.25
done
curl -sf -m2 "http://127.0.0.1:$PORT/v1/models" >/dev/null || {
	echo "FAIL: mock LLM 未就绪（端口 $PORT）"
	tail -20 /tmp/mock-llm.log
	exit 1
}
echo "==> mock LLM on :$PORT (tps=${MOCK_TPS:-40})"

# ── 2. 隔离 pi home（packages 指向挂载的仓库源码）──────────────────────────
write_mock_home "$PI_HOME" "$PORT" "$PLUGIN_ROOT"

# ── 3. tmux 起 pi ────────────────────────────────────────────────────────
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS"
tmux send-keys -t "$SESSION" \
	# COLORTERM=truecolor: without it pi's `system` theme emits indexed ANSI
	# colours (`warning`=ANSI 3, `error`=ANSI 1), and the Memory chart's two
	# curves are exactly that pair — the captured PNG then shows one colour and
	# the artifact cannot answer "are the curves right". Fixed truecolor keeps
	# the evidence deterministic across hosts, which is this script's whole job.
	"HOME=$PI_HOME PI_CODING_AGENT_DIR=$PI_HOME TERM=xterm-256color COLORTERM=truecolor PI_OFFLINE=1 LANG=C.utf8 pi --provider mock --model flash --thinking off --tui-mode fullscreen" C-m

wait_panel || {
	echo "FAIL: sysmon 面板（CPU/Memory）在 30s 内从未渲染 —— 插件没加载"
	exit 1
}

# boot 帧：结构未收敛属于硬失败（基线不可信），不再只 WARN。
wait_shape "$ART/boot.ansi" || {
	echo "FAIL: boot 帧结构 12s 内未收敛 —— 面板在抖动或渲染异常"
	exit 1
}
cp "$ART/boot.ansi" "$ART/frame-1.ansi"

# ── 4. 触发一次流式回复（Tokens 图 / t/s 读数）────────────────────────────
# 回复文本里带 `SMOKE_REPLY_MARKER`：用户输入回显是 `MOCK_SAY: <文本>`（带前缀），
# assistant 回复是**不带前缀**的裸文本，所以匹配「行首即 marker」只会命中回复。
REPLY="SMOKE_REPLY_MARKER sysmon tui visual smoke reply from the mock language model"
tmux send-keys -t "$SESSION" "MOCK_SAY: $REPLY" C-m

# 4a. 流式进行中抓帧：标题栏 `~Nt/s` 只在有 delta 的那一秒非零。
STREAMED=0
for _ in $(seq 1 60); do
	sleep 0.25
	cur=$(tmux capture-pane -p -t "$SESSION" -e)
	if printf '%s' "$cur" | plain | grep -qE '~[1-9][0-9.]*[KMG]?t/s'; then
		printf '%s\n' "$cur" >"$ART/frame-streaming.ansi"
		STREAMED=1
		break
	fi
done

# 4b. 等流式**结束**：判据必须是 assistant 回复（行首 marker），不能用用户回显。
# 旧实现用回显串判完成 → 第一次（t≈0.5s）就 break，frame-2 落在流式途中，
# 且「回复文本上屏」断言恒真（reviewer 在 MOCK_TPS=1 下实测 FAIL 复现）。
REPLIED=0
for _ in $(seq 1 160); do
	sleep 0.25
	# 匹配任意行包含 marker，但**排除** `MOCK_SAY:` 回显行：pi 会把回复也缩进一格，
	# 所以不能用 `^` 锚定行首（实测回复行开头是空格）。
	if frame_plain | grep -F "$REPLY" | grep -vq 'MOCK_SAY:'; then
		REPLIED=1
		break
	fi
done
# 再等 usage 落地（⌀ 出现）：message_end 是累计 token 与命中率的唯一来源。
for _ in $(seq 1 60); do
	frame_plain | grep -q '⌀' && break
	sleep 0.25
done
wait_shape "$ART/frame-2.ansi" || echo "WARN: frame-2 结构未收敛，继续取证（可能是流式途中）"

# ── 5. PNG 取证（优先仓库内渲染器，回退镜像烧录副本）───────────────────────
RENDERER="$PLUGIN_ROOT/test/tui/ansi2png.py"
[ -f "$RENDERER" ] || RENDERER=/opt/tui/ansi2png.py
python3 "$RENDERER" "$ART/frame-2.ansi" "$ART/frame-2.png" --cols "$COLS" >/dev/null
if [ -s "$ART/frame-streaming.ansi" ]; then
	python3 "$RENDERER" "$ART/frame-streaming.ansi" "$ART/frame-streaming.png" --cols "$COLS" >/dev/null
fi

# ── 6. 断言（明文优先；每行可见宽度不超过终端列数）────────────────────────
fail=0
check() { # check <描述> <文件> <模式>
	if plain <"$2" | grep -qE -- "$3"; then
		echo "  ok   $1"
	else
		echo "  FAIL $1   (pattern: $3)"
		fail=1
	fi
}

echo "==> 断言 boot 帧（插件加载）"
check "CPU 块" "$ART/boot.ansi" '┌ ?CPU'
check "Memory 块" "$ART/boot.ansi" 'Memory'
check "Network 块" "$ART/boot.ansi" 'Network'
check "Tokens 块" "$ART/boot.ansi" 'Tokens'
# 时间轴必须带边框锚点：裸 `0s` 会被 `60s` 命中（reviewer 实测），断言就恒真了。
check "时间轴左端 60s" "$ART/boot.ansi" '└ ?60s'
check "时间轴右端 0s" "$ART/boot.ansi" '0s ?┘'

echo "==> 断言交互帧（流式 + 读数）"
if [ "$REPLIED" -eq 1 ]; then
	echo "  ok   assistant 回复上屏（排除 MOCK_SAY 回显行）"
else
	echo "  FAIL assistant 回复始终没出现（只看到用户回显）"
	fail=1
fi
if [ -s "$ART/frame-streaming.ansi" ]; then
	check "标题栏 TPS 读数（流式中）" "$ART/frame-streaming.ansi" '~[1-9][0-9.]*[KMG]?t/s'
else
	echo "  FAIL 未抽到流式期间的帧（TPS 无法取证）"
	fail=1
fi
# 注意：chart widget 模式下 showTokenTotals=false（src/index.ts:979），插件**不画**
# `↑/↓/R` —— 屏幕上那份是 pi 自带 footer。断言它等于在测宿主，故改为断言插件
# 在自己的标题栏里真画的三段读数。
check "上下文占用读数 ◔N%" "$ART/frame-2.ansi" '◔ ?[0-9]+%'
check "瞬时命中率读数（mock 带 cached_tokens）" "$ART/frame-2.ansi" '· ?[0-9]+%'
check "累计命中率读数 ⌀N%" "$ART/frame-2.ansi" '⌀ ?[0-9]+%'

echo "==> 断言几何与活性"
# 用 python3 算**可见宽度**（EAW 宽字符算 2 列）：awk 的 length() 是字节数，
# 边框/盲文/中文一个字 3 字节，会误报「420 列」。
widths=$(
	python3 - "$ART/frame-2.ansi" "$ART/boot.ansi" "$COLS" <<'PY'
import sys, unicodedata, re, pathlib
ansi = re.compile(r"\x1b\[[0-9;:?]*[A-Za-z]")

def visible(lines):
    out = []
    for line in lines:
        s = ansi.sub("", line)
        out.append(sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in s))
    return out

def read(p):
    return pathlib.Path(p).read_text(encoding="utf-8", errors="replace").splitlines()

cols = int(sys.argv[3])
f2, boot = visible(read(sys.argv[1])), visible(read(sys.argv[2]))
print(f"max={max(f2) if f2 else 0} rows2={len(f2)} rows1={len(boot)}")
print("overflow=1" if max(f2 or [0]) > cols else "overflow=0")
print("rows-differ=1" if len(f2) != len(boot) else "rows-differ=0")
PY
)
echo "  $widths"
case "$widths" in
*overflow=1*)
	echo "  FAIL 有行可见宽度超过 $COLS 列"
	fail=1
	;;
*) echo "  ok   无行超过 $COLS 列" ;;
esac
case "$widths" in
*rows-differ=1*)
	echo "  FAIL 交互前后行数不同（高度必须恒定，否则编辑器抖动、选区失效）"
	fail=1
	;;
*) echo "  ok   交互前后行数恒定" ;;
esac
# 活性：面板必须还在刷新。否则「结构稳定」会把卡死误判成正常。
if assert_alive; then
	echo "  ok   面板仍在刷新（1.3s 内帧有变化）"
else
	echo "  FAIL 面板已停止刷新（疑似渲染卡死）"
	fail=1
fi

if [ -s "$ART/frame-2.png" ]; then
	echo "  ok   PNG 取证已生成"
else
	echo "  FAIL PNG 缺失"
	fail=1
fi

cat >"$ART/notes.md" <<EOF
# tui-visual smoke $(date -Iseconds)
- plugin: $PLUGIN_ROOT
- cols: $COLS  rows: $ROWS  mock tps: ${MOCK_TPS:-40}
- streaming frame captured: $STREAMED
- result: $([ "$fail" -eq 0 ] && echo PASS || echo FAIL)
EOF

if [ "$fail" -eq 0 ]; then
	echo "PASS: artifacts in $ART"
else
	echo "FAIL: see $ART"
	exit 1
fi
