# Deck preview — static site

Open `index.html`. Six slides, 1280×720, stacked vertically.

## What changed in the rebuild
The first version was a wireframe, not a design — uniform faint weight, no hierarchy, 9px type.
This version has:

- **38px bold headline** as the dominant element, with a short navy rule beneath it.
- **Navy as a structural colour** — filled bars, table headers, label text. Not decoration: it marks
  structure. One red, reserved solely for refusal/risk.
- **Real weight contrast** — filled navy surfaces against white type, 2px borders on the figures.
- **Type scale:** 38 / 15 / 12.5 / 12 / 11.5 / 10 / 9px. Nothing below 9.
- **Table headers reversed** (navy/ink fill, white type) so the risk table reads as an anchor.

## Files
| File | Contents |
|---|---|
| `tokens.css` | **Palette, type scale, slide frame.** Replace the 10 `:root` values with the real SIH template palette and the whole deck follows. |
| `s2.css` | The T |
| `s3.css` | Product mockup + agent-loop strip |
| `s456.css` | Table, tiers, grid |

## Provisional
- **All colour** — I have not read the Canva template. Swap the `:root` values.
- **Mockup values** (`2.1 mm`, `NOT APPROVED`, the clause) — placeholders showing shape and
  emphasis. Real run values must replace them.

## Fit
No browser was available here, so heights were computed. Body height available: **485px**.

| Slide | Content | Slack |
|---|---|---|
| 2 | 473px | 11px |
| 3 (left column) | 468px | 16px |

To gain room I **cut copy and merged blocks** (Slide 2: 7 blocks → 6; Slide 3: 6 → 5), rather than
shrinking type. If you add text, tell me and I'll rebalance — do not let it clip.

## Porting to Canva
Layout, scale and grid transfer as a spec. Rebuild as native shapes: the **T**, the **mockup**
(largest rebuild — a designed figure, not a picture), the **agent-loop strip**, the **three-field
join**. The tables port directly as native Canva tables.
