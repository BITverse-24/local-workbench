**Chat type:** agent

**Files to attach:** None.

**Knowledge base files:** None.

**Agent workspace:** Select `workspace/`. It contains `coldroom.py` and `tests/test_coldroom.py`.

Use `read_file` to inspect `coldroom.py` and `tests/test_coldroom.py`. In a short finding, state the current comparison, why `test_exact_boundary_is_alert` fails when it calls `is_alert(5.0)`, and the exact one-line fix: `return value >= limit`. Name the failing test exactly. Keep the workspace unchanged.
