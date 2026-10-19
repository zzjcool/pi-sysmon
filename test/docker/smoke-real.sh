#!/usr/bin/env bash
# 三层冒烟：L1 模型可达 → L2 插件真加载 → L3 插件命令真执行。
#
#   bash test/docker/smoke-real.sh [model] [container]
#
# L2/L3 不能省：模型通了不代表本仓库插件被加载 —— /plugin 未登记为 package 时
# 镜像自带的包照样能跑，插件却静默缺席（pi-sysmon 历史上就发生过
# 「单测全绿、真机不显示」）。L3 是最硬的一条：它要求扩展的命令处理器真的跑起来。
set -uo pipefail

NAME="${2:-pi-sysmon-real}"
MODEL="${1:-workbuddy/hy4-preview-ioa}"
PLUGIN_ROOT="${PLUGIN_ROOT:-/plugin}"

fail=0
run() { timeout 200 docker exec "$NAME" pi --model "$MODEL" --print "$1" 2>&1; }

# 容器不在时先报清楚原因：否则 L1 的 docker 报错文本会被后面的 grep 归因为
# 「插件没登记」，用户会去查 pi install，而真正原因是容器没起（reviewer 实测）。
if ! docker inspect "$NAME" >/dev/null 2>&1; then
	echo "FAIL: 容器 $NAME 不存在。先跑 make run（或 make print）起容器，再跑 make smoke"
	exit 1
fi
if [ -z "$(docker ps --filter "name=^/${NAME}$" --filter status=running --quiet)" ]; then
	echo "FAIL: 容器 $NAME 存在但没在运行。先跑 make run 起容器"
	exit 1
fi

echo "### L1 model reachable"
L1=$(run "Reply with the single word PONG and nothing else.")
echo "$L1"
if echo "$L1" | grep -qi pong; then
	echo "L1 OK"
else
	echo "L1 FAIL"
	fail=1
fi

echo
echo "### L2 plugin loaded"
L2=$(docker exec "$NAME" pi list 2>&1)
echo "$L2"
if echo "$L2" | grep -q "$PLUGIN_ROOT"; then
	echo "L2 OK"
else
	echo "L2 FAIL: $PLUGIN_ROOT not installed"
	fail=1
fi

echo
echo "### L3 extension command actually executes"
# 用隔离的配置目录 + 显式 -e 加载源码：/sysmon global off 是纯本地命令，
# 不需要模型也不需要 host 凭据，因此这条在离线容器里也能跑。
# 断言它把 enabled:false 落到 <config>/pi-sysmon.json —— 只有扩展真加载并
# 注册了 sysmon 命令才可能发生。
PROBE_HOME=/tmp/sysmon-smoke-home
docker exec "$NAME" rm -rf "$PROBE_HOME" >/dev/null 2>&1
L3=$(docker exec -e PI_CODING_AGENT_DIR="$PROBE_HOME" -e PI_OFFLINE=1 "$NAME" \
	timeout 120 pi -e "$PLUGIN_ROOT/src/index.ts" --print "/sysmon global off" 2>&1)
echo "$L3"
L3_CFG=$(docker exec "$NAME" cat "$PROBE_HOME/pi-sysmon.json" 2>/dev/null)
echo "pi-sysmon.json: ${L3_CFG:-<missing>}"
if echo "$L3_CFG" | grep -q '"enabled": false'; then
	echo "L3 OK"
else
	echo "L3 FAIL: /sysmon global off 没有写配置 —— 扩展命令没执行"
	fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
	echo "ALL THREE LAYERS PASSED"
else
	echo "SMOKE FAILED"
	exit 1
fi
