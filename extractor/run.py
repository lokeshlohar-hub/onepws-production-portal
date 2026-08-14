"""Production launcher: serve the Flask app via waitress on localhost:8082."""
from waitress import serve
from server import app

if __name__ == "__main__":
    # Localhost only. Threaded so a slow PDF doesn't block other requests.
    serve(app, host="127.0.0.1", port=8082, threads=4, connection_limit=100,
          channel_timeout=120)