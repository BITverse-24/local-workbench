import unittest
from pricing import (
    calculate_subtotal,
    apply_volume_discount,
    calculate_tax,
    calculate_final_invoice,
    is_tax_exempt
)


class TestPricing(unittest.TestCase):
    def test_calculate_subtotal(self):
        items = [{"price": 10.0, "quantity": 3}, {"price": 2.5, "quantity": 4}]
        self.assertEqual(calculate_subtotal(items), 40.0)

    def test_apply_volume_discount(self):
        self.assertEqual(apply_volume_discount(100.0, 100), 80.0)
        self.assertEqual(apply_volume_discount(100.0, 50), 90.0)
        self.assertEqual(apply_volume_discount(100.0, 20), 95.0)
        self.assertEqual(apply_volume_discount(100.0, 10), 100.0)

    def test_calculate_tax(self):
        self.assertEqual(calculate_tax(100.0, 0.08), 8.0)
        self.assertEqual(calculate_tax(-10.0, 0.08), 0.0)

    def test_calculate_final_invoice(self):
        items = [{"price": 50.0, "quantity": 2}]
        # subtotal 100, qty 2 -> no discount -> tax 8 -> total 108
        self.assertEqual(calculate_final_invoice(items, 0.08), 108.0)

    def test_is_tax_exempt(self):
        self.assertTrue(is_tax_exempt({"tax_exempt": True}))
        self.assertFalse(is_tax_exempt({"tax_exempt": False}))
        self.assertFalse(is_tax_exempt(None))


if __name__ == "__main__":
    unittest.main()
