"""SQLite device records and group-scoped, derived LAN address mapping."""
import sqlite3
import uuid
import ipaddress
import json
from datetime import datetime, timezone

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
                    selected_route TEXT NOT NULL DEFAULT 'mesh',
                    temp_ip TEXT,
                    temp_port INTEGER,
                    model TEXT,
                    android_version TEXT,
                    UNIQUE (ip, port)
                )
            """)
            # Non-destructive migration of existing M1 databases. The old
            # auto_reconnect column is intentionally left dormant: it is never
            # read and no timer or auto-connect is started.
            if "selected_route" not in {
                row["name"] for row in db.execute("PRAGMA table_info(devices)")
            }:
                db.execute("ALTER TABLE devices ADD COLUMN selected_route TEXT NOT NULL DEFAULT 'mesh'")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(devices)")}
            if "temp_ip" not in columns:
                db.execute("ALTER TABLE devices ADD COLUMN temp_ip TEXT")
            if "temp_port" not in columns:
                db.execute("ALTER TABLE devices ADD COLUMN temp_port INTEGER")
            db.execute("""CREATE TABLE IF NOT EXISTS device_unlock (
                device_id TEXT PRIMARY KEY, credential TEXT NOT NULL
            )""")
            db.execute("""
                CREATE TABLE IF NOT EXISTS group_configs (
                    name TEXT PRIMARY KEY,
                    ip_prefix TEXT
                )
            """)
            db.execute("""CREATE TABLE IF NOT EXISTS group_openwrt (
                group_name TEXT PRIMARY KEY, url TEXT NOT NULL, username TEXT NOT NULL,
                credential TEXT NOT NULL, credential_format TEXT NOT NULL DEFAULT 'plain'
            )""")
            # Previously encrypted rows are explicitly tagged on migration,
            # never accidentally used as plaintext. Do not touch the old key file.
            if "credential_format" not in {
                row["name"] for row in db.execute("PRAGMA table_info(group_openwrt)")
            }:
                db.execute("""ALTER TABLE group_openwrt ADD COLUMN credential_format
                              TEXT NOT NULL DEFAULT 'legacy-fernet'""")
            db.execute("""CREATE TABLE IF NOT EXISTS group_discovery_results (
                group_name TEXT PRIMARY KEY, scan_json TEXT NOT NULL, updated_at TEXT NOT NULL
            )""")
            # Import group names from existing M1 records without changing any device ID.
            db.execute("""INSERT OR IGNORE INTO group_configs(name, ip_prefix)
                          SELECT DISTINCT group_name, NULL FROM devices WHERE group_name <> ''""")

    @staticmethod
    def as_dict(row):
        if row is None:
            return None
        result = dict(row)
        # Legacy auto_reconnect records remain on disk solely for backwards
        # compatibility and have no behavioral or API effect.
        result.pop("auto_reconnect", None)
        # Legacy per-route temp_port stays in SQLite for compatibility, but
        # must not appear in API data or override the shared device port.
        result.pop("temp_port", None)
        if "ip" in result:
            result["lan_ip"] = internal_ip(result.pop("ip_prefix", None), result["ip"])
            result["mesh_ip"] = result["ip"]
            if result["selected_route"] == "lan" and not result["lan_ip"]:
                result["selected_route"] = "mesh"
            if result["selected_route"] == "temp" and not result["temp_ip"]:
                result["selected_route"] = "mesh"
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
            serials = {(row["ip"], row["port"])}
            if lan:
                serials.add((lan, row["port"]))
            if row["temp_ip"] is not None:
                serials.add((row["temp_ip"], row["port"]))
            for serial in serials:
                other = owners.get(serial)
                if other and other != row["id"]:
                    raise ValueError("ADB 连接地址与其他设备的组网、内网或临时 IP:端口冲突")
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

    @staticmethod
    def _public_group(row):
        if row is None:
            return None
        result = dict(row)
        result["discovery_configured"] = bool(result.pop("openwrt_url", None))
        result["discovery_needs_password"] = (result.pop("openwrt_credential_format", None) == "legacy-fernet")
        result["discovery_url"] = row["openwrt_url"] if result["discovery_configured"] else None
        result["discovery_username"] = row["openwrt_username"] if result["discovery_configured"] else None
        result.pop("openwrt_username", None)
        # Credential and encrypted bytes are NEVER part of an API response.
        return result

    def list_groups(self):
        with self.connection() as db:
            return [self._public_group(row) for row in db.execute(
                """SELECT g.name,g.ip_prefix,w.url AS openwrt_url,
                          w.credential_format AS openwrt_credential_format,
                          w.username AS openwrt_username
                   FROM group_configs g LEFT JOIN group_openwrt w ON w.group_name=g.name
                   ORDER BY g.name COLLATE NOCASE"""
            )]

    def get_group(self, name):
        with self.connection() as db:
            row = db.execute(
                """SELECT g.name,g.ip_prefix,w.url AS openwrt_url,
                          w.credential_format AS openwrt_credential_format,
                          w.username AS openwrt_username
                   FROM group_configs g LEFT JOIN group_openwrt w ON w.group_name=g.name
                   WHERE g.name=?""", (name,)
            ).fetchone()
            return self._public_group(row)

    def set_group_discovery(self, group_name, url, username, password):
        from .openwrt_discovery import validate_url
        url = validate_url(url)
        username = username.strip()
        if not username or len(username) > 64 or any(ch.isspace() for ch in username):
            raise ValueError("专用账号不能为空、不能包含空白字符且不超过 64 字符")
        with self.connection() as db:
            if not db.execute("SELECT 1 FROM group_configs WHERE name=?", (group_name,)).fetchone():
                return None
            old = db.execute("SELECT url,username,credential,credential_format FROM group_openwrt WHERE group_name=?",
                             (group_name,)).fetchone()
            if password:
                # OpenWrt has already generated a dedicated RPCD credential.
                # Store it directly; no second encryption key or extra file.
                credential = password
            elif (old and old["url"] == url and old["username"] == username
                  and old["credential_format"] == "plain"):
                credential = old["credential"]
            elif old and old["credential_format"] != "plain":
                raise ValueError("旧版凭据存储格式已停用，请重新粘贴 OpenWrt 专用密钥并保存")
            else:
                raise ValueError("首次配置或修改接口地址/用户名时，请填写 OpenWrt 专用密钥")
            db.execute("""INSERT INTO group_openwrt(group_name,url,username,credential,credential_format)
                          VALUES(?,?,?,?,'plain')
                          ON CONFLICT(group_name) DO UPDATE SET url=excluded.url,
                            username=excluded.username,credential=excluded.credential,
                            credential_format='plain'""",
                       (group_name, url, username, credential))
        return self.get_group(group_name)

    def remove_group_discovery(self, group_name):
        with self.connection() as db:
            if not db.execute("SELECT 1 FROM group_configs WHERE name=?", (group_name,)).fetchone():
                return None
            db.execute("DELETE FROM group_openwrt WHERE group_name=?", (group_name,))
        return self.get_group(group_name)

    def get_group_discovery_secret(self, group_name):
        with self.connection() as db:
            row = db.execute("SELECT url,username,credential,credential_format FROM group_openwrt WHERE group_name=?",
                             (group_name,)).fetchone()
        if not row:
            return None
        if row["credential_format"] != "plain":
            raise ValueError("该分组使用旧版凭据格式，请在分组设置重新粘贴专用密钥并保存")
        return row["url"], row["username"], row["credential"]

    def last_group_discovery(self, name):
        with self.connection() as db:
            row = db.execute("SELECT scan_json FROM group_discovery_results WHERE group_name=?",
                             (name,)).fetchone()
            return json.loads(row["scan_json"]) if row else None

    def apply_group_discovery(self, name, scan, blocked_ids=()):
        """Atomically update only per-device shared ports on exact group LAN IP matches.

        ADB and display sessions are never stopped. Ambiguous source/target
        matches and route collisions are skipped, never assigned arbitrarily.
        """
        blocked = set(blocked_ids)
        with self.connection() as db:
            group = db.execute("SELECT ip_prefix FROM group_configs WHERE name=?", (name,)).fetchone()
            if not group:
                raise ValueError("分组已不存在")
            prefix = group["ip_prefix"]
            if not prefix:
                raise ValueError("该分组未配置内网 IP 前缀，无法精确匹配扫描结果")
            rows = db.execute("SELECT id,name,ip,port FROM devices WHERE group_name=? ORDER BY id",
                              (name,)).fetchall()
            owners = {}
            for row in rows:
                lan = internal_ip(prefix, row["ip"])
                owners.setdefault(lan, []).append(row)
            source = {}
            ignored = 0
            for entry in scan["devices"]:
                if not isinstance(entry, dict):
                    ignored += 1
                    continue
                try:
                    ip = str(ipaddress.IPv4Address(entry.get("address", "")))
                    port = entry.get("port")
                    if type(port) is not int or not 1 <= port <= 65535:
                        raise ValueError()
                except (ValueError, ipaddress.AddressValueError):
                    ignored += 1
                    continue
                source.setdefault(ip, set()).add(port)
            result = {"group": name, "found": len(source), "updated": [], "unchanged": [],
                      "unmatched": [], "ambiguous": [], "conflicting": [], "busy": [],
                      "route_conflict": [], "invalid": ignored, "endpoints": []}
            for ip, ports in source.items():
                members = owners.get(ip, [])
                status = "unmatched"
                if not members:
                    result["unmatched"].append(ip)
                elif len(members) > 1:
                    status = "ambiguous"
                    result["ambiguous"].append(ip)
                elif len(ports) != 1:
                    status = "conflicting"
                    result["conflicting"].append(ip)
                else:
                    row = members[0]
                    port = next(iter(ports))
                    if row["id"] in blocked:
                        status = "busy"
                        result["busy"].append({"id": row["id"], "ip": ip})
                    elif row["port"] == port:
                        status = "unchanged"
                        result["unchanged"].append({"id": row["id"], "ip": ip, "port": port})
                    else:
                        db.execute("SAVEPOINT update_port")
                        db.execute("UPDATE devices SET port=? WHERE id=?", (port, row["id"]))
                        try:
                            self._check_routes(db)
                        except ValueError:
                            db.execute("ROLLBACK TO update_port")
                            status = "route_conflict"
                            result["route_conflict"].append(ip)
                        else:
                            status = "updated"
                            result["updated"].append({"id": row["id"], "ip": ip,
                                                      "old_port": row["port"], "port": port})
                        finally:
                            db.execute("RELEASE update_port")
                # Preserve each valid discovered IP:port, including unmatched
                # and conflicting endpoints. This snapshot is read-only in UI.
                for port in sorted(ports):
                    result["endpoints"].append({
                        "ip": ip, "port": port, "status": status,
                        "device_name": members[0]["name"] if len(members) == 1 else None
                    })
            result["scanned_at"] = scan.get("scanned_at")
            result["saved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            db.execute("""INSERT INTO group_discovery_results(group_name,scan_json,updated_at)
                          VALUES(?,?,?)
                          ON CONFLICT(group_name) DO UPDATE SET
                          scan_json=excluded.scan_json,updated_at=excluded.updated_at""",
                       (name, json.dumps(result, ensure_ascii=False), result["saved_at"]))
            return result

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
                db.execute("UPDATE group_openwrt SET group_name=? WHERE group_name=?", (name, old_name))
                db.execute("UPDATE group_discovery_results SET group_name=? WHERE group_name=?", (name, old_name))
                db.execute("DELETE FROM group_configs WHERE name=?", (old_name,))
            else:
                db.execute("UPDATE group_configs SET ip_prefix=? WHERE name=?", (prefix, name))
            # A removed LAN mapping must never remain selected; changing a
            # valid prefix keeps LAN selected and derives the NEW address.
            db.execute("""UPDATE devices SET selected_route='mesh'
                          WHERE group_name=? AND selected_route='lan' AND ? IS NULL""",
                       (name, prefix))
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
            db.execute("""UPDATE devices SET group_name='',
                          selected_route=CASE WHEN selected_route='lan' THEN 'mesh' ELSE selected_route END
                          WHERE group_name=?""", (name,))
            db.execute("DELETE FROM group_openwrt WHERE group_name=?", (name,))
            db.execute("DELETE FROM group_discovery_results WHERE group_name=?", (name,))
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
                   (id,name,group_name,ip,port,selected_route)
                   VALUES (?,?,?,?,?,'mesh')""",
                (device_id, values["name"], values["group_name"], values["ip"],
                 values["port"])
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
                   SET name=?,group_name=?,ip=?,port=?,
                       selected_route=CASE WHEN ?=0 AND selected_route='lan' THEN 'mesh' ELSE selected_route END,
                       model=CASE WHEN ip<>? OR port<>? THEN NULL ELSE model END,
                       android_version=CASE WHEN ip<>? OR port<>? THEN NULL ELSE android_version END
                   WHERE id=?""",
                (values["name"], values["group_name"], values["ip"],
                 values["port"], int(bool(values["group_name"] and self._prefix_in_db(db, values["group_name"]))),
                 values["ip"], values["port"], values["ip"], values["port"], device_id)
            )
            if cursor.rowcount == 0:
                return None
            self._check_routes(db)
        return self.get(device_id)

    @staticmethod
    def _prefix_in_db(db, group_name):
        row = db.execute("SELECT ip_prefix FROM group_configs WHERE name=?", (group_name,)).fetchone()
        return row["ip_prefix"] if row else None

    def select_route(self, device_id, route):
        """Persist the selected address, never issue an ADB operation."""
        if route not in ("mesh", "lan", "temp"):
            raise ValueError("请选择组网 IP、内网 IP 或临时 IP")
        with self.connection() as db:
            row = db.execute(self._query() + " WHERE d.id=?", (device_id,)).fetchone()
            if not row:
                return None
            if route == "lan" and not internal_ip(row["ip_prefix"], row["ip"]):
                raise ValueError("该设备所属分组没有配置有效的内网 IP")
            if route == "temp" and not row["temp_ip"]:
                raise ValueError("该设备还没有保存临时 IP")
            db.execute("UPDATE devices SET selected_route=? WHERE id=?", (route, device_id))
        return self.get(device_id)

    def set_temp_address(self, device_id, ip, port):
        """Persist the optional temp IP and the ONE shared ADB port.

        Removing the temporary IP never resets the shared port. The obsolete
        temp_port SQL column is cleared on write and ignored during reads.
        No ADB side effects.
        """
        with self.connection() as db:
            row = db.execute("SELECT id,port FROM devices WHERE id=?", (device_id,)).fetchone()
            if not row:
                return None
            common_port = row["port"] if ip is None or port is None else port
            db.execute("""UPDATE devices SET temp_ip=?,temp_port=NULL,port=?,
                          model=CASE WHEN port<>? THEN NULL ELSE model END,
                          android_version=CASE WHEN port<>? THEN NULL ELSE android_version END,
                          selected_route=CASE WHEN ? IS NULL AND selected_route='temp'
                                              THEN 'mesh' ELSE selected_route END
                          WHERE id=?""", (ip, common_port, common_port, common_port, ip, device_id))
            self._check_routes(db)
        return self.get(device_id)

    def set_metadata(self, device_id, model, android_version):
        with self.connection() as db:
            db.execute("UPDATE devices SET model=?, android_version=? WHERE id=?",
                       (model, android_version, device_id))

    def unlock_configured(self, device_id):
        with self.connection() as db:
            return db.execute("SELECT 1 FROM device_unlock WHERE device_id=?", (device_id,)).fetchone() is not None

    def get_unlock_secret(self, device_id):
        from .m2_unlock import decrypt_password
        with self.connection() as db:
            row = db.execute("SELECT credential FROM device_unlock WHERE device_id=?", (device_id,)).fetchone()
        return decrypt_password(self.path, row["credential"]) if row else None

    def save_unlock_secret(self, device_id, password):
        from .m2_unlock import encrypt_password
        ciphertext = encrypt_password(self.path, password)
        with self.connection() as db:
            if not db.execute("SELECT 1 FROM devices WHERE id=?", (device_id,)).fetchone():
                return False
            db.execute("""INSERT INTO device_unlock(device_id,credential) VALUES(?,?)
                          ON CONFLICT(device_id) DO UPDATE SET credential=excluded.credential""",
                       (device_id, ciphertext))
        return True

    def clear_unlock_secret(self, device_id):
        with self.connection() as db:
            return db.execute("DELETE FROM device_unlock WHERE device_id=?", (device_id,)).rowcount > 0

    def delete(self, device_id):
        with self.connection() as db:
            db.execute("DELETE FROM device_unlock WHERE device_id=?", (device_id,))
            return db.execute("DELETE FROM devices WHERE id=?", (device_id,)).rowcount > 0
