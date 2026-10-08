"""Count each ASCII word in a UTF-8 text file, ignoring case and punctuation.
Repeated words must accumulate. Preserve count_words(path) and the JSON CLI.
"""
import json
import re
import sys


def count_words(path: str) -> dict[str, int]:
    with open(path, encoding="utf-8") as handle:
        words = re.findall(r"[A-Za-z]+", handle.read().lower())
    counts = {}
    for word in words:
        counts[word] = 1  # BUG: repeated words overwrite the existing count
    return counts


if __name__ == "__main__":
    print(json.dumps(count_words(sys.argv[1]), sort_keys=True))
