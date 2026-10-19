"""Encrypt per-group RPCD credentials at rest. Never expose Fernet key via API."""
import os
import stat
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken


def _key(db_path):
    provided = os.getenv("EASYADB_DISCOVERY_KEY", "").strip()
    if provided:
        # Deployment can manage the key out of band. Never log it.
        return provided.encode("ascii")
    path = Path(str(db_path) + ".discovery-key")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "wb") as output:
            output.write(Fernet.generate_key())
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077:
        raise ValueError("专用凭据密钥文件权限不安全，必须是普通文件且仅所有者可访问")
    return path.read_bytes().strip()


def encrypt(db_path, password):
    return Fernet(_key(db_path)).encrypt(password.encode("utf-8")).decode("ascii")


def decrypt(db_path, token):
    try:
        return Fernet(_key(db_path)).decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, UnicodeError) as exc:
        raise ValueError("OpenWrt 专用凭据无法解密，请检查 NAS 密钥文件或重新配置分组") from None
