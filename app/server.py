"""HTTP API + static page for the calibration commit service.

Stdlib-only so the image needs nothing beyond a Python interpreter.
"""

from __future__ import annotations

import json
import os
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from .engine import (
    ACCEPTED,
    REJECTED,
    EngineError,
    Store,
)

DATA_PATH = os.environ.get("CALIB_DB", "/data/calibration.json")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# Populated in main(); importing the module must not touch the filesystem so
# build checks and tests can import it outside the container layout.
store: "Store | None" = None


class Handler(BaseHTTPRequestHandler):
    server_version = "CalibCommit/1.0"

    # ---------------------------------------------------------------- helpers
    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> object:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise EngineError("request body is required")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EngineError(f"invalid JSON body: {exc}") from exc

    def log_message(self, fmt: str, *args) -> None:  # quieter logs
        if os.environ.get("HTTP_LOG") == "1":
            super().log_message(fmt, *args)

    # ---------------------------------------------------------------- GET
    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        try:
            parts = urlsplit(self.path)
            path = parts.path
            q = {k: v[0] for k, v in parse_qs(parts.query).items()}

            if path == "/healthz":
                self._send_json(
                    200,
                    {
                        "status": "ok",
                        "current_generation": store.current_generation(),
                        "service": "ground-calibration-library",
                    },
                )
                return

            if path == "/api/state":
                self._send_json(200, store.export_exercise())
                return

            if path == "/api/history":
                self._send_json(200, {"generations": store.history()})
                return

            if path == "/api/transactions":
                self._send_json(200, {"transactions": store.list_transactions()})
                return

            if path.startswith("/api/transactions/"):
                txn_id = path.rsplit("/", 1)[1]
                result = store.get_transaction(txn_id)
                if result is None:
                    self._send_json(404, {"error": "transaction not found",
                                         "transaction_id": txn_id})
                else:
                    self._send_json(200, result)
                return

            if path == "/api/snapshot/point":
                gen = _require_int(q, "generation")
                key = q.get("key")
                if key is None:
                    raise EngineError("key query parameter is required")
                snap = store.snapshot(gen)
                self._send_json(
                    200,
                    {"generation": gen, "key": key, "value": snap.point_read(key)},
                )
                return

            if path == "/api/snapshot/scan":
                gen = _require_int(q, "generation")
                prefix = q.get("prefix", "")
                snap = store.snapshot(gen)
                self._send_json(200, snap.prefix_scan(prefix))
                return

            if path == "/" or path == "/index.html":
                self._serve_static("index.html", "text/html; charset=utf-8")
                return
            if path == "/app.js":
                self._serve_static("app.js", "application/javascript; charset=utf-8")
                return
            if path == "/styles.css":
                self._serve_static("styles.css", "text/css; charset=utf-8")
                return

            self._send_json(404, {"error": "not found", "path": path})
        except EngineError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception:  # noqa: BLE001 - surface as 500, never hang
            traceback.print_exc()
            self._send_json(500, {"error": "internal server error"})

    def _serve_static(self, name: str, content_type: str) -> None:
        target = os.path.normpath(os.path.join(STATIC_DIR, name))
        if not target.startswith(STATIC_DIR + os.sep) or not os.path.isfile(target):
            self._send_json(404, {"error": "not found"})
            return
        with open(target, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------------------------------------------------------------- POST
    def do_POST(self) -> None:  # noqa: N802
        try:
            parts = urlsplit(self.path)
            path = parts.path

            if path == "/api/exercise":
                body = self._read_json()
                if not isinstance(body, dict):
                    raise EngineError("body must be an object")
                initial = body.get("initial", body.get("keys"))
                if initial is None:
                    raise EngineError("initial key/values are required")
                self._send_json(201, store.seed(initial))
                return

            if path == "/api/commit":
                body = self._read_json()
                result = store.commit(body)
                # Accepted verdict -> 200 whether txn accepted or rejected;
                # the arbitration *itself* succeeded. Conflict semantics live
                # in body.status/reason, which is what clients and tests key on.
                self._send_json(200, result)
                return

            self._send_json(404, {"error": "not found", "path": path})
        except EngineError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            self._send_json(500, {"error": "internal server error"})


def _require_int(q: dict, name: str) -> int:
    raw = q.get(name)
    if raw is None:
        raise EngineError(f"{name} query parameter is required")
    try:
        value = int(raw)
    except ValueError as exc:
        raise EngineError(f"{name} must be an integer") from exc
    if value < 0:
        raise EngineError(f"{name} must be non-negative")
    return value


def main() -> None:
    global store
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    if store is None:
        store = Store(DATA_PATH)
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"calibration commit service on http://{host}:{port} (db={DATA_PATH})",
          flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
