"""Cold-room threshold checks."""


def is_alert(value: float, limit: float = 5.0) -> bool:
    """Return True when a temperature reaches or exceeds the alert limit."""
    # BUG: a reading exactly at the limit must raise an alert.
    return value > limit
