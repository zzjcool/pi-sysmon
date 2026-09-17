<div align="center">

# pi-sysmon

**在 [pi](https://github.com/earendil-works/pi) 里显示 bottom 风格的 braille 折线图**

CPU · 内存 · 网络 —— 用盲文点阵字符画的实时历史曲线

[![test](https://img.shields.io/badge/tests-13%2F13-brightgreen)](#测试)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

```
◆ sysmon CPU 12%  MEM 53% 33G  NET ↑2.3K/s ↓8.6K/s  win 4m
100% │
 50% │        ⢀⣀⡠⠤⠒⠉⠑⠒⠤⣀
  0% │⠤⠤⠤⣀⣀⡀              ⠉⠉⠒⠤⣀
     └──────────────────────────────────────
 -4m                                    now
100% │
 50% │⠒⠒⠒⠒⠒⠒⣀⣀⣀⡠⠤⠤⠔⠒⠒⠒⠒⣀⣀⡀
  0% │
     └──────────────────────────────────────
 -4m                                    now
```

## 特性

- **真正的折线图**，不是进度条或 sparkline —— 每个字符编码 2×4 个盲文点子像素，等效把终端分辨率放大 8 倍
- **零依赖** —— 只用 Node 内置模块 + pi 的公开扩展 API
- **直接读 `/proc`** —— 不需要 `systeminformation` / `pidusage` 之类的包
- **带坐标轴** —— y 轴刻度、x 轴线、时间窗标签（`-4m` → `now`），复刻 bottom 的排版
- **状态持久化** —— 开关和模式记在配置文件里，重启保留
- **多显示器模式** —— 图表（默认）/ 一行文字 / 整块底部
- **纯 Linux 友好，其他平台不崩** —— 非 Linux 上采集自动退化为零值

## 安装

### 单文件（推荐，最简单）

```bash
npm run build:single    # 生成 dist/pi-sysmon.ts
cp dist/pi-sysmon.ts ~/.pi/agent/extensions/pi-sysmon.ts
```

重启 pi 即可看到曲线，**默认就是开启的**。

### 目录形式（多文件）

```bash
cp -r . ~/.pi/agent/extensions/pi-sysmon
```

> ⚠️ 目录形式**必须放在子目录里**。pi 的自动发现会把 `extensions/` 下的每个 `.ts`
> 都当成扩展加载，平铺多个文件会导致 `braille.ts` 被当作扩展而整个加载失败。

### 从 npm / git 安装

```bash
pi install git:github.com/<you>/pi-sysmon
```

## 使用

```
/sysmon                开 / 关（会持久化）
/sysmon on | off       显式开 / 关
/sysmon chart          图表模式（默认）
/sysmon line           一行文字模式
/sysmon footer         用图表替换整个底部（不受 widget 10 行限制）
```

### 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_SYSMON_INTERVAL` | `1000` | 采样间隔（毫秒，下限 500） |
| `PI_SYSMON_POINTS` | 随终端宽度 | 历史点数（即时间窗长度） |
| `PI_SYSMON_CHART_HEIGHT` | `3` | 每张图的高度（1–6 行） |
| `PI_SYSMON_MODE` | `chart` | 初始模式 |

开关状态写在 `<configDir>/pi-sysmon.json`（`configDir` 默认 `~/.pi/agent`）。

## 实现说明

图表没有用任何 TUI 绘图库，而是自己合成字符。核心是 **braille 点阵**：

每个 braille 字符（U+2800–U+28FF）对应 8 个可独立点亮的点，排成 2 列 × 4 行：

```
(0,0) (1,0)      bit0  bit3
(0,1) (1,1)  →   bit1  bit4
(0,2) (1,2)      bit2  bit5
(0,3) (1,3)      bit6  bit7
```

所以一个 `width × height` 的字符区域，实际分辨率是 `2*width × 4*height`。
把数据点线性映射到子像素坐标，再用 **Bresenham** 连成线，就能得到平滑的折线。

这与 [bottom](https://github.com/ClementTsang/bottom) 的做法一致（ratatui 的
`Marker::Braille`）。我们对齐了 bottom 的这些参数：

| 项 | bottom | 本项目 |
| --- | --- | --- |
| 绘制字符 | `Marker::Braille`（2×4 子像素） | 同 |
| 连线算法 | Bresenham | 同 |
| 百分比图 y 轴 | 固定 `0 .. 100.5` | 同 |
| 动态图 y 轴 | 窗口内最大值 × 1.5（留白） | 同 |
| 网格线 | 无，只有轴线 + y 刻度 + 两端时间标签 | 同 |
| 默认采样间隔 | 1000 ms | 同 |

### 架构

```
src/
├── metrics.ts      # 采集层：读 /proc/{stat,meminfo,net/dev,diskstats} + os.loadavg
├── braille.ts      # 渲染层：数据 → braille 点阵 → 字符行（纯函数，无副作用）
├── chart-panel.ts  # 布局层：坐标轴、刻度、时间标签、顶部摘要
└── index.ts        # 扩展层：pi 生命周期、命令、配置持久化、定时刷新
```

分层原则：`braille.ts` 是**纯函数**（输入数值数组，输出字符串数组），因此可以脱离
pi 单独测试与复用；`metrics.ts` 只负责读数，不关心怎么显示。

## 测试

```bash
npm test          # 13 项单元测试
npm run typecheck # tsc strict
npm run check     # 两者都跑
```

测试覆盖 braille 位映射（对照 Unicode 标准逐点验证）、坐标映射、输出尺寸、
边界输入（空数据 / 全零 / 单点 / `NaN` / `Infinity` / 极小宽度）。

## 开发时踩过的坑

这些是实际踩到并修复的，记下来避免重犯：

1. **宽度算错会让 pi 直接崩溃退出。** pi 的渲染器发现某行超过终端宽度会抛
   `uncaughtException` 并退出。自定义组件必须用 `truncateToWidth()` 截断，
   且不能用 `String.slice()`（它按字节算，会把 ANSI 转义也算进去）。
2. **面板高度变化会挪动编辑器，破坏鼠标选区。** 若组件在有/无数据时行数不同，
   编辑器会上下位移，导致「选中文字后复制不了」。所以高度必须恒定，
   无数据时也要占满同样的行数。
3. **多文件平铺安装会让 pi 启动失败。** 见上文安装说明。
4. **`yMax <= 0` 或数据含 `NaN` 会算出 `NaN` 坐标**，非空断言 `!` 会掩盖这个
   问题并在运行时崩溃。所有坐标都要做有限性检查。
5. **不同扩展的 `setStatus` 共享同一行**，窄终端上会互相挤压截断。

## 贡献

欢迎 issue 和 PR。跑 `npm run check` 确保测试与类型检查通过。

## 许可证

[MIT](LICENSE)
