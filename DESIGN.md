# Sovereign Workbench — Design System v2 (Industrial Enterprise)

Reference aesthetic: Bloomberg Terminal / Palantir Foundry / SAP Fiori / Honeywell Experion —
dense, monochrome, restrained, exactly one accent color. Not: crypto dashboard, dev-tool
landing page, or gradient-heavy startup UI. If a component looks "cool" or "flashy," it is wrong
for this audience.

---

## 1. Non-negotiable rules

1. **One accent color in the entire app.** No rainbow badges, no per-role colors, no gradients.
2. **No glow, no pulse animation, no box-shadow on colored elements.** Flat surfaces only.
3. **Monospace font is reserved for**: code, file paths, host/IP/port, model tags, log/transcript
   output, numeric IDs. Everywhere else (labels, nav, buttons, headings) uses the sans UI font.
4. **No uppercase+letter-spacing except section eyebrows**, max one per panel, 11px, 0.02em
   tracking (not the current 0.1em+ wide-tracked ALL CAPS used everywhere).
5. **Backgrounds are charcoal, not pure black** (`#0a0a0a` → `#0B0D0F`). Text is off-white, not
   pure white (`#ffffff` → `#E6E8EA`).
6. **Status color (red/amber/green) is semantic only** — used for health/success/error, never as
   decorative role-coding (the current VISION/CODE/DRAFT/PLAN/EMBED rainbow badges must all
   become one neutral badge style, differentiated by label/icon, not hue).

---

## 2. Color tokens

```css
/* Surfaces */
--bg-canvas:        #0B0D0F;
--bg-surface:        #14171A;
--bg-surface-raised: #1B1F23;
--border-subtle:     rgba(255,255,255,0.08);
--border-default:    rgba(255,255,255,0.14);

/* Text */
--text-primary:   #E6E8EA;
--text-secondary: #9AA1A8;
--text-tertiary:  #6B7178;

/* The one accent (active states, primary buttons, focus rings, links) */
--accent:         #3E7CA6;
--accent-muted:   rgba(62,124,166,0.14);   /* accent bg wash, e.g. selected row */

/* Status — desaturated, not neon. Used ONLY for real health/state, never decoration. */
--status-success: #4C9A6A;
--status-warning: #B98A3D;
--status-error:   #B8615C;
--status-info:    var(--accent);
```

Delete every existing neon green (`#00ff9x`/`#39ff14`-type), neon purple, neon orange, and neon
teal value from the codebase. Search for `glow`, `shadow: 0 0 `, and any `filter: drop-shadow`
tied to color — remove.

---

## 3. Typography

```css
--font-ui:   'Inter', 'IBM Plex Sans', system-ui, sans-serif;   /* all UI chrome */
--font-mono: 'IBM Plex Mono', 'JetBrains Mono', monospace;      /* code/paths/ids/logs only */

--text-xs:   11px;  /* meta, timestamps, eyebrows */
--text-sm:   13px;  /* body, table cells, secondary labels */
--text-base: 14px;  /* primary body, input text */
--text-lg:   18px;  /* panel/section titles */
--text-xl:   20px;  /* page titles — used once per screen, not per-card */

--weight-regular: 400;
--weight-medium:  500;
--weight-semibold: 600;   /* max weight in the app — no 700/800 for "impact" */
```

Casing rule: **sentence case everywhere** (`Local inference server`, not `LOCAL INFERENCE
SERVER`). Exception: the single eyebrow label per panel may be uppercase at `--text-xs` with
0.02em tracking — e.g. one line like `System setup` above a section, not every card header.

---

## 4. Spacing & shape

```css
--space: 4px 8px 12px 16px 24px 32px;   /* 4px base grid, no arbitrary values */
--radius-sm: 6px;   /* buttons, inputs, badges */
--radius-md: 8px;   /* cards, panels */
--radius-pill: 999px; /* only for true toggle/pill controls, not general buttons */
--border-width: 1px;  /* never 2px+ for emphasis — use color/weight instead */
```

---

## 5. Component-by-component fixes (mapped to current screens)

**Top bar status badge** ("● AIR-GAPPED • ZERO EGRESS", bright green, pulsing dot)
→ Static (no animation) neutral chip: `--bg-surface-raised` background, `--border-subtle` border,
`--text-secondary` text, sentence case: `Air-gapped · zero egress`. Dot only present when it
reflects real state, colored with `--status-success`/`--status-error`, no pulse/glow.

**Dev-mode badges** ("Dev: OpenRouter [OFF]", orange; "Dev: Reset Onboarding", orange)
→ Move both into a single "Developer" overflow menu (small icon button, not two loud inline
pills). If they must stay inline for hackathon convenience, restyle as outline-only chips using
`--border-default` and `--text-secondary`, zero fill color.

**Role/task badges** (VISION teal / CODE purple / DRAFT green / PLAN yellow / EMBED teal)
→ One shared badge style for all five: `--bg-surface-raised` bg, `--border-subtle` border,
`--text-secondary` text, `--radius-sm`. Differentiate roles by a small monochrome icon (not
color). If a role is actively running, its badge may switch text/icon color to `--accent` —
that's the only color variation allowed.

**Onboarding numbered cards** (colored corner dots: blue/teal/green)
→ Remove the colored dots entirely. Use a plain numeral (`1`, `2`, `3`) in `--text-tertiary`, and
only show `--status-success` on the numeral once that step is actually validated/complete.

**Service health rows** ("vision-qwen25vl unavailable", red dot)
→ Keep the semantic dot but desaturate to `--status-error` / `--status-success` / `--status-warning`.
No glow. Text stays `--text-secondary`, not colored to match the dot.

**Toggle switches** ("Allow external requests")
→ Track: `--bg-surface-raised` off / `--accent` on (never bright white knob-glow). Thumb: solid
`--text-primary`, flat, no shadow.

**Sidebar section headers** (EXPLORER / CHATS / FILES / KNOWLEDGE (SOP), wide-tracked caps)
→ Sentence case, `--text-xs`, `--text-tertiary`, normal tracking (0), small line icon prefix.

**Buttons** ("Ollama Defaults", "Test All Endpoints", "Complete Setup & Launch Workbench")
→ Keep current shape logic (rectangular, `--radius-sm`). Primary action: `--accent` fill,
`--text-primary`(near-white) label. Secondary: `--bg-surface-raised` fill, `--border-default`
border, `--text-secondary` label. No gradient fills.

**Chat / execution plan panel** (model trace, run diagnostics, progress skeleton bars)
→ Keep structure as-is; apply tokens. Replace any pulsing/animated skeleton with a static
low-opacity bar (`--bg-surface-raised` at 60% opacity) or a slow, non-bouncing 1px progress line
in `--accent`.

**Endpoint config table** (host/port/context columns)
→ Table values (IPs, ports, model tags) use `--font-mono`. Column headers and row labels use
`--font-ui`. This is the correct existing split for this table — don't monospace the whole row.

---

## 6. Explicit "don't" list

- Don't use more than one hue for anything that isn't a true status indicator.
- Don't animate anything beyond a 120–150ms opacity/transform transition on hover/focus.
- Don't add drop-shadows, glows, or gradient fills anywhere.
- Don't set letter-spacing above 0.02em, and only on the one-eyebrow-per-panel exception.
- Don't use monospace for page titles, nav labels, or button text.
- Don't invent new badge colors per feature — every badge in the app shares one neutral style.

---

## 7. Acceptance check

Screenshot any two panels side by side. If you can't tell them apart from a generic ops/SCADA
dashboard aside from the actual content, the restyle worked. If it still looks like a landing page
for a dev tool, it hasn't.