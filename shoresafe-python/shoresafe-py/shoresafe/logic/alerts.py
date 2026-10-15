"""Turns weather alerts into the checklist actions a household should take."""
from datetime import datetime, timezone

# Take shelter NOW. Never route these to the evacuation checklist.
SHELTER_TRIGGERS = ["Tornado Warning", "Extreme Wind Warning"]

EVACUATION_TRIGGERS = [
    "Hurricane Warning", "Storm Surge Warning", "Flash Flood Warning",
    "Coastal Flood Warning", "Tropical Storm Warning", "Evacuation",
]

HUNKER_TRIGGERS = [
    "Hurricane Watch", "Storm Surge Watch", "Tropical Storm Watch", "Flood Watch",
    "Flash Flood Watch", "Coastal Flood Watch", "High Wind Warning",
    "Winter Storm Warning", "Blizzard Warning", "Flood Warning",
]

IMMEDIATE_TRIGGERS = ["Hurricane Warning", "Storm Surge Warning", "Flash Flood Warning", "Evacuation"]

TEN_MINUTE_ESSENTIALS = [
    "Grab your Go-Bag (emergency kit)",
    "Bring important documents (IDs, insurance, passports)",
    "Take cash — ATMs may be down after the storm",
    "Charge phones and bring chargers / power banks",
    "Pack all prescription medications (7+ day supply)",
    "Bring a flashlight and extra batteries",
    "Bring pet carriers / leashes",
    "Pack pet food for at least 3 days",
]


def _matches(event, triggers):
    return any(t in event for t in triggers)


def _parse(ts):
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, AttributeError):
        return None


def filter_active(alerts, now=None):
    """Drop alerts that have already ended or expired."""
    now = now or datetime.now(timezone.utc)
    kept = []
    for a in alerts:
        end = _parse(a.get("ends") or a.get("expires") or "")
        if end is not None and end <= now:
            continue
        kept.append(a)
    return kept


def has_actionable(alerts):
    every = SHELTER_TRIGGERS + EVACUATION_TRIGGERS + HUNKER_TRIGGERS
    return any(_matches(a["event"], every) for a in alerts)


def match_actions(alerts, checklist):
    """Return one action per relevant alert.

    kind: 'shelter' (take cover now), 'evacuate' (leave now), or 'prepare'.
    """
    actions = []
    for alert in alerts:
        event = alert["event"]
        base = {"alert_id": alert["id"], "event": event, "severity": alert.get("severity", "Unknown")}

        if _matches(event, SHELTER_TRIGGERS):
            actions.append({**base, "kind": "shelter", "category": "hunker_down",
                            "urgency": "immediate", "items": []})
            continue

        is_evac = _matches(event, EVACUATION_TRIGGERS)
        is_hunker = _matches(event, HUNKER_TRIGGERS)
        if not (is_evac or is_hunker):
            continue

        category = "evacuation" if is_evac else "hunker_down"
        immediate = _matches(event, IMMEDIATE_TRIGGERS)
        if immediate:
            urgency = "immediate"
        elif alert.get("severity") in ("Severe", "Extreme"):
            urgency = "prepare"
        else:
            urgency = "monitor"

        items = [i for i in checklist if i["category"] == category and not i["is_checked"]]
        if not items:
            continue
        actions.append({**base, "kind": "evacuate" if immediate else "prepare",
                        "category": category, "urgency": urgency, "items": items})
    return actions


def ten_minute_essentials(checklist):
    """Unchecked essentials from the checklist (exact label matches only)."""
    wanted = set(TEN_MINUTE_ESSENTIALS)
    return [i for i in checklist if i["label"] in wanted and not i["is_checked"]]
