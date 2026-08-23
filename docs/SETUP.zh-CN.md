# RouterOS 侧配置

这一页全部在**路由器上**做，在启动容器之前。大约五分钟。
跳过这步是面板打开一片空白最常见的原因。

命令针对 RouterOS 7.x，直接粘进终端（WinBox → New Terminal，或 SSH）。
把 `192.168.1.13` 换成将来跑 lanpulse 的那台机器的地址。

---

## 1. 只读账号（必需）

**不要**让 lanpulse 用 `admin`。建一个只能读、别的什么都干不了的账号：

```
/user group add name=monitor policy=read,api,rest-api,!write,!policy,!password,!sensitive,!ftp,!telnet,!ssh,!local,!web,!winbox,!sniff,!test,!reboot,!romon
/user add name=mon group=monitor address=192.168.1.13/32 password=换成一个长密码
```

`address=` 把这个账号锁死在监控机上——密码万一泄漏，从别处也用不了。
`!sensitive` 表示这个账号读不到路由器里存的其它密码。

这个密码填到 `.env` 的 `ROS_PASS`，以及 `exporters/mktxp/mktxp.conf` 里。

## 2. API 服务（必需）

mktxp 和 lanpulse 的 1 秒快车道都走 8728 的二进制 API。

```
/ip service set api disabled=no port=8728 address=192.168.1.13/32
/ip service print where name~"api"
```

第二条应该显示 `api 8728 tcp 192.168.1.13/32`，**前面没有 `X`**（X = 已禁用）。

> 想用 `api-ssl`（8729）？lanpulse 目前不支持二进制 API 上的 TLS——
> 保持用普通 `api` 并用 `address=` 限定来源，或者把两者放在同一个可信网段里。

## 3. kid-control —— 内网每设备流量必需

**内网设备流量**那张表（就是看谁在占带宽的那个）读的是 RouterOS 的 `kid-control` 计数器。
路由器上没有别的地方能提供这份数据，所以不做这步，那块面板永远是空的。

```
/ip kid-control add name=stats sun=0s-1d mon=0s-1d tue=0s-1d wed=0s-1d thu=0s-1d fri=0s-1d sat=0s-1d
```

> ⚠️ **务必用上面这种全天范围。** kid-control 本质是*家长控制*功能：如果你给它设了受限时段
> **并且把设备指派给它**，那些设备在时段外会**断网**。`0s-1d` 表示"始终允许"，
> 这样它就只统计字节、永远不拦任何东西。

设备会自动以动态条目出现。过一分钟检查：

```
/ip kid-control device print count-only
```

返回 0 说明 profile 没建成，或者还没有流量经过。

## 4. traffic-flow —— 可选，用于设备去向桑基图

只有跑 `netflow` profile 才需要。

```
/ip traffic-flow set enabled=yes interfaces=all cache-entries=64k active-flow-timeout=1m
/ip traffic-flow target add dst-address=192.168.1.13 port=2055 version=9
```

## 5. 启动容器前自查

```
/user print where name=mon
/ip service print where name~"api"
/ip kid-control device print count-only
```

期望：账号存在、`api` 已启用且限定了来源地址、设备数大于 0。

---

## 各面板分别需要什么

| 面板 | 需要 |
|---|---|
| WAN 上下行、24 小时曲线 | 第 1–2 步 |
| 流向图、WireGuard、OpenVPN、事件流 | 第 1–2 步 |
| 设备名 | 第 1–2 步 + 路由器上跑着 DHCP server |
| **内网设备流量** | **第 3 步** |
| 设备去向桑基图 | 第 4 步 + `--profile netflow` |
| 入口 / 分支隧道 / tailnet | textfile 采集器，见 [exporters/textfile](../exporters/textfile/README.md) |
| 硬件、Proxmox、NAS、无线 | 对应的可选 profile |

## 还是空的？

打开 `http://<主机>:9132` —— lanpulse 启动时会自检，并**直接在页面上**告诉你哪个数据源没通、为什么。
如果页面本身都打不开，看 `docker compose logs lanpulse` 和 `docker compose logs mktxp`；
路由器连不上会在后者里显示成 `Connection to router ... has failed`。
