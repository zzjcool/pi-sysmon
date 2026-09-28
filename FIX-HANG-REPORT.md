# pi-sysmon fix-hang 修复摘要（0.8.2）

## 现象（加粗）

**pi TUI 每约 6 秒被堵死约 5 秒，且网络图首拍出现 ~162GB/s 假尖峰。**

受影响环境：macOS + 腾讯云盾 YunDun/iOA（其网络扩展 `NGNAppProxyExtension` 创建虚拟网卡 `nan0`）。

## 根因

云盾的 `nan0` 接口使任何触碰它的 `netstat` 阻塞约 5 秒（实测 `netstat -ib` 全量 5.06s，`netstat -I nan0 -b` 单查 5.03s，其他接口 ≤15ms）。而 `src/metrics.ts` 的 `readNetDarwin()` 每 1 秒在主线程 `spawnSync(netstat -ib)` 同步执行——实测把 JS 线程阻塞 5003ms 直到 SIGKILL，且 stdout 为空（数据也拿不到）。雪上加霜：修复后首个真实读数落地时，`(rx - 0) / dt` 会把整机开机以来的累计流量当成一拍速率（~162GB/s 假尖峰）。

## 修法（对照任务 7 项要求）

### 1. 常驻异步子进程（src/metrics.ts `readNetDarwin`）
- `spawn(netstat -ib)` 异步发起，模块级 `netLastRx/netLastTx` 保存最近一次**成功完成**的读数。
- `collect()` 每次只触发一次异步 spawn，同步返回最近读数（计数器是累计值，旧一拍无害）。
- `netstatBusy` 布尔防重入：正在跑则跳过，绝不堆积子进程。

### 2. 15s SIGKILL 硬上限 + finish 清理
- `setTimeout(() => child.kill("SIGKILL"), 15_000)` + `.unref()`（沿用 `execText` 的教训：wedged 子进程可能永远收不到/忽略 TERM）。
- `error` 与 `close` 都走同一个幂等 `finish`；finish 里解析 per-child 的 stdout 缓冲，**仅在 rx/tx > 0 时更新** `netLastRx/netLastTx`（坏输出不清零好读数）。
- child 身份守卫：`stopCpuTempDarwin()` 后旧子进程迟到的 close 不会误释放新子进程的 busy 槽、不会污染新读数。

### 3. stopCpuTempDarwin() 同步回收
- 对 in-flight 的 netstat 子进程执行与 macmon 相同的处理：TERM → 500ms 后 SIGKILL（`unref()`），并同步释放 busy 槽。

### 4. safeRate 防假尖峰（createCollector）
- 新导出 `safeRate(prev, cur, dt)`：`prev <= 0 || dt <= 0` 时返回 0，否则 `Math.max(0, (cur-prev)/dt)`。
- 四个速率（rxBps/txBps/readBps/writeBps）全部走 safeRate；首读落地那一拍记 0，下一拍恢复正常。
- 磁盘 ioreg 保持同步（实测 ~20ms，无需改）。

### 5. 回归测试（test/metrics.test.ts，+299 行）
- `parseNetstatIb`：原有 5 个用例不变（解析器未动）。
- `safeRate`：0 基线防尖峰、正常差分、计数器复位钳 0、dt=0 防 Infinity，共 2 个用例。
- `readNetDarwin`（经 `setNetstatCommandForTest` 命令注入 seam，**Linux CI 也能跑**）：
  - wedged netstat 持槽期间 15 连调用每次 <100ms 且槽最终自愈；
  - busy 门：恰好 2 次 spawn（计数文件取证）；
  - wedged 空输出不清零最后一笔好读数；
  - ENOENT 降级且不卡槽；
  - `stopCpuTempDarwin` 回收 in-flight 子进程后槽立即可复用。
- darwin 端到端：真实 netstat 下首拍 0 速率、读数落地、无 >10GB/s 尖峰。
- 交叉环境教训：本机（受害者机器）端点安全软件使子进程启动延迟 ~450ms，固定 sleep 断言会环境性假失败——已全部改为 `waitFor` 轮询（50ms 步进、5s 预算）。

### 6. 验证
- `npm run check`（typecheck + 233 测试）**全绿**；`npm run build:single` bundle 自包含检查通过。
- `node --experimental-strip-types scripts/verify-no-block.ts`（新增，已纳入 tsconfig typecheck）：40 次 collect @250ms，实测 **max 32.7ms / avg 25.8ms**（预算 100ms），40 拍 39 拍拿到网络读数，0 尖峰。注意：这台机器本身就装着云盾（nan0 元凶），异步化后即使 netstat 依旧慢也完全不阻塞主线程。

### 7. CHANGELOG.md
- 按项目三段式（现象加粗 → 根因 → 修法）新增 `[0.8.2]` 条目。

## 变更文件

| 文件 | 变更 |
| --- | --- |
| `src/metrics.ts` | readNetDarwin 异步化 + safeRate + stop 回收 + 测试 seam（+172/-12） |
| `test/metrics.test.ts` | 新增 8 个测试用例 + waitFor/shHelper 辅助（+299） |
| `scripts/verify-no-block.ts` | 新增 10 秒实测脚本 |
| `tsconfig.json` | include 补 `scripts/**/*.ts`（新脚本纳入 typecheck） |
| `CHANGELOG.md` | 0.8.2 条目 |

## 验证命令复跑

```bash
npm run check                                    # 233/233 pass
node --experimental-strip-types scripts/verify-no-block.ts   # max ~33ms, PASS
```
