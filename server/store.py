"""SQLite device records and group-scoped, derived LAN address mapping."""
import ipaddress
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path


def internal_ip(prefix, mesh_ip):
    """A group prefix like 192.168.10.* retains only the mesh IP's last octet."""
    if not prefix:
        return None
    return prefix[:-1] + mesh_ip.rsplit(".", 1)[1]


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
            db.execute("""
                CREATE TABLE IF NOT EXISTS group_configs (
                    name TEXT PRIMARY KEY,
                    ip_prefix TEXT
                )
            """)
            # Import group names from existing M1 records without changing any device ID.
            db.execute("""INSERT OR IGNORE INTO group_configs(name, ip_prefix)
                          SELECT DISTINCT group_name, NULL FROM devices WHERE group_name <> ''""")

    @staticmethod
    def as_dict(row):
        if row is None:
            return None
        result = dict(row)
        if "auto_reconnect" in result:
            result["auto_reconnect"] = bool(result["auto_reconnect"])
        if "ip" in result:
            result["lan_ip"] = internal_ip(result.pop("ip_prefix", None), result["ip"])
            result["mesh_ip"] = result["ip"]
        return result

    @staticmethod
    def _query():
        return """SELECT d.*,g.ip_prefix FROM devices d
                  LEFT JOIN group_configs g ON g.name=d.group_name"""

    @staticmethod
    def _check_routes(db):
        """Reject ambiguous ADB serials shared by two logical devices."""
        owners = {}
        rows = db.execute(DeviceStore._query()).fetchall()
        for row in rows:
            lan = internal_ip(row["ip_prefix"], row["ip"])
            for ip in {row["ip"], lan} - {None}:
                serial = (ip, row["port"])
                other = owners.get(serial)
                if other and other != row["id"]:
                    raise ValueError("内网 IP 与其他设备的连接地址冲突，请调整分组前缀或设备端口")
                owners[serial] = row["id"]

    def list(self):
        with self.connection() as db:
            return [self.as_dict(r) for r in db.execute(
                self._query() + " ORDER BY d.group_name COLLATE NOCASE, d.name COLLATE NOCASE, d.id"
            )]

    def get(self, device_id):
        with self.connection() as db:
            return self.as_dict(db.execute(
                self._query() + " WHERE d.id=?", (device_id,)
            ).fetchone())

    def list_groups(self):
        with self.connection() as db:
            return [dict(row) for row in db.execute(
                "SELECT name,ip_prefix FROM group_configs ORDER BY name COLLATE NOCASE"
            )]

    def get_group(self, name):
        with self.connection() as db:
            row = db.execute("SELECT name,ip_prefix FROM group_configs WHERE name=?", (name,)).fetchone()
            return dict(row) if row else None

    def create_group(self, name, prefix):
        with self.connection() as db:
            db.execute("INSERT INTO group_configs(name,ip_prefix) VALUES (?,?)", (name, prefix))
            self._check_routes(db)
        return self.get_group(name)

    def update_group(self, old_name, name, prefix):
        with self.connection() as db:
            row = db.execute("SELECT name FROM group_configs WHERE name=?", (old_name,)).fetchone()
            if not row:
                return None
            # Rename must move members atomically. No group FK in the legacy M1 schema.
            if old_name != name:
                db.execute("INSERT INTO group_configs(name,ip_prefix) VALUES (?,?)", (name, prefix))
                db.execute("UPDATE devices SET group_name=? WHERE group_name=?", (name, old_name))
                db.execute("DELETE FROM group_configs WHERE name=?", (old_name,))
            else:
                db.execute("UPDATE group_configs SET ip_prefix=? WHERE name=?", (prefix, name))
            self._check_routes(db)
        return self.get_group(name)

    def delete_group(self, name):
        """Delete the group and move members to ungrouped in one transaction.

        Device IDs, stored mesh IPs, port numbers and ADB credentials remain
        unchanged. Derived LAN addresses disappear when group_name is cleared.
        """
        with self.connection() as db:
            exists = db.execute(
                "SELECT 1 FROM group_configs WHERE name=?", (name,)
            ).fetchone()
            if not exists:
                return None
            members = [row["id"] for row in db.execute(
                "SELECT id FROM devices WHERE group_name=? ORDER BY id", (name,)
            )]
            db.execute("UPDATE devices SET group_name='' WHERE group_name=?", (name,))
            db.execute("DELETE FROM group_configs WHERE name=?", (name,))
            self._check_routes(db)
            return {"deleted": True, "moved_count": len(members), "device_ids": members}

    def create(self, values):
        device_id = uuid.uuid4().hex
        with self.connection() as db:
            if values["group_name"]:
                db.execute("INSERT OR IGNORE INTO group_configs(name,ip_prefix) VALUES (?,NULL)",
                           (values["group_name"],))
            db.execute(
                """INSERT INTO devices
                   (id,name,group_name,ip,port,auto_reconnect)
                   VALUES (?,?,?,?,?,?)""",
                (device_id, values["name"], values["group_name"], values["ip"],
                 values["port"], int(values["auto_reconnect"]))
            )
            self._check_routes(db)
        return self.get(device_id)

    def update(self, device_id, values):
        with self.connection() as db:
            if values["group_name"]:
                db.execute("INSERT OR IGNORE INTO group_configs(name,ip_prefix) VALUES (?,NULL)",
                           (values["group_name"],))
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
            self._check_routes(db)
        return self.get(device_id)

    def set_metadata(self, device_id, model, android_version):
        with self.connection() as db:
            db.execute("UPDATE devices SET model=?, android_version=? WHERE id=?",
                       (model, android_version, device_id))

    def delete(self, device_id):
        with self.connection() as db:
            return db.execute("DELETE FROM devices WHERE id=?", (device_id,)).rowcount > 0
