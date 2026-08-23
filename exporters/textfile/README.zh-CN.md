# Textfile 采集器

有三块面板不来自路由器——**入口流量**、**分支隧道**、**tailnet**。
它们在终结隧道和反向代理的那台机器上采集（示例配置里叫 `edge`），
通过 node_exporter 的 textfile 采集器交给 Prometheus。

没有这么一台机器的话，把 `config.toml` 里 `[edge] enabled` 设成 `false`，这三块面板会干净地消失。

## 安装

在 edge 主机上，以 root 执行：

```bash
# 1. 让 node_exporter 启用 textfile 采集器
mkdir -p /var/lib/prometheus/node-exporter
#Debian/Ubuntu 的包从这个文件读参数, 不要去改 systemd unit
echo 'ARGS="--collector.textfile.directory=/var/lib/prometheus/node-exporter"' \
  >> /etc/default/prometheus-node-exporter
systemctl restart prometheus-node-exporter

# 2. 放入需要的采集脚本
install -m 755 edge-ingress-textfile.sh  /usr/local/bin/
install -m 755 edge-tunnels-textfile.sh  /usr/local/bin/
install -m 755 tailscale-textfile.sh     /usr/local/bin/
install -m 755 hwinfo-textfile.sh        /usr/local/bin/
```

## 各脚本作用

| 脚本 | 对应面板 | 运行方式 |
|---|---|---|
| `edge-ingress-textfile.sh` | 入口连接数与流量 | 常驻服务（循环） |
| `edge-tunnels-textfile.sh` | 分支隧道 | timer，每分钟 |
| `tailscale-textfile.sh` | tailnet 节点 | timer，每分钟 |
| `hwinfo-textfile.sh` | 硬件面板里的 CPU / 硬盘型号 | timer，每小时 |

`edge-ingress-textfile.sh` 要常驻，因为它维护着一张 `nft` 计数表：

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

其余三个是一次性的，用 timer 驱动：

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

> **不要用 cron。** Debian/Ubuntu 的云镜像默认**不装 cron**（`dpkg -l cron` 显示 `un`），
> 往 `/etc/cron.d/` 丢文件是静默失效的——文件在、语法对、永远不执行。用 systemd timer。

## 验证

```bash
ls -la /var/lib/prometheus/node-exporter/        # 应该有 .prom 文件
curl -s localhost:9100/metrics | grep -c edge_   # 应该 > 0
```

然后把这台主机加进 `prometheus.yml` 的 `node` job，并把 `config.toml` 里
`[edge] instance` 设成 `<edge主机>:9100`。
