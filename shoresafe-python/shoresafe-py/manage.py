"""Site-owner commands.

  python manage.py make-admin you@example.com     let this account clear or delete any drain report
  python manage.py remove-admin you@example.com
  python manage.py list-users
"""
import os
import sqlite3
import sys

DB = os.environ.get("SHORESAFE_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "shoresafe.db"))


def main(argv):
    if len(argv) < 2 or argv[1] not in ("make-admin", "remove-admin", "list-users"):
        print(__doc__)
        return 1
    conn = sqlite3.connect(DB)
    if argv[1] == "list-users":
        for row in conn.execute("SELECT id, email, is_admin, created_at FROM users ORDER BY id"):
            print(row)
        return 0
    if len(argv) != 3:
        print(__doc__)
        return 1
    email = argv[2].strip().lower()
    flag = 1 if argv[1] == "make-admin" else 0
    cur = conn.execute("UPDATE users SET is_admin = ? WHERE email = ?", (flag, email))
    conn.commit()
    if cur.rowcount == 0:
        print(f"No account with the email {email}. Create it in the app first.")
        return 1
    print(f"{email} is {'now' if flag else 'no longer'} an admin.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
