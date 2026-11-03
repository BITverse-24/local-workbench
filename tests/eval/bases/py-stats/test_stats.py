import unittest
from stats import (
    moving_average,
    find_outliers_iqr,
    calculate_range,
    normalize_min_max,
    cumulative_sum
)


class TestStats(unittest.TestCase):
    def test_moving_average(self):
        vals = [10, 20, 30, 40, 50]
        self.assertEqual(moving_average(vals, 3), [20.0, 30.0, 40.0])
        self.assertEqual(moving_average([], 2), [])

    def test_find_outliers_iqr(self):
        vals = [10, 12, 11, 13, 12, 100, 11]
        outliers = find_outliers_iqr(vals)
        self.assertEqual(outliers, [100])

    def test_calculate_range(self):
        self.assertEqual(calculate_range([5, 12, 3, 20]), 17)
        self.assertEqual(calculate_range([]), 0)

    def test_normalize_min_max(self):
        vals = [0, 50, 100]
        self.assertEqual(normalize_min_max(vals), [0.0, 0.5, 1.0])
        self.assertEqual(normalize_min_max([5, 5]), [0.0, 0.0])

    def test_cumulative_sum(self):
        self.assertEqual(cumulative_sum([1, 2, 3, 4]), [1, 3, 6, 10])


if __name__ == "__main__":
    unittest.main()
