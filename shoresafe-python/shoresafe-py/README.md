# ShoreSafe

Storm preparedness for Jersey Shore households: weather alerts for your county, evacuation and
hunker-down checklists, a supply tracker with gap analysis, and a community drain map where
neighbors report backups and flooding. Works offline once you've opened it.

- **Back end:** Python (Flask) and a SQLite database file. No Supabase.
- **Front end:** plain HTML, CSS, and JavaScript. No build step, no npm.

## Run it on your computer

1. Install Python 3.10 or newer from python.org (on Windows, tick "Add Python to PATH").
2. Open this folder in VS Code, then **Terminal → New Terminal**.
3. Type these one at a time:

   ```
   python -m venv .venv
   ```
   Then activate it. Windows: `.venv\Scripts\activate`   Mac/Linux: `source .venv/bin/activate`
   ```
   pip install -r requirements.txt
   python run.py
   ```
4. Open http://localhost:5000, create an account, and fill in your household.

Stop it with Ctrl+C. Your data lives in `data/shoresafe.db`.

## Check that it works

```
python -m unittest discover -s tests
```

For a full browser test (optional): `pip install playwright`, `playwright install chromium`, then
`python tests/e2e_browser.py`.

## Put it on the internet

The app is one Python web service, so it needs a host that runs Python and **keeps a file on disk**
(your SQLite database). Free hosts that wipe their disk on every restart will lose all accounts, so
check that before choosing. Two common options:

- **PythonAnywhere:** keeps files, supports Flask. Check that its free plan allows connections to
  `api.weather.gov`; if not, alerts will show "couldn't check".
- **Render, Fly.io, Railway:** run the app from your GitHub repo. Attach a persistent disk/volume
  and point `SHORESAFE_DB` at it. Start command: `gunicorn wsgi:app --workers 1 --threads 4`
  (the `Procfile` has it). Keep **one worker**: sign-in limits and the alert cache live in memory.

Set these environment variables on the host:

| Name | Value |
|---|---|
| `SECRET_KEY` | A long random string. The app refuses to start on a public site without it. Make one with `python -c "import secrets; print(secrets.token_hex(32))"` |
| `SHORESAFE_HTTPS` | `1` (login cookie is only sent over HTTPS) |
| `TRUST_PROXY` | `1` when behind Render/Fly/Railway/Heroku |
| `NWS_CONTACT` | Your email. The National Weather Service asks API users to identify themselves |
| `SHORESAFE_DB` | Path to the database file on the persistent disk, for example `/var/data/shoresafe.db` |
| `REPORT_TTL_HOURS` | Optional. Hours a map report stays up. Default 24 |

Back up the database file regularly.

## Admin

Make an account an admin (can clear or delete any map report) after it signs up:

```
python manage.py make-admin you@example.com
```

## How the pieces fit

```
shoresafe/app.py          all web routes (accounts, checklist, supplies, alerts, map)
shoresafe/logic/          checklist builder, supply gap finder, alert-to-action matcher
shoresafe/weather.py      National Weather Service alerts, cached, matched by county
shoresafe/db.py           database tables
shoresafe/seed_drains.csv starter drain points (see below)
static/                   the website: index.html, css/, js/, sw.js (offline), icons/
tests/                    automated tests
```

## Things to know

- **Drain points are approximate.** `seed_drains.csv` holds the 87 sample points from the earlier
  version. They are not surveyed infrastructure (two share identical coordinates). The map labels them
  as approximate. Real drain locations come from town or county GIS data; replace the CSV and delete
  `data/shoresafe.db` to reload, or insert rows into the `drains` table.
- **Reports are community information.** They drop off after 24 hours, can be confirmed by other
  people (not by the person who made them), and can be cleared by their author or an admin. There is
  no automatic moderation beyond sign-in and a limit of 10 reports per person per hour.
- **Weather alerts** come from the National Weather Service and are matched to your county. They are a
  planning aid, not an official warning system.
- **Map tiles** come from OpenStreetMap and Esri. That is fine for a small community app; if it grows,
  switch to a paid tile provider (edit `static/js/tilemap.js` and the Content-Security-Policy in
  `shoresafe/app.py`).
- **Accounts from the old Supabase version are not carried over.** People create new accounts.
- **Offline:** the app and your last-loaded data open without internet. Checklist check-offs are saved
  on the device and sync when you reconnect. Adding supplies or sending reports needs a connection.
