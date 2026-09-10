"""Deliberately broken starting point for Flow B's repair demo."""

import csv
import sys


def summarize(path: str) -> dict[str, int]:
    counts = {"ok": 0, "malformed": 0, "high": 0}
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            # Bug 1: malformed rows have no temperature and crash the run.
            temperature = float(row["temperature_c"])
            # Bug 2: the vendor's inclusive 350.0 upper limit is rejected.
            if temperature > 350.0:
                counts["high"] += 1
            counts["ok"] += 1
    return counts


if __name__ == "__main__":
    print(summarize(sys.argv[1]))
