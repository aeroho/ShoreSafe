"""SQLite storage. One small file on disk holds every account and household."""
import csv
import os
import sqlite3

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    household_name    TEXT NOT NULL,
    zone              TEXT NOT NULL,
    evacuation_zone   TEXT NOT NULL DEFAULT '',
    household_size    INTEGER NOT NULL,
    has_pets          INTEGER NOT NULL DEFAULT 0,
    pet_count         INTEGER NOT NULL DEFAULT 0,
    has_medical_needs INTEGER NOT NULL DEFAULT 0,
    has_elderly       INTEGER NOT NULL DEFAULT 0,
    has_children      INTEGER NOT NULL DEFAULT 0,
    home_type         TEXT NOT NULL,
    flood_risk        TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category   TEXT NOT NULL CHECK (category IN ('evacuation', 'hunker_down')),
    label      TEXT NOT NULL,
    is_checked INTEGER NOT NULL DEFAULT 0,
    is_custom  INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checklist_user ON checklist_items(user_id);

CREATE TABLE IF NOT EXISTS inventory_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    category   TEXT NOT NULL,
    quantity   INTEGER NOT NULL DEFAULT 1,
    location   TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    expires_at TEXT,
    priority   TEXT NOT NULL DEFAULT 'important'
               CHECK (priority IN ('essential', 'important', 'optional')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory_items(user_id);

-- Storm and sewer drain points shown on the map. Shared by everyone, changed only by the site owner.
CREATE TABLE IF NOT EXISTS drains (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    lat   REAL NOT NULL,
    lng   REAL NOT NULL,
    label TEXT NOT NULL,
    zone  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drains_zone ON drains(zone);

-- Community reports of backups and flooding.
CREATE TABLE IF NOT EXISTS drain_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    drain_id    INTEGER REFERENCES drains(id) ON DELETE SET NULL,
    lat         REAL NOT NULL,
    lng         REAL NOT NULL,
    report_type TEXT NOT NULL CHECK (report_type IN ('backup', 'flooding', 'overflow', 'odor', 'other')),
    severity    TEXT NOT NULL CHECK (severity IN ('low', 'moderate', 'high')),
    description TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
    created_at  TEXT NOT NULL,
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON drain_reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_user ON drain_reports(user_id, created_at);

-- One confirmation per person per report.
CREATE TABLE IF NOT EXISTS report_confirmations (
    report_id  INTEGER NOT NULL REFERENCES drain_reports(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (report_id, user_id)
);
"""

SEED_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed_drains.csv")

BOOL_COLUMNS = ("is_admin", "has_pets", "has_medical_needs", "has_elderly", "has_children", "is_checked", "is_custom")


def _connect(path):
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(path):
    conn = _connect(path)
    conn.executescript(SCHEMA)
    # Databases created before the admin flag existed get the column added.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "is_admin" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
    # First run: load the starter drain points. Later runs leave the table alone.
    if conn.execute("SELECT COUNT(*) FROM drains").fetchone()[0] == 0 and os.path.exists(SEED_CSV):
        with open(SEED_CSV, newline="", encoding="utf-8") as f:
            rows = [(float(r["lat"]), float(r["lng"]), r["label"], r["zone"]) for r in csv.DictReader(f)]
        conn.executemany("INSERT INTO drains (lat, lng, label, zone) VALUES (?, ?, ?, ?)", rows)
    conn.commit()
    conn.close()


def get_db():
    if "db" not in g:
        g.db = _connect(current_app.config["DATABASE"])
    return g.db


def close_db(_exc=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def row_to_dict(row):
    """Convert a sqlite row to a plain dict, turning 0/1 columns into booleans."""
    if row is None:
        return None
    d = dict(row)
    for col in BOOL_COLUMNS:
        if col in d:
            d[col] = bool(d[col])
    return d
