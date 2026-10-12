import csv
from datetime import datetime

LOWER_LIMIT = 250.0
UPPER_LIMIT = 350.0


def main():
    flagged = []
    with open("reactor-temperature-log.csv", newline="", encoding="utf-8") as source:
        rows = csv.DictReader(source)
        for row in rows:
            datetime.strptime(row["timestamp"], "%Y-%m-%dT%H:%M")
            temperature = float(row["temperature_c"])
            direction = ""
            if temperature > UPPER_LIMIT:
                direction = "high"
            elif temperature < LOWER_LIMIT:
                direction = "low"
            if direction:
                flagged.append({
                    "timestamp": row["timestamp"],
                    "reactor_id": row["reactor_id"],
                    "temperature_c": row["temperature_c"],
                    "direction": direction,
                })

    with open("out-of-range-rows.csv", "w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(
            output,
            fieldnames=["timestamp", "reactor_id", "temperature_c", "direction"],
        )
        writer.writeheader()
        writer.writerows(flagged)

    high = sum(row["direction"] == "high" for row in flagged)
    low = sum(row["direction"] == "low" for row in flagged)
    print(f"OUT_OF_RANGE {len(flagged)}/240 (high={high}, low={low})")


if __name__ == "__main__":
    main()
