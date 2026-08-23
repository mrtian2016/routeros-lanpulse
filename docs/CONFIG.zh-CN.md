# 配置详解

配置文件是 `config.toml`（从 `config.example.toml` 复制）。
**密码不在这里** —— 走 `.env` 里的环境变量，这样配置文件可以直接贴出来求助。

完整的、逐项带注释的版本就是 [`config.example.toml`](../config.example.toml) 本身；
这里只说几个容易踩的点。

## `[router]`

| 项 | 说明 |
|---|---|
| `host` | 路由器地址。用于 1 秒粒度快车道（RouterOS 二进制 API，8728） |
| `name` | **必须和 mktxp 配置里的段名一致** —— 它会变成指标上的 `routerboard_name` 标签 |
| `wan_interface` | 拨号线路是 `pppoe-out1`；静态 IP 或 DHCP 就填物理口名（如 `ether1`） |
| `lan_interface` | 网桥名，通常是 `bridge` |
| `fast_lane` | 关掉就全部走 Prometheus，粒度 = 抓取间隔，曲线会一顿一顿的 |

建议在路由器上单独建一个只读账号（`group=read`），不要用 admin。

## `[[hardware]]`

每有一台带 BMC 的机器写一段，没有就一段都不写（硬件区整块消失）。

- `bmc` 要和 `ipmi-exporter` 配置里的 target 名对上（会成为 `bmc` 标签）
- `instance` 是**同一台机器**的 node_exporter 地址
- `storage`：
  - `pve` —— 显示 PVE 存储池。**thin pool 不是文件系统，`node_filesystem_*` 看不见它**，
    只有 pve-exporter 有，所以跑 PVE 的机器要用这个
  - `fs` —— 显示本机文件系统（自动排除 tmpfs / overlay / **网络挂载**）
  - `none` —— 不显示

## `[topology.nodes]`

画布 960×520。节点是纯声明式的，`x/y/w/h/name/sub`；
`core = true` 画粗边框，`group = true` 是分组标题（不画方框）。

删掉一个节点，连到它的线会一起消失 —— 所以想简化拓扑就直接删。

## `[events]`

突发判定是「速率 > `*_floor_mbps` **且** 超过近期均值 `burst_multiplier` 倍」。

注意别给突发加"均值必须大于某个下限"这类条件：内网终端平时就是 0 Mbps，
均值贴着 0，突然拉到几百兆时反而会被这种条件挡掉 —— 这正是本项目早期踩过的坑。

## `[redact]`

见 README 的脱敏一节。`mask_hardware` 默认 `false`：
CPU / 硬盘型号不指向具体的人，而晒 homelab 截图时它往往正是想展示的部分。
要发到完全公开的地方可以打开。
