#!/usr/bin/env python3
"""scan-inbox - a tiny "scan on one device, read on another" inbox.

Standard library only. Serves the web pages and a small JSON API backed by SQLite.
Pages come from ./static (usually a bind mount) when a file exists there, otherwise from
./static-default, the copy built into the image.

  GET    /api/scans          list scans, newest first
  GET    /api/scans/latest   {"id": newest id, "count": n} - cheap change detector for polling
  POST   /api/scans          {"text": "...", "ts": <unix seconds, optional>}
  DELETE /api/scans/<id>
  GET    /healthz

Authentication is NOT handled here: put it behind authentication provider (like Authelia)
and bind the container to 127.0.0.1 only.
"""
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DB_PATH = os.environ.get("DB_PATH", "/data/scans.db")
PORT = int(os.environ.get("PORT", "8000"))
APP_DIR = Path(__file__).parent
# Checked in order: files in ./static override the pages built into the image.
STATIC_DIRS = [(APP_DIR / "static").resolve(), (APP_DIR / "static-default").resolve()]

MAX_TEXT = 4096          # characters per scan
MAX_BODY = 16 * 1024     # bytes per request body
RETENTION_DAYS = 183    # scans older than this (about 6 months) are deleted
MAX_LIST = 5000          # safety cap on rows returned by GET /api/scans
DEDUPE_SECONDS = 5       # same text as the newest row within this window = duplicate
MAX_AGE = 30 * 24 * 3600 # accept client-supplied timestamps up to this old

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json",
}


@contextmanager
def db():
    """One short-lived connection per operation; commits on success, always closes."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init_db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            """CREATE TABLE IF NOT EXISTS scans (
                   id   INTEGER PRIMARY KEY AUTOINCREMENT,
                   text TEXT    NOT NULL,
                   ts   INTEGER NOT NULL
               )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS scans_ts ON scans (ts)")
        prune(conn)


def prune(conn):
    cutoff = int(time.time()) - RETENTION_DAYS * 24 * 3600
    conn.execute("DELETE FROM scans WHERE ts < ?", (cutoff,))


def row_to_dict(row):
    return {"id": row["id"], "text": row["text"], "ts": row["ts"]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "scan-inbox"
    sys_version = ""

    # ---- helpers -------------------------------------------------------
    def log_request(self, code="-", size="-"):
        # Polling makes successful GETs very noisy; only log the interesting ones.
        if self.command == "GET" and str(code).startswith("2"):
            return
        super().log_request(code, size)

    def _send(self, status, body=b"", ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status, message):
        self._send(status, {"error": message}, headers={"Cache-Control": "no-store"})

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.close_connection = True  # body left unread, so drop the connection
            return None
        return self.rfile.read(length) if length else b""

    def _csrf_ok(self):
        # Browsers cannot add this header cross-site without a CORS preflight,
        # which this server never approves. It also makes Authelia answer 401
        # instead of a redirect when the session has expired.
        return self.headers.get("X-Requested-With") == "XMLHttpRequest"

    # ---- routes --------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/scans":
            return self._list()
        if path == "/api/scans/latest":
            return self._latest()
        if path == "/healthz":
            return self._send(200, {"ok": True})
        if path.startswith("/api/"):
            return self._error(404, "not found")
        return self._static(path)

    def do_POST(self):
        raw = self._read_body()
        if raw is None:
            return self._error(413, "request too large")
        if not self._csrf_ok():
            return self._error(403, "missing X-Requested-With header")
        if self.path.split("?", 1)[0] != "/api/scans":
            return self._error(404, "not found")
        try:
            data = json.loads(raw or b"{}")
            text = data["text"]
            if not isinstance(text, str) or not text.strip():
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self._error(400, "body must be JSON like {\"text\": \"...\"}")
        if len(text) > MAX_TEXT:
            return self._error(413, f"text longer than {MAX_TEXT} characters")

        now = int(time.time())
        ts = data.get("ts")
        if not isinstance(ts, int) or isinstance(ts, bool) or not (now - MAX_AGE <= ts <= now + 5):
            ts = now

        with db() as conn:
            newest = conn.execute(
                "SELECT id, text, ts FROM scans ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if newest and newest["text"] == text and abs(ts - newest["ts"]) < DEDUPE_SECONDS:
                return self._send(200, {**row_to_dict(newest), "duplicate": True})
            cur = conn.execute("INSERT INTO scans (text, ts) VALUES (?, ?)", (text, ts))
            new_id = cur.lastrowid
            prune(conn)
        self._send(201, {"id": new_id, "text": text, "ts": ts, "duplicate": False})

    def do_DELETE(self):
        if not self._csrf_ok():
            return self._error(403, "missing X-Requested-With header")
        match = re.fullmatch(r"/api/scans/(\d+)", self.path.split("?", 1)[0])
        if not match:
            return self._error(404, "not found")
        with db() as conn:
            cur = conn.execute("DELETE FROM scans WHERE id = ?", (int(match.group(1)),))
        if cur.rowcount == 0:
            return self._error(404, "no such scan")
        self._send(200, {"ok": True}, headers={"Cache-Control": "no-store"})

    # ---- handlers ------------------------------------------------------
    def _list(self):
        with db() as conn:
            rows = conn.execute(
                "SELECT id, text, ts FROM scans ORDER BY id DESC LIMIT ?", (MAX_LIST,)
            ).fetchall()
        self._send(200, {"scans": [row_to_dict(r) for r in rows]},
                   headers={"Cache-Control": "no-store"})

    def _latest(self):
        with db() as conn:
            row = conn.execute("SELECT COALESCE(MAX(id), 0) AS id, COUNT(*) AS count FROM scans").fetchone()
        self._send(200, {"id": row["id"], "count": row["count"]}, headers={"Cache-Control": "no-store"})

    def _static(self, path):
        if path.endswith("/"):
            path += "index.html"
        for base in STATIC_DIRS:
            target = (base / path.lstrip("/")).resolve()
            if base in target.parents and target.is_file():
                ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
                cache = "public, max-age=86400" if "vendor" in target.parts else "no-cache"
                return self._send(200, target.read_bytes(), ctype, {"Cache-Control": cache})
        self._error(404, "not found")


if __name__ == "__main__":
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"scan-inbox listening on :{PORT}, database at {DB_PATH}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
