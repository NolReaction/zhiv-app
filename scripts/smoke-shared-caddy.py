"""Exercise both imlive-cloud vhosts from Caddy's adapted production config on loopback."""
import http.client
import http.server
import json
import os
from pathlib import Path
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time


class Site(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Host") != "auto-gorizont.ru" or self.path not in ("/", "/postavki/", "/admin/"):
            self.send_error(404)
            return
        authorized = self.headers.get("Authorization") == "Bearer smoke-test"
        self.send_response(200 if authorized else 401)
        self.send_header("X-Smoke-Site", "auto-gorizont")
        if not authorized:
            self.send_header("WWW-Authenticate", 'Basic realm="smoke"')
        self.end_headers()

    def log_message(self, *args):
        pass


def request(port, host, path, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        conn.request("GET", path, headers={"Host": host, **(headers or {})})
        response = conn.getresponse()
        response.read()
        return response.status, response.headers
    finally:
        conn.close()


def main():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        site_dir = root / "avto-gorizont"
        site_dir.mkdir()
        (root / "maintenance").touch()
        # Keep both vhosts, their matchers, handlers and Unix transport from Compose.
        # Substitute a disposable socket/marker directory and a private HTTP listener.
        config = json.loads(sys.stdin.read().replace("/srv/deploy", directory))
        server, = config["apps"]["http"]["servers"].values()
        with socket.socket() as available:
            available.bind(("127.0.0.1", 0))
            port = available.getsockname()[1]
        server["listen"] = [":8080"]
        server["automatic_https"] = {"disable": True}
        config["admin"] = {"disabled": True}
        path = root / "Caddy.json"
        path.write_text(json.dumps(config))

        with socketserver.UnixStreamServer(str(site_dir / "site.sock"), Site) as site:
            threading.Thread(target=site.serve_forever, daemon=True).start()
            process = subprocess.Popen([
                "docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                "--publish", f"127.0.0.1:{port}:8080", "--volume", f"{directory}:{directory}",
                "--env", f"XDG_DATA_HOME={directory}", "--env", f"XDG_CONFIG_HOME={directory}",
                "--entrypoint", "caddy", sys.argv[1], "run", "--config", str(path),
            ])
            try:
                start = time.monotonic()
                while True:
                    try:
                        status, _ = request(port, "im-alive.ru", "/readyz")
                        break
                    except (ConnectionRefusedError, ConnectionResetError):
                        if process.poll() is not None or time.monotonic() - start > 15:
                            raise
                        time.sleep(0.05)
                assert status == 503, f"game maintenance returned HTTP {status}"
                for endpoint in ("/", "/postavki/", "/admin/"):
                    status, headers = request(port, "auto-gorizont.ru", endpoint)
                    assert status == 401 and headers.get("WWW-Authenticate"), endpoint
                    status, headers = request(port, "auto-gorizont.ru", endpoint, {"Authorization": "Bearer smoke-test"})
                    assert status == 200 and headers.get("X-Smoke-Site") == "auto-gorizont", endpoint
                print("Game maintenance returns 503; the second vhost forwards protected requests over its Unix socket.")
            finally:
                process.terminate()
                process.wait(timeout=5)
                site.shutdown()


if __name__ == "__main__":
    main()
