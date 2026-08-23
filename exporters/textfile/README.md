# Textfile collectors

Three panels — **ingress traffic**, **branch tunnels** and **tailnet** — do not come from
the router. They are collected on the host that terminates your tunnels and reverse proxies
(called `edge` in the example config) and handed to Prometheus through node_exporter's
textfile collector.

If you do not have such a host, set `[edge] enabled = false` in `config.toml` and those
panels disappear cleanly.

## Install

On the edge host, as root:

```bash
# 1. node_exporter with the textfile collector pointed at a directory
mkdir -p /var/lib/prometheus/node-exporter
#On Debian/Ubuntu the package reads its flags from this file — do not edit the unit
echo 'ARGS="--collector.textfile.directory=/var/lib/prometheus/node-exporter"' \
  >> /etc/default/prometheus-node-exporter
systemctl restart prometheus-node-exporter

# 2. drop in the collectors you need
install -m 755 edge-ingress-textfile.sh  /usr/local/bin/
install -m 755 edge-tunnels-textfile.sh  /usr/local/bin/
install -m 755 tailscale-textfile.sh     /usr/local/bin/
install -m 755 hwinfo-textfile.sh        /usr/local/bin/
```

## What each one does

| Script | Panel it feeds | How it runs |
|---|---|---|
| `edge-ingress-textfile.sh` | Ingress connections & traffic | long-running service (loop) |
| `edge-tunnels-textfile.sh` | Branch tunnels | timer, every minute |
| `tailscale-textfile.sh` | tailnet nodes | timer, every minute |
| `hwinfo-textfile.sh` | CPU / disk models in hardware panels | timer, hourly |

`edge-ingress-textfile.sh` runs continuously because it maintains an `nft` counter table:

```ini
#/etc/systemd/system/edge-ingress-stat.service
[Unit]
Description=lanpulse ingress accounting
After=network-online.target

[Service]
ExecStart=/usr/local/bin/edge-ingress-textfile.sh
ExecStopPost=-/usr/sbin/nft delete table inet ingstat
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

The other three are one-shot; drive them with a timer:

```ini
#/etc/systemd/system/lanpulse-textfile.service
[Unit]
Description=lanpulse textfile collectors
[Service]
Type=oneshot
ExecStart=/usr/local/bin/edge-tunnels-textfile.sh
ExecStart=/usr/local/bin/tailscale-textfile.sh
```
```ini
#/etc/systemd/system/lanpulse-textfile.timer
[Unit]
Description=run lanpulse textfile collectors every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=1m
[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now edge-ingress-stat.service lanpulse-textfile.timer
```

> **Do not use cron.** Debian/Ubuntu cloud images ship **without cron installed**
> (`dpkg -l cron` shows `un`), so dropping a file into `/etc/cron.d/` fails silently —
> the file is there, the syntax is right, and it never runs. Use a systemd timer.

## Verify

```bash
ls -la /var/lib/prometheus/node-exporter/        # should contain .prom files
curl -s localhost:9100/metrics | grep -c edge_   # should be > 0
```

Then add the host to `prometheus.yml` under the `node` job, and set `[edge] instance` in
`config.toml` to `<edge-host>:9100`.
