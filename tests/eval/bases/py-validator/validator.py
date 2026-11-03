import re


def is_valid_email(email):
    if not isinstance(email, str) or len(email) > 254:
        return False
    pattern = r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$"
    return bool(re.match(pattern, email))


def is_valid_port(port):
    if not isinstance(port, int) or isinstance(port, bool):
        return False
    return 1 <= port <= 65535


def sanitize_username(username):
    if not isinstance(username, str):
        return ""
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "", username.strip())
    return cleaned[:30]


def validate_password_strength(password):
    if not isinstance(password, str) or len(password) < 8:
        return False
    has_upper = any(c.isupper() for c in password)
    has_lower = any(c.islower() for c in password)
    has_digit = any(c.isdigit() for c in password)
    return has_upper and has_lower and has_digit


def parse_boolean_flag(val):
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        normalized = val.strip().lower()
        if normalized in ("true", "1", "yes", "on"):
            return True
        if normalized in ("false", "0", "no", "off"):
            return False
    return None
