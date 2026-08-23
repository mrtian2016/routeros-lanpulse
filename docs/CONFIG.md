# Configuration reference

The config file is `config.toml`, copied from `config.example.toml`.
**Secrets are not in it** — those live in `.env` as environment variables, so you can
paste your config into an issue without redacting it first.

[`config.example.toml`](../config.example.toml) is the complete, fully commented version;
this page only covers the parts people get wrong.

Also read [SETUP.md](SETUP.md) first — most "the dashboard is empty" reports are a missing
step on the router, not a config mistake.

## `[router]`

| Key | Notes |
|---|---|
| `host` | Router address. Used by the 1-second fast lane (RouterOS binary API, 8728). |
| `name` | **Must match the section name in `mktxp.conf`** — it becomes the `routerboard_name` label on every metric. |
| `wan_interface` | `pppoe-out1` for a dial-up line; the physical port name (`ether1`, …) for static IP or DHCP. |
| `lan_interface` | Bridge name, usually `bridge`. |
| `fast_lane` | Turn it off and everything falls back to Prometheus — granularity equals your scrape interval, and the page moves in visible steps. |

Use a dedicated read-only account (`policy=read,api`), never `admin`. See
[SETUP.md](SETUP.md#1-a-read-only-user-required).

## `[[hardware]]`

One block per machine with a BMC; none at all if you have none — then the whole hardware
row disappears.

- `bmc` must match the target name in your `ipmi-exporter` config (it becomes the `bmc` label)
- `instance` is the node_exporter on the **same machine**
- `storage`:
  - `pve` — show Proxmox storage pools. **A thin pool is not a filesystem**, so
    `node_filesystem_*` cannot see it; only pve-exporter can. Use this on a hypervisor.
  - `fs` — show local filesystems (tmpfs / overlay / **network mounts** are excluded)
  - `none` — no storage row

## `[topology.nodes]`

Canvas is 960×520. Nodes are declarative: `x/y/w/h/name/sub`.
`core = true` draws a heavier border, `group = true` is a side heading with no box.

Delete a node and every link to it disappears too — so to simplify the diagram, just delete.

## `[events]`

A burst is "rate > `*_floor_mbps` **and** more than `burst_multiplier` times the recent average".

Do not add a "the average must be above X" condition to that: LAN devices sit at 0 Mbps most
of the time, so their average hugs zero, and such a condition would filter out exactly the
case you care about — an idle device suddenly pulling hundreds of megabits. This project
shipped that bug once.

## `[alerts]`

Dashboard thresholds and push thresholds are deliberately separate. `[events]` floors are
low so you can see trends; `[alerts] min_burst_mbps` and `[alerts.kinds]` decide what is
worth waking your phone for. Types switched off in `[alerts.kinds]` still appear on the
dashboard.

## `[redact]`

See the README. `mask_hardware` defaults to `false`: CPU and disk models do not point at a
person, and when people share homelab screenshots the hardware is usually the part they
want to show. Turn it on for a fully public demo.
