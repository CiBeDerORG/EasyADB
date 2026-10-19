"""Explicit, authenticated RPCD discovery: no timers, push, or ADB side effects."""
import ipaddress
import json
import socket
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler

SCANNER = "/usr/libexec/luci-avahi-scan"
MAX_RESPONSE = 262144


class DiscoveryError(ValueError):
    pass


class RpcdSessionExpired(DiscoveryError):
    """Only a confirmed HTTP ubus session-expired response permits re-login."""


def validate_url(value):
    """Constrain the outbound request to one private IPv4 router /ubus endpoint."""
    if not isinstance(value, str) or len(value) > 256:
        raise DiscoveryError("请填写有效的 OpenWrt RPCD 接口地址")
    parsed = urlsplit(value.strip())
    if (parsed.scheme not in ("http", "https") or parsed.username is not None
            or parsed.password is not None or parsed.path != "/ubus"
            or parsed.query or parsed.fragment or not parsed.hostname):
        raise DiscoveryError("接口必须是内网 http(s)://IPv4[:端口]/ubus，不能包含账号、查询或跳转")
    try:
        ip = ipaddress.IPv4Address(parsed.hostname)
        allowed = (ipaddress.IPv4Network("10.0.0.0/8"),
                   ipaddress.IPv4Network("172.16.0.0/12"),
                   ipaddress.IPv4Network("192.168.0.0/16"))
        if not any(ip in network for network in allowed):
            raise ValueError()
        port = parsed.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError()
    except (ValueError, ipaddress.AddressValueError):
        raise DiscoveryError("仅允许内网私有 IPv4 路由器地址；不允许公共地址、回环或域名") from None
    return f"{parsed.scheme}://{ip}{':' + str(port) if port else ''}/ubus"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise DiscoveryError("RPCD 返回了重定向，已拒绝跟随")


class RpcdDiscovery:
    def __init__(self, transport=None):
        self.transport = transport
        self.lock = threading.RLock()
        self.sessions = {}

    def _call(self, url, session, method, params):
        payload = {"jsonrpc": "2.0", "id": 1, "method": "call",
                   "params": [session, "session" if method == "login" else "file",
                              method if method == "login" else "exec", params]}
        if self.transport:
            data = self.transport(url, payload)
        else:
            request = Request(url, json.dumps(payload).encode(), {
                "Content-Type": "application/json", "Accept": "application/json"
            }, method="POST")
            try:
                with build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=12) as response:
                    data = response.read(MAX_RESPONSE + 1)
            except HTTPError as exc:
                raise DiscoveryError(f"路由器 RPCD 返回 HTTP {exc.code}") from None
            except (URLError, socket.timeout, TimeoutError, OSError) as exc:
                raise DiscoveryError("无法访问 OpenWrt RPCD，请检查 EasyTier、接口地址与网络") from None
            if len(data) > MAX_RESPONSE:
                raise DiscoveryError("RPCD 响应超过允许长度")
            try:
                data = json.loads(data)
            except (UnicodeError, ValueError):
                raise DiscoveryError("RPCD 返回的不是有效 JSON") from None
        # /ubus normally returns one JSON-RPC object. Accept a one-item
        # batch response as a compatibility fallback, but never log or return
        # the raw response: session.login may carry a live session token.
        if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
            data = data[0]
        if not isinstance(data, dict):
            raise DiscoveryError("OpenWrt /ubus 返回结构无效（非 JSON-RPC 对象）")
        error = data.get("error")
        if error is not None:
            code = error.get("code") if isinstance(error, dict) else None
            stage = "session.login" if method == "login" else "file.exec"
            if code == -32001 and method != "login":
                raise RpcdSessionExpired("OpenWrt file.exec：RPCD 会话已过期（-32001）")
            # uhttpd performs ubus.file.exec access checks BEFORE rpcd-mod-file
            # evaluates the command and args. Never expose raw RPCD responses.
            known = {
                -32700: "JSON 解析失败", -32600: "请求格式错误",
                -32601: "调用方法不存在", -32602: "请求参数无效",
                -32603: "RPCD 内部错误", -32000: "ubus 对象不存在",
                -32001: "RPCD 会话不存在", -32002: "访问被拒绝",
                -32003: "ubus 请求超时",
            }
            if type(code) is int and code in known:
                hint = ("；请检查 OpenWrt 专用 ACL 同时包含 read.ubus.file.exec 和扫描脚本 file.exec"
                        if code == -32002 and method != "login" else
                        "；请检查 RPCD 登录接口及路由器状态" if code == -32002 else "")
                raise DiscoveryError(f"OpenWrt {stage}：{known[code]}（{code}）{hint}")
            raise DiscoveryError(f"OpenWrt {stage} 返回未识别的 JSON-RPC 错误（错误码：{code if type(code) is int else '未知'}）")
        result = data.get("result")
        if not isinstance(result, list) or not result or type(result[0]) is not int:
            raise DiscoveryError("RPCD 返回结构不正确")
        if result[0] != 0:
            return result[0], result[1] if len(result) > 1 and isinstance(result[1], dict) else {}
        if len(result) < 2 or not isinstance(result[1], dict):
            raise DiscoveryError("RPCD 返回结构不正确")
        return result

    def scan(self, url, username, password):
        # Explicit request only. Serialize per client, never perform periodic scans.
        url = validate_url(url)
        if not username or not password:
            raise DiscoveryError("请先在分组配置专用账号及密钥")
        cache_key = (url, username, password)
        with self.lock:
            session = self.sessions.get(cache_key)
            for attempt in range(2):
                if not session:
                    code, result = self._call(url, "00000000000000000000000000000000",
                                              "login", {"username": username, "password": password})
                    session = result.get("ubus_rpc_session")
                    if code != 0 or not isinstance(session, str) or len(session) != 32:
                        raise DiscoveryError("RPCD 登录失败，请检查专用账号和密钥")
                    self.sessions[cache_key] = session
                try:
                    code, result = self._call(url, session, "scan",
                                              {"command": SCANNER, "params": ["scan"]})
                except RpcdSessionExpired:
                    # Only uhttpd's explicit -32001 means the cached session
                    # disappeared. Retry login at most once, never on ACL denial.
                    self.sessions.pop(cache_key, None)
                    session = None
                    if attempt == 0:
                        continue
                    raise DiscoveryError("OpenWrt file.exec：重新登录后会话仍无效（-32001）") from None
                if code == 6:
                    raise DiscoveryError(
                        "OpenWrt file.exec 权限被拒绝（ubus 状态码 6）："
                        "请检查专用角色的 ubus.file.exec 和固定扫描命令 file.exec ACL"
                    )
                if code != 0:
                    raise DiscoveryError(f"OpenWrt file.exec 调用失败（ubus 状态码 {code}）")
                if result.get("code") != 0:
                    detail = str(result.get("stderr") or "").strip()[:300]
                    raise DiscoveryError("OpenWrt 扫描失败：" + (detail or f"执行码 {result.get('code')}"))
                try:
                    scan_data = json.loads(result.get("stdout", ""))
                except (ValueError, TypeError):
                    raise DiscoveryError("扫描命令没有返回有效的 JSON") from None
                if not isinstance(scan_data, dict) or scan_data.get("status") != "ok" or not isinstance(scan_data.get("devices"), list):
                    raise DiscoveryError("扫描结果格式不正确")
                if len(scan_data["devices"]) > 32:
                    raise DiscoveryError("扫描端点数超过上限")
                return scan_data
        raise DiscoveryError("扫描失败")
