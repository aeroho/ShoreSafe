"""Builds a household's evacuation and hunker-down checklists from its profile."""

EVACUATION = "evacuation"
HUNKER_DOWN = "hunker_down"


def _high_flood(p):
    return p["flood_risk"] in ("high", "extreme")


# (category, label, condition). condition is None (everyone) or a function(profile).
TEMPLATES = [
    # --- Evacuation: everyone ---
    (EVACUATION, "Grab your Go-Bag (emergency kit)", None),
    (EVACUATION, "Bring important documents (IDs, insurance, passports)", None),
    (EVACUATION, "Take cash — ATMs may be down after the storm", None),
    (EVACUATION, "Charge phones and bring chargers / power banks", None),
    (EVACUATION, "Bring a flashlight and extra batteries", None),
    (EVACUATION, "Pack a 3-day supply of non-perishable food", None),
    (EVACUATION, "Pack a 3-day supply of water (1 gallon per person per day)", None),
    (EVACUATION, "Bring a first aid kit", None),
    (EVACUATION, "Wear sturdy, closed-toe shoes", None),
    (EVACUATION, "Lock all doors and windows before leaving", None),
    (EVACUATION, "Turn off gas, electricity, and water at the main", None),
    (EVACUATION, "Follow designated evacuation routes — avoid flooded roads", None),
    (EVACUATION, "Fill up your gas tank before evacuating", None),
    (EVACUATION, "Bring vehicle registration and insurance docs", None),
    # --- Evacuation: pets ---
    (EVACUATION, "Pack pet food for at least 3 days", lambda p: p["has_pets"]),
    (EVACUATION, "Bring pet carriers / leashes", lambda p: p["has_pets"]),
    (EVACUATION, "Bring pet vaccination records", lambda p: p["has_pets"]),
    (EVACUATION, "Pack pet medications and a pet first aid kit", lambda p: p["has_pets"]),
    (EVACUATION, "Bring pet bowls and bottled water for pets", lambda p: p["has_pets"]),
    # --- Evacuation: medical ---
    (EVACUATION, "Pack all prescription medications (7+ day supply)", lambda p: p["has_medical_needs"]),
    (EVACUATION, "Bring medical equipment (CPAP, oxygen, mobility aids)", lambda p: p["has_medical_needs"]),
    (EVACUATION, "Carry a list of medical conditions and medications", lambda p: p["has_medical_needs"]),
    (EVACUATION, "Bring health insurance cards and doctor contact info", lambda p: p["has_medical_needs"]),
    # --- Evacuation: children ---
    (EVACUATION, "Pack baby formula, baby food, and bottles", lambda p: p["has_children"]),
    (EVACUATION, "Bring diapers, wipes, and changing supplies", lambda p: p["has_children"]),
    (EVACUATION, "Pack comfort items (blanket, stuffed animal, toys)", lambda p: p["has_children"]),
    (EVACUATION, "Bring children's immunization records", lambda p: p["has_children"]),
    # --- Evacuation: elderly ---
    (EVACUATION, "Pack extra eyeglasses, hearing aids, and batteries", lambda p: p["has_elderly"]),
    (EVACUATION, "Bring walker, cane, or other mobility aids", lambda p: p["has_elderly"]),
    (EVACUATION, "Prepare a list of emergency contacts and caregivers", lambda p: p["has_elderly"]),
    # --- Hunker down: everyone ---
    (HUNKER_DOWN, "Stock 3-7 days of non-perishable food", None),
    (HUNKER_DOWN, "Store 1 gallon of water per person per day (3-7 days)", None),
    (HUNKER_DOWN, "Test flashlights and lanterns; stock extra batteries", None),
    (HUNKER_DOWN, "Charge all phones, laptops, and power banks", None),
    (HUNKER_DOWN, "Fill the bathtub with water for sanitation use", None),
    (HUNKER_DOWN, "Set refrigerator and freezer to coldest settings", None),
    (HUNKER_DOWN, "Stock a first aid kit and manual can opener", None),
    (HUNKER_DOWN, "Secure outdoor furniture, grills, and loose objects", None),
    (HUNKER_DOWN, "Install storm shutters or board up windows", None),
    (HUNKER_DOWN, "Check smoke and carbon monoxide detectors", None),
    (HUNKER_DOWN, "Prepare a battery-powered or hand-crank radio", None),
    (HUNKER_DOWN, "Review your emergency plan with all household members", None),
    (HUNKER_DOWN, "Keep a fire extinguisher accessible", None),
    (HUNKER_DOWN, "Park vehicles in a garage or on higher ground", None),
    # --- Hunker down: flood risk ---
    (HUNKER_DOWN, "Move valuables and electronics to upper floors", _high_flood),
    (HUNKER_DOWN, "Place sandbags at entry points and garage doors", _high_flood),
    (HUNKER_DOWN, "Elevate appliances on blocks if on ground floor", _high_flood),
    (HUNKER_DOWN, "Know your evacuation route in case you need to leave fast", _high_flood),
    # --- Hunker down: pets / medical ---
    (HUNKER_DOWN, "Stock extra pet food (7 days)", lambda p: p["has_pets"]),
    (HUNKER_DOWN, "Prepare a quiet space for pets to feel safe", lambda p: p["has_pets"]),
    (HUNKER_DOWN, "Keep pet carriers ready in case of sudden evacuation", lambda p: p["has_pets"]),
    (HUNKER_DOWN, "Stock 7+ days of prescription medications", lambda p: p["has_medical_needs"]),
    (HUNKER_DOWN, "Ensure backup power for medical equipment", lambda p: p["has_medical_needs"]),
    (HUNKER_DOWN, "Keep a printed list of medications and dosages", lambda p: p["has_medical_needs"]),
]


def generate_items(profile):
    """Return [{'category','label','sort_order'}] for this profile."""
    counts = {EVACUATION: 0, HUNKER_DOWN: 0}
    items = []
    for category, label, condition in TEMPLATES:
        if condition is not None and not condition(profile):
            continue
        items.append({"category": category, "label": label, "sort_order": counts[category]})
        counts[category] += 1
    return items
