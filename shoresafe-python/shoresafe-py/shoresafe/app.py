"""ShoreSafe backend: accounts, household data, and weather-alert actions.

Serves the HTML/CSS/JS front end from /static and a JSON API under /api.
"""
import math
import os
import re
import secrets
import time
from datetime import date, datetime, timedelta, timezone
from functools import wraps

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

from . import db as dbm
from .logic import alerts as alert_logic
from .logic import checklist as checklist_logic
from .logic import gaps as gap_logic
from .weather import NJ_COUNTY_FIPS, WeatherService, alerts_for_county

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")

SHORE_COUNTIES = ["Cape May", "Atlantic", "Ocean", "Monmouth", "Cumberland", "Burlington", "Middlesex"]
OTHER_COUNTIES = sorted(c for c in NJ_COUNTY_FIPS if c not in SHORE_COUNTIES)
HOME_TYPES = ["house", "apartment", "condo", "mobile", "other"]
FLOOD_RISK_LEVELS = ["low", "moderate", "high", "extreme"]
INVENTORY_CATEGORIES = ["food", "water", "medical", "tools", "documents", "clothing",
                        "electronics", "pet supplies", "other"]
PRIORITIES = ["essential", "important", "optional"]

REPORT_TYPES = ["backup", "flooding", "overflow", "odor", "other"]
SEVERITIES = ["low", "moderate", "high"]
REPORT_TTL_HOURS = int(os.environ.get("REPORT_TTL_HOURS", "24"))  # old reports drop off the map
REPORTS_PER_HOUR = 10                                             # per person
NJ_BOUNDS = (38.7, 41.5, -75.7, -73.7)                            # south, north, west, east
NEAR_DRAIN_METERS = 150

MAX_CHECKLIST_ITEMS = 300
MAX_INVENTORY_ITEMS = 500
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# Used so a sign-in for an unknown email takes as long as one for a real email.
_DUMMY_HASH = generate_password_hash("not-a-real-password")


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------- validation ----------

def _text(data, key, max_len, default="", required=False):
    value = data.get(key, default)
    if value is None:
        value = default
    if not isinstance(value, str):
        raise ApiError(f"{key} must be text")
    value = value.strip()
    if required and not value:
        raise ApiError(f"{key.replace('_', ' ').capitalize()} is required")
    if len(value) > max_len:
        raise ApiError(f"{key.replace('_', ' ').capitalize()} is too long (max {max_len} characters)")
    return value


def _int(data, key, low, high, default=None):
    value = data.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ApiError(f"{key.replace('_', ' ').capitalize()} must be a whole number")
    if not low <= value <= high:
        raise ApiError(f"{key.replace('_', ' ').capitalize()} must be between {low} and {high}")
    return value


def _bool(data, key):
    value = data.get(key, False)
    if not isinstance(value, bool):
        raise ApiError(f"{key} must be true or false")
    return value


def _choice(data, key, options, default=None):
    value = data.get(key, default)
    if value not in options:
        raise ApiError(f"{key.replace('_', ' ').capitalize()} must be one of: {', '.join(options)}")
    return value


def clean_profile(data):
    has_pets = _bool(data, "has_pets")
    pet_count = _int(data, "pet_count", 0, 20, 0) if has_pets else 0
    if has_pets and pet_count < 1:
        pet_count = 1
    return {
        "household_name": _text(data, "household_name", 60, default="My Household") or "My Household",
        "zone": _choice(data, "zone", SHORE_COUNTIES + OTHER_COUNTIES),
        "evacuation_zone": _text(data, "evacuation_zone", 30),
        "household_size": _int(data, "household_size", 1, 20),
        "has_pets": has_pets,
        "pet_count": pet_count,
        "has_medical_needs": _bool(data, "has_medical_needs"),
        "has_elderly": _bool(data, "has_elderly"),
        "has_children": _bool(data, "has_children"),
        "home_type": _choice(data, "home_type", HOME_TYPES),
        "flood_risk": _choice(data, "flood_risk", FLOOD_RISK_LEVELS),
    }


def _clean_date(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ApiError("Expiry must be a date")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise ApiError("Expiry must be a date like 2027-03-15")


def clean_inventory(data, partial=False):
    """Validate an inventory item. With partial=True only the fields present are checked."""
    out = {}

    def want(key):
        return key in data or not partial

    if want("name"):
        out["name"] = _text(data, "name", 120, required=True)
    if want("category"):
        out["category"] = _choice(data, "category", INVENTORY_CATEGORIES, default="other")
    if want("quantity"):
        out["quantity"] = _int(data, "quantity", 0, 100000, default=1)
    if want("location"):
        out["location"] = _text(data, "location", 120)
    if want("notes"):
        out["notes"] = _text(data, "notes", 500)
    if want("expires_at"):
        out["expires_at"] = _clean_date(data.get("expires_at"))
    if want("priority"):
        out["priority"] = _choice(data, "priority", PRIORITIES, default="important")
    return out


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _float(data, key, low, high):
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ApiError(f"{key} must be a number")
    if not low <= value <= high:
        raise ApiError("Reports can only be placed in New Jersey")
    return float(value)


def clean_report(data):
    south, north, west, east = NJ_BOUNDS
    return {
        "lat": _float(data, "lat", south, north),
        "lng": _float(data, "lng", west, east),
        "report_type": _choice(data, "report_type", REPORT_TYPES, default="other"),
        "severity": _choice(data, "severity", SEVERITIES, default="moderate"),
        "description": _text(data, "description", 300),
    }


# ---------- app factory ----------

def create_app(config=None):
    app = Flask(__name__, static_folder=None)
    app.config.update(
        DATABASE=os.environ.get("SHORESAFE_DB", os.path.join(BASE_DIR, "data", "shoresafe.db")),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        # Set SHORESAFE_HTTPS=1 on a real website so the login cookie is only sent over HTTPS.
        SESSION_COOKIE_SECURE=os.environ.get("SHORESAFE_HTTPS") == "1",
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
        MAX_CONTENT_LENGTH=64 * 1024,
    )
    if config:
        app.config.update(config)

    if not app.config.get("SECRET_KEY"):
        if os.environ.get("SHORESAFE_HTTPS") == "1" and not os.environ.get("SECRET_KEY"):
            raise RuntimeError("Set the SECRET_KEY environment variable before running ShoreSafe on a public site.")
        app.config["SECRET_KEY"] = _load_secret_key(app.config["DATABASE"])

    if os.environ.get("TRUST_PROXY") == "1":  # running behind Render/Heroku/etc.
        from werkzeug.middleware.proxy_fix import ProxyFix
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    dbm.init_db(app.config["DATABASE"])
    app.teardown_appcontext(dbm.close_db)
    weather = app.config.get("WEATHER") or WeatherService()
    attempts = {}  # in-memory sign-in rate limiter: key -> [timestamps]

    # ----- request hooks -----

    @app.before_request
    def guard_api_writes():
        # Browsers only send this custom header from our own pages, which blocks
        # cross-site forged requests on top of the SameSite cookie.
        if request.path.startswith("/api/") and request.method in ("POST", "PUT", "PATCH", "DELETE"):
            if request.headers.get("X-Requested-With") != "ShoreSafe":
                raise ApiError("Request blocked", 403)

    @app.after_request
    def add_headers(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"  # map tile servers want a referrer
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org "
            "https://server.arcgisonline.com; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        elif request.path in ("/", "/index.html", "/sw.js", "/manifest.webmanifest"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.errorhandler(ApiError)
    def handle_api_error(err):
        return jsonify({"error": err.message}), err.status

    @app.errorhandler(404)
    def not_found(_err):
        if request.path.startswith("/api/"):
            return jsonify({"error": "Not found"}), 404
        return send_from_directory(STATIC_DIR, "index.html"), 404

    @app.errorhandler(405)
    def method_not_allowed(_err):
        return jsonify({"error": "Method not allowed"}), 405

    @app.errorhandler(413)
    def too_large(_err):
        return jsonify({"error": "Request too large"}), 413

    @app.errorhandler(500)
    def server_error(_err):
        return jsonify({"error": "Something went wrong on our end. Try again."}), 500

    # ----- helpers -----

    def body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ApiError("Expected a JSON object")
        return data

    def login_required(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            uid = session.get("uid")
            if uid is None:
                raise ApiError("Please sign in", 401)
            row = dbm.get_db().execute("SELECT id, email, is_admin FROM users WHERE id = ?", (uid,)).fetchone()
            if row is None:
                session.clear()
                raise ApiError("Please sign in", 401)
            request.user = dbm.row_to_dict(row)
            return fn(*args, **kwargs)
        return wrapper

    def rate_limited(key, limit, window):
        now = time.time()
        if len(attempts) > 5000:
            attempts.clear()
        recent = [t for t in attempts.get(key, []) if now - t < window]
        attempts[key] = recent
        return len(recent) >= limit

    def record_attempt(key):
        attempts.setdefault(key, []).append(time.time())

    def uid():
        return request.user["id"]

    def get_profile(user_id):
        row = dbm.get_db().execute("SELECT * FROM profiles WHERE user_id = ?", (user_id,)).fetchone()
        return dbm.row_to_dict(row)

    def get_checklist(user_id):
        rows = dbm.get_db().execute(
            "SELECT * FROM checklist_items WHERE user_id = ? ORDER BY category, sort_order, id", (user_id,)
        ).fetchall()
        return [dbm.row_to_dict(r) for r in rows]

    def get_inventory(user_id):
        rows = dbm.get_db().execute(
            "SELECT * FROM inventory_items WHERE user_id = ? ORDER BY category, name COLLATE NOCASE, id",
            (user_id,),
        ).fetchall()
        return [dbm.row_to_dict(r) for r in rows]

    def insert_generated(conn, user_id, items):
        conn.executemany(
            "INSERT INTO checklist_items (user_id, category, label, is_checked, is_custom, sort_order, created_at) "
            "VALUES (?, ?, ?, 0, 0, ?, ?)",
            [(user_id, i["category"], i["label"], i["sort_order"], now_iso()) for i in items],
        )

    # ----- static front end -----

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/<path:path>")
    def static_files(path):
        return send_from_directory(STATIC_DIR, path)

    # ----- config -----

    @app.get("/api/config")
    def config_route():
        return jsonify({
            "shore_counties": SHORE_COUNTIES,
            "other_counties": OTHER_COUNTIES,
            "home_types": HOME_TYPES,
            "flood_risk_levels": FLOOD_RISK_LEVELS,
            "inventory_categories": INVENTORY_CATEGORIES,
            "priorities": PRIORITIES,
            "report_types": REPORT_TYPES,
            "severities": SEVERITIES,
            "report_ttl_hours": REPORT_TTL_HOURS,
        })

    # ----- auth -----

    @app.post("/api/auth/signup")
    def signup():
        data = body()
        email = _text(data, "email", 254, required=True).lower()
        password = data.get("password")
        if not EMAIL_RE.match(email):
            raise ApiError("Enter a valid email address")
        if not isinstance(password, str) or not 8 <= len(password) <= 128:
            raise ApiError("Password must be 8 to 128 characters")
        ip_key = f"signup:{request.remote_addr}"
        if rate_limited(ip_key, 10, 3600):
            raise ApiError("Too many sign-ups from this network. Try again later.", 429)
        record_attempt(ip_key)

        conn = dbm.get_db()
        try:
            with conn:
                cur = conn.execute(
                    "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
                    (email, generate_password_hash(password), now_iso()),
                )
        except Exception:
            raise ApiError("An account with that email already exists. Sign in instead.", 409)
        session.clear()
        session["uid"] = cur.lastrowid
        session.permanent = True
        return jsonify({"user": {"id": cur.lastrowid, "email": email}, "profile": None}), 201

    @app.post("/api/auth/signin")
    def signin():
        data = body()
        email = _text(data, "email", 254).lower()
        password = data.get("password")
        key = f"signin:{request.remote_addr}:{email}"
        if rate_limited(key, 8, 600):
            raise ApiError("Too many attempts. Wait a few minutes and try again.", 429)
        row = dbm.get_db().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        ok = check_password_hash(row["password_hash"] if row else _DUMMY_HASH,
                                 password if isinstance(password, str) else "")
        if not row or not ok:
            record_attempt(key)
            raise ApiError("Incorrect email or password", 401)
        attempts.pop(key, None)
        session.clear()
        session["uid"] = row["id"]
        session.permanent = True
        return jsonify({"user": {"id": row["id"], "email": row["email"], "is_admin": bool(row["is_admin"])},
                        "profile": get_profile(row["id"])})

    @app.post("/api/auth/signout")
    def signout():
        session.clear()
        return jsonify({"ok": True})

    @app.get("/api/me")
    @login_required
    def me():
        return jsonify({"user": request.user, "profile": get_profile(uid())})

    @app.delete("/api/account")
    @login_required
    def delete_account():
        password = body().get("password")
        row = dbm.get_db().execute("SELECT password_hash FROM users WHERE id = ?", (uid(),)).fetchone()
        if not isinstance(password, str) or not check_password_hash(row["password_hash"], password):
            raise ApiError("Incorrect password", 403)
        with dbm.get_db() as conn:
            conn.execute("DELETE FROM users WHERE id = ?", (uid(),))
        session.clear()
        return jsonify({"ok": True})

    # ----- profile -----

    @app.put("/api/profile")
    @login_required
    def save_profile():
        p = clean_profile(body())
        conn = dbm.get_db()
        existing = get_profile(uid())
        created_checklist = False
        with conn:
            if existing:
                conn.execute(
                    "UPDATE profiles SET household_name=?, zone=?, evacuation_zone=?, household_size=?, "
                    "has_pets=?, pet_count=?, has_medical_needs=?, has_elderly=?, has_children=?, "
                    "home_type=?, flood_risk=?, updated_at=? WHERE user_id=?",
                    (p["household_name"], p["zone"], p["evacuation_zone"], p["household_size"],
                     int(p["has_pets"]), p["pet_count"], int(p["has_medical_needs"]),
                     int(p["has_elderly"]), int(p["has_children"]), p["home_type"], p["flood_risk"],
                     now_iso(), uid()),
                )
            else:
                conn.execute(
                    "INSERT INTO profiles (user_id, household_name, zone, evacuation_zone, household_size, "
                    "has_pets, pet_count, has_medical_needs, has_elderly, has_children, home_type, "
                    "flood_risk, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (uid(), p["household_name"], p["zone"], p["evacuation_zone"], p["household_size"],
                     int(p["has_pets"]), p["pet_count"], int(p["has_medical_needs"]),
                     int(p["has_elderly"]), int(p["has_children"]), p["home_type"], p["flood_risk"],
                     now_iso(), now_iso()),
                )
            # Only build a checklist if the account has none, so saving never duplicates it.
            has_items = conn.execute(
                "SELECT 1 FROM checklist_items WHERE user_id = ? LIMIT 1", (uid(),)
            ).fetchone()
            if not has_items:
                insert_generated(conn, uid(), checklist_logic.generate_items(p))
                created_checklist = True
        return jsonify({"profile": get_profile(uid()), "checklist_created": created_checklist})

    # ----- checklist -----

    @app.get("/api/checklist")
    @login_required
    def list_checklist():
        return jsonify({"items": get_checklist(uid())})

    @app.post("/api/checklist")
    @login_required
    def add_checklist_item():
        data = body()
        label = _text(data, "label", 200, required=True)
        category = _choice(data, "category", ["evacuation", "hunker_down"])
        conn = dbm.get_db()
        count = conn.execute("SELECT COUNT(*) FROM checklist_items WHERE user_id = ?", (uid(),)).fetchone()[0]
        if count >= MAX_CHECKLIST_ITEMS:
            raise ApiError("Checklist is full. Delete some custom items first.")
        top = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM checklist_items WHERE user_id = ? AND category = ?",
            (uid(), category),
        ).fetchone()[0]
        with conn:
            cur = conn.execute(
                "INSERT INTO checklist_items (user_id, category, label, is_checked, is_custom, sort_order, created_at) "
                "VALUES (?, ?, ?, 0, 1, ?, ?)",
                (uid(), category, label, top + 1, now_iso()),
            )
        row = conn.execute("SELECT * FROM checklist_items WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify({"item": dbm.row_to_dict(row)}), 201

    @app.patch("/api/checklist/<int:item_id>")
    @login_required
    def update_checklist_item(item_id):
        checked = body().get("is_checked")
        if not isinstance(checked, bool):
            raise ApiError("is_checked must be true or false")
        conn = dbm.get_db()
        with conn:
            cur = conn.execute(
                "UPDATE checklist_items SET is_checked = ? WHERE id = ? AND user_id = ?",
                (int(checked), item_id, uid()),
            )
        if cur.rowcount == 0:
            raise ApiError("Item not found", 404)
        return jsonify({"ok": True})

    @app.delete("/api/checklist/<int:item_id>")
    @login_required
    def delete_checklist_item(item_id):
        conn = dbm.get_db()
        row = conn.execute(
            "SELECT is_custom FROM checklist_items WHERE id = ? AND user_id = ?", (item_id, uid())
        ).fetchone()
        if row is None:
            raise ApiError("Item not found", 404)
        if not row["is_custom"]:
            raise ApiError("Only items you added can be deleted", 403)
        with conn:
            conn.execute("DELETE FROM checklist_items WHERE id = ? AND user_id = ?", (item_id, uid()))
        return jsonify({"ok": True})

    @app.post("/api/checklist/sync")
    @login_required
    def sync_checklist():
        """Apply check-offs the phone made while offline, then return the current list."""
        changes = body().get("changes")
        if not isinstance(changes, list) or len(changes) > 500:
            raise ApiError("changes must be a list of up to 500 items")
        rows = []
        for c in changes:
            if not isinstance(c, dict) or isinstance(c.get("id"), bool) or not isinstance(c.get("id"), int) \
                    or not isinstance(c.get("is_checked"), bool):
                raise ApiError("Each change needs an id and is_checked")
            rows.append((int(c["is_checked"]), c["id"], uid()))
        conn = dbm.get_db()
        with conn:
            conn.executemany("UPDATE checklist_items SET is_checked = ? WHERE id = ? AND user_id = ?", rows)
        return jsonify({"items": get_checklist(uid())})

    @app.post("/api/checklist/regenerate")
    @login_required
    def regenerate_checklist():
        profile = get_profile(uid())
        if not profile:
            raise ApiError("Set up your household first")
        items = get_checklist(uid())
        keep_labels = {i["label"] for i in items if i["is_checked"] or i["is_custom"]}
        stale_ids = [i["id"] for i in items if not i["is_custom"] and not i["is_checked"]]
        next_order = {"evacuation": 0, "hunker_down": 0}
        for i in items:
            next_order[i["category"]] = max(next_order[i["category"]], i["sort_order"] + 1)
        fresh = []
        for g in checklist_logic.generate_items(profile):
            if g["label"] in keep_labels:
                continue
            fresh.append({**g, "sort_order": next_order[g["category"]]})
            next_order[g["category"]] += 1
        conn = dbm.get_db()
        # One transaction: either the whole swap happens or none of it does.
        with conn:
            insert_generated(conn, uid(), fresh)
            conn.executemany("DELETE FROM checklist_items WHERE id = ? AND user_id = ?",
                             [(i, uid()) for i in stale_ids])
        return jsonify({"items": get_checklist(uid())})

    # ----- inventory -----

    @app.get("/api/inventory")
    @login_required
    def list_inventory():
        items = get_inventory(uid())
        profile = get_profile(uid())
        return jsonify({
            "items": items,
            "gaps": gap_logic.analyze(profile, items) if profile else None,
        })

    @app.post("/api/inventory")
    @login_required
    def add_inventory_item():
        item = clean_inventory(body())
        conn = dbm.get_db()
        count = conn.execute("SELECT COUNT(*) FROM inventory_items WHERE user_id = ?", (uid(),)).fetchone()[0]
        if count >= MAX_INVENTORY_ITEMS:
            raise ApiError("Supply list is full. Delete some items first.")
        ts = now_iso()
        with conn:
            cur = conn.execute(
                "INSERT INTO inventory_items (user_id, name, category, quantity, location, notes, expires_at, "
                "priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (uid(), item["name"], item["category"], item["quantity"], item["location"], item["notes"],
                 item["expires_at"], item["priority"], ts, ts),
            )
        row = conn.execute("SELECT * FROM inventory_items WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify({"item": dbm.row_to_dict(row)}), 201

    @app.patch("/api/inventory/<int:item_id>")
    @login_required
    def update_inventory_item(item_id):
        changes = clean_inventory(body(), partial=True)
        if not changes:
            raise ApiError("Nothing to update")
        columns = ", ".join(f"{k} = ?" for k in changes)  # keys come from clean_inventory, never from the client
        conn = dbm.get_db()
        with conn:
            cur = conn.execute(
                f"UPDATE inventory_items SET {columns}, updated_at = ? WHERE id = ? AND user_id = ?",
                (*changes.values(), now_iso(), item_id, uid()),
            )
        if cur.rowcount == 0:
            raise ApiError("Item not found", 404)
        row = conn.execute("SELECT * FROM inventory_items WHERE id = ?", (item_id,)).fetchone()
        return jsonify({"item": dbm.row_to_dict(row)})

    @app.delete("/api/inventory/<int:item_id>")
    @login_required
    def delete_inventory_item(item_id):
        conn = dbm.get_db()
        with conn:
            cur = conn.execute("DELETE FROM inventory_items WHERE id = ? AND user_id = ?", (item_id, uid()))
        if cur.rowcount == 0:
            raise ApiError("Item not found", 404)
        return jsonify({"ok": True})

    # ----- alerts and dashboard -----

    def alerts_for(profile):
        all_alerts, status, fetched_at = weather.get_alerts()
        mine = alert_logic.filter_active(alerts_for_county(all_alerts, profile["zone"]))
        return {"items": mine, "status": status, "fetched_at": fetched_at, "county": profile["zone"]}

    @app.get("/api/alerts")
    @login_required
    def alerts_route():
        profile = get_profile(uid())
        if not profile:
            raise ApiError("Set up your household first")
        return jsonify(alerts_for(profile))

    @app.get("/api/dashboard")
    @login_required
    def dashboard():
        profile = get_profile(uid())
        if not profile:
            raise ApiError("Set up your household first")
        checklist = get_checklist(uid())
        inventory = get_inventory(uid())
        alerts = alerts_for(profile)
        actions = alert_logic.match_actions(alerts["items"], checklist)
        progress = {}
        for cat in ("evacuation", "hunker_down"):
            in_cat = [i for i in checklist if i["category"] == cat]
            progress[cat] = {"done": sum(1 for i in in_cat if i["is_checked"]), "total": len(in_cat)}
        return jsonify({
            "profile": profile,
            "alerts": alerts,
            "has_actionable_alert": alert_logic.has_actionable(alerts["items"]),
            "actions": actions,
            "essentials": alert_logic.ten_minute_essentials(checklist),
            "gaps": gap_logic.analyze(profile, inventory),
            "expiring": gap_logic.expiring(inventory),
            "progress": progress,
            "inventory_count": len(inventory),
        })


    # ----- drain map and community reports -----

    def report_json(row, me, is_admin):
        d = dbm.row_to_dict(row)
        return {
            "id": d["id"], "lat": d["lat"], "lng": d["lng"], "drain_id": d["drain_id"],
            "drain_label": d.get("drain_label"), "drain_zone": d.get("drain_zone"), "report_type": d["report_type"],
            "severity": d["severity"], "description": d["description"], "created_at": d["created_at"],
            "confirm_count": d["confirm_count"], "confirmed_by_me": bool(d["confirmed_by_me"]),
            "mine": d["user_id"] == me, "can_manage": d["user_id"] == me or is_admin,
        }

    def active_reports(me, is_admin, report_id=None):
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=REPORT_TTL_HOURS)).isoformat(timespec="seconds")
        sql = (
            "SELECT r.*, dr.label AS drain_label, dr.zone AS drain_zone, "
            "(SELECT COUNT(*) FROM report_confirmations c WHERE c.report_id = r.id) AS confirm_count, "
            "EXISTS(SELECT 1 FROM report_confirmations c WHERE c.report_id = r.id AND c.user_id = ?) AS confirmed_by_me "
            "FROM drain_reports r LEFT JOIN drains dr ON dr.id = r.drain_id "
            "WHERE r.status = 'active' AND r.created_at >= ? "
        )
        args = [me, cutoff]
        if report_id is not None:
            sql += "AND r.id = ? "
            args.append(report_id)
        sql += "ORDER BY r.created_at DESC LIMIT 500"
        rows = dbm.get_db().execute(sql, args).fetchall()
        return [report_json(r, me, is_admin) for r in rows]

    @app.get("/api/drains")
    @login_required
    def list_drains():
        rows = dbm.get_db().execute("SELECT id, lat, lng, label, zone FROM drains ORDER BY zone, label").fetchall()
        return jsonify({"drains": [dict(r) for r in rows]})

    @app.get("/api/reports")
    @login_required
    def list_reports():
        return jsonify({"reports": active_reports(uid(), request.user["is_admin"]),
                        "ttl_hours": REPORT_TTL_HOURS})

    @app.post("/api/reports")
    @login_required
    def create_report():
        r = clean_report(body())
        conn = dbm.get_db()
        since = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec="seconds")
        recent = conn.execute(
            "SELECT COUNT(*) FROM drain_reports WHERE user_id = ? AND created_at >= ?", (uid(), since)
        ).fetchone()[0]
        if recent >= REPORTS_PER_HOUR:
            raise ApiError("You've sent a lot of reports in the last hour. Try again later.", 429)
        # Attach the report to the closest known drain if one is within ~150 m.
        drain_id, best = None, NEAR_DRAIN_METERS
        for d in conn.execute("SELECT id, lat, lng FROM drains WHERE abs(lat - ?) < 0.003 AND abs(lng - ?) < 0.004",
                              (r["lat"], r["lng"])):
            dist = haversine_m(r["lat"], r["lng"], d["lat"], d["lng"])
            if dist <= best:
                drain_id, best = d["id"], dist
        with conn:
            cur = conn.execute(
                "INSERT INTO drain_reports (user_id, drain_id, lat, lng, report_type, severity, description, created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (uid(), drain_id, r["lat"], r["lng"], r["report_type"], r["severity"], r["description"], now_iso()),
            )
        found = active_reports(uid(), request.user["is_admin"], cur.lastrowid)
        return jsonify({"report": found[0]}), 201

    def load_report(report_id):
        row = dbm.get_db().execute(
            "SELECT id, user_id, status FROM drain_reports WHERE id = ?", (report_id,)).fetchone()
        if row is None:
            raise ApiError("Report not found", 404)
        return row

    @app.post("/api/reports/<int:report_id>/confirm")
    @login_required
    def confirm_report(report_id):
        row = load_report(report_id)
        if row["status"] != "active":
            raise ApiError("That report was already cleared", 409)
        if row["user_id"] == uid():
            raise ApiError("You can't confirm your own report", 400)
        conn = dbm.get_db()
        try:
            with conn:
                conn.execute("INSERT INTO report_confirmations (report_id, user_id, created_at) VALUES (?,?,?)",
                             (report_id, uid(), now_iso()))
        except Exception:
            raise ApiError("You already confirmed this report", 409)
        return jsonify({"report": active_reports(uid(), request.user["is_admin"], report_id)[0]})

    @app.post("/api/reports/<int:report_id>/resolve")
    @login_required
    def resolve_report(report_id):
        row = load_report(report_id)
        if row["user_id"] != uid() and not request.user["is_admin"]:
            raise ApiError("Only the person who reported it can clear it", 403)
        with dbm.get_db() as conn:
            conn.execute("UPDATE drain_reports SET status = 'resolved', resolved_at = ? WHERE id = ?",
                         (now_iso(), report_id))
        return jsonify({"ok": True})

    @app.delete("/api/reports/<int:report_id>")
    @login_required
    def delete_report(report_id):
        row = load_report(report_id)
        if row["user_id"] != uid() and not request.user["is_admin"]:
            raise ApiError("Only the person who reported it can delete it", 403)
        with dbm.get_db() as conn:
            conn.execute("DELETE FROM drain_reports WHERE id = ?", (report_id,))
        return jsonify({"ok": True})

    return app


def _load_secret_key(db_path):
    """Use a saved random key so logins survive restarts. On a real host, set SECRET_KEY instead."""
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    path = os.path.join(os.path.dirname(os.path.abspath(db_path)), ".secret_key")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        key = secrets.token_hex(32)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(key)
        os.chmod(path, 0o600)
        return key
