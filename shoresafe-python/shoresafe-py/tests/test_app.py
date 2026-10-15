import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from shoresafe.app import create_app
from shoresafe.logic import alerts as alert_logic
from shoresafe.logic import checklist as checklist_logic
from shoresafe.logic import gaps as gap_logic
from shoresafe.weather import WeatherService, alerts_for_county

H = {"X-Requested-With": "ShoreSafe"}
PROFILE = {
    "household_name": "Test House", "zone": "Ocean", "evacuation_zone": "A", "household_size": 3,
    "has_pets": False, "pet_count": 0, "has_medical_needs": False, "has_elderly": False,
    "has_children": False, "home_type": "house", "flood_risk": "low",
}


def feature(fid, event, same=("034029",), severity="Severe", ends=None):
    ends = ends or (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat()
    return {"id": fid, "properties": {
        "event": event, "severity": severity, "sent": datetime.now(timezone.utc).isoformat(),
        "ends": ends, "areaDesc": "Ocean, NJ", "geocode": {"SAME": list(same)}}}


class FakeNWS:
    def __init__(self, features=None, fail=False):
        self.features, self.fail, self.calls = features or [], fail, 0

    def __call__(self, url):
        self.calls += 1
        if self.fail:
            raise OSError("network down")
        return {"features": self.features}


class ApiTest(unittest.TestCase):
    def make(self, nws=None):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.nws = nws or FakeNWS()
        app = create_app({
            "TESTING": True, "SECRET_KEY": "x" * 32,
            "DATABASE": os.path.join(self.tmp.name, "t.db"),
            "WEATHER": WeatherService(fetch=self.nws, ttl=60),
        })
        return app.test_client()

    def signup(self, c, email="a@b.com", pw="password123"):
        return c.post("/api/auth/signup", json={"email": email, "password": pw}, headers=H)

    def setup(self, c, **over):
        self.signup(c)
        return c.put("/api/profile", json={**PROFILE, **over}, headers=H)


class AuthTests(ApiTest):
    def test_signup_signin_signout(self):
        c = self.make()
        self.assertEqual(self.signup(c).status_code, 201)
        self.assertEqual(c.get("/api/me").status_code, 200)
        c.post("/api/auth/signout", headers=H)
        self.assertEqual(c.get("/api/me").status_code, 401)
        self.assertEqual(c.post("/api/auth/signin", json={"email": "a@b.com", "password": "password123"}, headers=H).status_code, 200)
        self.assertEqual(c.post("/api/auth/signin", json={"email": "a@b.com", "password": "wrong"}, headers=H).status_code, 401)

    def test_duplicate_and_validation(self):
        c = self.make()
        self.signup(c)
        self.assertEqual(self.signup(c).status_code, 409)
        self.assertEqual(self.signup(c, "bad", "password123").status_code, 400)
        self.assertEqual(self.signup(c, "c@d.com", "short").status_code, 400)

    def test_csrf_header_required(self):
        c = self.make()
        r = c.post("/api/auth/signup", json={"email": "a@b.com", "password": "password123"})
        self.assertEqual(r.status_code, 403)

    def test_signin_rate_limit(self):
        c = self.make()
        self.signup(c)
        codes = [c.post("/api/auth/signin", json={"email": "a@b.com", "password": "nope"}, headers=H).status_code for _ in range(10)]
        self.assertEqual(codes[:8], [401] * 8)
        self.assertEqual(codes[8], 429)

    def test_requires_login(self):
        c = self.make()
        for path in ("/api/checklist", "/api/inventory", "/api/dashboard", "/api/alerts"):
            self.assertEqual(c.get(path).status_code, 401, path)

    def test_delete_account_removes_data(self):
        c = self.make()
        self.setup(c)
        self.assertEqual(c.delete("/api/account", json={"password": "bad"}, headers=H).status_code, 403)
        self.assertEqual(c.delete("/api/account", json={"password": "password123"}, headers=H).status_code, 200)
        self.assertEqual(c.get("/api/me").status_code, 401)
        c2 = self.make()  # fresh DB, but also check that signing in to old creds fails on same db
        self.assertEqual(c2.post("/api/auth/signin", json={"email": "a@b.com", "password": "password123"}, headers=H).status_code, 401)


class ProfileChecklistTests(ApiTest):
    def test_conditional_items_only_when_needed(self):
        c = self.make()
        r = self.setup(c)
        self.assertTrue(r.get_json()["checklist_created"])
        labels = [i["label"] for i in c.get("/api/checklist").get_json()["items"]]
        self.assertEqual(len(labels), 28)
        self.assertFalse(any("pet" in l.lower() or "sandbag" in l.lower() or "baby" in l.lower() for l in labels))

    def test_conditional_items_when_needed(self):
        c = self.make()
        self.setup(c, has_pets=True, pet_count=2, has_children=True, flood_risk="high")
        labels = [i["label"] for i in c.get("/api/checklist").get_json()["items"]]
        self.assertEqual(len(labels), 44)
        self.assertTrue(any("sandbag" in l.lower() for l in labels))

    def test_saving_profile_twice_does_not_duplicate_checklist(self):
        c = self.make()
        self.setup(c)
        c.put("/api/profile", json={**PROFILE, "household_size": 4}, headers=H)
        self.assertEqual(len(c.get("/api/checklist").get_json()["items"]), 28)

    def test_profile_validation(self):
        c = self.make()
        self.signup(c)
        self.assertEqual(c.put("/api/profile", json={**PROFILE, "zone": "Atlantis"}, headers=H).status_code, 400)
        self.assertEqual(c.put("/api/profile", json={**PROFILE, "household_size": 0}, headers=H).status_code, 400)
        self.assertEqual(c.put("/api/profile", json={**PROFILE, "has_pets": "yes"}, headers=H).status_code, 400)

    def test_toggle_add_delete_and_isolation(self):
        c = self.make()
        self.setup(c)
        items = c.get("/api/checklist").get_json()["items"]
        first = items[0]["id"]
        self.assertEqual(c.patch(f"/api/checklist/{first}", json={"is_checked": True}, headers=H).status_code, 200)
        self.assertTrue(c.get("/api/checklist").get_json()["items"][0]["is_checked"])
        new = c.post("/api/checklist", json={"label": "<b>Feed cat</b>", "category": "evacuation"}, headers=H).get_json()["item"]
        self.assertTrue(new["is_custom"])
        self.assertEqual(c.delete(f"/api/checklist/{first}", headers=H).status_code, 403)
        self.assertEqual(c.delete(f"/api/checklist/{new['id']}", headers=H).status_code, 200)
        # another user cannot touch it
        other = self.make()
        other2 = other  # separate DB: ids may overlap, so use same app instead
        c2 = c.application.test_client()
        self.signup(c2, "z@z.com")
        self.assertEqual(c2.patch(f"/api/checklist/{first}", json={"is_checked": True}, headers=H).status_code, 404)

    def test_regenerate_keeps_checked_and_custom_and_adds_new(self):
        c = self.make()
        self.setup(c)
        items = c.get("/api/checklist").get_json()["items"]
        c.patch(f"/api/checklist/{items[0]['id']}", json={"is_checked": True}, headers=H)
        c.post("/api/checklist", json={"label": "Mine", "category": "hunker_down"}, headers=H)
        c.put("/api/profile", json={**PROFILE, "has_pets": True, "pet_count": 1}, headers=H)
        out = c.post("/api/checklist/regenerate", headers=H).get_json()["items"]
        labels = [i["label"] for i in out]
        self.assertEqual(len(labels), len(set(labels)))
        self.assertIn("Mine", labels)
        self.assertTrue(any("pet food" in l.lower() for l in labels))
        self.assertTrue([i for i in out if i["label"] == items[0]["label"]][0]["is_checked"])

    def test_offline_sync(self):
        c = self.make()
        self.setup(c)
        items = c.get("/api/checklist").get_json()["items"]
        changes = [{"id": items[0]["id"], "is_checked": True}, {"id": items[1]["id"], "is_checked": True}]
        out = c.post("/api/checklist/sync", json={"changes": changes}, headers=H).get_json()["items"]
        self.assertEqual(sum(1 for i in out if i["is_checked"]), 2)


class InventoryTests(ApiTest):
    def test_crud_and_validation(self):
        c = self.make()
        self.setup(c)
        r = c.post("/api/inventory", json={"name": "Water", "category": "water", "quantity": 6, "priority": "essential"}, headers=H)
        self.assertEqual(r.status_code, 201)
        item = r.get_json()["item"]
        self.assertEqual(c.patch(f"/api/inventory/{item['id']}", json={"quantity": 12}, headers=H).get_json()["item"]["quantity"], 12)
        self.assertEqual(c.post("/api/inventory", json={"name": "", "category": "water"}, headers=H).status_code, 400)
        self.assertEqual(c.post("/api/inventory", json={"name": "x", "category": "weapons"}, headers=H).status_code, 400)
        self.assertEqual(c.post("/api/inventory", json={"name": "x", "expires_at": "tomorrow"}, headers=H).status_code, 400)
        self.assertEqual(c.delete(f"/api/inventory/{item['id']}", headers=H).status_code, 200)
        self.assertEqual(c.delete(f"/api/inventory/{item['id']}", headers=H).status_code, 404)

    def test_sql_injection_attempt_is_stored_as_text(self):
        c = self.make()
        self.setup(c)
        evil = "x'); DROP TABLE users;--"
        self.assertEqual(c.post("/api/inventory", json={"name": evil}, headers=H).status_code, 201)
        self.assertEqual(c.get("/api/me").status_code, 200)


class LogicTests(unittest.TestCase):
    def test_gap_analysis_and_expired_not_counted(self):
        profile = {**PROFILE}
        today = datetime(2026, 10, 13).date()
        inv = [
            {"category": "water", "quantity": 30, "expires_at": None},
            {"category": "food", "quantity": 30, "expires_at": "2026-01-01"},  # expired
            {"category": "documents", "quantity": 1, "expires_at": None},
        ]
        g = gap_logic.analyze(profile, inv, today)
        by_cat = {n["category"]: n for n in g["needs"]}
        self.assertEqual(by_cat["water"]["status"], "met")
        self.assertEqual(by_cat["food"]["status"], "missing")
        self.assertEqual(by_cat["documents"]["status"], "met")
        self.assertEqual(gap_logic.expiring(inv, today)[0]["category"], "food")

    def test_tornado_is_shelter_not_evacuation(self):
        cl = [{"id": 1, "category": "evacuation", "label": "x", "is_checked": False}]
        acts = alert_logic.match_actions([{"id": "1", "event": "Tornado Warning", "severity": "Extreme"}], cl)
        self.assertEqual([a["kind"] for a in acts], ["shelter"])
        acts = alert_logic.match_actions([{"id": "2", "event": "Hurricane Warning", "severity": "Extreme"}], cl)
        self.assertEqual([a["kind"] for a in acts], ["evacuate"])
        acts = alert_logic.match_actions([{"id": "3", "event": "Flood Watch", "severity": "Minor"}],
                                         [{"id": 2, "category": "hunker_down", "label": "y", "is_checked": False}])
        self.assertEqual([a["kind"] for a in acts], ["prepare"])

    def test_expired_alerts_filtered(self):
        old = {"id": "a", "event": "Flood Watch", "ends": "2020-01-01T00:00:00+00:00"}
        new = {"id": "b", "event": "Flood Watch", "ends": "2099-01-01T00:00:00+00:00"}
        self.assertEqual([a["id"] for a in alert_logic.filter_active([old, new])], ["b"])

    def test_generator_matches_profile(self):
        self.assertEqual(len(checklist_logic.generate_items({**PROFILE})), 28)


class AlertTests(ApiTest):
    def test_county_filtering_and_actions(self):
        nws = FakeNWS([
            feature("1", "Coastal Flood Warning", same=("034029",)),
            feature("2", "Flood Watch", same=("034009",)),   # Cape May, not Ocean
            feature("3", "Tornado Warning", same=("034029",), ends="2020-01-01T00:00:00+00:00"),  # expired
        ])
        c = self.make(nws)
        self.setup(c)
        a = c.get("/api/alerts").get_json()
        self.assertEqual(a["status"], "live")
        self.assertEqual([x["id"] for x in a["items"]], ["1"])
        d = c.get("/api/dashboard").get_json()
        self.assertTrue(d["has_actionable_alert"])
        self.assertEqual(d["actions"][0]["kind"], "prepare")
        self.assertEqual(nws.calls, 1)  # cached between the two requests

    def test_outage_is_reported_not_hidden(self):
        c = self.make(FakeNWS(fail=True))
        self.setup(c)
        a = c.get("/api/alerts").get_json()
        self.assertEqual(a["status"], "unavailable")
        self.assertEqual(a["items"], [])

    def test_stale_copy_used_when_nws_fails_later(self):
        nws = FakeNWS([feature("1", "Flood Watch")])
        svc = WeatherService(fetch=nws, ttl=0)
        svc.get_alerts()
        nws.fail = True
        alerts, status, _ = svc.get_alerts()
        self.assertEqual(status, "stale")
        self.assertEqual(len(alerts), 1)

    def test_county_helper(self):
        al = [{"id": "x", "same": ["034029"], "area": ""}, {"id": "y", "same": [], "area": "Atlantic Ocean waters"},
              {"id": "z", "same": ["034009"], "area": ""}]
        self.assertEqual([a["id"] for a in alerts_for_county(al, "Ocean")], ["x", "y"])


class MapTests(ApiTest):
    def two_users(self):
        c1 = self.make()
        self.signup(c1, "one@x.com")
        c2 = c1.application.test_client()
        self.signup(c2, "two@x.com")
        return c1, c2

    def test_drains_seeded_and_login_required(self):
        c = self.make()
        self.assertEqual(c.get("/api/drains").status_code, 401)
        self.signup(c)
        drains = c.get("/api/drains").get_json()["drains"]
        self.assertEqual(len(drains), 87)

    def test_create_links_nearest_drain_and_hides_user_ids(self):
        c = self.make()
        self.signup(c)
        d = [x for x in c.get("/api/drains").get_json()["drains"] if x["label"] == "Manahawkin Bay Drain"][0]
        r = c.post("/api/reports", json={"lat": d["lat"] + 0.0003, "lng": d["lng"], "report_type": "backup",
                                         "severity": "high", "description": "Water on road"}, headers=H)
        self.assertEqual(r.status_code, 201)
        rep = r.get_json()["report"]
        self.assertEqual(rep["drain_id"], d["id"])
        self.assertEqual(rep["drain_label"], "Manahawkin Bay Drain")
        self.assertTrue(rep["mine"])
        self.assertNotIn("user_id", rep)
        far = c.post("/api/reports", json={"lat": 39.9, "lng": -74.9, "report_type": "other"}, headers=H).get_json()["report"]
        self.assertIsNone(far["drain_id"])

    def test_validation(self):
        c = self.make()
        self.signup(c)
        bad = [{"lat": 10, "lng": -74.2}, {"lat": 39.7, "lng": 40}, {"lat": "x", "lng": -74.2},
               {"lat": 39.7, "lng": -74.2, "report_type": "arson"}, {"lat": 39.7, "lng": -74.2, "severity": "huge"},
               {"lat": 39.7, "lng": -74.2, "description": "x" * 301}, {"lat": float("nan"), "lng": -74.2}]
        for payload in bad:
            self.assertEqual(c.post("/api/reports", json=payload, headers=H).status_code, 400, payload)

    def test_confirm_rules(self):
        c1, c2 = self.two_users()
        rid = c1.post("/api/reports", json={"lat": 39.7, "lng": -74.28}, headers=H).get_json()["report"]["id"]
        self.assertEqual(c1.post(f"/api/reports/{rid}/confirm", headers=H).status_code, 400)  # own report
        r = c2.post(f"/api/reports/{rid}/confirm", headers=H)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["report"]["confirm_count"], 1)
        self.assertTrue(r.get_json()["report"]["confirmed_by_me"])
        self.assertEqual(c2.post(f"/api/reports/{rid}/confirm", headers=H).status_code, 409)  # only once

    def test_resolve_and_delete_permissions(self):
        c1, c2 = self.two_users()
        rid = c1.post("/api/reports", json={"lat": 39.7, "lng": -74.28}, headers=H).get_json()["report"]["id"]
        self.assertEqual(c2.post(f"/api/reports/{rid}/resolve", headers=H).status_code, 403)
        self.assertEqual(c2.delete(f"/api/reports/{rid}", headers=H).status_code, 403)
        listed = c2.get("/api/reports").get_json()["reports"][0]
        self.assertFalse(listed["can_manage"])
        self.assertEqual(c1.post(f"/api/reports/{rid}/resolve", headers=H).status_code, 200)
        self.assertEqual(c2.get("/api/reports").get_json()["reports"], [])
        self.assertEqual(c2.post(f"/api/reports/{rid}/confirm", headers=H).status_code, 409)  # already cleared

    def test_admin_can_manage_any_report(self):
        import sqlite3
        c1, c2 = self.two_users()
        rid = c1.post("/api/reports", json={"lat": 39.7, "lng": -74.28}, headers=H).get_json()["report"]["id"]
        conn = sqlite3.connect(c1.application.config["DATABASE"])
        conn.execute("UPDATE users SET is_admin = 1 WHERE email = 'two@x.com'")
        conn.commit(); conn.close()
        self.assertTrue(c2.get("/api/reports").get_json()["reports"][0]["can_manage"])
        self.assertEqual(c2.delete(f"/api/reports/{rid}", headers=H).status_code, 200)

    def test_old_reports_drop_off(self):
        import sqlite3
        c = self.make()
        self.signup(c)
        rid = c.post("/api/reports", json={"lat": 39.7, "lng": -74.28}, headers=H).get_json()["report"]["id"]
        conn = sqlite3.connect(c.application.config["DATABASE"])
        old = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat(timespec="seconds")
        conn.execute("UPDATE drain_reports SET created_at = ? WHERE id = ?", (old, rid))
        conn.commit(); conn.close()
        self.assertEqual(c.get("/api/reports").get_json()["reports"], [])

    def test_report_rate_limit(self):
        c = self.make()
        self.signup(c)
        codes = [c.post("/api/reports", json={"lat": 39.7, "lng": -74.28}, headers=H).status_code for _ in range(12)]
        self.assertEqual(codes[:10], [201] * 10)
        self.assertEqual(codes[10], 429)

    def test_deleting_account_removes_reports(self):
        c1, c2 = self.two_users()
        c1.post("/api/reports", json={"lat": 39.7, "lng": -74.28}, headers=H)
        c1.delete("/api/account", json={"password": "password123"}, headers=H)
        self.assertEqual(c2.get("/api/reports").get_json()["reports"], [])


class StaticTests(ApiTest):
    def test_index_and_headers(self):
        c = self.make()
        r = c.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Content-Security-Policy", r.headers)
        self.assertEqual(c.get("/api/nope").status_code, 404)


if __name__ == "__main__":
    unittest.main()
