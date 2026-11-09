def calculate_subtotal(items):
    if not isinstance(items, list):
        return 0.0
    return sum(float(item.get("price", 0)) * int(item.get("quantity", 0)) for item in items)


def apply_volume_discount(subtotal, quantity):
    if quantity >= 100:
        return subtotal * 0.80  # 20% discount
    if quantity >= 50:
        return subtotal * 0.90  # 10% discount
    if quantity >= 20:
        return subtotal * 0.95  # 5% discount
    return subtotal


def calculate_tax(amount, rate=0.08):
    if amount < 0 or rate < 0:
        return 0.0
    return round(amount * rate, 2)


def calculate_final_invoice(items, tax_rate=0.08):
    total_qty = sum(int(item.get("quantity", 0)) for item in items) if isinstance(items, list) else 0
    subtotal = calculate_subtotal(items)
    discounted = apply_volume_discount(subtotal, total_qty)
    tax = calculate_tax(discounted, tax_rate)
    return round(discounted + tax, 2)


def is_tax_exempt(customer_record):
    if not isinstance(customer_record, dict):
        return False
    return bool(customer_record.get("tax_exempt", False))
