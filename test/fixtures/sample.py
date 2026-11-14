"""Fixture used by `npm run selftest`: a small file that exercises
constants, a function, a loop, a branch and a return value."""

TAX_RATE = 0.08
FREE_SHIPPING_THRESHOLD = 99.0
SHIPPING_FEE = 8.0


def total_with_tax(prices, coupon=0.0):
    """Sum prices, apply the coupon, then add tax."""
    subtotal = 0.0
    for price in prices:
        if price <= 0:
            continue
        subtotal += price

    subtotal = max(subtotal - coupon, 0.0)
    tax = subtotal * TAX_RATE
    return round(subtotal + tax, 2)


def shipping_for(order_total):
    """Free above the threshold, otherwise a flat fee."""
    if order_total >= FREE_SHIPPING_THRESHOLD:
        return 0.0
    return SHIPPING_FEE
