# pi-sysmon 容器化试跑环境：容器内装 pi，仓库源码挂到 /plugin 直接加载。
#
# 两个用途（见 test/docker/README.md）：
#   1. 交互看效果 —— docker 里起 pi，sysmon 图表就挂在编辑器下面；
#   2. 确定性回归 —— 容器内 mock LLM（test/docker/mock-llm.mjs）+ tmux 抓帧 + 断言。
#
# 模式对齐 pi-legion/test/docker/Dockerfile.tui-sandbox（那边已跑通，别自创）：
#   · tmux 驱动 TUI；python3+PIL 渲染 ANSI 帧；fonts-noto-cjk 保证 CJK/块元素不渲染成方框
#   · ripgrep/fd-find 预装 —— 缺了 pi 每次启动会从 GitHub 下静态二进制到 ~/.pi/agent/bin
#   · `pi install /plugin` 必须在构建期登记，否则容器里本仓库插件静默缺席

FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux python3 python3-pil fonts-noto-cjk fonts-dejavu-core curl ca-certificates \
      ripgrep fd-find \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
# fonts-dejavu-core 不是可选项：NotoSansCJK **没有盲文点阵字形**（U+2800–U+28FF），
# 而盲文曲线就是这个插件的全部图形。缺了它，取证 PNG 里的曲线全是方框，
# 等于把「看曲线对不对」这个唯一目的工了。ansi2png.py 逐字回退到 DejaVu。

# 全局安装 pi（被测宿主）。版本可用 build-arg 固定；默认 1.3.0 对齐
# package.json 的 devDependencies 主版本，避免 latest 漂移导致取帧差异。
ARG PI_VERSION=1.3.0
RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"

# 真模型沙箱靠宿主 auth.json 里的 any-endpoint 凭据；provider 本体必须烧进镜像
# （挂宿主的 npm: 包要重跑安装，直接烧录最稳 —— 做法对齐 pi-legion）。
ARG ANY_ENDPOINT_VERSION=0.1.3
RUN pi install "npm:pi-any-endpoint@${ANY_ENDPOINT_VERSION}"

# 守卫：渲染器的盲文回退依赖 DejaVu**比例**变体（Mono 变体不含盲文字形，实测）。
# 用文件存在性而非 fc-list —— 镜像不装 fontconfig，fc-list 根本不在这里。
RUN test -f /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
    || { echo "FAIL: fonts-dejavu-core missing — 盲文点阵会渲染成方框"; exit 1; }

# 不加这条，tmux 每次捕获都带一行 warning banner，且 modified Enter 键行为异常。
RUN echo "set -g extended-keys on" > /root/.tmux.conf

# 登记被测插件的挂载点：构建期目录为空（源码运行期才挂载），故 || true。
# 登记后 settings.json 里是相对路径 ../../../plugin，指回 /plugin，与挂载位置解耦。
RUN mkdir -p /plugin && pi install /plugin || true

# mock LLM 烧进镜像：即使不挂仓库也能起（verify 脚本优先用挂载里的最新版）。
COPY test/docker/mock-llm.mjs /opt/mock/mock-llm.mjs
# ANSI→PNG 渲染器兜底副本（仓库内 test/tui/ansi2png.py 存在时优先用它）。
COPY test/tui/ansi2png.py /opt/tui/ansi2png.py

# pi 只往 PI_CODING_AGENT_DIR 写（pi-sysmon.json / sessions），/plugin 可以是只读挂载；
# 但工作目录必须是容器内可写目录，不能 cd 进挂载仓库。
WORKDIR /root/work

ENV PI_OFFLINE=1
CMD ["bash"]
