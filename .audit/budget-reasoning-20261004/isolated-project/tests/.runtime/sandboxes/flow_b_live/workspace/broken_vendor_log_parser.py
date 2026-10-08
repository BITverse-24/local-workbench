"""Fixed vendor log parser."""

import csv
import sys


def summarize(path: str) -> dict[str, int]:
    counts = {"ok": 0, "malformed": 0, "high": 0}
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            # Fix 1: Handle missing temperature values gracefully
            temperature_str = row["temperature_c"]
            if temperature_str is None or temperature_str.strip() == "":
                counts["malformed"] += 1
                continue
            temperature = float(temperature_str)
            # Fix 2: 350.0 is the inclusive upper limit, so only > 350.0 is high
            if temperature > 350.0:
                counts["high"] += 1
            else:
                counts["ok"] += 1
    return counts


if __name__ == "__main__":
    print(summarize(sys.argv[1]))