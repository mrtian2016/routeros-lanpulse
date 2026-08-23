#!/usr/bin/env python3
"""轻量 NetFlow v9 收集器 (仅标准库)。
监听 UDP 2055 收 RouterOS 的 traffic-flow, 在内存里按"内网设备 → 目的分类"聚合,
HTTP 输出 /api/flows.json 给流向面板的桑基图, /metrics 给 Prometheus。
不落盘、不依赖 ClickHouse —— 只保留最近 WINDOW 秒的滚动窗口。
env: LISTEN_PORT(9133), NF_PORT(2055), WINDOW(300), LAN(192.168.1.0/24)
"""
import ipaddress, json, os, socket, struct, threading, time
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, HTTPServer

NF_PORT = int(os.environ.get("NF_PORT", "2055"))
HTTP_PORT = int(os.environ.get("LISTEN_PORT", "9133"))
WINDOW = int(os.environ.get("WINDOW", "300"))
LAN = ipaddress.ip_network(os.environ.get("LAN", "192.168.1.0/24"))
PRIV = [ipaddress.ip_network(x) for x in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10")]

# NetFlow v9 字段 ID
F = {1: "octets", 2: "packets", 4: "proto", 7: "srcport", 8: "srcaddr", 11: "dstport", 12: "dstaddr",
     10: "input", 14: "output", 21: "last", 22: "first", 27: "srcaddr6", 28: "dstaddr6"}
SERVICE = {80: "HTTP", 443: "HTTPS/QUIC", 22: "SSH", 53: "DNS", 123: "NTP", 445: "SMB", 548: "AFP",
           3478: "STUN", 5228: "推送", 1935: "RTMP", 554: "RTSP", 62226: "WireGuard", 60957: "OpenVPN",
           58443: "trojan", 58444: "anytls", 32443: "HTTPS 入口", 41641: "tailscale", 8006: "PVE", 11443: "UniFi"}

_templates = {}          # (src, source_id, tid) -> [(field_id, length), ...]
_flows = []              # [(ts, src, dst, dport, proto, bytes)]
_lock = threading.Lock()
_stat = {"packets": 0, "flows": 0, "templates": 0, "last": 0}

def is_priv(ip):
    try: a = ipaddress.ip_address(ip)
    except ValueError: return False
    return any(a in n for n in PRIV)

def parse_v9(data, src):
    if len(data) < 20: return
    ver, count, uptime, ts, seq, sid = struct.unpack("!HHIIII", data[:20])
    if ver != 9: return
    off, seen = 20, 0
    while off + 4 <= len(data) and seen < count:
        fsid, flen = struct.unpack("!HH", data[off:off + 4])
        if flen < 4: return
        body, end = data[off + 4:off + flen], off + flen
        if fsid == 0:                                   # 模板集
            p = 0
            while p + 4 <= len(body):
                tid, n = struct.unpack("!HH", body[p:p + 4]); p += 4
                fields = []
                for _ in range(n):
                    if p + 4 > len(body): break
                    ft, fl = struct.unpack("!HH", body[p:p + 4]); p += 4
                    fields.append((ft, fl))
                _templates[(src, sid, tid)] = fields
                _stat["templates"] = len(_templates)
                seen += 1
        elif fsid > 255:                                # 数据集
            tpl = _templates.get((src, sid, fsid))
            if tpl:
                rec = sum(f[1] for f in tpl)
                p = 0
                while p + rec <= len(body):
                    r, q = {}, p
                    for ft, fl in tpl:
                        v = body[q:q + fl]; q += fl
                        name = F.get(ft)
                        if not name: continue
                        if name in ("srcaddr", "dstaddr") and fl == 4: r[name] = socket.inet_ntoa(v)
                        elif name in ("srcaddr6", "dstaddr6") and fl == 16:
                            r[name.replace("6", "")] = socket.inet_ntop(socket.AF_INET6, v)
                        else: r[name] = int.from_bytes(v, "big")
                    p += rec; seen += 1
                    if r.get("srcaddr") and r.get("dstaddr"):
                        with _lock:
                            _flows.append((time.time(), r["srcaddr"], r["dstaddr"],
                                           r.get("dstport", 0), r.get("proto", 0), r.get("octets", 0)))
                            _stat["flows"] += 1
        off = end
    _stat["packets"] += 1; _stat["last"] = int(time.time())

def listener():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
    s.bind(("0.0.0.0", NF_PORT))
    while True:
        try:
            data, addr = s.recvfrom(65535)
            parse_v9(data, addr[0])
        except Exception:
            pass

def prune():
    while True:
        cut = time.time() - WINDOW
        with _lock:
            i = 0
            while i < len(_flows) and _flows[i][0] < cut: i += 1
            del _flows[:i]
        time.sleep(10)

def classify(dst, dport, proto):
    """目的地分类: 内网 / 服务名 / 端口"""
    if is_priv(dst): return "内网互访"
    if dport in SERVICE: return SERVICE[dport]
    if proto == 1: return "ICMP"
    if 1024 <= dport <= 65535 and proto == 6: return "其它 TCP"
    if proto == 17: return "其它 UDP"
    return f"端口 {dport}"

def summary():
    now = time.time()
    with _lock: rows = list(_flows)
    span = max(1.0, WINDOW)
    by_src = defaultdict(float); by_dst = defaultdict(float)
    link = defaultdict(float); talkers = defaultdict(float)
    def inlan(ip):
        try: return ipaddress.ip_address(ip) in LAN
        except ValueError: return False
    for ts, s_, d, dp, pr, b in rows:
        if ts < now - WINDOW: continue
        bits = b * 8 / span / 1e6                       # Mbps 均值
        si, di = inlan(s_), inlan(d)
        if si and not di:        dev, cat = s_, classify(d, dp, pr)      # 出站 (NAT 前)
        elif di and not si:      dev, cat = d, "公网入站"
        elif si and di:          dev, cat = s_, "内网互访"
        else:                    continue                                # NAT 后的重复视角, 丢弃
        by_src[dev] += bits; by_dst[cat] += bits
        link[(dev, cat)] += bits
        talkers[(s_, d, dp)] += b
    top_src = sorted(by_src.items(), key=lambda x: -x[1])[:8]
    keep = {k for k, _ in top_src}
    links = [{"src": a, "dst": b, "v": round(v, 3)} for (a, b), v in link.items() if a in keep and v > 0.001]
    return {
        "ts": int(now), "window": WINDOW,
        "sources": [{"id": k, "v": round(v, 3)} for k, v in top_src],
        "dests": [{"id": k, "v": round(v, 3)} for k, v in sorted(by_dst.items(), key=lambda x: -x[1])[:8]],
        "links": sorted(links, key=lambda x: -x["v"])[:40],
        "top": [{"src": a, "dst": b, "port": p, "mb": round(v / 1e6, 2)}
                for (a, b, p), v in sorted(talkers.items(), key=lambda x: -x[1])[:12]],
        "stat": dict(_stat, cached=len(rows)),
    }

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/metrics":
            s = summary()
            out = [f'netflow_packets_total {s["stat"]["packets"]}', f'netflow_flows_total {s["stat"]["flows"]}',
                   f'netflow_cached_flows {s["stat"]["cached"]}', f'netflow_templates {s["stat"]["templates"]}']
            for x in s["sources"]:
                out.append(f'netflow_device_mbps{{device="{x["id"]}"}} {x["v"]}')
            for x in s["dests"]:
                out.append(f'netflow_dest_mbps{{dest="{x["id"]}"}} {x["v"]}')
            b = ("\n".join(out) + "\n").encode(); ct = "text/plain; version=0.0.4"
        else:
            b = json.dumps(summary(), ensure_ascii=False).encode(); ct = "application/json; charset=utf-8"
        self.send_response(200); self.send_header("Content-Type", ct)
        self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass

if __name__ == "__main__":
    threading.Thread(target=listener, daemon=True).start()
    threading.Thread(target=prune, daemon=True).start()
    HTTPServer(("0.0.0.0", HTTP_PORT), H).serve_forever()
