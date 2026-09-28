# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> Merges with [0.8.2]'s netstat fix below: this branch generalizes that
> netstat-only async sampler to all four darwin externals (netstat / ioreg /
> vm_stat / sysctl) on one shared `fireText` primitive, keeping 0.8.2's test
> seams, plausible-output guard and shutdown reaping — `readNetDarwin()`, the
> `safeRate` spike guard and all of its seam tests survive on the new layer.

### Changed

- **Chart mode no longer blocks the main thread on every sample (macOS) — the biggest
  performance rework since the resident-macmon fix.** Measured on an M1 (arm64, 32GB):
  - **Per-tick main-thread blocking dropped from ~43ms to ~4ms (10×).** Every 1-second
    sample used to run `netstat -ib` + `ioreg` + `sysctl`/`vm_stat` through synchronous
    `spawnSync` (netstat ≈ 17ms, ioreg ≈ 17ms, sysctl+vm_stat ≈ 5ms) — in a TUI that
    re-renders on every keystroke and streaming delta, that was visible jank and ~4% CPU
    burned forever. These four darwin externals now follow the same pattern the macmon
    temperature child already established: fire-and-forget `spawn` + parse in the
    completion callback into module-level readings; `collect()` only reads the cached
    values. Rates are computed between reading **capture timestamps** (not the tick
    clock), so an asynchronously-late refresh can't distort them; a failed refresh keeps
    the previous reading (at most one tick stale — invisible on a 60s window).
  - **Extension registration is ~45ms cheaper.** `createCollector()` used to establish
    its baselines with synchronous netstat+ioreg spawns at import/registration time;
    it now only kicks the first async refresh round (~5ms) and captures rate baselines
    on first refresh completion instead.
  - `hw.memsize` is captured once (it is a boot constant) — subsequent ticks refresh
    `vm_stat` only, one spawn saved per second.
  - Every async child keeps the SIGKILL hard-kill contract (`fireText`): a wedged
    command is still bounded by the 5s timeout, output is buffer-capped at 4MiB, and
    in-flight refreshes never overlap (one live child per command max).
  - **stderr is drained** (`resume()`): an un-read stderr pipe fills its ~64KB buffer
    and a chatty child then blocks until the SIGKILL backstop — measured with a
    6.4MB-stderr helper: never exits without the drain, ~160ms with it.
  - **A refresh that hasn't landed keeps the previous rate.** Recomputing a rate over
    an unchanged counter injected a fake 0 B/s dip into the chart (measured 187 → 0 →
    back); the rate ledger now only advances when a new reading actually landed.
  - **A permanently failed `sysctl` probe stops retrying** (`-1` sentinel): a
    missing/broken sysctl used to make every tick a 2-spawn retry storm (measured 10
    spawns in 5s); the memory total falls back to `os.totalmem()` permanently.
- **Repaint memoization in the widget render path.** pi re-renders widgets on every
  keystroke and streaming delta, but the panel's inputs only move at the sampling
  cadence (1 Hz) and on `message_end`. The component now caches its body keyed by
  `(dataVersion, width, fullscreen)` — unchanged data returns the cached rows
  (measured: ~1µs vs ~1-2ms per frame at 150 cols; during token streaming this was
  pure waste on every frame). Width/fullscreen are part of the key, so a resize or
  mode switch can never serve stale rows (the width-overflow iron rule).
- **Startup preflight no longer delays the first paint.** The dependency probe
  (`which sysctl/macmon/…`, ~12ms of synchronous spawns) now runs fully async
  (`preflightMetricsAsync`); the warning notify lands whenever the probes finish
  instead of blocking inside the first `session_start`.

### Added

- Test hook `__waitDarwinReadings()` (exported from metrics.ts): resolves once every
  in-flight async refresh has landed, so darwin live tests await deterministically
  instead of sleeping fixed amounts.
- `fireText` is exported (async twin of `execText`) and covered by regression tests:
  a chatty-stderr child must exit promptly (drain contract), and a TERM-ignoring wedged
  child must settle `null` via SIGKILL with the `onDone` callback firing exactly once.
- Regression tests pinning the render-memoization contract: repeated renders with
  unchanged data return equal rows in a fresh array (caller-side mutation can't poison
  the cache), a width change recomputes (no stale wide rows — the width iron rule), a
  fullscreen flip recomputes (chip row appears, content round-trips), and a
  `message_end` invalidates the cache (the token readouts refresh — mutation-verified:
  deleting the `dataVersion++` fails the test).
- Regression test pinning the rate-hold contract on stalled refreshes (no fake zero-dip).
- `preflightMetricsAsync()` must agree with `preflightMetrics()` on every platform.
- The collect() budget test now measures the **real** 1Hz cadence (waiting for refresh
  quiescence between timed collects) and asserts the median, not the max — immune to
  single GC pauses.
- Top-level `after()` teardown in metrics tests kills the resident macmon child, so
  name-filtered runs (`--test-name-pattern`) no longer hang forever.

## [0.8.2] — 2026-09-29

### Fixed

- **pi's TUI froze ~5 seconds out of every ~6 on macOS machines running Tencent
  YunDun/iOA (腾讯云盾).** The security suite's network extension
  (`NGNAppProxyExtension`) creates a virtual interface (`nan0`) that wedges any
  `netstat` touching it — measured on the affected host: `netstat -ib` took
  **5.06s** (a single `netstat -I nan0 -b` took 5.03s; every other interface
  answered in ≤15ms). The collector ran exactly that command **synchronously
  (`spawnSync`) on the JS thread every 1-second sample**, so the sampler blocked
  **5003ms** until the 5s timeout SIGKILLed it — with stdout empty, so the data
  wasn't even collected. Result: a frozen TUI ~5s out of every ~6s, plus a
  ~162GB/s phantom network spike on the first tick the counters finally landed.
  The fix makes the macOS network source **asynchronous**: `readNetDarwin()` now
  kicks off a resident `spawn(netstat -ib)` child and immediately returns the
  last completed reading (cumulative counters, so one tick of staleness is
  harmless). Details:
  - One child at a time (`netstatBusy` re-entrancy gate): a slow read holds the
       slot until it finishes instead of piling up children; each child has a 15s
    `SIGKILL` hard ceiling (`setTimeout` + `unref` — same lesson as `execText`:
    a wedged child may never see TERM).
  - Both `error` and `close` drain into the same `finish` cleanup; the reading
    updates only when the parsed output is plausible (`rx/tx > 0`), so a
    killed/empty child can't zero the last good counters.
  - `stopCpuTempDarwin()` (the `session_shutdown` path) reaps the in-flight
    netstat child with the same TERM → SIGKILL escalation as the macmon child.
  - `createCollector`'s rate math is now spike-guarded via `safeRate`: a 0
    baseline (the async reading not landed yet) records 0 for that tick instead
    of dividing the whole boot-time traffic by one interval — the exact source
    of the 162GB/s phantom.
  - Regression tests cover the parser (unchanged), the spike guard, and the
    sampler contracts (busy-gating, no-blocking, SIGKILL ceiling, good-output-only
    updates, shutdown reap) — the sampler ones run on any platform via a test
    command seam, so Linux CI exercises them too.
  - `scripts/verify-no-block.ts`: a ~10s live proof (40 collects at 250ms) that
    no single `collect()` blocks ≥100ms; on the nan0-affected host it measures
    max ~33ms (pre-fix: 5003ms).

## [0.8.1] — 2026-09-29

### Fixed

- **pi froze at startup on machines with a misbehaving CPU-temperature helper (macOS).**
  On an M1 Mac with a brew-installed `osx-cpu-temp` and no `macmon`, the temperature
  fallback chain ran that binary **synchronously on every 1-second sample** (the first
  one inside the `session_start` handler), and when the helper wedged in an
  uninterruptible SMC call — ignoring the soft-timeout SIGTERM, which is all Node's
  `execFileSync` `timeout` ever sends — the sampler blocked **forever**: the whole TUI
  froze at launch, and disabling the extension "fixed" it. Two independent fixes, both
  required:
  - `execText` now uses `spawnSync` with `killSignal: "SIGKILL"`: SIGKILL cannot be
    trapped, so every probe is bounded by the 5s timeout no matter what the child does.
    (Reproduced locally: `execFileSync(timeout: 1200)` against a TERM-ignoring child
    never returned — not even an exception.)
  - The helper fallback is now circuit-broken: a helper that failed, timed out, or
    produced no usable reading (e.g. `0.0°C` on Apple Silicon, where the Intel SMC key
    `TC0P` doesn't exist) is skipped for 60s instead of being retried every tick —
    a `macmon`-less machine no longer re-spawns a dead-end binary once per second.
  - `stopCpuTempDarwin()` now escalates TERM → SIGKILL (500ms grace) so a wedged
    resident `macmon` can't outlive the session as an orphan either.
- Regression tests pin the hard-kill contract: a SIGTERM-ignoring child must degrade
  to `null` within the timeout (with a test-level fail-fast backstop, because a
  regression here hangs rather than fails), plus normal-command and ENOENT semantics.
  `execText` is exported for testing.

## [0.8.0] — 2026-09-29

### Changed

- **Default title-bar orders reworked to the user's requested reading order** (chart + line modes,
  no new settings — this **is** the default behavior now):
  - **CPU**: usage → **temperature** → load averages. The `°C` reading moved from last to right
    after the usage percent, matching the block's second (red) temperature curve; the load
    averages now yield first on narrow blocks.
  - **Network**: the cumulative `Σ↓X ↑Y` unit is now **atomic** — download and upload totals appear
    **together or not at all**. Previously the pieces dropped one by one, so a width that fit the
    2-column `Σ` marker but not its values showed a dangling `Σ` reading like a rendering bug.
    Implemented via a new `Seg.atomic` flag: consecutive atomic segments are welded into one
    keep-or-drop unit in `renderBlock`'s title-bar accumulator.
  - **Tokens**: rate → `◔N%` context usage → `·N%` instantaneous hit rate → `⌀N%` cumulative hit
    rate → (footer mode: `↑ ↓ R`). Context usage moved up to the second slot, so on narrowing
    blocks the hit rates now yield before it.

## [0.7.2] — 2026-09-28

### Fixed

- **Linux CPU temperature always read 0 — the sanity window was checked on milli-°C before
  conversion.** sysfs `temp*_input` / `thermal_zone*/temp` are milli-°C, but both Linux paths
  applied the 0..150°C plausibility window **before** dividing by 1000, so every real reading
  (e.g. k10temp `Tctl` 71875 milli-°C = 71.9°C) failed the `< 150` check and returned 0 — on any
  Linux host with a readable sensor the temperature curve never appeared, while the preflight
  still said a sensor existed. Convert first, window second, in both the hwmon and thermal_zone
  paths. Caught on an Omarchy/k10temp machine; verified end-to-end there after the fix
  (`readCpuTempLinux()` 72.8°C, `collect()` 70.9°C).
- Regression tests added: milli-°C arithmetic (real readings convert, garbage rejects) plus a
  Linux-only integration test against the real `/sys` when a sensor exists. `readCpuTempLinux()`
  is now exported for testing.

## [0.7.1] — 2026-09-25

### Added

- **Startup dependency preflight** — a machine without the optional helpers used to show
  silently flat charts with no explanation; now, on the first mount per pi process, pi-sysmon
  probes whether each metric group is actually readable and fires **one** warning with the fix:
  - New `preflightMetrics()` in metrics.ts returns `{ core, temp }`: `core` = system tools /
    `/proc` readable (dead on Windows — every chart would read 0), `temp` = `macmon` /
    `osx-cpu-temp` / `istats` on macOS, a CPU-ish `hwmon` / `thermal_zone` sensor on Linux.
  - `session_start` reports async (via `setImmediate`, never blocking the first paint) and
    with a process-lifetime latch, so `/new` and `/resume` never re-warn within one pi run.
  - The temp hint is per-platform ("brew install macmon" on macOS, sysfs paths on Linux);
    the core failure says the platform is unsupported and points at `/sysmon global off`.
  - `hasCpuTempSource()` (introduced in the unreleased preflight work) is kept as a
    back-compat alias for `preflightMetrics().temp`.
- **Requirements & Platform Support section** in README (and the zh-CN edition): a per-chart
  × per-platform source matrix, the container/VM temperature caveat (host sensors are not
  exposed through sysfs there), the Node ≥ 22.19 requirement, and a preflight explanation.

### Verified

- Full suite (219 tests + typecheck) on macOS and inside linux/arm64 and linux/amd64
  containers; the probe answers `core:true/temp:false` on sensor-less containers (correct) and
  `core:false/temp:false` on a simulated `win32` platform.

## [0.7.0] — 2026-09-23

### Fixed

- **Apple Silicon Macs could not read CPU temperature (`0.0°C`, so the temperature curve silently
  disappeared).** macOS has no unprivileged CPU-temperature API, and the helpers the darwin reader
  probed — `osx-cpu-temp` and `istats` — both hard-code the **Intel** SMC key `TC0P` with `sp78`
  decoding; that key does not exist on ARM, so both just print `0.0°C` (lavoiesl/osx-cpu-temp#38,
  Chris911/iStats#107, both still open upstream). `macmon pipe --interval 1000` (brew core) is the
  only path that works on Apple Silicon today, and it **streams one JSON line per interval
  forever**:
  - It runs as a single **resident** async child whose stdout is split into lines and parsed by the
    new pure, offline-tested `parseMacmonCpuTemp` (schema `temp.cpu_temp_avg`; truncated, drifted
    and out-of-window lines all read as unknown); `collect()` only reads the cached variable, so
    sampling stays non-blocking — the spawnSync-per-sample probe it replaced blocked ~2.5 s per call
    and froze the TUI.
  - A crashed child is lazily respawned on the next `collect()` after a 10 s backoff (a broken
    macmon install can't turn every sample into a fork bomb), and the new `stopCpuTempDarwin()` is
    called on `session_shutdown` so the streaming process never outlives pi as a reparented orphan.
  - `osx-cpu-temp` / `istats` stay as the Intel fallback, and "unknown" still degrades to the plain
    single-curve CPU block — never a red line glued to 0°C.
  - The single-file bundle's hand-written header re-declares the new `spawn` import it strips from
    sources (same silent-`ReferenceError` class as the v0.5.0 `execFileSync` fix, eb46925).

### Changed

- **Y-axis tick labels now wear the color of the curve they belong to** — with two fixed scales
  on one plot (CPU% + temperature, TPS + cache hit rate) uniformly grey ticks gave no clue which
  number went with which line. The left tick column takes the **primary** series' effective color
  (`series[0].color`, else the block's main color — so CPU's `100%` is now green), and the
  right-hand scale label takes the **last** series' color (CPU's `100°` is red, the temperature
  curve's own color). The x-axis time labels (`60s` / `0s`) stay neutral: they belong to no curve.

## [0.6.0] — 2026-09-23

### Added

- **CPU temperature curve** — the CPU chart draws a second (red) line with its own fixed 0–100°C
  scale sharing the plot area with CPU%, mirroring the Tokens chart's TPS/cache-hit-rate dual axis:
  a `100°` label overlaid at the top-right corner of the plot area marks the secondary scale
  (1°C ≡ 1% of the plot height — the two fixed scales coincide by construction, so raw °C needs
  no pre-mapping), and the title bar carries the current `°C` reading after the load averages
  (muted ≤75°C, warning ≤90°C, error above — where sustained throttling territory starts).
  - The temperature series is `excludeFromScale`: a real 100°C+ reading can neither stretch the
    CPU% axis nor trip a lying `+` overflow marker on the `100%` tick — pinned to the top simply
    reads "at or above 100°C".
  - Linux reads `/sys/class/hwmon` (`temp*_label`/`temp*_input`) with a CPU-ish label preference,
    falling back to `/sys/class/thermal` zone types; macOS has no unprivileged CPU-temperature
    API (`powermetrics` requires sudo), so a user-installed helper (`osx-cpu-temp` / `istats`)
    is probed instead.
  - No readable source ⇒ unknown ⇒ the second curve and the `100°` label are simply absent
    (never a red line glued to 0°C) — same "unknown ⇒ absent" degradation as `◔N%`.

### Fixed

- **The floating legend box no longer invades the title row** — `renderBlock`'s `plotTop`
  was 0 while `lines[0]` is the head/title row, so the box's top border was overlaid onto the
  title (masked in tests because the title row happens to carry its own `┌`/`┐` corners).
  Now the box starts on the first plot row. Found while wiring the right-axis label, which
  needs the same "true top plot row" coordinate — and with a box present the `100°` label now
  hugs the box's left edge on the same row instead of being buried underneath it.

- **Context-window usage `◔N%` in the Tokens readout** (both chart title bar and `line` mode).
  The number comes from pi's own `ctx.getContextUsage()` — the exact same ledger the built-in
  footer displays — refreshed once per sample, so the two readouts can be cross-checked.
  - Sits between the hit rates and the cumulative counters in the segment priority order: on a
    narrowing block it survives while `↑`/`↓`/`R` yield, and only the hit rates outlast it.
  - Color follows pi's footer thresholds: muted normally, warning above 70%, error above 90%.
  - Unknown readings degrade to an absent segment, never a bogus `◔0%`: no model yet, or the
    post-`/compact` window where pi reports no percent until the next LLM response. A throwing
    or absent host `getContextUsage` degrades the same way without breaking system sampling.

### Changed

- **Removed the duplicate `↑`/`↓`/`R` token counters** from the Tokens readout in widget modes
  (chart / line). pi's own footer sits right below the panel and permanently shows those exact
  numbers, so showing them twice was pure noise. `/sysmon footer` mode keeps them: it replaces
  pi's footer, and its token readout vanishes with it.

## [0.5.0] — 2026-09-22

### Fixed

- **macOS: all metrics read 0** (CPU / memory / network / disk). The collector only implemented
  Linux's `/proc` readers; on darwin every read threw and degraded to zeros, so only the load
  averages were real. Collection now branches per platform:
  - **CPU** — `os.cpus()` cumulative ticks (the exact `/proc/stat` counter model); `iostat`'s
    2nd sample is kept as a tested fallback, since `iostat -c 2` blocks a full second per call.
  - **Memory** — `vm_stat` + `sysctl -n hw.memsize`, with `used = total − (free + inactive +
    speculative) × pageSize` (the MemAvailable convention, not `os.freemem()`, which over-reports
    by ~35 percentage points on macOS).
  - **Network** — `netstat -ib`, de-duplicated per interface (max row wins), skipping only
    `lo0` / `veth*` / `docker*` / `br-*`; `bridge0` / `utun*` / `awdl*` carry real traffic and
    stay counted.
  - **Disk** — `ioreg`'s `IOBlockStorageDriver` `Bytes (Read)/(Write)` cumulative counters, the
    same counter+differential shape as Linux's `/proc/diskstats`, at ~20 ms per call.
  All Linux paths are byte-for-byte unchanged; every darwin parser is exported as a pure
  function and covered by fixture tests.
- **Single-file bundle silently lost `node:child_process`.** The bundler strips source imports
  and re-declares them from a hand-written header list, which the new `execFileSync` import
  never made it into — so the bundled extension threw `ReferenceError` inside `execText()`'s
  try/catch and every darwin metric read 0 again, while typecheck and unit tests stayed green
  (they import sources, never the bundle). The import ships now, and a new **Self-check 2b**
  fails the build when any external symbol is missing from the bundle header.

### Added

- 24 new tests (167 → 191): pure-parser fixtures for `vm_stat` / `netstat -ib` / `iostat` / `ioreg`,
  plus darwin-only live smoke tests with induced CPU / network / disk load.

## [0.4.0] — 2026-09-21

### Added

- **Cache hit-rate on the Tokens block (dual-line).** A second, yellow curve plots the
  session-cumulative prompt-cache hit rate on its **own fixed 0–100% scale** (pre-mapped onto the
  TPS axis and excluded from the y-scale, so a 3000 t/s spike can't squash the 90% line to the
  floor), and the title bar gains two readouts: `·N%` — the **instantaneous** hit rate of the last
  turn, computed from that turn's own `usage` so it reacts immediately when a turn misses the
  cache — and `⌀N%` — the cumulative session average, exactly what the yellow curve draws. Both
  only appear once the provider has reported a cache read; sessions that never touch the cache
  degrade to the previous single-curve block unchanged.
- **`line` mode gains the same hit-rate readouts** (`·N%` / `⌀N%`), gated identically to the
  chart so the two modes can never disagree.

### Changed

- **`line` mode group order is now CPU → MEM → TOK → NET** (was `… NET → TOK`): when the line
  runs out of room, whole groups are dropped from the tail, and the token readout is far less
  recoverable from elsewhere on screen than the network rate, so it outranks NET.

## [0.3.0] — 2026-09-20

### Added

- **Click-to-switch chip (fullscreen TUI only).** In pi's fullscreen TUI mode the panel shows a
  clickable `[line]` / `[chart]` chip at its bottom-right; one click toggles chart ⇄ line through
  the exact same path as `/sysmon chart|line`. In `line` mode the chip shares the single row
  (metrics lose the chip's columns and keep degrading by whole groups); the chart pays for the
  chip row out of its existing row budget. Clicks outside the chip are not consumed, so drag-to-select
  over the panel is unchanged. Regular TUI mode never captures mouse input, so no chip is rendered
  there — this also fixed footer ⇄ widget switches previously leaving both surfaces mounted.

## [0.2.0] — 2026-09-18

First public release. Published to npm as [`pi-sysmon`](https://www.npmjs.com/package/pi-sysmon),
installable with `pi install npm:pi-sysmon`.

### Added

- **Four braille dot-matrix history charts** rendered below the editor: CPU, memory, network and
  LLM token throughput — no TUI drawing library, the characters are composed by hand.
- **Responsive multi-chart layout.** Charts are laid out side by side, with column breakpoints and
  per-chart segment priority, so narrow terminals drop the least important readings first instead
  of clipping mid-curve.
- **Network chart** with separate downstream/upstream rates plus cumulative traffic.
- **Token throughput chart** (`~t/s`) fed by provider streaming deltas, with cache-read accounting
  and an auto-scaled token axis. Disable with `PI_SYSMON_TOKENS=0` to return to the three-chart form.
- **Optional disk I/O chart** (5th block) via `PI_SYSMON_DISKS=1`.
- **Three display modes**: `chart` (default), `line` (single text line) and `footer`
  (charts replace the bottom bar); `chart`/`line` are mutually exclusive.
- **Placement control**: charts/line above or below the editor, persisted across sessions.
- **`/sysmon` command** with `on` / `off` / `global on|off` / `chart` / `line` / `footer` /
  `above|below`.
- **Two-level on/off scope.** `/sysmon on|off` is stored in the session entry list, so `/resume`
  restores the switch for that session only; `/sysmon global on|off` writes the default for new
  sessions to `<configDir>/pi-sysmon.json` and applies it immediately.
- **`--sysmon` CLI flag** to force the monitor on for a single run (overrides the global default,
  but not an explicit in-session `/sysmon off`).
- **Environment variable overrides**: `PI_SYSMON_MODE`, `PI_SYSMON_PLACEMENT`, `PI_SYSMON_WINDOW`,
  `PI_SYSMON_INTERVAL`, `PI_SYSMON_CHART_HEIGHT`, `PI_SYSMON_POINTS`, `PI_SYSMON_SCALE_WINDOW`,
  `PI_SYSMON_LABEL`, `PI_SYSMON_TOKENS`, `PI_SYSMON_DISKS`.
- **Single-file bundle build** (`npm run build:single`) for the drop-in
  `~/.pi/agent/extensions/pi-sysmon.ts` install form.
- **143 unit tests** (`node --test`) plus strict `tsc --noEmit` type checking, wired into CI.

### Compatibility

- Requires pi's `configDir` (default `~/.pi/agent`) for the persisted `pi-sysmon.json`; an
  existing file that only carries the older `enabled: false` field is read as "global default off".
- `chart` and `line` share one widget, so both follow `above`/`below` placement.

[0.8.0]: https://github.com/zzjcool/pi-sysmon/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/zzjcool/pi-sysmon/compare/v0.7.1...v0.7.2
[0.8.0]: https://github.com/zzjcool/pi-sysmon/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/zzjcool/pi-sysmon/compare/v0.7.1...v0.7.2
[0.5.0]: https://github.com/zzjcool/pi-sysmon/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/zzjcool/pi-sysmon/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zzjcool/pi-sysmon/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zzjcool/pi-sysmon/releases/tag/v0.2.0
