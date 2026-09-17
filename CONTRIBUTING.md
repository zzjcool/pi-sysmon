# 贡献指南

## 环境

- Node.js >= 22.19（需要 `--experimental-strip-types` 直接跑 TS）
- 要把扩展装进本机 pi 测试交互效果，需要一个可用的 pi

## 开发流程

```bash
git clone <repo> && cd pi-sysmon
npm install

# 改 src/ 下的源码

npm run check        # 类型检查 + 单元测试，必须全绿
npm run build:single # 改了多文件源码后重新生成 dist/pi-sysmon.ts
```

### 在本机 pi 里试跑

```bash
# 方式一：临时加载（不改动你的 pi 配置）
pi -e ./src/index.ts

# 方式二：装到扩展目录（单文件形态，最接近真实用户）
npm run build:single
cp dist/pi-sysmon.ts ~/.pi/agent/extensions/pi-sysmon.ts
```

装好后重启 pi，底部应出现折线图（默认开启）。`/sysmon off` 关闭，
`/sysmon chart|line|footer` 切换模式。

## 代码约定

- **`src/braille.ts` 必须是纯函数**：输入数值数组，输出字符串数组，不碰
  `process`、不读文件、不持有状态。这样它才能脱离 pi 单独测试。
- 新增采集指标请放在 `src/metrics.ts`，并保证**非 Linux 平台不抛异常**
  （所有 `/proc` 读取都要有 try/catch 兜底）。
- 新增布局/渲染请放在 `src/chart-panel.ts`。

## 提交前自查（重要）

自定义 TUI 组件有两个会**搞坏用户环境**的坑，改渲染代码时务必检查：

1. **每一行的可见宽度不得超过传入的 `width`。**
   pi 发现越界会抛 `uncaughtException` 并**直接退出**。
   - 用 `truncateToWidth(line, width)`，不要用 `String.slice()`（按字节切，会误算 ANSI 转义）。
   - 宽字符/CJK 要用 `visibleWidth()` 计算。
   - 改了布局逻辑后，建议跑一遍脚本化的宽度断言（参考历史 PR）。

2. **面板高度必须恒定。**
   若组件在有数据 / 无数据时返回不同行数，编辑器会上下位移，
   导致用户「选中文字后复制不了」。无数据时也应占满同样行数（填占位内容）。

## 测试

测试用 `node:test`，无需额外依赖：

```bash
npm test
```

请为以下内容补测试：
- `braille.ts` 的位映射、坐标映射、边界输入（空/全零/单点/`NaN`/`Infinity`）
- 渲染输出每行的可见宽度恰好等于请求宽度
- 面板在有无数据时高度一致

## 提交 PR

- 一个 PR 做一件事，附上动机说明
- 说明你**实际怎么验证的**（命令 + 输出），不要只说「应该没问题」
- 涉及交互渲染的改动，请附上终端截图或 pty 抓取的帧
