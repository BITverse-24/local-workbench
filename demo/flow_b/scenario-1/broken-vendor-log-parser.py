"""Deliberately broken starting point for Flow B's repair demo."""

import csv
import sys


def summarize(path: str) -> dict[str, int]:
    """Count valid rows, malformed rows, and readings at or above 350.0 C.

    Each high reading increments both ok and high once.
    Missing, empty, or invalid temperatures increment malformed and are skipped.
    """
    counts = {"ok": 0, "malformed": 0, "high": 0}
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            # Bug 1: missing values (TypeError) and blank or invalid text (ValueError) must count as malformed, then be skipped.
            temperature = float(row["temperature_c"])
            # Bug 2: the high alarm boundary is inclusive; 350.0 C must count as high.
            if temperature > 350.0:
                counts["high"] += 1
            counts["ok"] += 1
    return counts


if __name__ == "__main__":
    print(summarize(sys.argv[1]))
