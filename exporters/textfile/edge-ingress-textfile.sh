#!/bin/bash
# edge 入口流量统计 -> node_exporter textfile
#
# 为什么不用 ROS 的 dst-nat 规则计数器:
#   dst-nat 规则只在每条连接的**首包**命中, 后续报文走连接跟踪不再经过该规则。
#   实测 trojan 那条规则只涨 ~5.7 B/s (30 分钟 11KB), 完全反映不了真实流量,
#   面板上 ingress 因此恒为 0, 突发事件永远触发不了。
#
# 这里改用 nft 独立计数表 (hook priority -300, policy accept, 只计数不改包),
# 端口从 sing-box 配置和实际监听表**动态读取**, 不写死。
set -u
OUT_DIR=/var/lib/prometheus/node-exporter
OUT=$OUT_DIR/edge-ingress.prom
SB_CFG=/etc/sing-box/config.json
MAP=/run/edge-ingress.map
INTERVAL=${INTERVAL:-5}

discover() {
  # sing-box 的 inbound: tag / type / port
  if [ -r "$SB_CFG" ]; then
    python3 - "$SB_CFG" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
for i in d.get("inbounds",[]):
    p=i.get("listen_port")
    if p: print("%s\t%s\t%s" % (i.get("tag") or i.get("type"), i.get("type") or "?", p))
PY
  fi
  # nginx 实际监听的端口 (从进程监听表取, 配置怎么改都跟得上)
  ss -lntpH 2>/dev/null | awk '/nginx/ {split($4,a,":"); print a[length(a)]}' | sort -un | while read -r p; do
    [ -n "$p" ] && printf 'nginx-%s\thttp\t%s\n' "$p" "$p"
  done
}

build_table() {
  discover > "$MAP.new" || true
  # 端口集合没变就不重建 (重建会清零计数器)
  if [ -f "$MAP" ] && cmp -s "$MAP" "$MAP.new"; then rm -f "$MAP.new"; return 0; fi
  mv "$MAP.new" "$MAP"
  { echo 'table inet ingstat {'
    n=0
    while IFS=$'\t' read -r tag typ port; do
      n=$((n+1)); echo "  counter c${n}_rx {}"; echo "  counter c${n}_tx {}"
    done < "$MAP"
    echo '  chain input { type filter hook input priority -300; policy accept;'
    n=0; while IFS=$'\t' read -r tag typ port; do n=$((n+1))
      echo "    tcp dport $port counter name c${n}_rx"; echo "    udp dport $port counter name c${n}_rx"
    done < "$MAP"
    echo '  }'
    echo '  chain output { type filter hook output priority -300; policy accept;'
    n=0; while IFS=$'\t' read -r tag typ port; do n=$((n+1))
      echo "    tcp sport $port counter name c${n}_tx"; echo "    udp sport $port counter name c${n}_tx"
    done < "$MAP"
    echo '  }'
    echo '}'
  } > /run/ingstat.nft
  nft delete table inet ingstat 2>/dev/null
  nft -f /run/ingstat.nft
}

export_metrics() {
  python3 - "$MAP" <<'PY' > "$OUT.tmp"
import json,subprocess,sys,os
rows=[l.rstrip("\n").split("\t") for l in open(sys.argv[1]) if l.strip()]
try: j=json.loads(subprocess.run(["nft","-j","list","counters","table","inet","ingstat"],capture_output=True,text=True).stdout)
except Exception: j={"nftables":[]}
cnt={}
for o in j.get("nftables",[]):
    c=o.get("counter")
    if c: cnt[c["name"]]={"bytes":c.get("bytes",0),"packets":c.get("packets",0)}
# 已建立连接数
try: ss=subprocess.run(["ss","-tnH","state","established"],capture_output=True,text=True).stdout
except Exception: ss=""
def conns(port):
    n=0
    for line in ss.splitlines():
        f=line.split()
        if len(f)>=4 and f[2].rsplit(":",1)[-1]==str(port): n+=1
    return n
print("# HELP edge_ingress_bytes_total edge 入口按服务累计字节 (nft 计数器, rx=入站 tx=出站)")
print("# TYPE edge_ingress_bytes_total counter")
print("# HELP edge_ingress_connections 当前已建立连接数")
print("# TYPE edge_ingress_connections gauge")
for i,(tag,typ,port) in enumerate(rows, start=1):
    lbl='svc="%s",type="%s",port="%s"' % (tag,typ,port)
    for d in ("rx","tx"):
        c=cnt.get("c%d_%s"%(i,d))
        if c is not None: print('edge_ingress_bytes_total{%s,dir="%s"} %d' % (lbl,d,c["bytes"]))
    print('edge_ingress_connections{%s} %d' % (lbl,conns(port)))
PY
  mv "$OUT.tmp" "$OUT"
}

mkdir -p "$OUT_DIR"
while :; do
  build_table
  export_metrics || true
  sleep "$INTERVAL"
done
