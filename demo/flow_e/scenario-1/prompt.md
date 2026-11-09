**Chat type:** work

**Files to attach:**
- `general-ledger.csv`
- `budget-targets.json`

Analyze the attached general ledger and budget targets:
1. Filter only transactions with status "CLEARED".
2. Group transactions by department and category, and compute total cleared spending per category.
3. Compare total cleared spending against budget targets in budget-targets.json, computing percentage variance: `pctDiff(budget, actual)` rounded to 2 decimal places.
4. Flag each category as "OVER_BUDGET" if actual spend exceeds budget, or "WITHIN_BUDGET" otherwise.
5. Generate a deliverable file `variance-summary.csv` with columns: `department,category,budget,actual_spend,variance_pct,status`.
6. State the total cleared spending across all departments and identify the category with the highest percentage overrun.
