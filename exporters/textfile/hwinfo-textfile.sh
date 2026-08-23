#!/bin/bash
# 输出静态硬件信息给 node_exporter textfile collector (CPU/内存/磁盘型号)
D=/var/lib/prometheus/node-exporter; mkdir -p $D; T=$D/hwinfo.prom.$$
{
  m=$(awk -F: "/model name/{gsub(/^ +| +\$/,\"\",\$2); print \$2; exit}" /proc/cpuinfo)
  c=$(lscpu 2>/dev/null | awk -F: "/^Core\\(s\\) per socket/{gsub(/ /,\"\",\$2); print \$2}")
  s=$(lscpu 2>/dev/null | awk -F: "/^Socket\\(s\\)/{gsub(/ /,\"\",\$2); print \$2}")
  t=$(nproc)
  echo "# HELP node_cpu_model_info CPU model"
  echo "# TYPE node_cpu_model_info gauge"
  echo "node_cpu_model_info{model=\"$m\",cores=\"$((${c:-1}*${s:-1}))\",threads=\"$t\"} 1"
  echo "# HELP node_memory_total_gb Installed RAM"
  echo "node_memory_total_gb $(awk "/MemTotal/{printf \"%.0f\", \$2/1048576}" /proc/meminfo)"
  echo "# HELP node_disk_model_info Disk model"
  echo "# TYPE node_disk_model_info gauge"
  lsblk -dnP -o NAME,MODEL,SIZE,ROTA 2>/dev/null | while read -r line; do
    eval "$line"
    case "$NAME" in loop*|sr*|dm-*|zram*|"") continue;; esac
    echo "node_disk_model_info{device=\"$NAME\",model=\"${MODEL:-unknown}\",size=\"$SIZE\",kind=\"$([ "$ROTA" = 0 ] && echo SSD || echo HDD)\"} 1"
  done
} > $T 2>/dev/null && mv $T $D/hwinfo.prom
