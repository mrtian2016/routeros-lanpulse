#!/bin/bash
# tailnet 状态 -> node_exporter textfile (peer 在线/总数, 每 peer 在线)
D=/var/lib/prometheus/node-exporter; mkdir -p $D; T=$D/tailscale.prom.$$
tailscale status --json 2>/dev/null | python3 /usr/local/bin/tailscale-textfile.py > $T 2>/dev/null && mv $T $D/tailscale.prom || rm -f $T
