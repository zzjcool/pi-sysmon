# 容器化试跑（test/docker）

把本仓库源码挂进一个干净容器，用容器里的 pi 直接看插件的真实渲染效果。
不需要在宿主机装 pi 插件、不污染本地 `~/.pi/agent`，改源码后**不用重建镜像**（源码是运行期挂载）。

模式对齐 [`pi-legion/test/docker`](https://github.com/zzjcool/pi-legion/tree/master/test/docker)
（那边已跑通 40+ issue，别自创）。

## 一键用法

```sh
cd test/docker
make help         # 全部目标
make build        # 构建镜像（首次约 1.5 分钟，日志 tee 到 /tmp/pi-sysmon-build.log）
make run          # 起容器并直接进 pi（真模型）—— 日常看效果用这个
```

**看 Tokens 图动起来但不碰宿主模型：**

```sh
make mock         # 容器内起 mock LLM（按 40 tok/s 节流流式吐字）
```

进 pi 后图表面板就在编辑器下方。发一句话即可看到 Tokens 曲线与 `~Nt/s`、`↑↓R`、`⌀` 读数。
`/sysmon chart|line|footer|off` 切换形态，`/sysmon global off` 改全局默认。

**其余目标：**

```sh
make it           # run 的别名
make print PROMPT="你好"   # 非交互问一句，验证模型可达
make shell        # 只进容器 bash
make smoke        # 三层冒烟：模型可达 → 插件加载 → 扩展命令真执行
make tui-visual   # 确定性 TUI 回归（mock + tmux 抓帧 + 断言 + PNG 取证）
make status       # 容器与镜像状态
make clean        # 删容器（镜像保留）
make rebuild      # 重建镜像 + 删旧容器（改 Dockerfile / 升 pi 版本后跑）
```

路径全部从 Makefile 位置反推仓库根，不硬编码 `/root/...`。
换模型：`make run MODEL=workbuddy/gpt-6-luna`。

## 三条路

| 路 | 用途 | 网络 | 模型 |
| --- | --- | --- | --- |
| `make run` | 真模型交互/体验 | `--network=host`（**必须**：接入点是宿主进程） | 宿主网关 |
| `make mock` | 不碰宿主模型也能看图表动 | bridge | 容器内 mock LLM |
| `make tui-visual` | 确定性回归（可进 CI） | bridge | 容器内 mock LLM |

### 为什么真模型必须 `--network=host`

网关是**宿主进程**。bridge 网络下容器里的 `localhost:3425` 是容器自己，
`host.docker.internal` 默认也不解析。用 host 网络后 `localhost:3425` 直通，
**`auth.json` 的 baseUrl 一个字都不用改**。

真模型容器的挂载：

```text
<repo>                        → /plugin           ro  源码，改宿主即生效
~/.pi/agent/auth.json         → 同路径             ro  模型接入点
~/.pi/agent/models-store.json → 同路径             rw  pi 要写回 checkedAt
```

## 为什么源码可以只读挂载

pi-sysmon 只往 **`$PI_CODING_AGENT_DIR/pi-sysmon.json`** 写（`src/index.ts` 的
`configPath()`），不碰 `cwd`、不碰会话文件。所以 `/plugin:ro` 完全可行 ——
与 pi-legion 不同，这个插件没有 `cwd/.pi-subagents/` 那类按工作目录落盘的行为。

容器的工作目录固定 `/root/work`。**不要在容器里 `cd /plugin` 再跑 pi**：
那是只读挂载，pi 本体要在 agent dir 之外写东西时会失败。

## 镜像里装了什么、为什么

- `pi@1.3.0`（build-arg `PI_VERSION` 可改）：被测宿主。
- `pi-any-endpoint@0.1.3`：注册 any-endpoint provider，真模型路径读宿主 `auth.json` 用。
  挂宿主的 npm 包不行 —— `settings.json` 里的 `npm:` 包要重跑安装，直接烧进镜像最稳。
- `pi install /plugin`：**必须登记挂载点**，否则容器里 `pi list` 只有镜像自带的包，
  本仓库插件静默缺席（模型照样能调通，所以不查 `pi list` 发现不了）。
- `ripgrep` + `fd-find`：缺了 pi 每次启动从 GitHub 下静态二进制到 `~/.pi/agent/bin`。
- `tmux` / `python3-pil` / `fonts-noto-cjk`：TUI 驱动、ANSI→PNG 渲染。
- **`fonts-dejavu-core`**：`NotoSansCJK` 和 `DejaVuSansMono` **都没有盲文点阵字形**
  （U+2800–U+28FF），只有比例变体 `DejaVuSans` 有。而盲文曲线就是这个插件的全部图形 ——
  缺字体时取证 PNG 里的曲线全是方框（这个坑实际踩过）。Dockerfile 里有存在性守卫。
- `set -g extended-keys on`：不加 tmux 每次捕获都带一行 warning banner，且 modified Enter 异常。

`.dockerignore` 排除了 `node_modules` / 抓帧产物 / `.git`，否则构建上下文要 tar 几百 MB。

## 为什么 L2/L3 冒烟不能省

`make smoke` 的三层各自堵一类静默失效：

- **L1** 只证明模型可达。镜像自带的包照样能跑模型，但本仓库插件可能压根没加载。
- **L2** 查 `pi list` 里有 `/plugin`：`/plugin` 未登记为 package 时就是「L1 通、插件缺席」。
- **L3** 让扩展的**命令处理器真跑一遍**：`pi -e src/index.ts --print "/sysmon global off"`
  必须把 `{"enabled": false}` 落到隔离的 `pi-sysmon.json`。这条不需要模型，
  但只有扩展真加载并注册了 `sysmon` 命令才可能通过 —— 是最硬的一条。

## TUI 回归（make tui-visual）

`verify-tui-visual.sh` 在容器内：随机端口起 mock LLM → 隔离 pi home（`packages: ["/plugin"]`）
→ tmux 起 pi（`--tui-mode fullscreen`）→ 等面板出现 → 抽**流式进行中**的帧 → 抓帧 → 断言 → 渲染 PNG。
产物写 `test/tui/artifacts/<时间戳>-<pid>/`（已 gitignore；pid 避免并行跑互盖）。

断言锚点为什么是这几个：

| 断言 | 为什么可信 |
| --- | --- |
| `┌ CPU` / `Memory` / `Network` / `Tokens` | 块名由 `src/blocks.ts` 的 `name` 画出，**插件真加载**的唯一可信证据 |
| `└ 60s` / `0s ┘` | 底边框时间轴，纯 ASCII。**必须带边框锚点**：裸 `0s` 会被 `60s` 命中，断言就恒真了 |
| `~Nt/s`（带 `~`） | 标题栏速率读数。Y 轴刻度是**裸**的 `40t/s`，带 `~` 才是「真在流」 |
| `◔N%` / `·N%` / `⌀N%` | 插件自己的标题栏读数。**不**断言 `↑/↓/R`：chart widget 模式 `showTokenTotals=false`，屏幕上那份是 pi 自带 footer，测它等于测宿主 |
| assistant 回复（排除 `MOCK_SAY:` 行） | 用户输入回显里含同样的文本，用回显判完成会让断言恒真 |
| 可见宽度 ≤ 列数 | pi 某行超宽会直接崩溃退出（本项目历史事故） |
| 交互前后行数相同 + 面板仍在刷新 | 前者防抖动，后者防「卡死被当成稳定」 |

四个踩过的坑（脚本里都有注释）：

1. **不能等「帧稳定」**：sysmon 按 `PI_SYSMON_INTERVAL`（默认 1s）每秒重绘，曲线永远在动。
   等整帧相同只会白等满超时 —— 脚本比的是**去掉非 ASCII 与数字后的骨架**。
2. **骨架不能用多字节字面量做 `sed` 字符类**：`sed 's/[]▁…]//g'` 在 UTF-8 locale 下
   报 `Invalid collation character` 并输出空串，两侧都是空 → 「收敛」恒真（实测过）。
   现在走 `LC_ALL=C tr -d '\200-\377'` + 数字归一化，与 locale 无关。
3. **不能用 awk `length()` 量宽度**：那是字节数，边框/盲文/中文一个字 3 字节，会误报
   「420 列」。脚本用 python3 按 East Asian Width 算可见宽度。
4. **低 TPS 下的时序**：mock 按「流式持续时长」定回复长度（`MOCK_STREAM_SECS`，默认 4s），
   否则 `MOCK_TPS=1` 要吐 150 秒才能结束、`MOCK_TPS=40` 又只有 1.5s 窗口。
   现在 TPS=1 / 10 / 40 都稳定通过。

## 与 pi-legion 的差异

| 维度 | pi-legion | pi-sysmon |
| --- | --- | --- |
| mock LLM | `test/mock-llm/`（TS + scenario 引擎，subagent 语义） | `test/docker/mock-llm.mjs`（单文件，**按 TPS 节流**） |
| 为什么要自己写 | —— | legions 的 mock 在一个同步循环里 flush 所有 chunk，TPS 只会有一个尖峰；这里每个 chunk `sleep` |
| 冒烟 L3 | 问模型「有没有 subagent 工具」 | `pi -e ... --print "/sysmon global off"` 后查配置文件 |
| 镜像发布 | ghcr 自动推送 | 仅本地构建（`pi-sysmon-sandbox:latest`） |
