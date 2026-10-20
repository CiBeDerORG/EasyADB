"""HTTP input validation; preserve M3 errors and normalization."""
import ipaddress
import re
from fastapi import HTTPException


def clean_group(payload):
    name = payload.name.strip()
    if not 1 <= len(name) <= 64 or name == "未分组":
        raise HTTPException(400, "分组名称须为 1–64 字符，且不能使用保留名称「未分组」")
    prefix = (payload.ip_prefix or "").strip() or None
    if prefix:
        match = re.fullmatch(r"([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\.\*", prefix)
        if not match:
            raise HTTPException(400, "IP 前缀格式应为 192.168.10.*")
        try:
            canonical = ipaddress.IPv4Address(match.group(1) + ".1")
        except ipaddress.AddressValueError:
            raise HTTPException(400, "IP 前缀包含无效的 IPv4 网段") from None
        prefix = str(canonical).rsplit(".", 1)[0] + ".*"
    return name, prefix


def address(ip, port):
    try:
        parsed = ipaddress.IPv4Address(ip.strip())
    except ipaddress.AddressValueError:
        raise HTTPException(400, "目前仅支持有效的 IPv4 地址") from None
    if not 1 <= port <= 65535:
        raise HTTPException(400, "端口必须在 1 到 65535 之间")
    return f"{parsed}:{port}"


def clean_input(payload):
    serial = address(payload.ip, payload.port)
    name = payload.name.strip()
    group = payload.group_name.strip()
    if not 1 <= len(name) <= 64:
        raise HTTPException(400, "设备名称长度必须为 1–64 字符")
    if len(group) > 64:
        raise HTTPException(400, "分组名称不能超过 64 字符")
    return {
        "name": name, "group_name": group,
        "ip": serial.rsplit(":", 1)[0], "port": payload.port,
    }


