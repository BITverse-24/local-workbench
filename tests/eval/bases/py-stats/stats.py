def moving_average(values, window_size=3):
    if not isinstance(values, list) or window_size <= 0 or len(values) < window_size:
        return []
    result = []
    for i in range(len(values) - window_size + 1):
        window = values[i : i + window_size]
        result.append(round(sum(window) / window_size, 3))
    return result


def find_outliers_iqr(values, factor=1.5):
    if not isinstance(values, list) or len(values) < 4:
        return []
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    q1 = sorted_vals[n // 4]
    q3 = sorted_vals[(3 * n) // 4]
    iqr = q3 - q1
    lower_bound = q1 - (factor * iqr)
    upper_bound = q3 + (factor * iqr)
    return [x for x in values if x < lower_bound or x > upper_bound]


def calculate_range(values):
    if not isinstance(values, list) or not values:
        return 0
    return max(values) - min(values)


def normalize_min_max(values):
    if not isinstance(values, list) or not values:
        return []
    min_val = min(values)
    max_val = max(values)
    if min_val == max_val:
        return [0.0 for _ in values]
    diff = max_val - min_val
    return [round((x - min_val) / diff, 3) for x in values]


def cumulative_sum(values):
    if not isinstance(values, list):
        return []
    running = 0
    result = []
    for val in values:
        running += val
        result.append(running)
    return result
