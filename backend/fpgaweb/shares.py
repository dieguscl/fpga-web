"""Short share links: immutable project snapshots in SQLite.

Abuse limits live here and in the API layer: only validated project text is
stored (never served as a file), IDs are random and unlisted, snapshots expire
after `share_ttl_days` without being opened, there is a global storage quota,
creators get a delete key, anyone can report, and an admin can delete or ban.
Creators are recorded as a keyed hash of their IP, never the IP itself.
"""

import hashlib
import hmac
import json
import secrets
import sqlite3
import string
import threading
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

ID_ALPHABET = string.ascii_letters + string.digits
ID_LEN = 10
ACCESS_WRITE_EVERY_S = 86400  # refresh last_access at most once a day per share


class ShareError(Exception):
    """Refused for a reason the client should see (quota, ban)."""


@dataclass(frozen=True)
class Created:
    id: str
    delete_key: str | None  # None when the same creator already shared identical content


def _canonical(project: dict) -> bytes:
    return json.dumps(project, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


class ShareStore:
    def __init__(self, path: Path, quota_bytes: int, ttl_days: int, clock=time.time):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._quota = quota_bytes
        self._ttl_s = ttl_days * 86400
        self._clock = clock
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS shares (
              id TEXT PRIMARY KEY,
              hash TEXT NOT NULL,
              creator TEXT NOT NULL,
              data BLOB NOT NULL,
              size INTEGER NOT NULL,
              created REAL NOT NULL,
              last_access REAL NOT NULL,
              delete_key TEXT NOT NULL,
              reports INTEGER NOT NULL DEFAULT 0
            );
            CREATE UNIQUE INDEX IF NOT EXISTS shares_creator_hash ON shares (creator, hash);
            CREATE TABLE IF NOT EXISTS bans (creator TEXT PRIMARY KEY, at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
            """
        )
        row = self._db.execute("SELECT v FROM meta WHERE k = 'salt'").fetchone()
        if row is None:
            salt = secrets.token_hex(32)
            self._db.execute("INSERT INTO meta (k, v) VALUES ('salt', ?)", (salt,))
        else:
            salt = row[0]
        self._salt = salt.encode()

    def creator_id(self, ip: str) -> str:
        return hmac.new(self._salt, ip.encode(), hashlib.sha256).hexdigest()[:24]

    def create(self, project: dict, ip: str) -> Created:
        creator = self.creator_id(ip)
        raw = _canonical(project)
        digest = hashlib.sha256(raw).hexdigest()
        blob = zlib.compress(raw, 9)
        now = self._clock()
        with self._lock:
            if self._db.execute("SELECT 1 FROM bans WHERE creator = ?", (creator,)).fetchone():
                raise ShareError("sharing is disabled for this connection")
            dup = self._db.execute("SELECT id FROM shares WHERE creator = ? AND hash = ?", (creator, digest)).fetchone()
            if dup:
                self._db.execute("UPDATE shares SET last_access = ? WHERE id = ?", (now, dup[0]))
                return Created(dup[0], None)
            used = self._db.execute("SELECT COALESCE(SUM(size), 0) FROM shares").fetchone()[0]
            if used + len(blob) > self._quota:
                raise ShareError("share storage is full; please try again later or export a .zip")
            key = secrets.token_urlsafe(18)
            while True:
                sid = "".join(secrets.choice(ID_ALPHABET) for _ in range(ID_LEN))
                if not self._db.execute("SELECT 1 FROM shares WHERE id = ?", (sid,)).fetchone():
                    break
            self._db.execute(
                "INSERT INTO shares (id, hash, creator, data, size, created, last_access, delete_key)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (sid, digest, creator, blob, len(blob), now, now, hashlib.sha256(key.encode()).hexdigest()),
            )
            return Created(sid, key)

    def get(self, sid: str) -> dict | None:
        now = self._clock()
        with self._lock:
            row = self._db.execute("SELECT data, last_access FROM shares WHERE id = ?", (sid,)).fetchone()
            if row is None:
                return None
            if now - row[1] > self._ttl_s:
                self._db.execute("DELETE FROM shares WHERE id = ?", (sid,))
                return None
            if now - row[1] > ACCESS_WRITE_EVERY_S:
                self._db.execute("UPDATE shares SET last_access = ? WHERE id = ?", (now, sid))
        return json.loads(zlib.decompress(row[0]))

    def delete(self, sid: str, key: str) -> bool:
        with self._lock:
            row = self._db.execute("SELECT delete_key FROM shares WHERE id = ?", (sid,)).fetchone()
            if row is None or not hmac.compare_digest(row[0], hashlib.sha256(key.encode()).hexdigest()):
                return False
            self._db.execute("DELETE FROM shares WHERE id = ?", (sid,))
            return True

    def report(self, sid: str) -> bool:
        with self._lock:
            return self._db.execute("UPDATE shares SET reports = reports + 1 WHERE id = ?", (sid,)).rowcount > 0

    def purge_expired(self) -> int:
        with self._lock:
            cutoff = self._clock() - self._ttl_s
            return self._db.execute("DELETE FROM shares WHERE last_access < ?", (cutoff,)).rowcount

    def backup(self, dest_dir: Path, keep: int = 7) -> Path:
        """Consistent copy of the database (safe while in use); keeps the newest `keep`."""
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / time.strftime("shares-%Y%m%d.db", time.gmtime(self._clock()))
        with self._lock, sqlite3.connect(dest) as out:
            self._db.backup(out)
        for old in sorted(dest_dir.glob("shares-*.db"))[:-keep]:
            old.unlink(missing_ok=True)
        return dest

    # ── admin ──

    def admin_delete(self, sid: str) -> bool:
        with self._lock:
            return self._db.execute("DELETE FROM shares WHERE id = ?", (sid,)).rowcount > 0

    def admin_ban(self, sid: str, purge: bool) -> int:
        """Ban whoever created share `sid`; with purge, delete all their shares. Returns shares deleted."""
        with self._lock:
            row = self._db.execute("SELECT creator FROM shares WHERE id = ?", (sid,)).fetchone()
            if row is None:
                raise ShareError(f"no share {sid}")
            self._db.execute("INSERT OR IGNORE INTO bans (creator, at) VALUES (?, ?)", (row[0], self._clock()))
            if not purge:
                return 0
            return self._db.execute("DELETE FROM shares WHERE creator = ?", (row[0],)).rowcount

    def stats(self) -> dict:
        with self._lock:
            n, size = self._db.execute("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM shares").fetchone()
            bans = self._db.execute("SELECT COUNT(*) FROM bans").fetchone()[0]
            reported = self._db.execute(
                "SELECT id, reports, created FROM shares WHERE reports > 0 ORDER BY reports DESC LIMIT 50"
            ).fetchall()
        return {"shares": n, "bytes": size, "quota": self._quota, "bans": bans,
                "reported": [{"id": r[0], "reports": r[1], "created": r[2]} for r in reported]}
