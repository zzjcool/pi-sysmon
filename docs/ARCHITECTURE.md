[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md)

# Architecture & Design Decisions

## Layers

```
src/
├── metrics.ts      # collection  — reads /proc, produces a Snapshot
├── braille.ts      # rendering   — Snapshot numbers → braille character rows (pure functions)
├── blocks.ts       # assembly    — history + snapshot → MetricBlock[] (pure data → pure data)
├── chart-panel.ts  # layout      — responsive columns / borders / ticks / floating readout box / side-by-side splicing
└── index.ts        # extension   — pi lifecycle / commands / config / timers
```

Dependencies flow one way: `index → chart-panel → braille`, `index → blocks → {chart-panel, tokens}`,
`index → metrics`, `index → tokens`. `braille.ts` and `tokens.ts` **depend on nothing else in this module**.

### Why split it this way?

- **`braille.ts` is independently testable**: it's a pure `number[] → string[]` function
  that never touches the system or the pi API. All 13 unit tests target it, and they run
  without starting pi.
- **Collection decoupled from presentation**: `metrics.ts`'s `collect()` returns a plain
  object, so swapping the renderer (sparkline, progress bar) doesn't touch collection code.
- **Layout is its own layer**: axes, ticks, and padding strategy are about "where to put
  things", which is a different concern from "how to draw the line".

## Key design decisions

### 1. Why braille instead of block characters

Block characters (`▁▂▃▄▅▆▇█`) only express 8 discrete heights per column, and one row is a
single pixel tall — drawing a line chart needs multiple rows with poor vertical resolution.
Each braille character is a 2×4 grid of independently lit dots: 4× the vertical resolution
in the same character area, plus two dots per column horizontally.

The cost: it depends on terminal font support for U+2800–U+28FF (supported by virtually all
monospace fonts; bottom's fallback when unsupported is `--dot_marker`, which this project
has not implemented).

### 2. Why `stretch` is the default (stretch to fill)

`renderChart` has a `stretch` option:

- `stretch: true` — stretch the existing history to fill the whole width
- `stretch: false` — right-align, with the x axis strictly mapped to a fixed time window (bottom's approach)

bottom right-aligns because it always has a full 10 minutes of history. A freshly started
extension only has a few data points, and right-alignment would leave the chart mostly
empty on the left for a long time — it looks bad. So we stretch by default, and once enough
history accumulates it visually converges to right-aligned anyway.

### 3. y-axis scale strategy

- **Percentage metrics (CPU / memory)**: fixed `0..100`. Charts at different times are then
  directly comparable — small fluctuations don't get amplified into dramatic swings just
  because the current peak is low.
- **Rate metrics (network)**: dynamic scale = window maximum × 1.5. The ×1.5 comes from
  bottom: it places peaks at about 2/3 of the axis height, leaving breathing room above and
  below the curve instead of touching the top.

### 4. Config persistence uses a file, not `pi.appendEntry()`

pi offers `pi.appendEntry()` for persistence, but it writes into the **session file** —
a new session (or a restart) can't read it. What the user wants is "I turned it off, and it
stays off next time" — that's a cross-session preference, so it goes into a standalone config
file at `<configDir>/pi-sysmon.json`.

### 5. Responsive column count must depend on width only

`chooseColumns(width, count)` is a pure function: **it looks at width and block count, never at data**.

(`count` comes from the `PI_SYSMON_TOKENS` / `PI_SYSMON_DISKS` environment switches and is
constant for the process lifetime. So the invariant "same width ⇒ same row count" still
holds — only the width changes, or the user changes config and restarts.)

If the column count depended on **data** (e.g. "fewer charts when the peak is high"), the
column count would change frame by frame with sampling, which changes the panel's row
count — and changing the row count shifts the editor vertically, breaking mouse selections
anchored to screen coordinates (symptom: "I selected text but can't copy it"). This is a
real incident recorded by this project's predecessor, so column/row counts are only allowed
to change on **resize** (a resize already reflows the whole screen, adding no new risk).

The breakpoint is "at least 24 columns per block" (`MIN_BLOCK_W`): border 2 + plot area 22.
Ticks are **overprinted** onto the plot area instead of owning dedicated columns, so this
floor is much lower than the old layout (where ticks owned 5 columns); 22 plot columns =
44 braille sub-pixel columns. Below this, bottom would cram all N charts into one row
(measured at 50 columns: each chart gets only 16 columns and the curves are unreadable);
this project degrades the arrangement instead.

**Column count adapts to block count** (this is the key to the 4-chart rework):

| Blocks | Width | Layout |
| --- | --- | --- |
| 4 charts (default) | ≥ 96 | 4×1 (8 rows) |
| 4 charts | 48–95 | 2×2 (16 rows) |
| 4 charts | < 48 | 1×4 vertical stack |
| 3 charts | ≥ 72 | 3×1 |
| 3 charts | 48–71 | 2 columns (last cell left empty) |

Principle: **never pick a column count that leaves a half-empty group**. The old
implementation hard-capped at 3 columns, so 4 charts at ≥72 columns laid out as "3+1" —
the second group held 1 block plus an empty cell spanning a full row (wasting 67 columns at
200 columns wide). So with 4 charts we **skip the 3-column tier** and go straight to
4 columns at 96.

### 6. Why a "cell array" instead of string splicing

The floating readout box has to be **overlaid** onto plot rows that already contain ANSI
escape sequences. Doing string surgery with `slice`/`padEnd` would count escape sequences
toward visible width, immediately corrupting the width math and triggering pi's
out-of-bounds crash.

So `renderBlock` represents each row internally as a `Cell[]` (fixed-width cells);
overwriting is array assignment, and `paint()` only generates ANSI at the very end. The
width math is exact by construction, and **no intermediate step ever touches escape
sequences**.

### 7. Timer refresh via `setInterval` + `tui.requestRender()`

pi's TUI renders differentially, and `requestRender()` is throttled/deduplicated
internally, so calling it once per second is cheap. The component itself is stateless (it
only reads the `snap` captured in its closure) and computes at render time — no cache
invalidation logic needed.

### 8. Single-file bundle self-checks (learned the hard way)

Beyond "concatenate + strip imports", the bundle script runs two self-checks, both of which
come from **bugs we actually hit**:

1. **No local relative imports may remain** — in single-file form there's nowhere for
   `./braille.ts` and friends to resolve to.
2. **Every runtime symbol imported from a local module must have a definition in the
   output** — this one closes the loop on an incident that **actually shipped**:

   A refactor added `src/blocks.ts` (`buildBlocks`), but forgot to add `blocks.ts` to the
   bundle script's `MODULES` list; meanwhile `RENAMES` still contained an entry
   "rename `renderPanel` from `chart-panel.ts` to `renderChartPanel`" — a leftover from
   **before** the refactor (back when `index.ts` had its own same-named `renderPanel`).
   After the refactor, `index.ts` imports it from chart-panel, so the rename wiped out the
   *definition* of `renderPanel` while leaving the *call sites* untouched.

   Result: the output called `renderPanel(...)` and `buildBlocks(...)` with **no
   definitions anywhere**.

   The nastiest part of this bug is that **every existing verification step missed it**:
   - `tsc` passed (type checking looks at the sources, where both functions exist);
   - 40 unit tests passed (tests `import` the source files directly and **never go through
     the bundle**);
   - my render harness passed too (same reason — it uses the sources).

   It only blew up when **pi actually loaded the extension**:
   `ReferenceError: renderPanel is not defined` → `uncaughtException` → **pi exits**.
   What finally caught it was "launch a real pi and capture the frames it renders".

   **Lesson**: the correctness of a build artifact must be verified by **running it in the
   real host**; unit tests and typecheck don't cover the bundle layer.

### 9. Why the single-file bundle exists

See the comment at the top of `scripts/bundle-single-file.mjs`. Short version: pi treats
every `.ts` under `extensions/` as an extension, so a multi-file layout gets non-entry
files loaded as extensions, which fails — and **takes down the entire pi startup**. The
single-file form has no such constraint and is the least hassle for users.

## Layout parity with bottom

The layout parameters weren't tuned by feel — they were **copied exactly from the source
and verified character-by-character against frames captured from a real `btm`**:

| Material | Used for |
| --- | --- |
| `ratatui-widgets-0.3.2/src/chart.rs` | the actual chart widget bottom uses: position formulas for axes/ticks/labels |
| `bottom/src/canvas/components/time_series/base.rs` | `Block` border + `title_top`, x labels `["-Ns","0s"]`, legend thresholds |
| `bottom/src/canvas/widgets/network_graph.rs` | rate chart scale = max×1.5 (keep the top 1 tick) |
| `bottom/src/components/time_series/percent.rs` | percent charts use fixed scale `AxisBound::Max(100.5)` |
| Real `btm` frame captures at controlled widths (50/72/100/150 columns) | character-by-character verification |

The three details that are easiest to get wrong:

1. **The x axis does not extend into the y-axis column** ⇒ the axis row is `│╌╌└───…│`,
   not `│╌╌┴───…│`.
   Source: `Chart::layout` executes `x += 1` after placing the y axis.
2. **The last character of the bottom-left time label lands on the y-axis column** ⇒ in
   `│ 60s` the `s` shares a column with the y axis.
   Source: with `labels_alignment = Left`, the first x-label area is
   `[chart_left, graph_left)` (left-inclusive, right-exclusive) and right-aligned within it.
3. **y-tick index 0 is at the bottom**, positioned at `dy = i*(plotH-1)/(n-1)` (**integer
   division = floor**, not rounding), drawn at `plotBottom - dy`.
   This one was pinned down from frame captures: bottom's Network block at plotH=8 with 4
   ticks lands them on plot rows `{0,2,4,7}` (floor); `Math.round` would give `{0,2,5,7}`,
   off by one row on the third tick. There's a test in `test/layout.test.ts` that nails
   these 4 row numbers down.

**Two deliberate deviations**:

1. **Readouts live in the border title bar by default** (`PI_SYSMON_LABEL=title`) rather
   than a floating box in the top-right corner. The title bar row has to render the block
   name anyway, and the remaining `─` fill is pure decoration — putting the readout there
   costs nothing and never covers the curve (bottom's floating box is an overlay that eats
   a chunk of plot area).

2. **Floating box visibility threshold** (only applies under `box`/`both`). bottom uses
   `hidden_legend_constraints` (Network 9/10 × 3/4, Memory 3/4 × 3/4), a set of
   **proportional** thresholds calibrated for charts 40+ columns wide — applied to this
   project's 20–30 column blocks, the readout box would never appear.
   This project uses "it fits (`legendW <= plotW`) + one row remains below the box
   (`legendH < rows`)" instead.
   That "leave one row" clause matters: if the box reaches the last plot row, the bottom
   border overlaps the 0% baseline into a double horizontal line that looks like a render
   glitch.

   ⚠️ A pitfall we hit here: **there used to be an additional rule "at least 40% of the
   curve must remain visible", and it permanently blocked the Network box** — it has the
   longest text, so the width rule rejected it first; then the height rule rejected it
   again on top.
   "The box covers the curve" is by design, so there was no reason to demand clearance;
   that rule has been deleted.
   In title mode none of these thresholds participate (no box is drawn at all).

## Layout geometry: overprinted ticks + border doubling as axis (raising chart utilization)

The first version was "ticks own a column, x axis owns a row, time labels own a row", and
each block paid this overhead:

```
┌ CPU ─ 5% ────────┐
│100%│      plot   │   ← gutter 4 columns + axis 1 column = 5 columns drawing no data
│  0%│             │
│    └─────────────│   ← x axis owns 1 row
│  60s          0s │   ← time labels own 1 row
└──────────────────┘   → chrome 4 rows
```

After making three things share space, the same screen area draws much more data:

```
┌ CPU ─ 5% ────────┐
│100%        plot  │   ← ticks **overprinted** on the left of the plot area, owning no columns
│                  │
│  0%──────────────│   ← 0 baseline doubles as the x axis
└ 60s ───────── 0s ┘   ← time labels embedded in the bottom border (symmetric with the title in the top border)
                      → chrome 2 rows
```

| Item | Old | New |
| --- | --- | --- |
| Columns owned by y ticks | 5 (4 digits + 1 vertical line) | **0** (overprinted) |
| Chrome rows per block | 4 | **2** |
| Plot area of a 50-column block | 42 × 4 = 168 cells | **48 × 6 = 288 cells (+71%)** |
| Width needed for three charts side by side | ≥ 90 columns | **≥ 72 columns** |

**Three companion changes** (without them the layout would "lie"):

1. **x-axis labels must be positioned proportionally to time** (`MetricBlock.windowPoints`
   → the `slots` parameter of `renderChartGlyphs`). Neither old path works:
   `stretch: true` stretches 3 seconds of data to masquerade as a full window;
   `stretch: false` is "one point = one sub-pixel column", so a full 60-point window only
   fills `60/subW` of the width, leaving the right side empty.
   The `slots` mode is "one point = `subW/windowPoints` sub-pixel columns", and the ratio
   **does not change as points accumulate** — 3 seconds after startup the data only fills
   the rightmost 1/20, and only then is the `60s` reading actually true.

2. **Window duration is fixed from the first second** (`resolveWindow` no longer uses
   `min(points, available)`).
   Previously labels shrank with accumulated history to `3s`/`14s`/`30s` — the x-axis
   duration kept changing and nothing was comparable.
   Note the duration must be derived from the **actual point count**
   (`points × intervalMs / 1000`), not by returning `windowSecs` directly — otherwise
   `PI_SYSMON_POINTS=200` would falsely report `60s`.

3. **Single label sticks to the top**. With only the top value labeled, the generic formula
   `y = rows-1 - floor(i*(rows-1)/(n-1))` degenerates to `rows-1` (the bottom) when `n=1`,
   but the sole label semantically means "scale ceiling" and must sit at the top.

**Why only the top tick is labeled**: 0's position is the bottom baseline — self-evident;
and once ticks are overprinted onto the curve, a bottom `0B` would be crammed together with
the curve and the baseline. The top value is the only information not readable from the
chart itself ("how much does the top edge represent").
The top value on rate charts **carries its unit** (`3.0MB`) — otherwise the screen shows a
bare `3.0` with no sense of magnitude.

### The overflow marker `+`: the "lying tick" problem that auto-fallback necessarily creates

Auto-fallback (scale only looks at the most recent 1/6 of the window) has an **inevitable
side effect**, surfaced by a user's question:

> "Why did the network chart hit 10MB/s in the middle, and a while later the maximum became
> a few hundred KB — the 10MB point hadn't even left the time window yet?"

Root cause: the scale window (10s) is shorter than the display window (60s). About 10s
after the spike, the scale falls back, **but the spike is still inside the 60s display
window**. At render time, over-scale values get clamped to the top (`Math.min(top, raw)` in
`braille.ts`), so the screen shows a spike hitting the ceiling while the top tick reads
`293KB` — a reader concludes "it peaked at a few hundred KB". **The tick is lying.**

The fix is to append a `+` to the top tick (`293KB` → `293K+`, read as "at least this
much"):

| Moment | Spike in display window | Spike in scale window | Top tick |
| --- | --- | --- | --- |
| Just happened | ✅ | ✅ | `15MB` (contained, unmarked) |
| 10s later | ✅ | ❌ | `293K+` (not contained, marked) |
| 60s later | ❌ | ❌ | `293KB` (rolled out of the window, unmarked) |

⚠️ **`+` replaces the last character; it is not appended**: `rawGutter` is computed from
the original label, and appending would make the overprint width change frame to frame →
the plot area's left edge would jitter by one column (see pitfall #6 below).
So `"293KB"` becomes `"293K+"` (the `B` is dropped but it stays 5 columns), not `"293KB+"`.

Side effect: the `B` unit is displaced by `+`. This is a deliberate trade-off —
`293K+` is still readable at a glance (and matches the `↓195K/s` style in the title bar),
while width jitter makes the whole chart flash left and right, which is unacceptable.

## Two pitfalls that would break the user's environment (must be respected)

### Row width must never overflow

If pi finds a row whose visible width exceeds the terminal width during rendering, it
throws `uncaughtException` and **exits immediately**.

- You must use `truncateToWidth(line, width)` — **never** `String.slice()`
  (`slice` cuts by UTF-16 code units and counts ANSI escape sequences, corrupting the
  width math)
- Use `visibleWidth()` for wide characters

### Tick width must be constant (or the plot area jitters frame to frame)

`renderBlock`'s gutter (y-tick column width) comes from "the longest tick label", so
**whenever a tick label's width changes, the plot area's left edge jumps by one column**.
This pitfall is real on rate charts:

`rateAxis`'s fourth label is `scaled × 1.5`, and when it crosses 1000 it gains a digit over
the other three labels (`dataMax = 670` → `1005.0` is 6 columns, the rest are 5). When the
network peak hovers around 670, the gutter flips 5↔6 frame to frame — the curve, the axis,
and the time labels all flash left and right, far uglier than any tick.

**The later-added overflow marker `+` is subject to this constraint too**: it must replace
a character, not append — see the previous section.

So `rateAxis` uses `fit()` to **normalize every label to exactly `RATE_GUTTER` columns**,
and the normalization strategy is **reducing precision, not truncating**:

```ts
const one = v.toFixed(1);
if (one.length <= RATE_GUTTER) return one.padStart(RATE_GUTTER);
return v.toFixed(0).padStart(RATE_GUTTER);   // fall back to integer when it doesn't fit
```

Truncation would produce broken strings like `1005.`; reducing precision just drops one
decimal place, and ticks are only a coarse scale anyway.
Tests assert "every label is exactly 5 columns" across the full range `0 .. 10^15`, with
special attention on 600..800, the original jitter band.

### Auto-scale: default is "max over the whole window"; fallback is an opt-in switch

Rate charts (network/disk) have a dynamic y-axis scale: maximum over the visible window ×
1.5 (matching bottom: `auto_y.rs` scans the entire `visible_duration`).

**Default behavior (`DEFAULT_SCALE_WINDOW_FRAC = 1`): scale window == display window ==
60s.**
The top of the y axis is the true maximum over those 60 seconds, and every curve on screen
can be read directly against the top tick — **the tick never lies**, so the overflow marker
`+` is never needed.

There was a detour in the middle; recorded here so we don't retrace it: for a while the
default only used the most recent 1/6 of the window (10s) for the scale, motivated by this
very real pain point —

> A 100× spike pins the scale until that point **rolls out of the entire window** (a full
> 60 seconds for a 60s window).
> In the meantime everything after it is squashed into a line hugging the bottom — measured
> baseline occupying only **0.7%** of the plot height — i.e. invisible.

The user report "the height won't come down, all later values look tiny" was exactly this.

At the time the default was changed to **scale from only the most recent
`scaleWindowPoints` points** (1/6 of the window, i.e. 10s for a 60s window):

| Time since spike | Whole-window max (old) | Only last 10s (new) |
| --- | --- | --- |
| 0 s | baseline at 0.7% | 0.7% |
| 10 s | 0.7% | **67%** |
| 30 s | 0.7% | **67%** |
| 55 s | 0.7% (still invisible) | **67%** |

The cost is that **spikes older than 10s get clipped at the top** (drawn as a flat line at
the ceiling). The render layer already clamps (`Math.min(top, raw)` in `braille.ts`), so
nothing goes out of bounds; this is the standard off-scale semantics of terminal charts.

**But this default was later rejected by the user**, verbatim:

> "I don't need the + — I just want it to show the highest point, and a 60s window."

Because when "the spike has left the scale window but is still in the display window", the
**tick lies**: the screen shows a spike hitting the ceiling while the top tick reads only
`293KB`. I first added the `+` marker as a remedy (`293K+`, read as "at least this much"),
but the user didn't want an extra symbol — what they wanted was the simpler, self-consistent
semantics of "scale = the window's true maximum".

So the current trade-off is:

| `PI_SYSMON_SCALE_WINDOW` | Scale window | Top tick semantics | Overflow marker `+` |
| --- | --- | --- | --- |
| unset (default) = `1` | 60s (== display window) | true maximum of the window | never needed |
| `< 1` (e.g. `1/6`) | last 10s | current scale ceiling | needed, activates automatically |

Both paths are self-consistent, with **no middle state**: either the scale covers the whole
window (no marker needed), or it covers only a short slice (overflow must be marked). The
`+` code is therefore kept — deleting it would knowingly reintroduce "lying ticks" on the
opt-in path.

This approach references btop's `net_auto` (`linux/btop_collect.cpp:2996-3073`:
after a hysteresis count of 5 frames, lower the scale to "recent average × 1.3", with a
10 KiB floor).
We take "10 seconds" rather than btop's "5 frames" as a translation to this project's time
scale — 5 seconds is too sensitive; normal short bursts would get clipped the moment
they're drawn.

Two implementation points (both learned the hard way):

1. **The scale window uses an absolute point count, not a ratio.** A ratio multiplies by
   "the current array length", which is short right after startup, so the same ratio yields
   an ever-growing scale window and erratic recovery times (measured 10s↔18s).
   The point count is converted by `buildBlocks` from the **target window**, fixing the
   recovery time at 10s (asserted by a test).
2. **It remains a pure function**, depending only on the current frame's data, with no
   hidden cross-frame state — so the render harness and the full-width sweep assertions
   stay reproducible (a stateful exponential-decay scheme would not).

`PI_SYSMON_SCALE_WINDOW=1` restores the old behavior of "max over the whole window".

### The cell model's hidden invariant: one cell = one display column

`renderBlock` splits each row into a `Cell[]` for overwriting and right alignment
(`putRight` positions ticks and time labels; the border lands fixed at `w-1`), all of which
depends on one invariant:

> Each cell occupies exactly one display column, i.e. `row.length === visibleWidth(row text)`

ASCII satisfies this naturally, but `visibleWidth` is computed via `get-east-asian-width`
and differs from "character count" in three cases (all verified by measurement):

| Category | Examples | visibleWidth | char count | Handling |
| --- | --- | --- | --- | --- |
| Regular (incl. box/braille) | `─` `⣿` `µ` `−` | 1 | 1 | one cell |
| Wide characters | `你` `🙂` `\u3000` | 2 | 1 | character cell + `vw-1` placeholder cells |
| Combining / zero-width | `e\u0301` `\u200b` | 0 | 1~2 | merged into the previous cell |

- Not handling wide characters → rows **get wider** (visible width > declared width) → pi
  throws and exits;
- Not handling zero-width characters → subsequent content **shifts left** relative to the
  border → the border misaligns.

Placeholder cells are added with `for (k = 1; k < vw; k++)` rather than hard-coding
`vw === 2`, so nothing suddenly overflows if pi-tui ever reclassifies some ambiguous
character as wider.

**Two related pitfalls** (both only surfaced after adding non-ASCII tests):

1. Title width must be computed with `visibleWidth(name)`, not `name.length` — `.length`
   counts code points, CJK takes 2 columns, so you'd underestimate the width → overfill →
   the right border `┐` gets squeezed out.
2. Truncating a cell row must **never** use `row.slice(0, n)` — a wide character's
   character cell and its placeholder cells are one unit; a hard cut leaves the placeholder
   outside (returns 9 cells but renders 10 columns), pushing `┐` past the boundary.
   `truncateRow()` accumulates whole "characters": if the whole character doesn't fit, it's
   dropped entirely.

`test/layout.test.ts` has a sweep test that replaces block names/readouts/readout values
with CJK, combining marks, zero-width characters, full-width spaces, and emoji, asserting
per width "no overflow + constant row count + closed borders".

### Row count must be constant

Changing the number of rows a component renders shifts the editor vertically and breaks
mouse selections anchored to screen coordinates — symptom: "I selected text in the input
box but can't copy it". This is a real incident recorded by this project's predecessor (the
`tps.ts` extension on this machine). So with or without data, the same row count must be
returned, with placeholder content when there's no data.

Thus `totalRows` from `computeLayout` is a hard contract: `renderPanel` must return exactly
that many rows (22 tests watch this, including a sweep across all widths 8..220).

### There can be only one source of truth for block count

`renderPanel` indexes blocks by `band * cols + c`, and **out-of-range indexes silently get
nothing, with no error** — extra blocks are silently dropped, drawing an incomplete but
normal-looking panel, with all tests still green.

So the block count **must never be hand-computed**. It used to be:

```ts
// ✗ Two independent ledgers — they drift sooner or later
const blockCount = 3 + (showTokens ? 1 : 0) + (showDisks ? 1 : 0);
renderPanel(…, computeLayout(w, h, blockCount, maxRows), …)
```

`buildBlocks` has its own `if`s inside, and the moment the two disagree, blocks get dropped
silently. Now there is a single path:

```ts
// ✓ Single source of truth
const blocks = buildBlocks(hist, snap, opts);
const layout = computeLayout(w, chartH, blocks.length, maxRows);
```

A hazard of the same family: **switch combinations not covered by tests**. If the
full-width sweep test always uses `count = 3`, the Tokens block — on by default — would
**never be checked by that crash-defense line**. All `4 switch combinations × non-zero
readouts` must be exercised.

### `setWidget`'s 10-row cap: applies to string arrays only (verified; corrects the old claim)

This document previously said "widgets are capped at 10 rows". **That was inaccurate**;
verified against the pi source:

```js
// pi-coding-agent/dist/modes/interactive/interactive-mode.js
if (Array.isArray(content)) {
    for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) { ... }  // ← only here
    if (content.length > InteractiveMode.MAX_WIDGET_LINES) { /* "... (widget truncated)" */ }
} else {
    component = content(this.ui, theme);   // ← component factory branch: no clipping whatsoever
}
```

`MAX_WIDGET_LINES = 10` applies only to the `Array.isArray(content)` branch.
The component-factory branch instantiates directly with no row limit (in
`chat-viewport.js`, widgetsAbove is just `{ component, shrink: 1, minSize: 0 }`).

This project uses the **component factory**, so panel height is free. So why does
`index.ts` still have a `WIDGET_MAX_ROWS`? That's a **self-imposed screen budget** (so the
charts don't squeeze the chat area away), not a platform limit.
Footer mode uses the larger `FOOTER_MAX_ROWS`, since the bottom space was occupied anyway.

## The Tokens chart (LLM token throughput)

The fourth chart, on by default (`PI_SYSMON_TOKENS=0` to disable). Its **data source is
entirely different** from the first three: CPU/memory/network come from `/proc` polling,
while TPS comes from pi's streaming events.

### Data source: estimation only, never metering

`pi.on("message_update")` fires once per delta, carrying the `assistantMessageEvent`'s
`text_delta` / `thinking_delta` / `toolcall_delta` — all of which contain `delta` text.

**But `partial.usage` is unavailable during streaming** (confirmed by reading the pi-ai
source, not guessed):

| provider | When usage arrives |
| --- | --- |
| Anthropic | `message_start` gives input; output only in the **final** `message_delta` |
| OpenAI Completions | usage chunk at the end (`stream_options.include_usage`) |
| OpenAI Responses | `response.completed` event |
| Google | `usageMetadata` in the final chunk |

`text_delta` events contain usage in **0 places**. So per-frame values can only be
estimated from delta text; exact token counts are only available at `message_end`.

**The two data paths have clear roles** (this is the chart's single most important design
decision):

| Display item | Data source | Precision |
| --- | --- | --- |
| **Curve** (downstream rate, t/s) | per-frame delta-text estimate → 1s buckets | estimate (with `~`) |
| **Title-bar readout** (↑ input / ↓ output / R cacheRead) | `usage` at `message_end` | **exact** (no `~`) |

So "rate" and "cumulative totals" do not come from the same source, and we don't pretend
they do:
the curve must have a value every frame (otherwise there's no shape to draw), and it can
inherently only be an estimate;
the totals don't need per-frame values and can wait for an authoritative number at message
end.
`~` is only attached to the rate — that difference itself is information for the user.

Estimator: `ceil(asciiish_chars / 4) + cjk_chars`, i.e. 4 chars/token for English and
**1 char/token for CJK**. Rationale:

- `chars/4` is pi-ai's own context-estimation formula (`CHARS_PER_TOKEN = 4`), exactly
  matching English/code;
- but in modern BPE a Chinese character is roughly 1 token, so `chars/4` underestimates
  Chinese by 4×.
  This project's users produce a lot of Chinese output; that error is unacceptable.

Readouts therefore carry a `~` prefix (`~635t/s`, compact form — see the `fmtTps`
comment) — it's an estimate, and without `~` people would treat it as a billing number.

### Why one curve, but up/down split in the readout

The user's request was "tokens don't distinguish upstream and downstream". But **we can't
draw two curves like Network does**: the two directions have fundamentally different time
shapes. Measured on a real call:

| Direction | Measured value | Time shape |
| --- | --- | --- |
| ↑ upstream (input, the prompt we send) | 5671 tokens | **uploaded in one block** |
| ↓ downstream (output, the model's reply) | 11 tokens | **streamed character by character** |

A ratio of about **516 : 1**. On the same y axis, input would pin the scale at 5671 and
output would be squashed to 0.2% height, **completely invisible** — an extreme version of
the "spike pins the scale" problem.

So the split is: the **curve** carries the only meaningful continuous quantity (downstream
rate); **both directions' cumulative totals** go in the title bar — they were never rates
and don't belong on a rate axis.

### Readout format matches pi's footer character for character

Order and characters are copied from pi's own footer
(`dist/modes/interactive/components/footer.js`):

```
↑input  ↓output  RcacheRead  WcacheWrite
```

The benefit: numbers on the chart can be compared directly against pi's bottom line
(verified matching in practice: `~58t/s  ↑5.9k ↓60 R2.7k` vs the footer's `↑5.9k ↓60 R2`).
Even `formatTokens`' **lowercase `k`** is copied — an uppercase `K` would both clash with
the host and be confusable with `fmtTps`'s `Kt/s`.

`fmtTokensTotal` differs from pi in exactly one way: **it adds an upper clamp**. This
project's iron rule is that any over-wide rendered row crashes pi, so extreme values must
be reined in (pi's side has no cap).

### Why only assistant messages are accumulated

`message_end` also fires for user messages. Only `role === "assistant"` is accumulated,
otherwise the prompt would be double-counted as usage.
Every field passes through `Number.isFinite` — a provider may return null, and once NaN
gets into a cumulative value it poisons the title row (bad width math → overflow → pi
exits).

### Which deltas are counted

Body + thinking + tool-call arguments — **all counted** — because all three are billed
output tokens (`Usage.output` itself includes thinking and tool-call JSON).
Missing thinking is the worst case: during a long thinking phase there's output without
input, yet the chart would show 0.

**Never touch `*_end.content`** — that's the full text in one block; counting it would
double-count against the deltas already counted.

### Per-second buckets: events decoupled from sampling

The event side only does O(1) integer accumulation; the sampling side reuses the existing
1s `setInterval` to roll buckets and compute the rate:

```
message_update ──► meter.add(delta)   // accumulate only, synchronous, never throws
setInterval 1s ──► meter.tick(now)    // roll bucket → tps → hist.tps ring buffer
```

However dense the events get (fast models emit hundreds of deltas per second), it's just
one addition and never slows streaming — `agent-loop`'s `emit` is `await`ed, so a slow
handler directly stalls the stream.

Use `performance.now()` rather than assuming the interval is exactly 1000ms:
`setInterval` gets deferred under load, and dividing by the nominal interval would
systematically overestimate.

⚠️ **A pitfall we created ourselves**: the meter kept accumulating while the widget was
closed, so "close for 30 seconds then reopen" reported a backlog-driven fake spike on the
**first tick** after re-enabling (measured 6000 tok/s against a true value near 0).
The fix is to drain the current bucket in `stop()` — drained tokens **enter no displayed
value** (totals now have an exact source and don't need estimate backfill).

### The token chart's own ticks

`rateAxis` can't be reused: it hard-codes base-1024 and `B/KB/MB` suffixes; drawing tok/s
with it would output `2.2KB` (actually 1500 tok/s) — a wrong unit is worse than no tick.
So `blocks.ts` has a dedicated `tokenAxis`: same algorithm (×1.5, top-only, fixed-width
right-aligned), but the unit is `t/s` and the base is **1000** (tokens are a decimal
quantity, consistent with API billing).

Tick column width `TPS_GUTTER = 8`, wider than `RATE_GUTTER` (5), because the `t/s` unit
alone takes 3 columns.
Width is still constant — tick width changes shift the overprint area, and the plot area's
left edge jitters frame to frame (see pitfall #6).

Scale floor `MIN_TPS_SCALE = 10`: otherwise during idle time a single 1 tok/s trailing
point would pin the scale at 1.5, and the next 200 tok/s reply would slam the ceiling.

### Known blind spots

- **compaction / branch-summary** use independent LLM calls that **don't go through the
  agent event loop**, so that throughput is completely unmeasurable (the chart shows 0).
  The data is unavailable — not a bug.
- **redacted thinking** has no delta and can't be measured.
- Multiple processes (herdr subagents) are independent pi instances, each drawing its own
  chart — per-process counters are naturally correct.

## Chart above or below the editor

`options.placement` of pi's `setWidget(key, content, options)` is public API:

```ts
// dist/core/extensions/types.d.ts
export type WidgetPlacement = "aboveEditor" | "belowEditor";
export interface ExtensionWidgetOptions { placement?: WidgetPlacement; }
```

The underlying dock's assembly order (`dist/modes/interactive/chat-viewport.js`) determines
the position:

```
pendingMessages → status → [widgetsAbove] → editor → [widgetsBelow] → footer
```

So `belowEditor` is simply "between the editor and the footer" — no hack needed.

**Default is `belowEditor`** (chart below the input box) — the user-chosen default: charts
hug the bottom and don't take the slot above the chat area. To place above, use
`PI_SYSMON_PLACEMENT=above` or `/sysmon above` (persisted).
`parsePlacement` therefore falls back to **below for every unknown/empty value**, and only
words that clearly mean "above" (`above`/`aboveEditor`/`top`) go above.

**Measured behavior** (frames captured from a real pi, not speculation):

| Item | Conclusion |
| --- | --- |
| Rendering below | ✅ works; the 8-row chart displays fully between editor and footer |
| Auto spacer | pi adds a `leadingSpacer` to `widgetsAbove` but not `widgetsBelow` — so below sits **flush** against the editor |
| When space runs short | both widgets have `shrink` 1 and `minSize` 0; the deficit is split weighted by `shrink × current height`, so **the taller one gets squeezed first** (measured in an 18-row terminal: above 8→5 rows, below kept 8) |
| Autocomplete popup | unaffected — it renders **inside** `editorContainer`, unrelated to the widget containers |

⚠️ One trade-off: with `belowEditor` the chart sits flush against the editor (no leading
blank line), visually a bit tighter than above mode.
That's pi's layout behavior, and the extension can't insert a blank line — short of
emitting one itself as the component's first row, which would cost a row of height.
We stay consistent with pi's native behavior rather than getting clever.

### `line` mode is a widget too, not `setStatus`

The one-row text mode originally used `ctx.ui.setStatus(key, text)`, and that was wrong
for two independent reasons:

1. **It ignores `placement`.** `setStatus` text is rendered by pi's *built-in* footer
   (`footer.js` concatenates `getExtensionStatuses()` into a third footer line), so it is
   pinned to the very bottom of the screen. `/sysmon below` then moved the chart but left
   the text line where it was — the reported "position doesn't match the chart" bug.
   `setWidget(..., { placement })` uses the same dock slot as the chart
   (`widgetsAbove` / `widgetsBelow`), so both modes now follow `above`/`below`.
   Verified by frame capture: with `belowEditor` the chart occupies rows 32–39 and line
   mode occupies row 33; with `aboveEditor` both move to the editor's top side.
2. **It shares a line with every other extension.** `footer.js` joins *all* extension
   statuses with a space and truncates — pitfall #5 in the README. A widget is ours alone.

Cost: `line` mode now consumes one dock row per frame rather than living in the footer.
That is the same row it occupied visually before (it was the footer's third line), and the
height is constant (exactly 1 row) so it cannot shift the editor.

### `line` content is a ranked segment list, not a chosen string

The old implementation picked one of three hard-coded strings by testing `visibleWidth` —
all-or-nothing, and it had no token readout at all (the reported gap). Now `plainLineSegs`
returns a ranked `StyledLine` list (CPU → MEM → NET → TOK) and drops **whole groups** from
the tail until it fits, so a narrow terminal never shows a half-eaten number like `↑1.0`.
The CPU group is never dropped: an empty row would look like the extension had died.

Rendering goes through `renderStyledLine` in `chart-panel.ts`, which reuses the same cell
model as the charts (`segsToRow` → `truncateRow` → `paint`). That is deliberate: hand-rolled
`padEnd` is precisely how a line ends up one column too wide and takes pi down with it
(pitfall #1), and the cell model already handles wide characters, ANSI, and zero-width
combining marks correctly.

## Behavior on non-Linux

All `/proc` and `/sys` reads are wrapped in try/catch, degrading to zero values on failure
(total memory falls back to `os.totalmem()`). This way the extension loads and the UI
renders fine on macOS/Windows — the curves just hug the bottom. Far better than throwing
and taking pi down.
