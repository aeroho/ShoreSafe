"""Compares what a household has stocked against what its profile says it needs."""
from datetime import date

FOOD_DAYS = 7
WATER_DAYS = 7


def days_until_expiry(item, today):
    exp = item.get("expires_at")
    if not exp:
        return None
    try:
        return (date.fromisoformat(exp) - today).days
    except ValueError:
        return None


def _is_expired(item, today):
    d = days_until_expiry(item, today)
    return d is not None and d < 0


def _need(label, category, required, have, unit):
    gap = max(0, required - have)
    if have <= 0:
        status = "missing"
    elif have >= required:
        status = "met"
    else:
        status = "short"
    return {
        "label": label, "category": category, "required": required,
        "have": have, "gap": gap, "unit": unit, "status": status,
    }


def analyze(profile, inventory, today=None):
    today = today or date.today()
    # Expired supplies don't count as stocked.
    stock = [i for i in inventory if not _is_expired(i, today)]

    def total(category):
        return sum(i["quantity"] for i in stock if i["category"] == category)

    def count(category):
        return sum(1 for i in stock if i["category"] == category)

    size = profile["household_size"]
    needs = [
        _need("Store 1 gallon of water per person per day (3-7 days)", "water",
              size * WATER_DAYS, total("water"), "gallons"),
        _need("Stock 3-7 days of non-perishable food", "food",
              size * FOOD_DAYS, total("food"), "items"),
    ]
    if profile["has_medical_needs"]:
        needs.append(_need("Stock 7+ days of prescription medications", "medical",
                           size * 7, total("medical"), "doses"))
    else:
        needs.append(_need("Stock a first aid kit", "medical", 1, total("medical"), "kits"))
    if profile["has_pets"]:
        needs.append(_need("Stock extra pet food (7 days)", "pet supplies",
                           profile["pet_count"] * 7, total("pet supplies"), "days"))
    needs.append(_need("Test flashlights and lanterns; stock extra batteries", "tools",
                       2, min(count("tools"), 2), "items"))
    needs.append(_need("Bring important documents (IDs, insurance, passports)", "documents",
                       1, min(count("documents"), 1), "set"))

    met = sum(1 for n in needs if n["status"] == "met")
    short = sum(1 for n in needs if n["status"] == "short")
    missing = sum(1 for n in needs if n["status"] == "missing")
    return {
        "needs": needs,
        "met_count": met,
        "short_count": short,
        "missing_count": missing,
        "total_needs": len(needs),
        "readiness_score": round(met / len(needs) * 100) if needs else 0,
        "shopping_list": [
            {"label": n["label"], "quantity": n["gap"], "unit": n["unit"], "category": n["category"]}
            for n in needs if n["status"] != "met"
        ],
    }


def expiring(inventory, today=None, within_days=30):
    """Items already expired or expiring soon, soonest first."""
    today = today or date.today()
    out = []
    for item in inventory:
        d = days_until_expiry(item, today)
        if d is not None and d <= within_days:
            out.append({**item, "days_left": d})
    out.sort(key=lambda i: i["days_left"])
    return out
