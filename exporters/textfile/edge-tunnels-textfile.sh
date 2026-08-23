#!/bin/bash
# 分支隧道实况 -> node_exporter textfile: 隧道单元名 / tun 设备 / 对端网关 / 承载网段
# 全部从运行时推导, 不写死任何映射
D=/var/lib/prometheus/node-exporter; mkdir -p $D; T=$D/edge-tunnels.prom.$$
{
  echo "# HELP edge_tunnel_up OpenVPN 分支隧道状态 (1=已建立)"
  echo "# TYPE edge_tunnel_up gauge"
  echo "# HELP edge_tunnel_route 该隧道承载的对端网段"
  echo "# TYPE edge_tunnel_route gauge"
  for u in $(systemctl list-units 'openvpn-client@*' --no-legend --plain 2>/dev/null | awk '{print $1}'); do
    name=${u#openvpn-client@}; name=${name%.service}
    act=$(systemctl is-active "$u" 2>/dev/null)
    # 该单元打开的 tun 设备 (openvpn 启动时会记录)
    dev=$(journalctl -u "$u" -n 200 --no-pager 2>/dev/null | grep -oE 'TUN/TAP device tun[0-9]+ opened' | tail -1 | grep -oE 'tun[0-9]+')
    up=0; [ "$act" = active ] && [ -n "$dev" ] && [ -d "/sys/class/net/$dev" ] && up=1
    gw=""; net=""
    if [ -n "$dev" ] && [ -d "/sys/class/net/$dev" ]; then
      net=$(ip -o -4 route show dev "$dev" scope link 2>/dev/null | awk '{print $1; exit}')
      gw=$(ip -o -4 addr show dev "$dev" 2>/dev/null | grep -oE 'peer [0-9.]+' | awk '{print $2}')
      [ -z "$gw" ] && gw=$(echo "$net" | awk -F'[./]' '{printf "%s.%s.%s.1", $1,$2,$3}')
    fi
    echo "edge_tunnel_up{unit=\"$name\",device=\"${dev:-none}\",net=\"${net:-}\",peer=\"${gw:-}\"} $up"
    [ -n "$dev" ] && ip -o -4 route show dev "$dev" 2>/dev/null | awk -v u="$name" -v d="$dev" '$1!="default"{print "edge_tunnel_route{unit=\"" u "\",device=\"" d "\",dest=\"" $1 "\"} 1"}'
  done
} > $T 2>/dev/null && mv $T $D/edge-tunnels.prom || rm -f $T
