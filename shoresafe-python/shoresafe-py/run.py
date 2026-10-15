"""Start ShoreSafe on your own computer:  python run.py   then open http://localhost:5000"""
from shoresafe.app import create_app

if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=5000, debug=True)
