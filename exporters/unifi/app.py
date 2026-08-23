#!/usr/bin/env python3
"""UniFi -> Prometheus exporter (仅标准库)。
数据源: Network 私有 API (/proxy/network/api/s/<site>/stat/*), 用 Integration API 的 X-API-KEY 认证 —— 实测可用,
字段远比 Integration API v1 丰富 (v1 的 clients 没有 signal/rate, 见 README)。
env: UNIFI_URL, UNIFI_API_KEY, UNIFI_SITE(default), LISTEN_PORT(9131), INTERVAL(30)
"""
import json, os, ssl, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

URL = os.environ.get("UNIFI_URL", "https://192.168.1.14:11443").rstrip("/")
KEY = os.environ.get("UNIFI_API_KEY", "")
SITE = os.environ.get("UNIFI_SITE", "default")
PORT = int(os.environ.get("LISTEN_PORT", "9131"))
INTERVAL = int(os.environ.get("INTERVAL", "30"))
API = f"{URL}/proxy/network/api/s/{SITE}"
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
_lock = threading.Lock(); _text = "unifi_up 0\n"
BAND = {"ng": "2.4G", "na": "5G", "6e": "6G", "ax": "6G"}

def api(path):
    req = urllib.request.Request(API + path, headers={"X-API-KEY": KEY, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
        return json.loads(r.read().decode()).get("data", [])

def esc(v): return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
def lbl(**kw):
    p = [f'{k}="{esc(v)}"' for k, v in kw.items() if v not in (None, "")]
    return "{" + ",".join(p) + "}" if p else ""

def collect():
    out, ok = [], 1
    def add(name, val, **labels):
        try: f = float(val)
        except (TypeError, ValueError): return
        if f == f: out.append(f"{name}{lbl(**labels)} {f}")
    try:
        devs = api("/stat/device")
        mac2name = {d.get("mac"): (d.get("name") or d.get("model") or d.get("mac")) for d in devs}
        for d in devs:
            L = dict(device=mac2name.get(d.get("mac"), "?"), mac=d.get("mac", ""),
                     model=d.get("model", ""), ip=d.get("ip", ""))
            add("unifi_device_up", 1 if d.get("state") == 1 else 0, **L)
            add("unifi_device_uptime_seconds", d.get("uptime"), **L)
            add("unifi_device_clients", d.get("num_sta"), **L)
            add("unifi_device_guest_clients", d.get("guest-num_sta"), **L)
            add("unifi_device_satisfaction_percent", d.get("satisfaction"), **L)
            add("unifi_device_rx_bytes_total", d.get("rx_bytes"), **L)
            add("unifi_device_tx_bytes_total", d.get("tx_bytes"), **L)
            add("unifi_device_bytes_rate", d.get("bytes-r"), **L)
            sy = d.get("system-stats") or {}
            add("unifi_device_cpu_percent", sy.get("cpu"), **L)
            add("unifi_device_memory_percent", sy.get("mem"), **L)
            add("unifi_device_load1", (d.get("sys_stats") or {}).get("loadavg_1"), **L)
            out.append(f'unifi_device_info{lbl(**L, version=d.get("version",""), adopted=str(d.get("adopted")))} 1')
            for r in (d.get("radio_table_stats") or []):
                RL = dict(device=L["device"], band=BAND.get(r.get("radio"), str(r.get("radio"))),
                          radio=r.get("name", ""), channel=str(r.get("channel", "")))
                add("unifi_radio_clients", r.get("num_sta"), **RL)
                add("unifi_radio_channel_utilization_percent", r.get("cu_total"), **RL)
                add("unifi_radio_cu_self_rx_percent", r.get("cu_self_rx"), **RL)
                add("unifi_radio_cu_self_tx_percent", r.get("cu_self_tx"), **RL)
                add("unifi_radio_tx_retries_total", r.get("tx_retries"), **RL)
                add("unifi_radio_satisfaction_percent", r.get("satisfaction"), **RL)
                add("unifi_radio_channel", r.get("channel"), **RL)
        cls = api("/stat/sta")
        wired = sum(1 for c in cls if c.get("is_wired"))
        add("unifi_clients_total", len(cls) - wired, type="wireless")
        add("unifi_clients_total", wired, type="wired")
        for c in cls:
            if c.get("is_wired"): continue
            L = dict(client=c.get("name") or c.get("hostname") or c.get("mac", "?"), mac=c.get("mac", ""),
                     ip=c.get("last_ip") or c.get("ip", ""), ssid=c.get("essid", ""),
                     band=BAND.get(c.get("radio") or c.get("last_radio"), ""),
                     ap=mac2name.get(c.get("ap_mac"), c.get("last_uplink_name", "")),
                     channel=str(c.get("channel", "")), proto=c.get("radio_proto", ""))
            add("unifi_client_signal_dbm", c.get("signal"), **L)
            add("unifi_client_rssi", c.get("rssi"), **L)
            add("unifi_client_noise_dbm", c.get("noise"), **L)
            add("unifi_client_tx_rate_kbps", c.get("tx_rate"), **L)
            add("unifi_client_rx_rate_kbps", c.get("rx_rate"), **L)
            add("unifi_client_satisfaction_percent", c.get("satisfaction"), **L)
            add("unifi_client_tx_bytes_total", c.get("tx_bytes"), **L)
            add("unifi_client_rx_bytes_total", c.get("rx_bytes"), **L)
            add("unifi_client_bytes_rate", c.get("bytes-r"), **L)
            add("unifi_client_tx_retries_total", c.get("tx_retries"), **L)
            add("unifi_client_tx_retries_percent", c.get("wifi_tx_retries_percentage"), **L)
            add("unifi_client_uptime_seconds", c.get("uptime"), **L)
            add("unifi_client_idle_seconds", c.get("idletime"), **L)
            add("unifi_client_channel_width_mhz", c.get("channel_width") or c.get("channelWidth"), **L)
            add("unifi_client_nss", c.get("nss"), **L)
            add("unifi_client_tx_power_dbm", c.get("tx_power"), **L)
            out.append(f"unifi_client_online{lbl(**L)} 1")
    except Exception as e:
        ok = 0; out.append(f'unifi_exporter_error{{msg="{esc(type(e).__name__)}"}} 1')
    out.append(f"unifi_up {ok}")
    return "# HELP unifi_up UniFi API reachable\n# TYPE unifi_up gauge\n" + "\n".join(out) + "\n"

def loop():
    global _text
    while True:
        t = collect()
        with _lock: _text = t
        time.sleep(INTERVAL)

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        with _lock: b = _text.encode()
        self.send_response(200); self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass

if __name__ == "__main__":
    threading.Thread(target=loop, daemon=True).start()
    HTTPServer(("0.0.0.0", PORT), H).serve_forever()
