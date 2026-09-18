# 设计记录：Tokens（LLM 吞吐）图

这份文档记录了第四张图（Tokens）的设计过程与决策依据 ——
从可行性调研、分工实现，到对抗式审查找出的问题与修法。

原始需求：「能不能增加一个 token 的速度的图，就是 pi 和 llm api 吞吐 tps 的速度，
这样默认四个图。」

## 调研结论（两份独立调研报告交叉验证，关键事实均已复核）

### 关键事实

1. `pi.on("message_update")` 在交互式 TUI **每 delta 都发**
   （agent-loop 发出 → agent-session 转发 → 扩展收到）。
2. **`partial.usage` 流式期间不可用**：`text_delta` 事件里 0 处 usage；
   Anthropic 只在末尾 `message_delta` 给 output，OpenAI/Google 同样只在末块。
   ⇒ 逐帧只能用 **delta 文本估算**，精确值只能在 `message_end` 拿。
3. `chooseColumns` 目前**写死最多 3 列**，count=4 会排成 3+1（第二行只有 1 块 + 空位）。
   实测 w=150/200 → cols=3 bands=2 rows=16。
4. 4 图布局修复只需改 `chooseColumns`：≥96 列用 4 列（4×1，8 行），
   48–95 用 2 列（2×2，16 行），<48 用 1 列。行预算 18 永远够。

## 决策

- **TPS 默认开启**（用户要求默认 4 图），可用 `PI_SYSMON_TOKENS=0` 关闭。
- 采样：事件侧 O(1) 累加，复用现有 1s interval 出桶 → `hist.tps` 环形缓冲，
  复用 `rateAxis` 的 60s 窗口与「顶端=窗口最高值」语义。
- 估算器：`ceil(asciiish/4) + cjk`（CJK 1 字≈1 token），读数带 `~` 表示估算。
- 计入 `text_delta + thinking_delta + toolcall_delta`；**不碰** `*_end.content`（重复计数）。
- 新模块 `src/tokens.ts`（纯函数 + 闭包 meter），可单测。

## 分工（不同 agent 并行，按文件不相交划分）

| 执行者 | 负责文件 | 内容 |
| --- | --- | --- |
| worker A | `src/tokens.ts`、`test/tokens.test.ts`（**全新文件**） | 估算器 + 累积 meter + fmtTps |
| worker B | `src/chart-panel.ts`、`test/layout.test.ts` | `chooseColumns(width, count)` 支持 4 列 |
| 主 agent | `src/blocks.ts`、`src/index.ts`、其余测试与文档 | 集成：History.tps、第 4 块、事件接线 |

## 验收

- `npm run check` 全绿（严格 TS：noUncheckedIndexedAccess + noUnusedLocals）
- 打包两条自检通过
- **真机 pi 抓帧**：4 图并排、窄宽度降级、无越界崩溃
- 对抗式 review 后再交付

---

## 实施结果（已完成）

| 执行者 | 产出 |
| --- | --- |
| worker A | `src/tokens.ts` + `test/tokens.test.ts`（估算器 / meter / fmtTps） |
| worker B | `src/chart-panel.ts` 的 `chooseColumns(width, count)` 支持 4 列 + 4 条布局测试 |
| 主 agent | `src/blocks.ts`（History.tps、tokenAxis、fmtTokensTotal、Tokens 块）、`src/index.ts`（message_update 接线、meter、stop 排水）、文档 |
| 2 个独立 review agent | 对抗式审查，找出 2 critical + 3 major，已全部修复 |

### 对抗式审查找出的真问题（已修 + 已加回归测试）

1. **全宽度扫描静默丢弃 Tokens 块**（critical）：`count = showDisks ? 4 : 3` 手算，
   而 Tokens 默认开 → 4 块渲染进 3 格网格，第 4 块永远不被索引。
   本仓库最重要的崩溃防线（越界 = pi 退出）对 Tokens **一次都没验证过**。
   改为 `count = blocks.length`，并覆盖 4 种开关组合 × 非零读数。
2. **`tokenAxis` / `fmtTokensTotal` 零测试**（critical）：与 `rateAxis` 同款的定宽约束
   没有任何测试。已加全量级扫描 + 单位断言（绝不允许出现 `KB`）。
3. **窄块 + 高 TPS 时读数整块消失**（major）：实测 `~12.3K tok/s`（12 列）在
   24 列块里放不下 → 只剩空框。改用紧凑格式 `~12.3Kt/s`（与 y 轴刻度同款）。
4. **块数双账本**（critical）：`index.ts` 手算 `blockCount` 与 `buildBlocks` 内部 if
   是两个独立来源，漂移时静默画残缺面板。改为单一真相来源 `blocks.length`。
5. **stop-drain 与坏输入防御零测试**（major）：已补 meter 级序列测试 +
   `add(null/undefined/42)` 容忍测试。

### 最终验收

- `npm run check` 全绿，typecheck 干净
- 打包两条自检通过（含新增的 `tokens.ts` 模块）
- **真机 pi 抓帧**：四图并排（150 列 4×1）、60 列 2×2、40 列 1×4 均正常
- **真实 LLM 流式验证**：Tokens 图画出真实曲线，读数与 pi 状态栏的
  `⚡ t/s (avg)` 相互印证
- 回归测试经**注入旧行为验证**（注入后 2 条失败，还原后全绿）
