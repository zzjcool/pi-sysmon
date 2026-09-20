# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/zzjcool/pi-sysmon/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zzjcool/pi-sysmon/releases/tag/v0.2.0
