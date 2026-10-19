# shellcheck disable=SC2046  # 本文件是 Makefile：$(...) 是 make 变量展开，不是命令替换
# pi-sysmon 容器化试跑 —— 一键入口（模式对齐 pi-legion/test/docker）
#
#   cd test/docker && make help
#
# 三条路：
#   real      真模型（挂宿主 auth + models-store，--network=host）—— 日常看效果
#   mock      容器内 mock LLM —— 不碰宿主模型，也能看到 Tokens 图动起来
#   tui-visual 确定性回归：mock + tmux 抓帧 + 断言 + PNG 取证
#
# 路径全部从 Makefile 位置反推仓库根，不硬编码 /root/...

SHELL := /bin/bash
# 注意：不能靠 `SHELLFLAGS := -eu -o pipefail -c` 来收 pipefail —— 实测对本 Makefile
# 的 recipe 不生效（make 对 .SHELLFLAGS 的处理与 recipe 前缀有关）。
# 改为在 build recipe 里显式 `set -o pipefail`：否则 `docker build | tee | tail`
# 只取最后一段的退出码，构建失败也返回 0（reviewer 实测）。
ROOT  := $(shell cd "$(dir $(lastword $(MAKEFILE_LIST)))/../.." && pwd)
DOCK  := $(ROOT)/test/docker

NAME  ?= pi-sysmon-real
IMAGE ?= pi-sysmon-sandbox:latest
MODEL ?= workbuddy/hy4-preview-ioa
# mock 与真模型的挂载/网络不同，容器名必须分开：共用名字时 ensure() 会拿
# mock 容器去跑真模型，报「Model not found」（reviewer 实测串台）。
MOCK_NAME ?= $(NAME)-mock

COLS ?= 140
ROWS ?= 40
TPS  ?= 40

.PHONY: help build rebuild run it mock print shell status smoke tui-visual clean down

help: ## 显示帮助
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}'

build: ## 构建沙箱镜像（首次约 1.5 分钟，日志 tee 到 /tmp/pi-sysmon-build.log）
	@echo "构建中 → /tmp/pi-sysmon-build.log"
	@set -o pipefail; docker build -t "$(IMAGE)" -f "$(DOCK)/Dockerfile" "$(ROOT)" 2>&1 \
	  | tee /tmp/pi-sysmon-build.log | tail -3

rebuild: clean ## 重建镜像 + 删掉旧容器（改 Dockerfile / 升 pi 版本后跑这个）
	@$(MAKE) build

run: ## 起容器并直接进入 pi（真模型）—— 日常用这个
	@docker image inspect "$(IMAGE)" >/dev/null 2>&1 || $(MAKE) build
	@env PI_DOCKER_IMAGE="$(IMAGE)" PI_DOCKER_NAME="$(NAME)" PI_MODEL="$(MODEL)" \
	  MOCK_TPS="$(TPS)" TUI_COLS="$(COLS)" TUI_ROWS="$(ROWS)" \
	  bash "$(DOCK)/run-real.sh"

it: run ## run 的别名

mock: ## 容器内 mock LLM，不碰宿主模型也能看图表（含 Tokens）
	@docker image inspect "$(IMAGE)" >/dev/null 2>&1 || $(MAKE) build
	@env PI_DOCKER_IMAGE="$(IMAGE)" PI_DOCKER_NAME="$(MOCK_NAME)" \
	  TUI_COLS="$(COLS)" TUI_ROWS="$(ROWS)" MOCK_TPS="$(TPS)" \
	  bash "$(DOCK)/run-real.sh" --mock

print: ## 非交互问一句（PROMPT="..."），验证模型可达
	@docker image inspect "$(IMAGE)" >/dev/null 2>&1 || $(MAKE) build
	@env PI_DOCKER_IMAGE="$(IMAGE)" PI_DOCKER_NAME="$(NAME)" PI_MODEL="$(MODEL)" \
	  MOCK_TPS="$(TPS)" bash "$(DOCK)/run-real.sh" --print "$(PROMPT)"

shell: ## 只进容器 bash（不自动跑 pi）
	@docker image inspect "$(IMAGE)" >/dev/null 2>&1 || $(MAKE) build
	@env PI_DOCKER_IMAGE="$(IMAGE)" PI_DOCKER_NAME="$(NAME)" \
	  bash "$(DOCK)/run-real.sh" --shell

smoke: ## 三层冒烟：模型可达 → 插件加载 → 扩展命令真执行
	@bash "$(DOCK)/smoke-real.sh" "$(MODEL)" "$(NAME)"

tui-visual: ## 确定性 TUI 回归（COLS/ROWS/TPS 可调）
	@docker image inspect "$(IMAGE)" >/dev/null 2>&1 || $(MAKE) build
	@env TUI_COLS="$(COLS)" TUI_ROWS="$(ROWS)" MOCK_TPS="$(TPS)" \
	  docker run --rm \
	  -e TUI_COLS -e TUI_ROWS -e MOCK_TPS \
	  -v "$(ROOT)":/plugin -w /plugin "$(IMAGE)" \
	  bash test/docker/verify-tui-visual.sh

status: ## 容器与镜像状态
	@docker ps -a --filter name=$(NAME) --filter name=$(MOCK_NAME) \
	  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
	@docker image inspect "$(IMAGE)" >/dev/null 2>&1 \
	  && echo "$(IMAGE) 已构建" || echo "（镜像 $(IMAGE) 未构建）"
	@echo "--- 模型目录（真模型路径）"
	@docker exec $(NAME) pi --list-models 2>/dev/null | head -3 \
	  || echo "  容器 $(NAME) 未运行"

down: clean ## clean 的别名（与 clean 等价）
clean: ## 删容器（镜像保留）
	@docker rm -f $(NAME) $(MOCK_NAME) >/dev/null 2>&1 \
	  && echo "已删 $(NAME) / $(MOCK_NAME)" || echo "容器不存在"
