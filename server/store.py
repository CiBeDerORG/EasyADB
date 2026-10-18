"""Persistent device records; ADB connection state is intentionally not persisted."""
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path


class DeviceStore:
    def __init__(self, filename: str):
        self.path = Path(filename)

    @contextmanager
    def connection(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(str(self.path), timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=10000")
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def initialize(self):
        with self.connection() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS devices (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    group_name TEXT NOT NULL DEFAULT '',
                    ip TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    auto_reconnect INTEGER NOT NULL DEFAULT 0,
                    model TEXT,
                    android_version TEXT,
                    UNIQUE (ip, port)
                )
            """)

    @staticmethod
    def as_dict(row):
        if row is None:
            return None
        result = dict(row)
        result["auto_reconnect"] = bool(result["auto_reconnect"])
        return result

    def list(self):
        with self.connection() as db:
            return [self.as_dict(r) for r in db.execute(
                "SELECT * FROM devices ORDER BY group_name COLLATE NOCASE, name COLLATE NOCASE, id"
            )]

    def get(self, device_id):
        with self.connection() as db:
            return self.as_dict(db.execute(
                "SELECT * FROM devices WHERE id=?", (device_id,)
            ).fetchone())

    def create(self, values):
        device_id = uuid.uuid4().hex
        with self.connection() as db:
            db.execute(
                """INSERT INTO devices
                   (id,name,group_name,ip,port,auto_reconnect)
                   VALUES (?,?,?,?,?,?)""",
                (device_id, values["name"], values["group_name"], values["ip"],
                 values["port"], int(values["auto_reconnect"]))
            )
        return self.get(device_id)

    def update(self, device_id, values):
        with self.connection() as db:
            cursor = db.execute(
                """UPDATE devices
                   SET name=?,group_name=?,ip=?,port=?,auto_reconnect=?,
                       model=CASE WHEN ip<>? OR port<>? THEN NULL ELSE model END,
                       android_version=CASE WHEN ip<>? OR port<>? THEN NULL ELSE android_version END
                   WHERE id=?""",
                (values["name"], values["group_name"], values["ip"],
                 values["port"], int(values["auto_reconnect"]),
                 values["ip"], values["port"], values["ip"], values["port"], device_id)
            )
            if cursor.rowcount == 0:
                return None
        return self.get(device_id)

    def set_metadata(self, device_id, model, android_version):
        with self.connection() as db:
            db.execute(
                "UPDATE devices SET model=?, android_version=? WHERE id=?",
                (model, android_version, device_id)
            )

    def delete(self, device_id):
        with self.connection() as db:
            return db.execute("DELETE FROM devices WHERE id=?", (device_id,)).rowcount > 0
