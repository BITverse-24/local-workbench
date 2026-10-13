**Chat type:** chat

**Files to attach:**
- `cold-room-readings.csv`

**Knowledge base files:**
- `monitoring-rule.md`

Use CR-2 to identify readings outside the inclusive 2.0–5.0°C range. Return only these exact CSV rows and header:

```csv
timestamp,zone,temp_c
2026-10-11T08:30:00Z,CR-A,5.1
2026-10-11T09:00:00Z,CR-A,1.9
2026-10-11T09:45:00Z,CR-A,6.4
```

Keep each timestamp matched to its source value. Leave in-range and blank readings out.
