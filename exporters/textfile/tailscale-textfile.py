import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
peers = list((d.get("Peer") or {}).values())
online = sum(1 for p in peers if p.get("Online"))
self_ = d.get("Self") or {}
esc = lambda s: str(s).replace("\\", "\\\\").replace('"', '\\"')
out = [
    "# HELP tailscale_peers_total tailnet peers known to this node",
    "# TYPE tailscale_peers_total gauge",
    "tailscale_peers_total %d" % len(peers),
    "# HELP tailscale_peers_online tailnet peers currently online",
    "# TYPE tailscale_peers_online gauge",
    "tailscale_peers_online %d" % online,
    "# HELP tailscale_peer_online per-peer online state",
    "# TYPE tailscale_peer_online gauge",
]
for p in peers:
    ip = (p.get("TailscaleIPs") or [""])[0]
    out.append('tailscale_peer_online{peer="%s",ip="%s",os="%s"} %d'
               % (esc(p.get("HostName", "?")), esc(ip), esc(p.get("OS", "")), 1 if p.get("Online") else 0))
out.append('tailscale_self_online{peer="%s"} %d' % (esc(self_.get("HostName", "?")), 1 if self_.get("Online") else 0))
out.append("tailscale_backend_running %d" % (1 if d.get("BackendState") == "Running" else 0))
print("\n".join(out))
