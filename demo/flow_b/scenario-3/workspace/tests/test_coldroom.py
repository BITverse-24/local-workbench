import unittest

from coldroom import is_alert


class IsAlertTests(unittest.TestCase):
    def test_below_limit_is_not_an_alert(self):
        self.assertFalse(is_alert(4.9))

    def test_above_limit_is_an_alert(self):
        self.assertTrue(is_alert(5.1))

    def test_exact_boundary_is_alert(self):
        self.assertTrue(is_alert(5.0))


if __name__ == "__main__":
    unittest.main()
