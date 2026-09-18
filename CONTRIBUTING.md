[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

# Contributing Guide

## Environment

- Node.js >= 22.19 (needs `--experimental-strip-types` to run TS directly)
- To install the extension into your local pi and test interactions, you need a working pi

## Development Workflow

```bash
git clone <repo> && cd pi-sysmon
npm install

# edit the source under src/

npm run check        # type check + unit tests; must be all green
npm run build:single # regenerate dist/pi-sysmon.ts after changing multi-file source
```

### Trying it in your local pi

```bash
# Option 1: load temporarily (doesn't touch your pi config)
pi -e ./src/index.ts

# Option 2: install into the extensions directory (single-file form, closest to a real user)
npm run build:single
cp dist/pi-sysmon.ts ~/.pi/agent/extensions/pi-sysmon.ts
```

After installing, restart pi and the line charts should appear at the bottom (enabled by default).
`/sysmon off` turns it off; `/sysmon chart|line|footer` switches modes.

## Code Conventions

- **`src/braille.ts` must stay pure functions**: numeric arrays in, string arrays out — no
  touching `process`, no file reads, no held state. That's what lets it be tested outside pi.
- New collected metrics go in `src/metrics.ts`, and must **not throw on non-Linux platforms**
  (every `/proc` read needs a try/catch fallback).
- New layout/rendering goes in `src/chart-panel.ts`.

## Pre-submit Self-check (Important)

Custom TUI components have two pitfalls that can **wreck the user's environment**; always check
them when touching rendering code:

1. **Every row's visible width must not exceed the given `width`.**
   When pi detects an overflow it throws `uncaughtException` and **exits immediately**.
   - Use `truncateToWidth(line, width)`, not `String.slice()` (it cuts by bytes and miscounts ANSI escapes).
   - Compute wide-character/CJK widths with `visibleWidth()`.
   - After changing layout logic, run a scripted width assertion (see historical PRs).

2. **Panel height must be constant.**
   If a component returns different row counts with vs. without data, the editor shifts up and
   down, causing "selected text can't be copied" for the user. Occupy the same number of rows
   even when there's no data (fill with placeholder content).

## Testing

Tests use `node:test`, no extra dependencies needed:

```bash
npm test
```

Please add tests for:

- `braille.ts` bit mapping, coordinate mapping, boundary inputs (empty / all zeros / single point / `NaN` / `Infinity`)
- Every rendered output row's visible width exactly matching the requested width
- The panel having the same height with and without data

## Submitting a PR

- One PR does one thing, with the motivation explained
- Describe **how you actually verified it** (command + output), not just "it should be fine"
- For changes involving interactive rendering, attach a terminal screenshot or a pty-captured frame
