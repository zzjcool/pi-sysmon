#!/usr/bin/env bash
# 容器内启动 pi 的 mock 模式（由 verify-tui-visual.sh / run-real.sh --mock 调用）。
#
# 做三件事：
#   1. 起容器内 mock LLM（test/docker/mock-llm.mjs），随机端口；
#   2. 写隔离 PI_CODING_AGENT_DIR：settings.packages 指向 /plugin（本仓库源码）；
#   3. 跑 pi（provider=mock / model=flash）。
#
# 用法（容器内）：
#   bash /plugin/test/docker/inside-mock-tui.sh                 # 直接进 pi
#   bash /plugin/test/docker/inside-mock-tui.sh --print "hi"    # 非交互
#
# 环境变量：PLUGIN_ROOT（默认 /plugin）、MOCK_TPS、MOCK_REPLY_CHARS、PI_HOME_DIR
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="${PLUGIN_ROOT:-/plugin}"
PI_HOME_DIR="${PI_HOME_DIR:-/tmp/pi-sysmon-home}"

MOCK_ENTRY="$PLUGIN_ROOT/test/docker/mock-llm.mjs"
[ -f "$MOCK_ENTRY" ] || MOCK_ENTRY=/opt/mock/mock-llm.mjs

# shellcheck source=lib-mock-home.sh
. "$HERE/lib-mock-home.sh"

PORT=$(free_port)
# TPS/回复长度必须显式转发：只靠环境继承时，调用方不 export 就会静默退回默认值。
MOCK_LLM_PORT="$PORT" \
	MOCK_TPS="${MOCK_TPS:-40}" \
	MOCK_REPLY_CHARS="${MOCK_REPLY_CHARS:-600}" \
	node "$MOCK_ENTRY" >/tmp/mock-llm.log 2>&1 &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
	curl -sf -m2 "http://127.0.0.1:$PORT/v1/models" >/dev/null && break
	sleep 0.25
done
curl -sf -m2 "http://127.0.0.1:$PORT/v1/models" >/dev/null || {
	echo "FAIL: mock LLM 未就绪（端口 $PORT）"
	tail -20 /tmp/mock-llm.log
	exit 1
}

write_mock_home "$PI_HOME_DIR" "$PORT" "$PLUGIN_ROOT"

export PI_CODING_AGENT_DIR="$PI_HOME_DIR"
export PI_OFFLINE=1
export TERM="${TERM:-xterm-256color}"

# 不用 exec：exec 会把 shell 换成 pi，EXIT trap 随之丢失，mock 会变成孤儿进程。
pi --provider mock --model flash --thinking off "$@"
