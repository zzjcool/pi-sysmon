# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/zzjcool/pi-sysmon/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/zzjcool/pi-sysmon/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/zzjcool/pi-sysmon/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zzjcool/pi-sysmon/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zzjcool/pi-sysmon/releases/tag/v0.2.0
