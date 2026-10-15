"""Fetches active National Weather Service alerts for New Jersey and filters them by county.

One request to NWS is shared by every user and cached for a minute, so more users
does not mean more load on the NWS API.
"""
import json
import os
import threading
import time
import urllib.request
from datetime import datetime, timezone

# FIPS codes for New Jersey counties. NWS alerts list the counties they cover as
# "SAME" codes: "0" + state FIPS (34) + county FIPS, for example Ocean = "034029".
NJ_COUNTY_FIPS = {
    "Atlantic": "001", "Bergen": "003", "Burlington": "005", "Camden": "007",
    "Cape May": "009", "Cumberland": "011", "Essex": "013", "Gloucester": "015",
    "Hudson": "017", "Hunterdon": "019", "Mercer": "021", "Middlesex": "023",
    "Monmouth": "025", "Morris": "027", "Ocean": "029", "Passaic": "031",
    "Salem": "033", "Somerset": "035", "Sussex": "037", "Union": "039", "Warren": "041",
}

NWS_URL = "https://api.weather.gov/alerts/active?area=NJ&status=actual"


def _default_fetch(url, contact):
    req = urllib.request.Request(url, headers={
        "User-Agent": f"ShoreSafe/1.0 ({contact})",
        "Accept": "application/geo+json",
    })
    with urllib.request.urlopen(req, timeout=8) as resp:  # noqa: S310 (fixed https URL)
        return json.loads(resp.read().decode("utf-8"))


def _parse_feature(feature):
    p = feature.get("properties") or {}
    same = (p.get("geocode") or {}).get("SAME") or []
    return {
        "id": feature.get("id") or p.get("id") or "",
        "event": p.get("event") or "Unknown",
        "headline": p.get("headline") or "",
        "description": p.get("description") or "",
        "instruction": p.get("instruction") or "",
        "severity": p.get("severity") or "Unknown",
        "certainty": p.get("certainty") or "Unknown",
        "urgency": p.get("urgency") or "Unknown",
        "sent": p.get("sent") or "",
        "effective": p.get("effective") or "",
        "expires": p.get("expires") or "",
        "ends": p.get("ends") or "",
        "sender": p.get("senderName") or "NWS",
        "area": p.get("areaDesc") or "",
        "same": list(same),
    }


_SEVERITY_ORDER = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3}


def alerts_for_county(alerts, county):
    """Keep alerts that cover the given county (matched by FIPS code).

    An alert with no county codes at all is kept for everyone: showing one extra
    alert is safer than hiding one that applies.
    """
    fips = NJ_COUNTY_FIPS.get(county)
    if fips is None:
        return list(alerts)
    code = "034" + fips
    return [a for a in alerts if not a["same"] or code in a["same"]]


class WeatherService:
    def __init__(self, fetch=None, contact=None, ttl=60, stale_max=3 * 3600):
        self.contact = contact or os.environ.get("NWS_CONTACT", "set NWS_CONTACT env var")
        self._fetch = fetch or (lambda url: _default_fetch(url, self.contact))
        self.ttl = ttl
        self.stale_max = stale_max
        self._lock = threading.Lock()
        self._alerts = None
        self._fetched_at = 0.0

    def get_alerts(self):
        """Return (alerts, status, fetched_at_iso) for all of NJ.

        status is 'live', 'stale' (NWS unreachable, showing the last good copy)
        or 'unavailable' (NWS unreachable and nothing recent to show).
        """
        with self._lock:
            now = time.time()
            if self._alerts is not None and now - self._fetched_at < self.ttl:
                return self._alerts, "live", self._iso(self._fetched_at)
            try:
                data = self._fetch(NWS_URL)
                seen, alerts = set(), []
                for feature in data.get("features", []):
                    alert = _parse_feature(feature)
                    if alert["id"] in seen:
                        continue
                    seen.add(alert["id"])
                    alerts.append(alert)
                alerts.sort(key=lambda a: (_SEVERITY_ORDER.get(a["severity"], 4), -_ts(a["sent"])))
                self._alerts, self._fetched_at = alerts, now
                return alerts, "live", self._iso(now)
            except Exception:  # network error, bad JSON, NWS outage: never crash the app
                if self._alerts is not None and now - self._fetched_at < self.stale_max:
                    return self._alerts, "stale", self._iso(self._fetched_at)
                return [], "unavailable", None

    @staticmethod
    def _iso(ts):
        return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def _ts(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return 0.0
