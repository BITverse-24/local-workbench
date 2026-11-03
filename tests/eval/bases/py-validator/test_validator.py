import unittest
from validator import (
    is_valid_email,
    is_valid_port,
    sanitize_username,
    validate_password_strength,
    parse_boolean_flag
)


class TestValidator(unittest.TestCase):
    def test_is_valid_email(self):
        self.assertTrue(is_valid_email("alice@example.com"))
        self.assertFalse(is_valid_email("invalid-email"))
        self.assertFalse(is_valid_email(""))

    def test_is_valid_port(self):
        self.assertTrue(is_valid_port(80))
        self.assertTrue(is_valid_port(65535))
        self.assertFalse(is_valid_port(0))
        self.assertFalse(is_valid_port(70000))
        self.assertFalse(is_valid_port(True))

    def test_sanitize_username(self):
        self.assertEqual(sanitize_username("  user_name-123! "), "user_name-123")
        self.assertEqual(sanitize_username(""), "")

    def test_validate_password_strength(self):
        self.assertTrue(validate_password_strength("P@ssw0rd123"))
        self.assertFalse(validate_password_strength("short1A"))
        self.assertFalse(validate_password_strength("alllowercase1"))
        self.assertFalse(validate_password_strength("ALLUPPERCASE1"))

    def test_parse_boolean_flag(self):
        self.assertTrue(parse_boolean_flag("yes"))
        self.assertTrue(parse_boolean_flag(True))
        self.assertFalse(parse_boolean_flag("off"))
        self.assertIsNone(parse_boolean_flag("maybe"))


if __name__ == "__main__":
    unittest.main()
