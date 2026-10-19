#!/usr/bin/env bash
# 容器化试跑（真模型）：容器里装好 pi + 本仓库源码，模型走宿主网关。
#
#   bash test/docker/run-real.sh                 # 起容器并进 pi TUI（日常看效果用这个）
#   bash test/docker/run-real.sh --print "你好"   # 非交互问一句，验证模型可达
#   bash test/docker/run-real.sh --shell         # 只进容器 bash
#   bash test/docker/run-real.sh --mock          # 不碰宿主模型：容器内起 mock LLM 再看效果
#
# 做法对齐 pi-legion/test/docker/run-tui-real.sh（那边已跑通，别自创）：
#   · --network=host —— 网关是宿主进程，bridge 下 localhost:<port> 是容器自己；
#                        用 host 网络后 auth.json 里的 baseUrl 一个字都不用改。
#   · auth.json 挂 ro / models-store.json 挂 rw（pi 要写回 checkedAt）
#   · 仓库挂到 /plugin:ro，pi 只往 PI_CODING_AGENT_DIR 写，不碰 cwd
#
# 可调环境变量：
#   PI_DOCKER_IMAGE  镜像（默认 pi-sysmon-sandbox:latest）
#   PI_DOCKER_NAME   容器名（默认 pi-sysmon-real；mock 请用 pi-sysmon-real-mock 之类的独立名字）
#   PI_MODEL         模型 id（默认 workbuddy/hy4-preview-ioa）
#   HOST_PI_AGENT    宿主 agent 目录（默认 ~/.pi/agent）
#   MOCK_TPS         mock 吐字速度（默认 40 tok/s）；TUI_COLS/TUI_ROWS 只被 verify 使用
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${PI_DOCKER_IMAGE:-pi-sysmon-sandbox:latest}"
NAME="${PI_DOCKER_NAME:-pi-sysmon-real}"
MODEL="${PI_MODEL:-workbuddy/hy4-preview-ioa}"
HOST_AGENT="${HOST_PI_AGENT:-$HOME/.pi/agent}"
COLS="${TUI_COLS:-140}" ROWS="${TUI_ROWS:-40}"
# mock 路径的旋钮（真模型路径不读，但转发无害）。
TPS="${MOCK_TPS:-40}" REPLY_CHARS="${MOCK_REPLY_CHARS:-600}"

MOCK=0
# 先扫掉 --mock（位置无关），剩下的才是真正的模式参数。
# 之前只在 $1 处看 --mock，`--mock --print ...` 会落到 *) 分支变成交互启动。
ARGS=()
for arg in "$@"; do
	if [ "$arg" = "--mock" ]; then MOCK=1; else ARGS+=("$arg"); fi
done
MODE="${ARGS[0]:-}"

image_ready() { docker image inspect "$IMAGE" >/dev/null 2>&1; }
# ── mock 路径：不涉及模型凭据，不需要 host 网络 ─────────────────────────
start_mock() {
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	docker run -d --name "$NAME" \
		-e TERM=xterm-256color \
		-e COLORTERM="${COLORTERM:-truecolor}" \
		-e TUI_COLS="$COLS" -e TUI_ROWS="$ROWS" \
		-v "$ROOT:/plugin:ro" \
		-w /root/work \
		"$IMAGE" sleep infinity >/dev/null
	echo "==> pi version: $(docker exec "$NAME" pi --version)"
}

# ── 真模型路径 ──────────────────────────────────────────────────────────
start_real() {
	for f in auth.json models-store.json; do
		[ -f "$HOST_AGENT/$f" ] || {
			echo "FAIL: $HOST_AGENT/$f 不存在（宿主需先 /login）。"
			exit 1
		}
	done
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	docker run -d --name "$NAME" --network=host \
		-e TERM=xterm-256color \
		-e COLORTERM="${COLORTERM:-truecolor}" \
		-v "$ROOT:/plugin:ro" \
		-v "$HOST_AGENT/auth.json:$HOST_AGENT/auth.json:ro" \
		-v "$HOST_AGENT/models-store.json:$HOST_AGENT/models-store.json" \
		-w /root/work \
		"$IMAGE" sleep infinity >/dev/null
	echo "==> pi version: $(docker exec "$NAME" pi --version)"
	# 换镜像/换宿主后这条最容易静默失效：没有 any-endpoint provider，模型直接不可见。
	docker exec "$NAME" pi --list-models 2>&1 | grep -q "$MODEL" ||
		docker exec "$NAME" pi --list-models 2>&1 | sed 's/^/    /' | head -10 ||
		echo "WARN: model '$MODEL' not in catalog — 检查 models-store.json 挂载与 any-endpoint 扩展" >&2
}

running() { [ -n "$(docker ps --filter "name=^/${NAME}$" --filter status=running --quiet)" ]; }

# 容器名相同但模式不同（mock ↔ 真模型）时必须重建：两者的挂载与网络不一样。
# 否则复用 mock 容器跑真模型会报「Model not found」，用户看不出是模式串台。
container_mode() {
	docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}{{.HostConfig.NetworkMode}}' \
		"$NAME" 2>/dev/null || true
}

ensure() {
	image_ready || {
		echo "镜像 $IMAGE 未构建，先跑： make -C test/docker build"
		exit 1
	}
	if running; then
		local want_mode
		if [ "$MOCK" = "1" ]; then want_mode="bridge"; else want_mode="host"; fi
		if printf '%s' "$(container_mode)" | grep -qw "$want_mode"; then
			echo "reusing running container '$NAME'"
			return
		fi
		echo "容器 '$NAME' 存在但模式不符（需要 $want_mode），重建"
		docker rm -f "$NAME" >/dev/null 2>&1 || true
	fi
	if [ "$MOCK" = "1" ]; then start_mock; else start_real; fi
}

case "$MODE" in
--shell)
	ensure
	exec docker exec -it "$NAME" bash
	;;
--print)
	# ARGS[0] 是 "--print"，剩下的是 prompt
	PROMPT="${ARGS[*]:1}"
	ensure
	if [ "$MOCK" = "1" ]; then
		exec docker exec "$NAME" env MOCK_TPS="$TPS" MOCK_REPLY_CHARS="$REPLY_CHARS" \
			bash -lc "bash /plugin/test/docker/inside-mock-tui.sh --print $(printf '%q' "$PROMPT")"
	fi
	exec docker exec "$NAME" pi --model "$MODEL" --print "$PROMPT"
	;;
*)
	ensure
	if [ "$MOCK" = "1" ]; then
		echo "==> mock 模式（tps=$TPS）：容器内 pi，图表数据来自容器自身 /proc"
		exec docker exec -it "$NAME" env MOCK_TPS="$TPS" MOCK_REPLY_CHARS="$REPLY_CHARS" \
			bash -lc "bash /plugin/test/docker/inside-mock-tui.sh"
	fi
	exec docker exec -it "$NAME" pi --model "$MODEL"
	;;
esac
