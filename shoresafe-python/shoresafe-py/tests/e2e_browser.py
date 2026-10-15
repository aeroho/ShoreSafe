"""End-to-end test: runs the real app in a headless Chromium browser.

    pip install playwright && playwright install chromium
    python tests/e2e_browser.py

Uses a fake weather feed and a temporary database. Set SCREENSHOTS=dir to save pictures.
"""
import os
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from playwright.sync_api import expect, sync_playwright  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

from shoresafe.app import create_app  # noqa: E402
from shoresafe.weather import WeatherService  # noqa: E402

PORT = 5055
BASE = f"http://127.0.0.1:{PORT}"
SHOTS = os.environ.get("SCREENSHOTS")
FEATURES = []


def feature(fid, event, severity="Severe", same=("034029",)):
    ends = (datetime.now(timezone.utc) + timedelta(hours=6)).isoformat()
    return {"id": fid, "properties": {
        "event": event, "severity": severity, "headline": f"{event} issued for Ocean County",
        "description": "Water levels will rise.\n\nTake action.", "instruction": "Avoid flooded roads.",
        "sent": datetime.now(timezone.utc).isoformat(), "ends": ends, "senderName": "NWS Mount Holly NJ",
        "areaDesc": "Ocean, NJ", "geocode": {"SAME": list(same)}}}


def fake_nws(_url):
    return {"features": list(FEATURES)}


def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, f"{name}.png"), full_page=True)


def main():
    tmp = tempfile.TemporaryDirectory()
    app = create_app({"TESTING": False, "SECRET_KEY": "e2e" * 12, "DATABASE": os.path.join(tmp.name, "e2e.db"),
                      "WEATHER": WeatherService(fetch=fake_nws, ttl=0)})
    server = make_server("127.0.0.1", PORT, app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    problems = []
    passed = []

    def check(name, cond, detail=""):
        (passed if cond else problems).append(name if cond else f"{name} {detail}")
        print(("PASS " if cond else "FAIL ") + name, detail if not cond else "")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" and "tile" not in m.text.lower()
                and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)

        # ---- sign up and onboarding ----
        page.goto(BASE)
        expect(page.get_by_role("heading", name="ShoreSafe")).to_be_visible()
        shot(page, "01-auth")
        page.fill("input[name=email]", "e2e@example.com")
        page.fill("input[name=password]", "password123")
        page.click("[data-mode=signup]")
        page.fill("input[name=email]", "e2e@example.com")
        page.fill("input[name=password]", "password123")
        page.click("button[type=submit]")
        expect(page.get_by_text("Set up your household")).to_be_visible()
        page.fill("input[name=household_name]", "Beach House")
        page.select_option("select[name=zone]", "Ocean")
        shot(page, "02-setup-1")
        page.click("[data-next]")
        page.get_by_text("Pets", exact=True).click()
        page.click("[data-next]")
        page.get_by_text("High", exact=True).first.click()
        page.click("[data-next]")
        expect(page.get_by_text("Beach House")).to_be_visible()
        page.click("[data-save]")
        expect(page.get_by_text("No active weather alerts for Ocean County")).to_be_visible()
        check("onboarding creates household and shows Home", True)
        shot(page, "03-home")

        # ---- checklist: conditional items present because pets + high flood ----
        page.click("a[data-route=checklist]")
        expect(page.get_by_text("Grab your Go-Bag")).to_be_visible()
        check("pet items appear for a pet household", page.get_by_text("Pack pet food for at least 3 days").count() == 1)
        first_box = page.locator("input[type=checkbox][data-id]").first
        first_box.check()
        expect(page.locator("[data-done]")).to_contain_text("1 of")
        check("checking an item updates progress", True)
        shot(page, "04-checklist")

        # ---- custom item with hostile text is shown as text, never run ----
        page.fill("#new-item", "<img src=x onerror=window.__pwned=1> Feed cat")
        page.click("[data-add] button[type=submit]")
        expect(page.get_by_text("Feed cat")).to_be_visible()
        check("script-like text is escaped (no XSS)", page.evaluate("window.__pwned") is None)

        # ---- supplies ----
        page.click("a[data-route=supplies]")
        expect(page.get_by_text("What your household needs")).to_be_visible()
        if not page.locator("details.fold[open]").count():
            page.click("details.fold summary")
        page.fill("input[name=name]", "Bottled water")
        page.select_option("select[name=category]", "water")
        page.fill("input[name=quantity]", "6")
        page.click("[data-add] button[type=submit]")
        expect(page.locator(".supply-name", has_text="Bottled water")).to_be_visible()
        check("supply added and gap analysis shows water short", page.get_by_text("Have 6 of 14 gallons").count() == 1)
        shot(page, "05-supplies")

        # ---- alerts: tornado -> shelter, hurricane warning -> evacuation-level ----
        FEATURES.extend([feature("a1", "Tornado Warning", "Extreme"), feature("a2", "Hurricane Warning", "Extreme"),
                         feature("a3", "Flood Watch", "Moderate", same=("034009",))])
        page.click("a[data-route=alerts]")
        expect(page.get_by_text("Tornado Warning").first).to_be_visible()
        check("alerts only for my county", page.get_by_text("Flood Watch").count() == 0)
        shot(page, "06-alerts")
        page.click("a[data-route=home]")
        expect(page.get_by_text("Take shelter now: Tornado Warning")).to_be_visible()
        expect(page.get_by_text("Evacuation-level alert: Hurricane Warning")).to_be_visible()
        check("tornado shows shelter panel, hurricane shows evacuation panel", True)
        check("alerts tab badge shows", page.locator("[data-badge]").is_visible())
        shot(page, "07-home-alerts")
        FEATURES.clear()

        # ---- offline: app opens from the service worker, check-offs queue and sync ----
        page.evaluate("navigator.serviceWorker.ready.then(() => true)")
        page.wait_for_timeout(800)
        page.click("a[data-route=checklist]")
        expect(page.get_by_text("Grab your Go-Bag")).to_be_visible()
        ctx.set_offline(True)
        page.reload()
        expect(page.get_by_text("Grab your Go-Bag")).to_be_visible(timeout=8000)
        check("app reloads with no connection", True)
        expect(page.get_by_text("You're offline").first).to_be_visible()
        boxes = page.locator("input[type=checkbox][data-id]")
        boxes.nth(1).check()
        boxes.nth(2).check()
        expect(page.locator("[data-pending]")).to_contain_text("2 changes saved on this device")
        check("offline check-offs are queued", True)
        shot(page, "08-offline")
        page.click("a[data-route=home]")
        expect(page.get_by_text("You're offline").first).to_be_visible()
        page.wait_for_timeout(1500)
        check("home shows saved data offline", page.get_by_text("Supply readiness").count() == 1,
              f"(page text: {page.locator('#view').inner_text()[:200]!r})")
        ctx.set_offline(False)
        page.evaluate("window.dispatchEvent(new Event('online'))")
        page.wait_for_timeout(1500)
        done = page.evaluate("fetch('/api/checklist').then(r => r.json()).then(d => d.items.filter(i => i.is_checked).length)")
        check("queued check-offs reach the server on reconnect", done == 3, f"(server has {done} checked, expected 3)")

        # ---- drain map ----
        page.click("a[data-route=map]")
        expect(page.get_by_role("heading", name="Drain map")).to_be_visible()
        page.wait_for_selector(".pin-drain")
        check("87 drain markers drawn", page.locator(".pin-drain").count() == 87, f"(found {page.locator('.pin-drain').count()})")
        check("map requests tiles", page.locator("img.tile").count() > 0)
        page.get_by_role("button", name="Ocean", exact=True).click()
        page.wait_for_timeout(300)
        box = page.locator(".tilemap").bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2 - 60, box["y"] + box["height"] / 2 - 60)
        expect(page.get_by_text("Report a problem")).to_be_visible()
        page.get_by_role("radio", name="Flooding").click()
        page.get_by_role("radio", name="High").click()
        page.fill("textarea[name=description]", "Street under 6 inches of water")
        shot(page, "09-map-form")
        page.get_by_role("button", name="Send report").click()
        page.wait_for_selector(".pin-report")
        expect(page.locator("[data-list]")).to_contain_text("Street under 6 inches of water")
        check("tap map, send report, see it listed", page.locator(".pin-report").count() == 1,
              f"(pins={page.locator('.pin-report').count()}, list={page.locator('[data-list]').inner_text()[:160]!r})")
        shot(page, "10-map-report")

        # a second person sees it and confirms it
        ctx2 = browser.new_context(viewport={"width": 390, "height": 844})
        p2 = ctx2.new_page()
        p2.goto(BASE)
        p2.click("[data-mode=signup]")
        p2.fill("input[name=email]", "neighbor@example.com")
        p2.fill("input[name=password]", "password123")
        p2.click("button[type=submit]")
        p2.click("[data-next]"); p2.click("[data-next]"); p2.click("[data-next]"); p2.click("[data-save]")
        p2.wait_for_selector("a[data-route=map]")
        p2.click("a[data-route=map]")
        p2.wait_for_selector(".pin-report")
        p2.locator(".pin-report").first.click()
        p2.get_by_role("button", name="I see this too").click()
        expect(p2.get_by_text("1 person has confirmed this.")).to_be_visible()
        check("another person can confirm a report", True)
        ctx2.close()

        # ---- theme, household settings, sign out ----
        page.click("[data-theme-btn]")
        check("theme toggle sets data-theme", page.evaluate("document.documentElement.dataset.theme") in ("dark", "light"))
        shot(page, "11-theme")
        page.click("a[href='#/household']")
        expect(page.locator("h1", has_text="Household")).to_be_visible()
        page.fill("input[name=household_name]", "Bay House")
        page.click("[data-save]")
        expect(page.get_by_text("Saved.")).to_be_visible()
        check("household can be edited", page.locator("[data-brand-sub]").inner_text().startswith("Bay House"))
        page.click("[data-signout]")
        expect(page.get_by_role("button", name="Sign in").first).to_be_visible()
        check("sign out clears on-device data",
              page.evaluate("Object.keys(localStorage).filter(k => k.startsWith('shoresafe:v2') || k === 'shoresafe:last-me').length") == 0)

        # ---- desktop layout screenshots ----
        page.set_viewport_size({"width": 1180, "height": 860})
        page.fill("input[name=email]", "e2e@example.com")
        page.fill("input[name=password]", "password123")
        page.click("button[type=submit]")
        page.wait_for_selector("a[data-route=home]")
        shot(page, "12-desktop-home")

        check("no console errors or CSP violations", not errors, "\n".join(errors[:8]))
        browser.close()

    server.shutdown()
    print(f"\n{len(passed)} passed, {len(problems)} failed")
    for pr in problems:
        print("  -", pr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
