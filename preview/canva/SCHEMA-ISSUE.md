# perform-editing-operations — schema defect report

Design: `DAHWelgTt2s` (SIH2026). Two sessions attempted: `7509143822439693041`,
`8664317128895222494`. **No edit ever applied; design verified unmodified.**

## Symptom
Every call fails before execution:
```
Input validation error: Invalid arguments for tool perform-editing-operations:
[{ "code": "invalid_type", "expected": "array", "received": "object",
   "path": ["operations"], "message": "Expected array, received object" }]
```

## Payloads tried (all fail identically)
| # | `operations` value | Reported as |
|---|---|---|
| 1 | `{"update_text": {...}}` | object |
| 2 | `[{"update_text": {...}}]` | object |
| 3 | `[]` | string |
| 4 | `[{"operation":"update_text", ...}]` | object |
| 5 | `"[{\"update_text\": {...}}]"` (JSON string) | string |
| 6 | `[1]` (array of ints) | object |

## Proof it is transport, not payload shape
- **Row 6 is decisive.** An array of integers cannot legitimately be reported as
  an `object` by a type validator. The value is being coerced before validation.
- `get-design-content` accepts `pages: [2]` as a genuine array and filters
  correctly. Arrays therefore work in this MCP server generally.
- The tool's own declared schema types `operations` as a generic **object**,
  while the server validates the same path as an **array**. The declaration and
  the validator disagree.

## Conclusion
Client/transport coerces the `operations` parameter to an object before
validation. No caller-side payload can satisfy a validator that receives a type
it cannot produce. This is a connector defect.

## Unblocks when
The `operations` schema is corrected server-side to match the validator
(`oneOf: [array, object]`), or the client stops coerccing the value.

## Verified safe
Design content re-read after all attempts and still shows original template
text on page 2. Sessions hold drafts only and expire unattended.

## Session 2 — definitive diagnostic

Environment was re-provisioned (network on, approval policy `never`) and the
work retried. Same failure. One further probe settled it:

| # | `operations` | Reported as |
|---|---|---|
| 7 | *omitted entirely* | `received: "undefined"` — `Required` |

Row 7 is the proof. The validator **does** observe the true runtime type of the
value it receives: absent → `undefined`. But every array sent → `object`.
An array of integers (`[1]`, row 6) cannot be `object` to a type checker.
Therefore the array is being coerced to an object **in transport, client-side**,
before the server ever sees it.

No caller-side payload can satisfy a validator that is handed a type the
transport layer refuses to produce. This is unfixable from my side.

## Verification that the design is untouched
Re-read after all attempts:
- `get-design-content` page 2 → still `IDEA TITLE` + original bullet text
- `get-design-pages` → 6 pages, 1920×1080, original thumbnail hashes
No partial or corrupt state. Two sessions held drafts only and expire unattended.

## Session 3 — retest after connector update (still broken)

New session `8216208963292876143`. Retested immediately:

| # | `operations` | Reported as |
|---|---|---|
| 8 | `{"update_text": {...}}` | object |
| 9 | `[1]` | object |
| 10 | `{"batches": [[{...}]]}` | object |

**Row 9 reproduces exactly.** The transport coercion is unchanged — the connector
update did not address this parameter.

### Alternate code paths also checked and closed
| Path | Tool | Result |
|---|---|---|
| Data-field population | `get-design-dataset` | `{}` — the template has **no autofill fields**, so `autofill-design` cannot be used |
| Transaction reopen | `start-editing-transaction` | works, but every write still routes through `perform-editing-operations` |

So there is no second write path into this design's content.

## Cumulative evidence
9 distinct payload shapes, 3 sessions, 2 environment configurations
(sandboxed + unsandboxed). Consistent `expected array, received object` at
path `["operations"]` in every case.

**Design state: unmodified.** Pages 2–5 re-read after the final attempt and
still carry their original template text. No partial writes have ever landed.

## Status
Blocked on a connector-side defect. The fix must be applied to the Canva MCP
server or client: the `operations` schema must accept a real array
(`type: "array"` with an items schema, or `oneOf: [array, object]`), and the
transport must stop coercing the value to an object before validation.

Everything required to execute the population the moment this clears is in
`BUILD-SPEC.md` — geometry, palette, type scale, and per-slide element lists.
