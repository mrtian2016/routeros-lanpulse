#!/usr/bin/env python3
"""lanpulse-agent: 从 Prometheus 聚合出实时流向图所需的 state.json (仅标准库)。
GET /api/state.json  -> 全量状态
GET /            -> 前端页面 (index.html)
env: PROM(http://prometheus:9090), LISTEN_PORT(9132), INTERVAL(2)
"""
import base64, hmac, ipaddress, json, os, re, secrets, shutil, socket, threading, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


# 事件类型清单。key 是 ev(kind=...) 的取值, 顺序决定设置页里的排列顺序。
# 默认值按"是否需要你动手"来定: 需要处理的默认开, 信息性的默认关。
EVENT_KINDS = [
    ("hw",      True,  "硬件: 温度越线 / 风扇停转 / 磁盘写满 / RAID 异常"),
    ("branch",  True,  "分支隧道中断与恢复"),
    ("wan",     True,  "WAN 拨号上下线"),
    ("vm",      True,  "虚拟机启停"),
    ("ovpn",    True,  "OpenVPN 拨入用户上下线"),
    ("wg",      False, "WireGuard peer 上下线 (手机常切网, 比较碎)"),
    ("ts",      False, "tailnet 节点上下线"),
    ("lan",     False, "内网设备接入 / 离开"),
    ("wifi",    False, "无线接入 / 离开 / 漫游"),
    ("ingress", False, "入口连接数变化"),
    ("burst",   False, "流量突发 (家用场景通常是'有意思'而不是'要处理')"),
]


def _load_cfg():
    """配置来自 config.toml —— 用标准库 tomllib 读, 不引第三方依赖。

    设计: 配置只描述"身份"(地址/名字/开关), 不描述逻辑; 密码一律走环境变量,
    不进配置文件, 这样配置可以直接贴到 issue 里问问题。
    找不到配置文件也能起来(什么都监控不到), 便于 `docker run` 先看页面长什么样。"""
    import tomllib
    path = os.environ.get("CONFIG", os.path.join(HERE, "config.toml"))
    raw = {}
    if os.path.exists(path):
        with open(path, "rb") as fh:
            raw = tomllib.load(fh)
    else:
        print(f"[config] 未找到 {path}, 使用默认值 (面板会是空的)", flush=True)
    merge = lambda k, dflt: {**dflt, **(raw.get(k) or {})}
    return {
        "site": merge("site", {"title": "routeros-lanpulse", "note": "", "timezone": "Asia/Shanghai"}),
        "prometheus": merge("prometheus", {"url": "http://prometheus:9090", "rate_window": "1m"}),
        "router": merge("router", {"enabled": True, "label": "RouterOS", "name": "ROS", "host": "",
                                   "port": 8728, "user": "mon", "wan_interface": "", "lan_interface": "",
                                   "wg_interface_regex": "wg.*", "fast_lane": True}),
        "edge": merge("edge", {"enabled": False, "instance": "", "label": "edge"}),
        "pve": merge("pve", {"enabled": False, "instance": "", "memory_total_gb": 32}),
        "nas": merge("nas", {"enabled": False, "title": "NAS", "hint": ""}),
        "unifi": merge("unifi", {"enabled": False}),
        "netflow": merge("netflow", {"enabled": False, "url": "http://netflow:9133"}),
        # 旁路由(mihomo/clash): 从它的控制器 API 读实时分流 —— 走代理的速率与连接数
        "bypass": merge("bypass", {"enabled": False, "api": "", "secret": "", "label": "旁路由"}),
        "redact": merge("redact", {"enabled": False, "keep_subnet": True, "mask_hardware": False}),
        "events": merge("events", {"buffer": 200, "wan_burst_floor_mbps": 8, "device_burst_floor_mbps": 5,
                                   "ingress_burst_floor_mbps": 1, "ovpn_burst_floor_mbps": 3,
                                   "burst_multiplier": 4, "burst_cooldown_sec": 60,
                                   "disk_warn_pct": 85, "burst_level": "warn",
                                   "threshold_level": "warn"}),
        "alerts": merge("alerts", {"enabled": False, "lang": "zh", "levels": ["warn", "bad"],
                                   "kinds": {k: d for k, d, _ in EVENT_KINDS}, "cooldown_sec": 300, "startup_quiet_sec": 60,
                                   "max_per_hour": 20, "min_burst_mbps": 0,
                                   "bark": {"enabled": False, "server": "https://api.day.app",
                                            "group": "routeros-lanpulse", "sound": "", "icon": ""},
                                   "telegram": {"enabled": False, "api_base": "https://api.telegram.org"}}),
        "hosts": raw.get("hosts") or {},
        "hardware": raw.get("hardware") or [],
        "topology": (raw.get("topology") or {}).get("nodes") or {},
    }


def _load_i18n():
    """翻译表和前端共用同一份 (lanpulse/i18n/*.json)。
    后端要用它是因为告警外发也得按配置的语言发文案 —— 两边各存一份迟早对不上。"""
    out = {}
    d = os.path.join(HERE, "i18n")
    if os.path.isdir(d):
        for f in os.listdir(d):
            if f.endswith(".json"):
                try:
                    with open(os.path.join(d, f), encoding="utf-8") as fh:
                        out[f[:-5]] = json.load(fh)
                except Exception as e:
                    print(f"[i18n] {f} 读取失败: {e}", flush=True)
    return out


I18N = _load_i18n()


def t_event(text, lang):
    """把事件文案翻成目标语言。规则和前端 i18n.js 的 translateEvent 一致。"""
    d = I18N.get(lang)
    if not d or lang == "zh":
        return text
    for zh, en in sorted(d.get("events", []), key=lambda x: -len(x[0])):
        text = text.replace(zh, en)
    return re.sub(r"\s{2,}", " ", re.sub(r"\s*条(?=[\s→]|$)", "", text)).strip()


CFG = _load_cfg()
PROM = os.environ.get("PROM", CFG["prometheus"]["url"]).rstrip("/")
PORT = int(os.environ.get("LISTEN_PORT", "9132"))
INTERVAL = float(os.environ.get("INTERVAL", "2"))
RW = "[" + str(CFG["prometheus"]["rate_window"]) + "]"       # 速率窗口
RT = CFG["router"]; ED = CFG["edge"]; PV = CFG["pve"]; EVC = CFG["events"]
EI = f'instance="{ED["instance"]}"'                          # 边缘主机选择器
WANIF = RT["wan_interface"]; LANIF = RT["lan_interface"]; WGRE = RT["wg_interface_regex"]
RBN = RT["name"]                                             # routerboard_name
# 设备命名: 路由器只能从 DHCP 租约拿到名字, 用 cloud-init 固定 IP 的虚拟机没有租约,
# 面板上就只剩一串 MAC。这两张表给它们补名字 (环境变量仍可覆盖, 兼容老部署)。
HOST_MAC = {k.upper(): v for k, v in
            (json.loads(os.environ["VM_MACS"]) if os.environ.get("VM_MACS")
             else (CFG["hosts"].get("by_mac") or {})).items()}
HOST_IP = (json.loads(os.environ["STATIC_HOSTS"]) if os.environ.get("STATIC_HOSTS")
           else (CFG["hosts"].get("by_ip") or {}))
_lock = threading.Lock(); _state = {"ts": 0, "ready": False}
_events = []

# ================= 快车道: 直连 ROS REST, 1 秒粒度 =================
# Prometheus/mktxp 只有 15s 粒度, 面板看起来会"卡住再跳"; 这里自己读计数器算差值。
ROS_HOST = os.environ.get("ROS_HOST", RT["host"])
ROS_USER = os.environ.get("ROS_USER", RT["user"])
ROS_PASS = os.environ.get("ROS_PASS", "")
FAST_INTERVAL = float(os.environ.get("FAST_INTERVAL", "1"))
_fast = {"ready": False}
_prev_ctr = {}
_dev_last = [0.0]
_sec_cache = [0.0, {}]
DEV_INTERVAL = float(os.environ.get("DEV_INTERVAL", "2"))
_names = {"ts": 0, "map": {}}

class RosAPI:
    """RouterOS 二进制 API (8728) 长连接客户端 —— 只用标准库。
    换掉 REST 的原因: REST 每个请求都会在 ROS 日志里写一条 "logged in/out",
    1 秒轮询会几分钟刷爆 1000 行日志缓冲区, 把真实事件挤掉。长连接只登录一次。"""

    def __init__(self, host, user, pw, port=8728):
        self.host, self.port, self.user, self.pw = host, port, user, pw
        self.sock = None

    # --- 协议原语 ---
    @staticmethod
    def _enclen(n):
        if n < 0x80: return bytes([n])
        if n < 0x4000: return (n | 0x8000).to_bytes(2, "big")
        if n < 0x200000: return (n | 0xC00000).to_bytes(3, "big")
        if n < 0x10000000: return (n | 0xE0000000).to_bytes(4, "big")
        return b"\xf0" + n.to_bytes(4, "big")

    def _recv(self, n):
        buf = b""
        while len(buf) < n:
            c = self.sock.recv(n - len(buf))
            if not c: raise ConnectionError("closed")
            buf += c
        return buf

    def _readlen(self):
        b0 = self._recv(1)[0]
        if b0 < 0x80: return b0
        if b0 < 0xC0: return ((b0 & 0x3F) << 8) | self._recv(1)[0]
        if b0 < 0xE0: return ((b0 & 0x1F) << 16) | int.from_bytes(self._recv(2), "big")
        if b0 < 0xF0: return ((b0 & 0x0F) << 24) | int.from_bytes(self._recv(3), "big")
        return int.from_bytes(self._recv(4), "big")

    def _send(self, words):
        out = b"".join(self._enclen(len(w.encode())) + w.encode() for w in words) + b"\x00"
        self.sock.sendall(out)

    def _read_sentence(self):
        words = []
        while True:
            n = self._readlen()
            if n == 0: return words
            words.append(self._recv(n).decode("utf-8", "replace"))

    def connect(self):
        self.close()
        s_ = socket.create_connection((self.host, self.port), timeout=6)
        s_.settimeout(6)
        self.sock = s_
        self._send(["/login", "=name=" + self.user, "=password=" + self.pw])
        while True:
            w = self._read_sentence()
            if not w: raise ConnectionError("empty login reply")
            if w[0] == "!done": return
            if w[0] in ("!trap", "!fatal"): raise ConnectionError("login failed: " + " ".join(w))

    def close(self):
        try:
            if self.sock: self.sock.close()
        except Exception:
            pass
        self.sock = None

    def cmd(self, path, *args):
        """执行 print 类命令, 返回 [dict, ...]"""
        for attempt in (1, 2):
            try:
                if not self.sock: self.connect()
                self._send([path] + list(args))
                rows, cur = [], None
                while True:
                    w = self._read_sentence()
                    if not w: continue
                    tag = w[0]
                    if tag == "!re":
                        cur = {}
                        for x in w[1:]:
                            if x.startswith("="):
                                k, _, v = x[1:].partition("=")
                                cur[k] = v
                        rows.append(cur)
                    elif tag == "!done":
                        return rows
                    elif tag in ("!trap", "!fatal"):
                        raise ConnectionError(" ".join(w))
            except Exception:
                self.close()
                if attempt == 2: raise
        return []

_api = RosAPI(ROS_HOST, ROS_USER, ROS_PASS, int(RT["port"]))

def ros(path, props=None, *extra):
    """/interface -> /interface/print; props 走 .proplist 只取需要的字段"""
    args = list(extra)
    if props: args.append("=.proplist=" + props)
    return _api.cmd(path.rstrip("/") + "/print", *args)

def rate(key, value, now):
    """计数器 -> bit/s (首次返回 0, 计数器回绕返回 0)"""
    prev = _prev_ctr.get(key)
    _prev_ctr[key] = (now, value)
    if not prev: return 0.0
    dt, dv = now - prev[0], value - prev[1]
    if dt <= 0 or dv < 0: return 0.0
    return dv * 8 / dt / 1e6                      # Mbit/s

_log_seen = {"ids": set(), "init": False}
_log_last = 0.0
LOG_INTERVAL = float(os.environ.get("LOG_INTERVAL", "3"))
LOG_KIND = [("pppoe", "wan"), ("ppp", "ovpn"), ("wireguard", "wg"), ("ovpn", "ovpn"),
            ("dhcp", "lan"), ("firewall", "hw"), ("critical", "hw"), ("error", "hw"),
            ("system", "vm"), ("account", "vm"), ("interface", "wan"), ("route", "branch")]
LOG_SKIP = ("logged in", "logged out", "user admin", "user mon", "已登录")

# ROS 日志是英文, 这里翻成中文再进事件流 (面板是给人看的)
_REASONS = {"poll error": "连接中断", "disconnected": "对端断开", "timeout": "超时",
            "peer disconnected": "对端断开", "hung up": "对端挂断", "auth failed": "认证失败",
            "connection closed": "连接关闭", "no route to host": "路由不可达"}
def _reason(r):
    k = r.strip().lower()
    return _REASONS.get(k, r)

_RE_RULES = [
    (r"^<ovpn-(\S+?)>: connected$",                    lambda m: f"OpenVPN 用户 {m[1]} 已连接"),
    (r"^<ovpn-(\S+?)>: disconnected$",                 lambda m: f"OpenVPN 用户 {m[1]} 已断开"),
    (r"^<ovpn-(\S+?)>: terminating\.\.\. - (.+)$",      lambda m: f"OpenVPN 用户 {m[1]} 正在断开 ({_reason(m[2])})"),
    (r"^<(\d+\.\d+\.\d+\.\d+)>: disconnected <(.+)>$", lambda m: f"OpenVPN 客户端 {m[1]} 掉线 ({_reason(m[2])})"),
    (r"^connection established from (\S+), port: (\d+) to (\S+)$",
                                                       lambda m: f"OpenVPN 收到来自 {m[1]} 的连接 (端口 {m[2]})"),
    (r"^(\S+): using encoding - (\S+)$",               lambda m: f"OpenVPN {m[1]} 协商加密 {m[2]}"),
    (r"^(\S+) logged in, (\S+) from (\S+)$",           lambda m: f"OpenVPN 用户 {m[1]} 登录成功, 分配 {m[2]} (来自 {m[3]})"),
    (r"^(\S+) logged out, .*from (\S+)$",              lambda m: f"OpenVPN 用户 {m[1]} 登出 (来自 {m[2]})"),
    (r"^<(\S+)> detect WAN$",                          lambda m: f"接口 {m[1]} 识别为外网"),
    (r"^<(\S+)> detect UNKNOWN$",                      lambda m: f"接口 {m[1]} 建立中"),
    (r"^(\S+): initializing\.\.\.$",                    lambda m: f"{m[1]} 初始化"),
    (r"^(\S+): connecting\.\.\.$",                      lambda m: f"{m[1]} 正在连接"),
    (r"^(\S+): authenticated$",                        lambda m: f"{m[1]} 认证通过"),
    (r"^(\S+): connected$",                            lambda m: f"{m[1]} 已连接"),
    (r"^(\S+): disconnected$",                         lambda m: f"{m[1]} 已断开"),
    (r"^(\S+): terminating\.\.\. - (.+)$",              lambda m: f"{m[1]} 正在断开 ({_reason(m[2])})"),
    (r"^dhcp\S* assigned (\S+) (?:for|to) (\S+)(?: (\S+))?$",
                                                       lambda m: f"DHCP 分配 {m[1]} 给 {m[3] or m[2]}"),
    (r"^dhcp\S* deassigned (\S+) (?:for|from) (\S+)(?: (\S+))?$",
                                                       lambda m: f"DHCP 回收 {m[1]} ({m[3] or m[2]})"),
    (r"^wg-\S+: \[(\S+)\].*[Hh]andshake for peer did not complete",
                                                       lambda m: f"WireGuard {m[1]} 握手超时"),
    (r"^(\S+) link (up|down)",                         lambda m: f"接口 {m[1]} 链路{'恢复' if m[2]=='up' else '断开'}"),
    (r"^user (\S+) logged in from (\S+) via (\S+)$",   lambda m: f"管理员 {m[1]} 从 {m[2]} 登录 ({m[3]})"),
]
_WORDS = [("out of memory", "内存不足"), ("login failure", "登录失败"), ("timeout", "超时"),
          ("poll error", "轮询错误"), ("authentication failed", "认证失败"),
          ("no response", "无响应"), ("bad password", "密码错误")]

def zh(msg):
    """ROS 英文日志 -> 中文"""
    for pat, fn in _RE_RULES:
        m = re.match(pat, msg)
        if m:
            try: return fn(m)
            except Exception: break
    out = msg
    for en, cn in _WORDS:
        out = re.sub(en, cn, out, flags=re.I)
    return out

def poll_ros_log():
    """拉 ROS 日志, 新增条目转成事件 (首轮只记录不刷屏)"""
    global _log_last
    if time.time() - _log_last < LOG_INTERVAL:
        return
    _log_last = time.time()
    try:
        rows = ros("/log", ".id,time,topics,message")
    except Exception:
        return
    ids = {r.get(".id") for r in rows}
    first = not _log_seen["init"]
    if first:
        # 首轮: 用日志历史回填面板 (重启后不至于空白)
        new = rows[-18:]
        _log_seen["init"] = True
    else:
        new = [r for r in rows if r.get(".id") not in _log_seen["ids"]][-12:]
    _log_seen["ids"] = ids
    picked = []
    for r in new:
        msg = (r.get("message") or "").strip()
        topics = (r.get("topics") or "")
        if not msg or any(k in msg for k in LOG_SKIP): continue
        kind = next((k for t_, k in LOG_KIND if t_ in topics), "lan")
        lvl = "bad" if "critical" in topics else ("warn" if ("error" in topics or "warning" in topics) else "info")
        # ROS 日志时间形如 "14:53:01" 或 "aug/22 14:53:01"
        ts = (r.get("time") or "").split()[-1][:8] or None
        picked.append((kind, zh(msg)[:110], lvl, ts))
    if first:
        for kind, msg, lvl, ts in picked:             # 由旧到新插入, 最终最新在最上
            ev(kind, msg, lvl, ts)
    else:
        for kind, msg, lvl, ts in picked:
            ev(kind, msg, lvl, ts)

def fast_loop():
    global _fast
    while True:
        t0 = time.time()
        try:
            now = time.time()
            f = {"ready": True, "ts": int(now)}
            ifs = {i["name"]: i for i in ros("/interface", "name,rx-byte,tx-byte,running")}
            def ifrate(n):
                i = ifs.get(n)
                if not i: return (0.0, 0.0)
                return (rate("rx:" + n, int(i.get("rx-byte", 0)), now),
                        rate("tx:" + n, int(i.get("tx-byte", 0)), now))
            d, u = ifrate(WANIF); f["wan"] = {"down": round(d, 3), "up": round(u, 3)}
            d, u = ifrate(LANIF); f["lan"] = {"down": round(d, 3), "up": round(u, 3)}
            # 注意: ifrate() 有状态 —— rate() 每次调用都会把基线更新成本次采样。
            # 原来写成 {"down": ifrate(n)[0], "up": ifrate(n)[1]} 调了两次, 第二次 dt=0,
            # 于是 **所有 OpenVPN 服务端接口的上行速率恒为 0**。必须一次取回两个值。
            f["ifaces"] = {}
            for n in ifs:
                if n.startswith("<ovpn-"):
                    d_, u_ = ifrate(n)
                    f["ifaces"][n] = {"down": round(d_, 3), "up": round(u_, 3)}
            # OpenVPN 服务端会话 (所有对端共用一个账号, 只能靠 caller-id 区分身份)
            f["ovpn_sessions"] = []
            try:
                # 账号说明取自 ROS 里 /ppp secret 的 comment —— 跟着路由器配置走, 不在监控侧写死任何映射
                if now - _sec_cache[0] > 60:
                    _sec_cache[0] = now
                    _sec_cache[1] = {x.get("name", ""): x.get("comment", "")
                                     for x in ros("/ppp/secret", "name,comment")}
                notes = _sec_cache[1]
                for a in ros("/ppp/active", "name,service,caller-id,address,uptime,encoding"):
                    if a.get("service") != "ovpn": continue
                    u = a.get("name", "")
                    f["ovpn_sessions"].append({
                        "user": u, "caller": a.get("caller-id", ""),
                        "note": notes.get(u, ""), "ip": a.get("address", ""),
                        "uptime": a.get("uptime", ""), "enc": a.get("encoding", ""),
                    })
            except Exception:
                pass
            f["wg"] = {}
            for p_ in ros("/interface/wireguard/peers", "comment,allowed-address,rx,tx,last-handshake"):
                nm = re.sub(r"\s*\(.*", "", p_.get("comment", "")) or p_.get("allowed-address", "?")
                f["wg"][nm] = {
                    "down": round(rate("wgrx:" + nm, int(p_.get("rx", 0)), now), 3),
                    "up": round(rate("wgtx:" + nm, int(p_.get("tx", 0)), now), 3),
                    "hs": p_.get("last-handshake", ""),
                }
            # MAC -> 名字 (DHCP 租约 + VM_MACS), 每 60 秒刷新
            if now - _names["ts"] > 60:
                mp = {}
                try:
                    for l in ros("/ip/dhcp-server/lease", "mac-address,host-name,comment"):
                        mac = (l.get("mac-address") or "").upper()
                        nm2 = l.get("host-name") or l.get("comment") or ""
                        if mac and nm2: mp[mac] = nm2
                except Exception:
                    pass
                mp.update(HOST_MAC)
                _names.update(ts=now, map=mp)
            nmap = _names["map"]
            is_mac2 = lambda x: len(x) == 17 and x.count(":") == 5
            f["dev"] = _fast.get("dev", {}) if (now - _dev_last[0] < DEV_INTERVAL) else {}
            need_dev = not f["dev"]
            if need_dev: _dev_last[0] = now
            try:
                if not need_dev: raise StopIteration
                kds = []
                for kd in ros("/ip/kid-control/device", "name,mac-address,ip-address,bytes-down,bytes-up"):
                    nm = kd.get("name") or kd.get("mac-address", "?")
                    if is_mac2(nm): nm = nmap.get(nm.upper(), nm)
                    ip4 = next((x.strip() for x in (kd.get("ip-address") or "").split(",")
                                if re.match(r"^\d+\.\d+\.\d+\.\d+$", x.strip())), "")
                    kds.append((nm, ip4, kd))
                # 名字常会重复 (同型号的两台手机、两台同名主机)。直接拿名字当 key
                # 会互相覆盖: 既少统计设备, 又把两台的字节数喂进同一个 rate(), 算出的速率是错的。
                # 重名时用末位 IP 区分; 速率的 key 用 MAC (改名也不会重置基线)。
                dupes = {n for n in (x[0] for x in kds) if [y[0] for y in kds].count(n) > 1}
                for nm, ip4, kd in kds:
                    key = f"{nm} ({ip4.rsplit('.', 1)[-1]})" if (nm in dupes and ip4) else nm
                    rid = kd.get("mac-address") or key
                    bd, bu = int(kd.get("bytes-down", 0)), int(kd.get("bytes-up", 0))
                    f["dev"][key] = {
                        "down": round(rate("kdd:" + rid, bd, now), 3),
                        "up": round(rate("kdu:" + rid, bu, now), 3),
                        # 累计字节: kid-control 自路由器启动累加 (实测 24h 内 resets()=0, 不会每日清零)
                        "rxb": bd, "txb": bu,
                        "mac": kd.get("mac-address", ""), "ip": kd.get("ip-address", ""),
                    }
            except StopIteration:
                pass
            except Exception:
                pass
            with _lock: _fast = f
            poll_ros_log()
        except Exception as e:
            with _lock: _fast = {"ready": False, "err": type(e).__name__}
        time.sleep(max(0.2, FAST_INTERVAL - (time.time() - t0)))


def qrange(expr, span=3600, step=30):
    """range query -> [[ts, value], ...]"""
    try:
        now = int(time.time())
        u = PROM + "/api/v1/query_range?" + urllib.parse.urlencode(
            {"query": expr, "start": now - span, "end": now, "step": step})
        with urllib.request.urlopen(u, timeout=15) as r:
            d = json.loads(r.read().decode())
        res = d["data"]["result"]
        return [[int(t), round(float(v) * 8 / 1e6, 3)] for t, v in res[0]["values"]] if res else []
    except Exception:
        return []

# WAN 曲线的时间档位: (总时长秒, 步长秒, rate 窗口)
# 短档必须同时调小 rate 窗口 —— 30 分钟的图配 [5m] 的 rate, 细节全被抹平了,
# 看着和 12 小时档没区别。步长也要跟上, 否则点太少画不出形状。
HIST_RANGES = {
    "30m": (1800, 15, "1m"),      # 15s 一点 = 120 个点; mktxp 15s 抓一次, 这是理论上限
    "1h":  (3600, 30, "1m"),      # 120 个点
    "12h": (43200, 300, "5m"),    # 144 个点
}
DEFAULT_RANGE = "1h"
_hist = {}


def history(rng=DEFAULT_RANGE):
    """WAN 上下行曲线。按档位分别缓存, 缓存时长取步长的一半 —— 短档刷新更勤。"""
    if rng not in HIST_RANGES:
        rng = DEFAULT_RANGE
    span, step, win = HIST_RANGES[rng]
    c = _hist.setdefault(rng, {"ts": 0.0, "data": {}})
    if c["data"] and time.time() - c["ts"] < max(10, step / 2):
        return c["data"]
    d = {"range": rng, "step": step, "span": span, "win": win,
         "down": qrange(f'rate(mktxp_interface_rx_byte_total{{name="{WANIF}"}}[{win}])', span, step),
         "up":   qrange(f'rate(mktxp_interface_tx_byte_total{{name="{WANIF}"}}[{win}])', span, step)}
    c.update(ts=time.time(), data=d)
    return d


_qerr = set()

def q(expr):
    """instant query -> [(labels, value)]

    出错时返回空列表, 但**会把错误打到日志**: 写错的 PromQL (例如 rate() 套多指标名
    导致 "vector cannot contain metrics with the same labelset") 和"真的没数据"
    表现完全一样, 静默吞掉会让面板上某个值长期为 0 而没人发现。"""
    try:
        u = PROM + "/api/v1/query?" + urllib.parse.urlencode({"query": expr})
        with urllib.request.urlopen(u, timeout=8) as r:
            d = json.loads(r.read().decode())
        return [(x["metric"], float(x["value"][1])) for x in d["data"]["result"]]
    except Exception as e:
        key = expr[:120]
        if key not in _qerr:          # 同一条表达式只报一次, 不刷屏
            _qerr.add(key)
            detail = ""
            try:
                detail = e.read().decode()[:160]
            except Exception:
                pass
            print(f"[promql] {type(e).__name__} {detail} <- {key}", flush=True)
        return []

def one(expr, default=0.0):
    r = q(expr)
    return r[0][1] if r else default

def mbps(expr):     # bytes/s -> Mbit/s
    return round(one(expr) * 8 / 1e6, 3)

def ev(kind, text, level="info", t=None, value=None):
    """value 是这条事件的"量" (突发的 Mbps、温度的 °C、占用的 %)。
    面板不用它, 但推送侧要靠它做大小过滤 —— 面板上 8 Mbps 就标突发方便看趋势,
    没必要为一次正常下载响手机。"""
    now = t or time.strftime("%H:%M:%S")
    # 5 秒内同文本去重
    if _events and _events[0]["text"] == text and _events[0]["t"] == now:
        return
    evt = {"t": now, "kind": kind, "text": text, "level": level}
    if value is not None:
        evt["v"] = round(float(value), 2)
    _events.insert(0, evt)
    del _events[EVC["buffer"]:]
    try:
        NOTIFY.maybe(evt)          # 外发是尽力而为, 绝不能因为推送失败影响面板
    except Exception:
        pass

_prev = {}
_ewma = {}
_wgp = {"ts": 0.0, "v": []}   # WireGuard 监听端口缓存
_ovp = {"ts": 0.0, "v": ""}   # OpenVPN 服务端端口缓存
_stab = {}

def stable(key, value, n=2):
    """连续 n 次读到同一状态才认账。
    抓取偶尔丢一次点会让指标短暂消失, 直接判定就会刷出一串假的"中断/恢复"。"""
    st_ = _stab.setdefault(key, {"acc": value, "cand": value, "cnt": n})
    if value == st_["cand"]:
        st_["cnt"] += 1
    else:
        st_["cand"], st_["cnt"] = value, 1
    if st_["cnt"] >= n:
        st_["acc"] = st_["cand"]
    return st_["acc"]

def step_change(key, value, name, kind, step=5, unit="", level="info"):
    """数值变化超过 step 才报一次 (记的是"上次报过的值", 避免缓慢漂移不断刷屏)"""
    was = _prev.get(key)
    if was is None:
        _prev[key] = value; return
    if abs(value - was) >= step:
        ev(kind, f"{name} {was}{unit} → {value}{unit}", level, value=value)
        _prev[key] = value

def edge_change(key, online, name, kind, up="恢复", down="中断", level_down="warn"):
    was = _prev.get(key)
    if was is not None and was != online:
        ev(kind, f"{name} {up if online else down}", "info" if online else level_down)
    _prev[key] = online

def once_change(key, value, fmt_, kind, level="info"):
    """值变化时报一次 (首次不报)"""
    was = _prev.get(key)
    if was is not None and was != value and value not in (None, "", 0):
        ev(kind, fmt_(was, value), level)
    _prev[key] = value

def threshold(key, value, limit, name, unit, kind="hw", hyst=3):
    """越线报警 + 回落恢复 (带迟滞, 避免抖动刷屏)"""
    if value is None: return
    over = _prev.get(key, False)
    if not over and value > limit:
        _prev[key] = True
        ev(kind, f"{name} {value:.0f}{unit} 超过阈值 {limit}{unit}", EVC.get("threshold_level", "warn"), value=value)
    elif over and value < limit - hyst:
        _prev[key] = False
        ev(kind, f"{name} 回落到 {value:.0f}{unit}", "info", value=value)

_burst_last = {}

def burst(key, value, name, kind="burst", floor=3.0, mult=None, cooldown=None, down=None, up=None):
    """流量突发: 高于 floor Mbps 且超过近期均值 mult 倍。

    原来还要求 `avg > 0.05`, 结果把最该报的情况挡掉了 —— 内网终端平时就是 0 Mbps,
    EWMA 贴着 0, 突然拉到几百兆时永远过不了那个门槛; 而 WAN 一直有背景流量、
    EWMA 总大于 0.05, 所以只有 WAN 报得出突发。floor 本身已经保证了值有意义,
    那个条件是多余的。
    改为冷却期防刷屏: 同一对象 cooldown 秒内不重复报, 除非这次比上次大一倍以上
    (一次下载的爬坡过程原本会连报五六条)。"""
    mult = EVC["burst_multiplier"] if mult is None else mult
    cooldown = EVC["burst_cooldown_sec"] if cooldown is None else cooldown
    avg = _ewma.get(key)
    _ewma[key] = value if avg is None else avg * 0.85 + value * 0.15
    if avg is None or value <= floor or value <= avg * mult:
        return
    now_ = time.time()
    last_t, last_v = _burst_last.get(key, (0.0, 0.0))
    if now_ - last_t < cooldown and value < last_v * 2:
        return
    _burst_last[key] = (now_, value)
    # 判定用的是上下行之和, 但报出来必须说清方向 —— 只给一个总数没法判断是谁在拉谁在推。
    # ↓ = 进入家里, ↑ = 离开家里 (WAN / 入口端口 / WireGuard 三处语义一致)
    if down is None or up is None:
        detail = f"流量突发 {value:.1f} Mbps"
    elif up > down * 3:
        detail = f"上行突发 {up:.1f} Mbps"
    elif down > up * 3:
        detail = f"下行突发 {down:.1f} Mbps"
    else:
        detail = f"双向突发 ↓{down:.1f} / ↑{up:.1f} Mbps"
    ev(kind, f"{name} {detail} (均值 {avg:.2f})", EVC.get("burst_level", "warn"), value=value)

def set_change(key, cur, kind, add_fmt, del_fmt, limit=6):
    """集合增删 (新设备接入 / 设备离开)"""
    was = _prev.get(key)
    _prev[key] = set(cur)
    if was is None: return
    for x in list(set(cur) - was)[:limit]: ev(kind, add_fmt(x))
    for x in list(was - set(cur))[:limit]: ev(kind, del_fmt(x))

_bypass_ok = {"ok": True}


def collect():
    st = {"ts": int(time.time()), "ready": True}
    R = "[1m]"
    # ---- WAN ----
    st["wan"] = {
        "down": mbps(f'rate(mktxp_interface_rx_byte_total{{name="{WANIF}"}}{R})'),
        "up":   mbps(f'rate(mktxp_interface_tx_byte_total{{name="{WANIF}"}}{R})'),
        "online": bool(one(f'mktxp_interface_running{{name="{WANIF}"}}')),
        "ip": next((m.get("public_address", "") for m, _ in q(f'mktxp_public_ip_address_info{{routerboard_name="{RBN}"}}') if m.get("public_address")), ""),
    }
    edge_change("wan", st["wan"]["online"], "WAN 拨号", "wan")
    # ---- WireGuard peers ----
    wg = {}
    for metric, key in (("mktxp_peer_rx_total", "down"), ("mktxp_peer_tx_total", "up")):
        for m, v in q(f"rate({metric}{R})"):
            name = re.sub(r"\s*\(.*", "", m.get("comment", "")) or m.get("allowed_address", "?")
            wg.setdefault(name, {"id": name, "ip": m.get("allowed_address", "").split("/")[0], "down": 0, "up": 0, "hs": None})
            wg[name][key] = round(v * 8 / 1e6, 3)
    for m, v in q("mktxp_last_handshake"):
        name = re.sub(r"\s*\(.*", "", m.get("comment", "")) or "?"
        if name in wg: wg[name]["hs"] = int(v)
    for p in wg.values():
        # mktxp_last_handshake = 距上次握手的秒数; 0 = 从未握手
        p["online"] = stable("wgon:" + p["id"], bool(p["hs"]) and 0 < p["hs"] < 300)
        edge_change("wg:" + p["id"], p["online"], "WG " + p["id"], "wg")
    st["wg"] = sorted(wg.values(), key=lambda x: (-x["online"], x["id"]))
    # ---- OpenVPN 服务端用户 (ROS 动态接口 <ovpn-*>) ----
    ov = {}
    for metric, key in (("mktxp_interface_rx_byte_total", "down"), ("mktxp_interface_tx_byte_total", "up")):
        for m, v in q(f'rate({metric}{{name=~"<ovpn-.*"}}{R})'):
            n = m["name"].strip("<>").replace("ovpn-", "")
            ov.setdefault(n, {"id": n, "down": 0, "up": 0, "online": True})
            ov[n][key] = round(v * 8 / 1e6, 3)
    st["ovpn"] = list(ov.values())
    # ---- 分支隧道 (edge tun*) ----
    # 分支隧道: 单元名/设备/网段全部来自 edge 的运行时采集 (edge-tunnels-textfile.sh), 零硬编码
    br, dev2unit = {}, {}
    for m, v in q(f'edge_tunnel_up{{{EI}}}'):
        unit = m.get("unit", "?"); dev = m.get("device", "")
        name = unit.replace("ovpn_", "")
        dev2unit[dev] = name
        br[name] = {"id": name, "dev": dev, "net": m.get("net", ""), "peer": m.get("peer", ""),
                    "online": bool(v), "down": 0, "up": 0, "nets": []}
    for m, _ in q(f'edge_tunnel_route{{{EI}}}'):
        n = br.get(m.get("unit", "").replace("ovpn_", ""))
        if n and m.get("dest") and m["dest"] != n["net"]:
            n["nets"].append(m["dest"])
    for metric, key in (("node_network_receive_bytes_total", "down"), ("node_network_transmit_bytes_total", "up")):
        for m, v in q(f'rate({metric}{{{EI},device=~"tun.*"}}{R})'):
            n = br.get(dev2unit.get(m.get("device", ""), ""))
            if n: n[key] = round(v * 8 / 1e6, 3)
    for n in br.values():
        n["nets"] = sorted(n["nets"])[:6]
        edge_change("br:" + n["id"], n["online"], "分支 " + n["id"], "branch")
    st["branches"] = sorted(br.values(), key=lambda x: (-x["online"], x["id"]))
    # ---- tailnet ----
    st["tailnet"] = {
        "nodes": int(one(f'tailscale_peers_total{{{EI}}}')),
        "online": int(one(f'tailscale_peers_online{{{EI}}}')),
        "peers": sorted([{"id": m.get("peer", "?"), "ip": m.get("ip", ""), "os": m.get("os", ""), "online": bool(v)}
                         for m, v in q(f'tailscale_peer_online{{{EI}}}')],
                        key=lambda x: (-x["online"], x["id"])),
    }
    # ---- 入口流量 ----
    # 数据源 = edge 上的 nft 独立计数表 (edge-ingress-textfile.sh), 端口从 sing-box 配置和
    # 实际监听表动态发现。**不能**用 ROS 的 dst-nat 规则计数器: 那个只在每条连接的首包命中,
    # 后续报文走连接跟踪不再经过规则, 实测只涨 ~5.7 B/s, 面板会恒为 0、突发事件永不触发。
    ing_dir, ing_meta_ = {}, {}
    for m, v in q(f'sum by (svc,type,port,dir) (rate(edge_ingress_bytes_total{{{EI}}}{R})) * 8 / 1e6'):
        svc = m.get("svc", "?")
        ing_meta_[svc] = (m.get("type", "?"), m.get("port", ""))
        ing_dir.setdefault(svc, {"rx": 0.0, "tx": 0.0})[m.get("dir", "rx")] = round(v, 3)
    ing_rows = []
    for svc, (typ, port) in ing_meta_.items():
        rx, tx = ing_dir[svc]["rx"], ing_dir[svc]["tx"]
        # rx = 公网进到 edge (↓), tx = edge 发回公网 (↑)
        ing_rows.append({"svc": svc, "type": typ, "port": port,
                         "rx": rx, "tx": tx, "mbps": round(rx + tx, 3)})
    conns = {m.get("svc"): int(v) for m, v in q(f'edge_ingress_connections{{{EI}}}')}
    for r_ in ing_rows: r_["conns"] = conns.get(r_["svc"], 0)
    ing_rows.sort(key=lambda x: (x["type"], x["port"]))
    # WireGuard 在 ROS 上终结, 取接口字节数 (接口名按 wg* 匹配, 不写死具体名字)
    # 注意: 不能写成 rate({__name__=~"..._(rx|tx)_..."}) —— rate() 会剥掉 __name__,
    # rx 和 tx 剩下的标签完全相同, Prometheus 直接报 "vector cannot contain metrics
    # with the same labelset", q() 吞异常返回空, 结果永远是 0。必须分开求和。
    wg_rx = round(one(f'sum(rate(mktxp_interface_rx_byte_total{{name=~"{WGRE}"}}{R})) * 8 / 1e6'), 3)
    wg_tx = round(one(f'sum(rate(mktxp_interface_tx_byte_total{{name=~"{WGRE}"}}{R})) * 8 / 1e6'), 3)
    wg_mbps = round(wg_rx + wg_tx, 3)
    # WireGuard 监听端口从 ROS 实时读, 不写死 (端口极少变, 缓存 1 小时, 免得 2 秒问一次)
    if time.time() - _wgp["ts"] > 3600:
        try:
            _wgp["v"] = [str(w["listen-port"]) for w in ros("/interface/wireguard", "name,listen-port") if w.get("listen-port")]
            _wgp["ts"] = time.time()
        except Exception:
            pass
    wg_ports = _wgp["v"]
    grp = lambda types: round(sum(r_["mbps"] for r_ in ing_rows if r_["type"] in types), 3)
    st["ingress"] = {"trojan": grp(("trojan", "anytls")), "https": grp(("http",)), "wg": wg_mbps}
    st["ingress_detail"] = ing_rows
    st["ingress_wg_dir"] = {"rx": wg_rx, "tx": wg_tx}
    # OpenVPN 服务端端口: 前端提示里原来写死成 60957, 改成向 ROS 实时读 (端口极少变, 缓存 1 小时)
    if time.time() - _ovp["ts"] > 3600:
        try:
            _ovp["v"] = next((str(x.get("port")) for x in ros("/interface/ovpn-server/server", "port,enabled")
                              if x.get("port")), "")
            _ovp["ts"] = time.time()
        except Exception:
            pass
    st["ovpn_port"] = _ovp["v"]
    st["ros_uptime"] = int(one(f'mktxp_system_uptime{{routerboard_name="{RBN}"}}'))
    st["health"] = health()
    # 前端画的三条入口线, 标签/端口/连接数全部来自运行时采集
    # id 就是画在图上的标签, 必须短 (节点框只有 120px, 长了会溢出压到圆点上);
    # 完整端口清单放 ports, 前端在悬浮提示里展示。
    proxy_rows = sorted([r_ for r_ in ing_rows if r_["type"] in ("trojan", "anytls")], key=lambda x: x["port"])
    http_rows = sorted([r_ for r_ in ing_rows if r_["type"] == "http"], key=lambda x: -x["conns"])
    st["ingress_meta"] = [
        {"k": "trojan", "id": " / ".join(dict.fromkeys(r_["type"] for r_ in proxy_rows)) or "trojan / anytls",
         "conns": sum(r_["conns"] for r_ in proxy_rows),
         "ports": [r_["port"] for r_ in proxy_rows]},
        {"k": "https", "id": "HTTPS" + (" " + http_rows[0]["port"] if http_rows else ""),
         "conns": sum(r_["conns"] for r_ in http_rows),
         "ports": [r_["port"] for r_ in http_rows]},
        {"k": "wg", "id": "WireGuard" + (" " + wg_ports[0] if wg_ports else ""),
         "conns": 0, "ports": wg_ports},
    ]
    # ---- 内网每设备 (kid-control) ----
    lease_by_mac = {}
    for m, _ in q("mktxp_dhcp_lease_info"):
        mac = (m.get("mac_address") or "").upper()
        nm_ = m.get("host_name") or m.get("comment") or ""
        if mac and nm_: lease_by_mac[mac] = nm_
    is_mac = lambda x: len(x) == 17 and x.count(":") == 5
    # PVE 虚拟机网卡走 cloud-init 静态 IP, 没有 DHCP 租约, 用 VM 名兜底 (MAC 在 VM 配置里固定)
    lease_by_mac.update(HOST_MAC)
    dev = {}
    for metric, key in (("mktxp_kid_control_device_bytes_down_total", "down"), ("mktxp_kid_control_device_bytes_up_total", "up")):
        for m, v in q(f"rate({metric}{R})"):
            n = m.get("dhcp_name") or m.get("user") or m.get("mac_address", "?")
            if is_mac(n): n = lease_by_mac.get(n.upper(), n)
            dev.setdefault(n, {"name": n, "ip": m.get("ip_address", ""), "down": 0, "up": 0})
            dev[n][key] = round(v * 8 / 1e6, 3)
    st["lan"] = {"devices": sorted(dev.values(), key=lambda d: -(d["down"] + d["up"]))[:12],
                 "clients": int(one("mktxp_dhcp_lease_active_count"))}
    # ---- 无线 ----
    wifi = {}
    for expr, key in ((f"unifi_client_signal_dbm", "rssi"), ("unifi_client_tx_rate_kbps", "tx"),
                      ("unifi_client_rx_rate_kbps", "rx"), ("unifi_client_satisfaction_percent", "sat"),
                      (f"rate(unifi_client_rx_bytes_total{R})", "down"), (f"rate(unifi_client_tx_bytes_total{R})", "up")):
        for m, v in q(expr):
            n = m.get("client", "?")
            wifi.setdefault(n, {"name": n, "band": m.get("band", ""), "ssid": m.get("ssid", ""), "ap": m.get("ap", "")})
            wifi[n][key] = round(v * 8 / 1e6, 3) if key in ("down", "up") else round(v, 1)
    st["wifi_all"] = sorted(wifi.values(), key=lambda w: w.get("rssi", -99), reverse=True)
    st["wifi"] = st["wifi_all"][:14]
    st["ap"] = [{"name": m.get("device", ""), "model": m.get("model", ""), "ip": m.get("ip", ""), "fw": m.get("version", "")}
                for m, _ in q("unifi_device_info")]
    st["radios"] = [{"band": m.get("band"), "ch": m.get("channel"), "util": v,
                     "clients": one(f'unifi_radio_clients{{band="{m.get("band")}"}}')}
                    for m, v in q("unifi_radio_channel_utilization_percent")]
    # ---- PVE / VM ----
    vms = {}
    for m, v in q('pve_up{id=~"qemu.*"}'):
        vms[m["id"]] = {"id": m["id"].split("/")[1], "on": bool(v)}
    for m, _ in q('pve_guest_info{id=~"qemu.*"}'):
        if m["id"] in vms:
            vms[m["id"]]["name"] = m.get("name") or m.get("guest_name") or ""
            vms[m["id"]]["node"] = m.get("node", "")
    for expr, key in (("pve_cpu_usage_ratio", "cpu"), ("pve_memory_usage_bytes", "mem"), ("pve_memory_size_bytes", "memmax")):
        for m, v in q(f'{expr}{{id=~"qemu.*"}}'):
            if m["id"] in vms: vms[m["id"]][key] = v
    for v in vms.values():
        v["cpu"] = round(v.get("cpu", 0) * 100, 1)
        v["mem"] = round(v.get("mem", 0) / 1073741824, 2)
        v["memmax"] = round(v.get("memmax", 0) / 1073741824, 1)
        v["name"] = v.get("name") or v["id"]          # 名字来自 pve_guest_info, 不写死
    st["vms"] = sorted(vms.values(), key=lambda x: x["id"])
    # ---- 硬件 (IPMI + 宿主机) ----
    def hwinfo(inst):
        cpu = next(({"model": m.get("model", ""), "cores": m.get("cores", ""), "threads": m.get("threads", "")}
                    for m, _ in q(f'node_cpu_model_info{{instance="{inst}"}}')), {})
        disks = [{"dev": m.get("device", ""), "model": m.get("model", ""), "size": m.get("size", ""), "kind": m.get("kind", "")}
                 for m, _ in q(f'node_disk_model_info{{instance="{inst}"}}')]
        nvme = [{"dev": m.get("device", ""), "model": m.get("model", ""), "fw": m.get("firmware_revision", "")}
                for m, _ in q(f'node_nvme_info{{instance="{inst}"}}')]
        board = next((f'{m.get("system_vendor","")} {m.get("product_name","")}'.strip()
                      for m, _ in q(f'node_dmi_info{{instance="{inst}"}}')), "")
        return {"cpu": cpu, "disks": sorted(disks, key=lambda d: d["dev"]), "nvme": nvme,
                "ram": one(f'node_memory_total_gb{{instance="{inst}"}}'), "board": board}

    def fsusage(inst, min_gb=2):
        """本机文件系统占用。
        排除 tmpfs/overlay/fuse 和**网络挂载** —— .89 上挂了三个群晖 NFS 共享(各 11.5TB),
        混进来会让人以为这台机器自己有 11TB 盘; 群晖的容量在 NAS 面板里另有展示。"""
        sel = (f'instance="{inst}",'
               'fstype!~"tmpfs|overlay|squashfs|fuse.*|nfs.*|cifs|autofs|devtmpfs|ramfs"')
        sz, dv = {}, {}
        for m, v in q(f'node_filesystem_size_bytes{{{sel}}}'):
            mp = m.get("mountpoint"); sz[mp] = v; dv[mp] = m.get("device", "")
        av = {m.get("mountpoint"): v for m, v in q(f'node_filesystem_avail_bytes{{{sel}}}')}
        out = []
        for mp, total in sz.items():
            if not total or total < min_gb * 1e9:      # 跳过 /boot/efi 这类小分区
                continue
            used = total - av.get(mp, 0.0)
            out.append({"name": mp, "dev": dv.get(mp, ""), "used": used, "total": total,
                        "pct": round(used / total * 100, 1)})
        return sorted(out, key=lambda x: -x["total"])

    def pvestorage():
        """PVE 存储池占用。local-lvm 是 thin pool, 不是文件系统, node_exporter 看不见,
        只有 pve-exporter 有 —— 这才是宿主机上真正要盯的那个数。"""
        sz = {m.get("id"): v for m, v in q('pve_disk_size_bytes{id=~"storage/.*"}')}
        us = {m.get("id"): v for m, v in q('pve_disk_usage_bytes{id=~"storage/.*"}')}
        out = []
        for sid, total in sz.items():
            if not total:
                continue
            used = us.get(sid, 0.0)
            out.append({"name": sid.rsplit("/", 1)[-1], "used": used, "total": total,
                        "pct": round(used / total * 100, 1)})
        return sorted(out, key=lambda x: -x["total"])

    def ipmi(bmc, name):
        return one(f'ipmi_temperature_celsius{{bmc="{bmc}",name="{name}"}}')
    # 硬件面板按 [[hardware]] 循环生成 —— 一台都没有就是空列表, 前端不渲染这一区。
    # 每台机器要一个 BMC (ipmi-exporter 的 bmc 标签) 和一个同机的 node_exporter instance。
    st["hw"] = []
    for h in CFG["hardware"]:
        inst, bmc = h.get("instance", ""), h.get("bmc", "")
        e = {"key": h.get("key") or bmc or inst, "title": h.get("title", ""), "hint": h.get("hint", ""),
             "cpu": ipmi(bmc, "CPU Temp"), "sys": ipmi(bmc, "System Temp"),
             "periph": ipmi(bmc, "Peripheral Temp"), "dimm": ipmi(bmc, "DIMMA1 Temp"),
             "load": one(f'node_load1{{instance="{inst}"}}'),
             "fans": [{"name": m.get("name"), "rpm": v} for m, v in q(f'ipmi_fan_speed_rpm{{bmc="{bmc}"}}')],
             "bmc": bmc, "info": hwinfo(inst)}
        if h.get("nvme"):
            e.update({"nvme": one(f'node_hwmon_temp_celsius{{instance="{inst}",chip=~".*nvme.*",sensor="temp1"}}'),
                      "nvme_pct": one(f'nvme_percentage_used_ratio{{instance="{inst}"}}') * 100,
                      "nvme_spare": one(f'nvme_available_spare_ratio{{instance="{inst}"}}') * 100,
                      "nvme_hours": one(f'nvme_power_on_hours_total{{instance="{inst}"}}')})
        sto = h.get("storage", "none")
        if sto == "pve":
            e["storage"] = pvestorage()          # thin pool 只有 pve-exporter 看得见
        elif sto == "fs":
            e["fs"] = fsusage(inst)
        st["hw"].append(e)
    # ---- NAS ----
    st["nas"] = {
        "temp": one("synology_system_temperature_celsius"),
        "disks": sorted([{"name": m.get("disk", "?"), "t": v} for m, v in q("synology_disk_temperature_celsius")],
                        key=lambda d: d["name"]),
        "raid": [{"name": m.get("raid", "?"), "ok": v == 1} for m, v in q("synology_raid_status")],
        "model": next((m.get("model", "") for m, _ in q("synology_system_info")), ""),
    }
    # ---- IP -> 设备名 (DHCP 租约 + 配置静态映射), 旁路由与 NetFlow 共用 ----
    ip_names, mac_names = {}, {}
    for m, _ in q("mktxp_dhcp_lease_info"):
        _ip = m.get("address") or m.get("ip_address")
        _nm = m.get("host_name") or m.get("comment")
        if _ip and _nm:
            ip_names[_ip] = _nm
        if m.get("mac_address") and _nm:
            mac_names[m["mac_address"].upper()] = _nm
    ip_names.update(HOST_IP)
    mac_names.update(HOST_MAC)

    def dev_name(sip):
        """IP -> 设备名。IPv6 的 SLAAC 地址按 EUI-64 反推 MAC 再查
        (隐私地址反推不了, 原样返回)。"""
        if sip in ip_names:
            return ip_names[sip]
        if ":" in sip:
            try:
                b = ipaddress.IPv6Address(sip).packed[8:]
                if b[3] == 0xFF and b[4] == 0xFE:
                    mac = ":".join("%02X" % x for x in
                                   (b[0] ^ 0x02, b[1], b[2], b[5], b[6], b[7]))
                    if mac in mac_names:
                        return mac_names[mac]
            except Exception:
                pass
            # 隐私地址反推不了 MAC —— 截短显示, 别让整条 v6 撑爆悬浮框
            if len(sip) > 24:
                return sip[:10] + "…" + sip[-9:]
        return sip

    # ---- 旁路由 (mihomo 控制器): 实时分流 ----
    byp = CFG["bypass"]
    if byp.get("enabled") and byp.get("api"):
        try:
            req = urllib.request.Request(byp["api"].rstrip("/") + "/connections")
            if byp.get("secret"):
                req.add_header("Authorization", "Bearer " + byp["secret"])
            with urllib.request.urlopen(req, timeout=4) as r:
                cj = json.loads(r.read().decode())
            now_b = time.time()
            conns = cj.get("connections") or []
            # chains[0] 是实际出口: "DIRECT" = mihomo 里的直连规则, 其余 = 走了代理
            proxied = [c for c in conns if (c.get("chains") or ["?"])[0] != "DIRECT"]
            outs, per_src = {}, {}
            for c in proxied:
                grp = (c.get("chains") or ["?"])[-1]
                outs[grp] = outs.get(grp, 0) + 1
                sip = (c.get("metadata") or {}).get("sourceIP") or "?"
                e = per_src.setdefault(sip, [0, 0])
                e[0] += 1
                e[1] += (c.get("download") or 0) + (c.get("upload") or 0)
            # 每来源速率: 对该来源全部连接的累计字节做增量; 连接关闭时和会回退, rate() 对负增量返 0
            merged = {}
            for sip, (ncon, tot) in per_src.items():
                r_s = max(0.0, rate("byp_src_" + sip, tot, now_b))
                nm_ = dev_name(sip)
                e = merged.setdefault(nm_, {"name": nm_, "conns": 0, "rate": 0.0})
                e["conns"] += ncon
                e["rate"] += r_s
            srcs = sorted(merged.values(), key=lambda x: (-x["rate"], -x["conns"]))
            for x in srcs:
                x["rate"] = round(x["rate"], 2)
            st["bypass"] = {
                "sources": srcs[:5],
                "down": round(rate("byp_dl", cj.get("downloadTotal", 0), now_b), 3),
                "up": round(rate("byp_ul", cj.get("uploadTotal", 0), now_b), 3),
                "conns": len(conns), "proxied": len(proxied),
                "direct": len(conns) - len(proxied),
                "groups": sorted(outs.items(), key=lambda kv: -kv[1])[:4],
            }
            _bypass_ok["ok"] = True
        except Exception:
            st["bypass"] = {"down": 0, "up": 0, "conns": 0, "proxied": 0,
                            "direct": 0, "groups": [], "sources": [], "stale": True}
            _bypass_ok["ok"] = False

    # ---- NetFlow: 每设备去向 (IP -> 设备名) ----
    try:
        with urllib.request.urlopen(CFG["netflow"]["url"] + "/api/flows.json", timeout=6) as r:
            fl = json.loads(r.read().decode())
        nm = lambda ip: ip_names.get(ip, ip)   # 名字表在上面和旁路由共用一份
        # 同名设备(多网卡/多 IP)合并
        agg_s, agg_l = {}, {}
        for x in fl.get("sources", []):
            k = nm(x["id"]); e = agg_s.setdefault(k, {"id": k, "ip": x["id"], "v": 0}); e["v"] = round(e["v"] + x["v"], 3)
        for l in fl.get("links", []):
            k = (nm(l["src"]), l["dst"]); agg_l[k] = round(agg_l.get(k, 0) + l["v"], 3)
        st["flows"] = {
            "sources": sorted(agg_s.values(), key=lambda x: -x["v"])[:8],
            "dests": fl.get("dests", []),
            "links": sorted([{"src": a, "dst": b, "v": v} for (a, b), v in agg_l.items()], key=lambda x: -x["v"])[:30],
            "top": [{"src": nm(t["src"]), "dst": t["dst"], "port": t["port"], "mb": t["mb"]} for t in fl.get("top", [])],
            "stat": fl.get("stat", {}), "window": fl.get("window", 300),
        }
    except Exception:
        st["flows"] = None
    with _lock: st["fast"] = dict(_fast)

    # ================= 事件检测 =================
    try:
        # 公网 IP 变化 / PPPoE
        once_change("wanip", st["wan"].get("ip"), lambda a, b: f"公网 IP 变更 {a} → {b}", "wan", "warn")
        # OpenVPN 用户拨入/断开
        set_change("ovpnset", {u["id"] for u in st["ovpn"]}, "ovpn",
                   lambda x: f"OpenVPN 用户 {x} 拨入", lambda x: f"OpenVPN 用户 {x} 断开")
        # 内网新设备 (DHCP)
        leases = {m.get("host_name") or m.get("comment") or m.get("mac_address", "?")
                  for m, _ in q("mktxp_dhcp_lease_info")}
        set_change("leases", leases, "lan", lambda x: f"新设备接入内网 {x}", lambda x: f"设备离开 {x}", 4)
        # 无线: 上线/离线 + 漫游(换频段) + 弱信号
        wifi_now = {w["name"]: w for w in st.get("wifi_all", st["wifi"])}
        set_change("wifiset", set(wifi_now), "wifi",
                   lambda x: f"无线接入 {x}" + (f" ({wifi_now[x].get('band','')} {wifi_now[x].get('rssi','')}dBm)" if x in wifi_now else ""),
                   lambda x: f"无线离开 {x}", 4)
        for n, w in wifi_now.items():
            once_change("band:" + n, w.get("band"), lambda a, b, n=n: f"{n} 漫游 {a} → {b}", "wifi")
            r = w.get("rssi")
            if r is not None: threshold("rssi:" + n, -r, 78, f"{n} 信号弱", " dBm", "wifi", 4)
        # tailnet: 每个 peer 上线/离线 + 整体连通
        tn = st.get("tailnet") or {}
        seen_ts = {}
        for pr in tn.get("peers", []):
            seen_ts[pr["id"]] = seen_ts.get(pr["id"], 0) + 1
        for pr in tn.get("peers", []):
            uid = pr.get("ip") or pr["id"]                       # 同名设备(如两台 surge-iphone)用 IP 区分
            label = pr["id"] + (f" ({pr['ip'].split('.')[-1]})" if seen_ts.get(pr["id"], 0) > 1 and pr.get("ip") else "")
            edge_change("ts:" + uid, pr["online"], f"tailnet 节点 {label}", "ts", "上线", "离线", "info")
        once_change("tsonline", tn.get("online"),
                    lambda a, b: f"tailnet 在线节点 {a} → {b}", "ts")
        # VM 开关机
        for v in st["vms"]:
            edge_change("vm:" + v["id"], v["on"], f"虚拟机 {v['id']} {v['name']}", "vm", "启动", "停机")
        # 硬件温度
        # 硬件告警对每台配置里的机器都做一遍; 显示名取 title 的第一段
        for e_ in st["hw"]:
            k_ = e_["key"]
            nm_ = ((e_.get("title") or k_).split("·")[0].strip()) or k_
            threshold(f"t_cpu:{k_}", e_.get("cpu"), 85, f"{nm_} CPU", "°C")
            threshold(f"t_dimm:{k_}", e_.get("dimm"), 80, f"{nm_} 内存", "°C")
            if e_.get("nvme") is not None:
                threshold(f"t_nvme:{k_}", e_.get("nvme"), 75, f"{nm_} NVMe", "°C")
            for f_ in e_.get("fans", []):
                if f_.get("name", "").startswith("FAN") and f_.get("rpm") is not None:
                    edge_change(f"fan:{k_}:{f_['name']}", f_["rpm"] > 0,
                                f"{nm_} {f_['name']}", "hw", "恢复转动", "停转")
            # 磁盘/存储写满是最常见的翻车方式, 默认 85% 报警
            for s_ in list(e_.get("storage") or []) + list(e_.get("fs") or []):
                threshold(f"disk:{k_}:{s_['name']}", s_.get("pct"), EVC["disk_warn_pct"],
                          f"{nm_} {s_['name']} 占用", "%", "hw", 5)
        # NAS
        for d in st["nas"].get("disks", []):
            threshold("nasdisk:" + d["name"], d.get("t"), 50, f"NAS {d['name']}", "°C", "hw", 3)
        for r_ in st["nas"].get("raid", []):
            edge_change("raid:" + r_["name"], r_["ok"], f"NAS {r_['name']}", "hw", "正常", "异常", "bad")
        # 流量突发 (WAN + 每设备)
        fast = st.get("fast") or {}
        if fast.get("ready"):
            burst("wan", fast["wan"]["down"] + fast["wan"]["up"], "WAN", "burst",
                  floor=EVC["wan_burst_floor_mbps"], down=fast["wan"]["down"], up=fast["wan"]["up"])
            for n, d in (fast.get("dev") or {}).items():
                burst("dev:" + n, d["down"] + d["up"], n, "burst",
                      floor=EVC["device_burst_floor_mbps"], down=d["down"], up=d["up"])
            # OpenVPN 服务端: 每个拨入用户单独报。接口名 <ovpn-用户名> 是 ROS 动态生成的,
            # 用户名跟着 /ppp secret 走, 监控侧不写死。门槛比内网低 (远端受上行带宽限制)。
            # ROS 侧 rx = 客户端发进家里 (↓), tx = 家里发给客户端 (↑), 与 WAN 语义一致。
            for n_, d_ in (fast.get("ifaces") or {}).items():
                if not n_.startswith("<ovpn-"):
                    continue
                u_ = n_.strip("<>")[len("ovpn-"):]
                burst("ovpn:" + u_, d_["down"] + d_["up"], "OpenVPN " + u_, "burst", floor=EVC["ovpn_burst_floor_mbps"],
                      down=d_["down"], up=d_["up"])
        # 入口: 逐个 inbound 报"有无客户端"和"流量突发" (名字/端口来自运行时, 不写死)
        for r_ in (st.get("ingress_detail") or []):
            nm = f"{r_['type']} 入口 :{r_['port']}"
            edge_change("ingc:" + r_["svc"], stable("ingon:" + r_["svc"], r_["conns"] > 0), nm, "ingress",
                        up=f"有客户端接入 ({r_['conns']} 条连接)", down="连接归零", level_down="info")
            step_change("ingn:" + r_["svc"], r_["conns"], nm + " 连接数", "ingress", step=5, unit=" 条")
            burst("ingb:" + r_["svc"], r_["mbps"], nm, "ingress", floor=EVC["ingress_burst_floor_mbps"], mult=3.0,
                  down=r_.get("rx"), up=r_.get("tx"))
        wgd = st.get("ingress_wg_dir") or {}
        burst("ing:wg", (st.get("ingress") or {}).get("wg", 0), "WireGuard 入口", "ingress",
              floor=EVC["ingress_burst_floor_mbps"], mult=3.0, down=wgd.get("rx"), up=wgd.get("tx"))
    except Exception as e:
        ev("hw", f"事件引擎异常 {type(e).__name__}", "warn")

    st["events"] = list(_events)
    return st

def loop():
    global _state
    while True:
        try:
            s = collect()
            with _lock: _state = s
        except Exception as e:
            with _lock: _state = {"ts": int(time.time()), "ready": False, "error": type(e).__name__}
        time.sleep(INTERVAL)

# ================= 脱敏 =================
# 目的有两个: 你要把截图发到网上; 别人想先看看效果又不想暴露自己的网络。
# 替换是**确定性**的 —— 同一个原值每次都映射到同一个假名, 所以图上的关系不会乱,
# 但从假名反推不出真值。
_RE_V4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_RE_V6 = re.compile(r"\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b")
_RE_DOM = re.compile(r"\b(?:[a-zA-Z0-9-]+\.)+(?:com|cn|net|org|io|dev|xyz|top|me|cc)\b")
_RE_MAC = re.compile(r"\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b")

_HOSTS = ["书房台式", "客厅电视", "主卧手机", "次卧平板", "阳台摄像头", "厨房音箱", "玄关门锁",
          "扫地机器人", "办公笔记本", "儿童房平板", "车库摄像头", "客厅空调", "餐厅灯",
          "阳台洗衣机", "书房打印机", "客卧手机", "健身房音箱", "地下室主机"]
_SITES = ["站点甲", "站点乙", "站点丙", "站点丁", "站点戊", "站点己"]
_USERS = ["用户 A", "用户 B", "用户 C", "用户 D", "用户 E", "用户 F"]


def _h(v, n):
    """稳定哈希 -> [0, n)。用 md5 是为了跨进程重启也一致, 不是为了安全。"""
    import hashlib
    return int(hashlib.md5(str(v).encode()).hexdigest()[:8], 16) % n


_assigned, _used = {}, {}


def _pick(pool, v):
    """把一个真名映射到假名。必须保证**不同真名不撞同一个假名** ——
    撞了会把两台设备画成一台, 图上的关系就错了。所以先按哈希取一个候选,
    撞了就往后加序号, 并记住这次分配 (同一进程内同一真名永远得到同一假名)。"""
    pid = id(pool)
    key = (pid, v)
    if key in _assigned:
        return _assigned[key]
    used = _used.setdefault(pid, set())
    base = pool[_h(v, len(pool))]
    name, i = base, 1
    while name in used:
        i += 1
        name = f"{base}{i}"
    used.add(name)
    _assigned[key] = name
    return name


def _mask_ip(m):
    ip = m.group(0)
    parts = ip.split(".")
    if len(parts) != 4 or any(not x.isdigit() or int(x) > 255 for x in parts):
        return ip
    private = (parts[0] == "10" or (parts[0] == "192" and parts[1] == "168")
               or (parts[0] == "172" and 16 <= int(parts[1]) <= 31) or parts[0] == "127")
    # 写成 CIDR 的是网段而不是主机。内网网段保留原样(拓扑图上要看得懂), 但**公网网段必须换** ——
    # 一个真实的公网 /24 能直接暴露分支所在的 ISP 和地区。
    # 判据是"后面跟着 /掩码"而不是"末位为 0": 公网 IP 也可能以 .0 结尾。
    # (这两条都是被演示站生成器的泄漏扫描当场抓出来的)
    if re.match(r"/\d{1,2}\b", m.string[m.end():]):
        if private:
            return ip
        return "10.%d.%d.0" % (_h(ip, 254) + 1, _h(ip + "x", 254) + 1)
    if private:
        if CFG["redact"].get("keep_subnet", True):
            return ".".join(parts[:3] + [str(_h(ip, 254) + 1)])   # 只改末位, 保住网段结构
        return "10.9.9." + str(_h(ip, 254) + 1)
    return "203.0.113." + str(_h(ip, 254) + 1)                     # RFC5737 文档专用网段


def _mask_str(v):
    v = _RE_V4.sub(_mask_ip, v)
    # 注意: "20:17:29" 这种时间戳也符合"十六进制组 + 冒号"的形态, 直接套 IPv6 正则
    # 会把事件时间戳替换掉。所以要求出现 "::" 或至少 4 个冒号 (时间只有 2 个)。
    v = _RE_V6.sub(lambda m: ("2001:db8::" + hex(_h(m.group(0), 65535))[2:]
                              if ("::" in m.group(0) or m.group(0).count(":") >= 4) else m.group(0)), v)
    v = _RE_MAC.sub(lambda m: "02:00:00:%02x:%02x:%02x" % (_h(m.group(0), 255), _h(m.group(0) + "b", 255), _h(m.group(0) + "c", 255)), v)
    v = _RE_DOM.sub("example.com", v)
    return v


# 哪些区块里的"名字"要换, 以及换成哪种风格的假名
_SSIDS = ["HomeWiFi", "HomeWiFi-5G", "Guest-WiFi", "IoT-WiFi"]
_NAME_POOLS = {"lan": _HOSTS, "top": _HOSTS, "dev": _HOSTS, "wg": _USERS,
               "ovpn": _USERS, "tailnet": _USERS, "branches": _SITES,
               # 无线客户端也是设备; AP/电台名字里常带型号和位置
               "wifi": _HOSTS, "wifi_all": _HOSTS, "ap": _HOSTS, "radios": _HOSTS}
# 按**字段名**指定假名池, 优先级高于所在区块。SSID 常常直接带着户主姓名。
_KEY_NAME_POOLS = {"ssid": _SSIDS}
# 这些字典的**键本身**就是设备名 (fast.dev 是 {设备名: {...}}), 键也得换,
# 否则脱敏完设备名还明晃晃挂在那儿。
_KEY_POOLS = {"dev": _HOSTS}
_NAME_KEYS = ("name", "id", "user", "peer", "host_name", "src", "dst", "ssid")


def _redact(node, pool=None, key_pool=None):
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            nk = _pick(key_pool, k) if key_pool else k
            p = _NAME_POOLS.get(k, pool)
            if k in ("model", "board", "bmc") and isinstance(v, str) and v and CFG["redact"].get("mask_hardware"):
                out[nk] = "型号已隐藏"          # CPU/硬盘型号: 默认保留 (晒机器往往就是想展示硬件)
            elif k in _NAME_KEYS and isinstance(v, str) and v and (_KEY_NAME_POOLS.get(k) or p):
                out[nk] = _pick(_KEY_NAME_POOLS.get(k) or p, v)
            else:
                out[nk] = _redact(v, p, _KEY_POOLS.get(k))
        return out
    if isinstance(node, list):
        return [_redact(x, pool) for x in node]
    if isinstance(node, str):
        return _mask_str(node)
    return node


def _apply_names(node, table):
    """第二遍: 把自由文本里出现的真名也换掉。
    事件描述是一句话 (例如 "DHCP 回收 192.168.1.7 (客厅电视)"), 设备名嵌在里面,
    第一遍按字段名替换是够不着的。按长度倒序替换, 避免短名字先把长名字切碎。"""
    if isinstance(node, dict):
        return {k: _apply_names(v, table) for k, v in node.items()}
    if isinstance(node, list):
        return [_apply_names(x, table) for x in node]
    if isinstance(node, str):
        for real, fake in table:
            if real in node:
                node = node.replace(real, fake)
        return node
    return node


def redact_state(st):
    """只在开关打开时调用; 原始 state 不动, 返回一份脱敏副本。"""
    if not CFG["redact"].get("enabled"):
        return st
    out = _redact(st)                       # 第一遍: 按字段替换, 同时建立真名->假名表
    pairs = [(str(real), fake) for (_, real), fake in _assigned.items() if len(str(real)) >= 3]
    # 同一台设备在 state 里有两种写法: 去重后的 "iPhone (131)" 和裸名 "iPhone"。
    # 只登记了带后缀的那个, 裸名就会从事件文本里漏出去 —— 两种都要映射到同一个假名。
    for real, fake in list(pairs):
        m = re.match(r"^(.+?)\s*\(\d+\)$", real)
        if m and len(m.group(1)) >= 3:
            pairs.append((m.group(1), fake))
    table = sorted(set(pairs), key=lambda x: -len(x[0]))
    out = _apply_names(out, table)          # 第二遍: 扫自由文本
    out["redacted"] = True
    return out


def _mask_cfg(node):
    """脱敏也要覆盖注入前端的配置。
    拓扑节点的 name/sub 是用户自己写的标签, 里面往往带着路由器 IP、网段、交换机型号 ——
    只脱敏 state 而放过 config, 等于前门锁了后窗开着 (演示站上就能看到真实拓扑)。"""
    if isinstance(node, dict):
        return {k: _mask_cfg(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_mask_cfg(x) for x in node]
    if isinstance(node, str):
        return _mask_str(node)
    return node


def ui_config():
    """前端要的那部分配置 (静态, 页面加载时取一次)。"""
    cfg = {
        "site": CFG["site"],
        "topology": CFG["topology"],
        "panels": {"router": bool(RT.get("enabled", True)), "edge": bool(ED.get("enabled")),
                   "pve": bool(PV.get("enabled")), "nas": bool(CFG["nas"].get("enabled")),
                   "unifi": bool(CFG["unifi"].get("enabled")), "netflow": bool(CFG["netflow"].get("enabled")),
                   "bypass": bool(CFG["bypass"].get("enabled"))},
        "nas": {"title": CFG["nas"].get("title", "NAS"), "hint": CFG["nas"].get("hint", "")},
        "router": {"label": RT.get("label", "RouterOS")},
        "edge": {"label": ED.get("label", "edge")},
        "bypass": {"label": CFG["bypass"].get("label", "旁路由")},
        "pve_mem_total": PV.get("memory_total_gb", 32),
        "hist_ranges": [{"k": k, "step": v[1], "win": v[2]} for k, v in HIST_RANGES.items()],
        "hist_default": DEFAULT_RANGE,
        "redact": bool(CFG["redact"].get("enabled")),
    }
    return _mask_cfg(cfg) if CFG["redact"].get("enabled") else cfg


def kind_enabled(kind):
    """某类事件要不要推送。
    未在配置里出现的类型默认**推送** —— 升级带来新类型时, 宁可吵一下也别静默吞掉。"""
    k = CFG["alerts"].get("kinds")
    if isinstance(k, dict):
        return bool(k.get(kind, k.get("default", True)))
    if isinstance(k, list) and k:          # 兼容早期的数组写法(白名单)
        return kind in k
    return True


def toml_set_bools(text, section, updates):
    """就地改 TOML 里某个段的布尔键, **保留注释和排版**。
    标准库没有 TOML 写入器, 而整段重新序列化会把注释全丢掉 —— 配置文件的注释
    恰恰是这个项目最该保住的东西, 所以这里按行改。"""
    lines = text.splitlines(keepends=True)
    out, in_sec, done, seen_sec = [], False, set(), False
    bl = lambda v: "true" if v else "false"
    for ln in lines:
        st = ln.strip()
        if st.startswith("[") and st.endswith("]"):
            if in_sec:                       # 离开目标段前补上缺失的键
                for k, v in updates.items():
                    if k not in done:
                        out.append(f"{k} = {bl(v)}\n")
            in_sec = (st == f"[{section}]")
            seen_sec = seen_sec or in_sec
        elif in_sec:
            m = re.match(r"^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)", ln)
            if m and m.group(2) in updates:
                key = m.group(2)
                done.add(key)
                cmt = ln.split("#", 1)[1].rstrip("\n") if "#" in ln else ""
                out.append(f"{m.group(1)}{key}{m.group(3)}{bl(updates[key])}"
                           + (f"  #{cmt}\n" if cmt else "\n"))
                continue
        out.append(ln)
    if in_sec:
        for k, v in updates.items():
            if k not in done:
                out.append(f"{k} = {bl(v)}\n")
    elif not seen_sec:                        # 段不存在就新建
        out.append(f"\n[{section}]\n")
        for k, v in updates.items():
            out.append(f"{k} = {bl(v)}\n")
    return "".join(out)


# ================= 首屏自检 =================
# 数据源不通时, 面板只会是一片 0 —— 用户无法判断是自己配错了还是项目坏了。
# 这里逐项检查并给出"缺什么、怎么补", 直接显示在页面上。
_health = {"ts": 0.0, "items": []}
HEALTH_INTERVAL = 30.0


def health():
    """每 30 秒算一次: 这些查询不便宜, 而且配置问题不会秒级变化。"""
    if time.time() - _health["ts"] < HEALTH_INTERVAL and _health["items"]:
        return _health["items"]
    out = []

    def add(ok, label, hint="", doc=""):
        out.append({"ok": bool(ok), "label": label, "hint": hint, "doc": doc})

    # 1. Prometheus 本身
    ups = q("up")
    add(bool(ups), "Prometheus 可达",
        "面板拿不到任何指标。检查 config.toml 的 [prometheus] url —— 用 compose 部署时应为 http://prometheus:9090")
    if not ups:
        _health.update(ts=time.time(), items=out)
        return out                      # Prometheus 都不通, 后面的检查没有意义

    # 2. RouterOS 指标 (mktxp)
    ros_metrics = bool(q(f'mktxp_interface_running{{routerboard_name="{RBN}"}}'))
    add(ros_metrics, f"RouterOS 指标 (mktxp, routerboard_name={RBN})",
        "mktxp 没有产出数据。三个常见原因: ①compose 里 mktxp 的配置要挂到 /etc/mktxp; "
        f"②mktxp.conf 的段名必须是 [{RBN}], 和 config.toml 的 router.name 一致; "
        "③路由器上没开 API 服务或账号密码不对 —— 看 docker compose logs mktxp",
        "docs/SETUP.md#2-the-api-service-required")

    # 3. WAN 接口名是否对得上
    if ros_metrics:
        add(bool(q(f'mktxp_interface_running{{name="{WANIF}"}}')),
            f"WAN 接口 {WANIF}",
            f"路由器上没有叫 {WANIF} 的接口。拨号线路通常是 pppoe-out1, "
            "静态 IP / DHCP 则填物理口名(如 ether1)。改 config.toml 的 router.wan_interface")

    # 4. 1 秒快车道 (直连二进制 API)
    fast_ok = bool((_fast or {}).get("ready"))
    add(fast_ok or not RT.get("fast_lane", True), "1 秒快车道 (RouterOS API 8728)",
        "连不上路由器的二进制 API, 面板会退化成 Prometheus 的抓取粒度(一顿一顿的)。"
        "检查 router.host / .env 的 ROS_PASS / 路由器上 /ip service 的 api 是否启用并放行了本机",
        "docs/SETUP.md#2-the-api-service-required")

    # 5. kid-control —— 内网每设备流量的唯一来源
    if ros_metrics:
        kc = len(q("mktxp_kid_control_device_bytes_down_total"))
        add(kc > 0, f"kid-control 设备 ({kc})",
            "没有 kid-control 数据, '内网设备流量'表会是空的。这是 RouterOS 的功能, "
            "需要在路由器上建一个 kid-control profile(用全天范围, 否则会拦设备)",
            "docs/SETUP.md#3-kid-control--required-for-per-device-traffic")

    # 6. 可选模块: 开了但没数据的才提示
    opt = [("edge", ED.get("enabled"), f'up{{instance="{ED["instance"]}"}}',
            "边缘主机的 node_exporter 没数据。入口/分支隧道/tailnet 这三块会是空的",
            "exporters/textfile/README.md"),
           ("pve", PV.get("enabled"), "pve_up", "pve-exporter 没数据。用 --profile pve 启动并填好 .env 里的 PVE token", ""),
           ("nas", CFG["nas"].get("enabled"), "synology_system_temperature_celsius",
            "群晖 SNMP 没数据。用 --profile snmp 启动, 并在 exporters/snmp/snmp.yml 填好凭据", ""),
           ("unifi", CFG["unifi"].get("enabled"), "unifi_client_signal_dbm",
            "UniFi 没数据。用 --profile unifi 启动并在 .env 填 UNIFI_URL / UNIFI_API_KEY", ""),
           ("ipmi", bool(CFG["hardware"]), 'ipmi_temperature_celsius',
            "ipmi-exporter 没数据。用 --profile ipmi 启动, 并在 exporters/ipmi/ipmi.yml 填 BMC 账号", "")]
    for name, on, probe, hint, doc in opt:
        if on:
            add(bool(q(probe)), f"可选模块: {name}", hint, doc)

    # 7. 旁路由 mihomo API
    if CFG["bypass"].get("enabled"):
        add(_bypass_ok.get("ok", True), "旁路由 mihomo API",
            "连不上 mihomo 控制器 (bypass.api), 流向图上的分流节点会显示为断线", "")

    _health.update(ts=time.time(), items=out)
    return out


# ================= 告警外发 (Bark / Telegram) =================
class Notifier:
    """把事件推到手机。

    几条刻意的设计:
      - **后台线程 + 队列**: 推送要走公网, 慢或超时都不能拖住每秒一次的事件引擎。
      - **启动静默期**: 刚起来时会把路由器日志缓冲区里的历史条目重放一遍,
        不静默的话每次重启都给你炸一屏通知。
      - **去重 + 限频**: 抖动类事件(隧道反复上下线)最容易刷爆手机, 所以同文案有冷却,
        整体还有每小时上限。宁可漏, 不可吵 —— 太吵的告警等于没有告警。
      - **一个渠道挂了不影响另一个**, 失败只打日志, 绝不抛到调用方。
    """

    def __init__(self):
        self.q = []
        self.lock = threading.Lock()
        self.sent = {}            # 文案 -> 上次发送时间
        self.hour = [0, 0.0]      # [本小时已发条数, 小时起点]
        self.start = time.time()
        # 分原因计数: 只记一个笼统的 dropped, 排查时根本不知道是被静默期、级别、
        # 去重还是限频挡掉的 —— 静默丢弃尤其容易让人以为"配置没生效"。
        self.stats = {"sent": 0, "failed": 0, "queued": 0,
                      "drop_quiet": 0, "drop_level": 0, "drop_kind": 0,
                      "drop_dup": 0, "drop_rate": 0, "drop_full": 0, "drop_small": 0}
        threading.Thread(target=self._worker, daemon=True).start()

    # ---- 判断要不要发 ----
    def maybe(self, evt):
        a = CFG["alerts"]
        if not a.get("enabled"):
            return
        if time.time() - self.start < a.get("startup_quiet_sec", 60):
            self.stats["drop_quiet"] += 1              # 启动静默: 别把历史日志重放成通知
            return
        if evt.get("level") not in (a.get("levels") or ["warn", "bad"]):
            self.stats["drop_level"] += 1
            return
        if not kind_enabled(evt.get("kind")):
            self.stats["drop_kind"] += 1
            return
        # 突发类事件单独的门槛: 面板阈值调低是为了看趋势, 推送阈值该高得多。
        floor = a.get("min_burst_mbps", 0) or 0
        if floor and evt.get("kind") in ("burst", "ingress") and (evt.get("v") or 0) < floor:
            self.stats["drop_small"] += 1
            return
        text = evt.get("text", "")
        now = time.time()
        with self.lock:
            if now - self.sent.get(text, 0) < a.get("cooldown_sec", 300):
                self.stats["drop_dup"] += 1
                return
            if now - self.hour[1] > 3600:
                self.hour = [0, now]
            if self.hour[0] >= a.get("max_per_hour", 20):
                self.stats["drop_rate"] += 1
                return
            self.sent[text] = now
            self.hour[0] += 1
            if len(self.q) < 200:                      # 队列有上限, 网络长时间不通不会撑爆内存
                self.q.append(evt)
                self.stats["queued"] += 1
            else:
                self.stats["drop_full"] += 1

    # ---- 后台发送 ----
    def _worker(self):
        while True:
            with self.lock:
                evt = self.q.pop(0) if self.q else None
            if evt is None:
                time.sleep(1)
                continue
            lang = CFG["alerts"].get("lang", "zh")
            title = CFG["site"].get("title", "routeros-lanpulse")
            body = t_event(evt.get("text", ""), lang)
            for fn in (self._bark, self._telegram):
                try:
                    fn(title, body, evt.get("level", "info"))
                except Exception as e:
                    self.stats["failed"] += 1
                    print(f"[alert] {fn.__name__} 失败: {type(e).__name__}: {e}", flush=True)
            self.stats["sent"] += 1

    @staticmethod
    def _post(url, payload, timeout=8):
        req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status

    def _bark(self, title, body, level):
        c = CFG["alerts"].get("bark") or {}
        key = os.environ.get("BARK_KEY", "")
        if not c.get("enabled") or not key:
            return
        payload = {"title": title, "body": body,
                   "group": c.get("group") or "routeros-lanpulse",
                   # Bark 的 level 决定是否响铃/进摘要; bad 走时效性通知, info 静默
                   "level": {"bad": "timeSensitive", "warn": "active"}.get(level, "passive")}
        if c.get("sound"):
            payload["sound"] = c["sound"]
        if c.get("icon"):
            payload["icon"] = c["icon"]
        self._post(f"{(c.get('server') or 'https://api.day.app').rstrip('/')}/{key}", payload)

    def _telegram(self, title, body, level):
        c = CFG["alerts"].get("telegram") or {}
        tok, chat = os.environ.get("TELEGRAM_TOKEN", ""), os.environ.get("TELEGRAM_CHAT_ID", "")
        if not c.get("enabled") or not tok or not chat:
            return
        mark = {"bad": "🔴", "warn": "🟠"}.get(level, "🔵")
        # api_base 可配: Telegram 官方 API 在部分地区不可达, 可以指到自建反代;
        # 也可以给容器设 https_proxy 环境变量, urllib 默认就认。
        base = (c.get("api_base") or "https://api.telegram.org").rstrip("/")
        self._post(f"{base}/bot{tok}/sendMessage",
                   {"chat_id": chat, "text": f"{mark} <b>{_esc(title)}</b>\n{_esc(body)}",
                    "parse_mode": "HTML", "disable_notification": level == "info"})

    # ---- 设置页的"发一条测试"----
    def quiet_left(self):
        return max(0, int(CFG["alerts"].get("startup_quiet_sec", 60) - (time.time() - self.start)))

    def test(self):
        out = {}
        title = CFG["site"].get("title", "routeros-lanpulse")
        body = t_event("routeros-lanpulse 告警测试 —— 看到这条说明通道是通的", CFG["alerts"].get("lang", "zh"))
        for name, fn in (("bark", self._bark), ("telegram", self._telegram)):
            c = (CFG["alerts"].get(name) or {})
            if not c.get("enabled"):
                out[name] = "未启用"
                continue
            try:
                fn(title, body, "warn")
                out[name] = "已发送"
            except Exception as e:
                out[name] = f"失败: {type(e).__name__}: {e}"
        return out


def _esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


NOTIFY = Notifier()


# ================= 设置页鉴权 =================
# 原则是 fail-closed: **没配 ADMIN_PASSWORD 就整个设置页关闭**, 不设默认密码。
# 自托管项目最常见的翻车方式就是留一个 admin/admin 然后被扫到。
ADMIN_PW = os.environ.get("ADMIN_PASSWORD", "")
SESSION_TTL = 8 * 3600
_sessions = {}          # token -> 过期时间戳
_login_fail = {}        # ip -> (失败次数, 最近失败时间)
LOCK_AFTER, LOCK_SECS = 5, 300


def _client_ip(h):
    # 反代后面才信 X-Forwarded-For; 直连时用对端地址
    xff = h.headers.get("X-Forwarded-For", "")
    return (xff.split(",")[0].strip() if xff else h.client_address[0])


def _locked(ip):
    n, ts = _login_fail.get(ip, (0, 0.0))
    if n >= LOCK_AFTER and time.time() - ts < LOCK_SECS:
        return int(LOCK_SECS - (time.time() - ts))
    return 0


def _try_login(ip, pw):
    if not ADMIN_PW:
        return None
    if not hmac.compare_digest(str(pw or ""), ADMIN_PW):
        n, _ = _login_fail.get(ip, (0, 0.0))
        _login_fail[ip] = (n + 1, time.time())
        return None
    _login_fail.pop(ip, None)
    tok = secrets.token_urlsafe(32)
    _sessions[tok] = time.time() + SESSION_TTL
    for t, exp in list(_sessions.items()):          # 顺手清过期
        if exp < time.time():
            _sessions.pop(t, None)
    return tok


def _authed(h):
    if not ADMIN_PW:
        return False
    ck = h.headers.get("Cookie", "")
    for part in ck.split(";"):
        k, _, v = part.strip().partition("=")
        if k == "lp_session" and _sessions.get(v, 0) > time.time():
            return True
    return False


def config_path():
    return os.environ.get("CONFIG", os.path.join(HERE, "config.toml"))


def save_config(text):
    """校验 -> 备份 -> 写入 -> 热重载。校验不过就原样退回, 不动磁盘上的文件。"""
    import tomllib
    try:
        tomllib.loads(text)
    except Exception as e:
        return False, f"TOML 语法错误: {e}"
    path = config_path()
    try:
        if os.path.exists(path):
            shutil.copyfile(path, path + ".bak")     # 存一份上一版, 改坏了能退回
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    except OSError as e:
        return False, f"写入失败: {e} (配置文件是否以只读方式挂载?)"
    reload_cfg()
    return True, "已保存并重载。监听端口等启动项需要重启容器才生效。"


def reload_cfg():
    """重新读配置并刷新派生的全局量。改端口这类启动期才用的值需要重启。"""
    global CFG, RT, ED, PV, EVC, EI, WANIF, LANIF, WGRE, RBN, HOST_MAC, HOST_IP
    CFG = _load_cfg()
    RT, ED, PV, EVC = CFG["router"], CFG["edge"], CFG["pve"], CFG["events"]
    EI = f'instance="{ED["instance"]}"'
    WANIF, LANIF, WGRE, RBN = RT["wan_interface"], RT["lan_interface"], RT["wg_interface_regex"], RT["name"]
    HOST_MAC = {k.upper(): v for k, v in (CFG["hosts"].get("by_mac") or {}).items()}
    HOST_IP = CFG["hosts"].get("by_ip") or {}


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/api/history.json", "/history.json"):
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            b = json.dumps(history((qs.get("range") or [DEFAULT_RANGE])[0])).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
        elif p == "/api/auth.json":
            b = json.dumps({"enabled": bool(ADMIN_PW), "authed": _authed(self)}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
        elif p == "/api/alerts/kinds.json":
            if not _authed(self):
                self.send_response(401); self.send_header("Content-Type", "application/json")
                self.end_headers(); self.wfile.write(b'{"error":"unauthorized"}'); return
            b = json.dumps({"kinds": [{"key": k, "on": kind_enabled(k), "desc": d}
                                      for k, _, d in EVENT_KINDS]}, ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
        elif p == "/api/i18n.json":
            b = json.dumps(I18N.get("en") or {}, ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
        elif p == "/api/settings.json":
            if not _authed(self):
                self.send_response(401); self.send_header("Content-Type", "application/json")
                self.end_headers(); self.wfile.write(b'{"error":"unauthorized"}'); return
            try:
                txt = open(config_path(), encoding="utf-8").read()
            except OSError as e:
                txt = f"# 读不到配置文件: {e}\n"
            b = json.dumps({"toml": txt, "path": config_path()}, ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
        elif p in ("/api/config.json", "/config.json"):
            b = json.dumps(ui_config(), ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
        elif p in ("/api/state.json", "/state.json"):
            with _lock: b = json.dumps(redact_state(_state), ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
        else:
            # 静态文件: web/ 目录。路径做规范化, 防止 ../ 跳出目录。
            rel = p.lstrip("/") or "index.html"
            root = os.path.join(HERE, "web")
            f = os.path.normpath(os.path.join(root, rel))
            if not f.startswith(root) or not os.path.isfile(f):
                self.send_response(404); self.end_headers(); self.wfile.write(b"not found"); return
            ext = os.path.splitext(f)[1].lower()
            ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                     ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
                     ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
                     ".woff2": "font/woff2"}.get(ext, "application/octet-stream")
            if ext == ".html":
                # 把配置直接注进页面, 前端就不用为了等一个 fetch 把整个初始化改成异步
                html = open(f, encoding="utf-8").read()
                inject = ("<script>window.__CFG__=%s;window.__CFG_FROM_SERVER__=1;window.__I18N__=%s;</script>"
                          % (json.dumps(ui_config(), ensure_ascii=False),
                             json.dumps(I18N.get("en") or {}, ensure_ascii=False)))
                b = html.replace("</head>", inject + "</head>", 1).encode()
            else:
                b = open(f, "rb").read()
            self.send_response(200); self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def _json_body(self, limit=256 * 1024):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return {}
        return json.loads(self.rfile.read(min(n, limit)).decode() or "{}") if n else {}

    def _reply(self, code, obj, cookie=None):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def do_POST(self):
        p = self.path.split("?")[0]
        ip = _client_ip(self)
        try:
            if p == "/api/login":
                if not ADMIN_PW:
                    return self._reply(403, {"error": "未配置 ADMIN_PASSWORD, 设置页已关闭"})
                wait = _locked(ip)
                if wait:
                    return self._reply(429, {"error": f"失败次数过多, 请 {wait} 秒后再试"})
                tok = _try_login(ip, (self._json_body() or {}).get("password"))
                if not tok:
                    return self._reply(401, {"error": "密码错误"})
                # SameSite=Strict + HttpOnly: 防 CSRF 和 XSS 偷 cookie
                return self._reply(200, {"ok": True},
                                   f"lp_session={tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}")
            if p == "/api/logout":
                ck = self.headers.get("Cookie", "")
                for part in ck.split(";"):
                    k, _, v = part.strip().partition("=")
                    if k == "lp_session":
                        _sessions.pop(v, None)
                return self._reply(200, {"ok": True}, "lp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
            if p == "/api/alerts/kinds":
                if not _authed(self):
                    return self._reply(401, {"error": "未登录"})
                body = self._json_body() or {}
                want = {k: bool(v) for k, v in (body.get("kinds") or {}).items()
                        if k in {x[0] for x in EVENT_KINDS}}
                if not want:
                    return self._reply(400, {"error": "没有可识别的事件类型"})
                try:
                    txt = open(config_path(), encoding="utf-8").read()
                except OSError as e:
                    return self._reply(400, {"error": f"读不到配置: {e}"})
                ok2, msg = save_config(toml_set_bools(txt, "alerts.kinds", want))
                return self._reply(200 if ok2 else 400, {"ok": ok2, "message": msg})
            if p == "/api/alerts/test":
                if not _authed(self):
                    return self._reply(401, {"error": "未登录"})
                return self._reply(200, {"ok": True, "result": NOTIFY.test(),
                                         "stats": NOTIFY.stats, "quiet_left": NOTIFY.quiet_left()})
            if p == "/api/settings":
                if not _authed(self):
                    return self._reply(401, {"error": "未登录"})
                ok, msg = save_config((self._json_body() or {}).get("toml", ""))
                return self._reply(200 if ok else 400, {"ok": ok, "message": msg})
        except Exception as e:
            return self._reply(500, {"error": f"{type(e).__name__}: {e}"})
        self._reply(404, {"error": "not found"})

    def log_message(self, *a): pass

if __name__ == "__main__":
    threading.Thread(target=loop, daemon=True).start()
    threading.Thread(target=fast_loop, daemon=True).start()
    HTTPServer(("0.0.0.0", PORT), H).serve_forever()
