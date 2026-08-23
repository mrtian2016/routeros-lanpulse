# RouterOS setup

Everything on this page happens **on the router**, before you start the containers.
It takes about five minutes. Skipping it is the most common reason the dashboard comes
up empty.

Commands are for RouterOS 7.x. Paste them into a terminal (WinBox → New Terminal, or SSH).
Replace `192.168.1.13` with the address of the machine that will run lanpulse.

---

## 1. A read-only user (required)

Do **not** point lanpulse at `admin`. Make a user that can read metrics and nothing else:

```
/user group add name=monitor policy=read,api,rest-api,!write,!policy,!password,!sensitive,!ftp,!telnet,!ssh,!local,!web,!winbox,!sniff,!test,!reboot,!romon
/user add name=mon group=monitor address=192.168.1.13/32 password=PICK-SOMETHING-LONG
```

`address=` restricts the account to the monitoring host — if the password ever leaks it is
useless from anywhere else. `!sensitive` means the account cannot read stored passwords.

Put that password in `.env` as `ROS_PASS`, and in `exporters/mktxp/mktxp.conf`.

## 2. The API service (required)

Both mktxp and lanpulse's 1-second fast lane speak the binary API on port 8728.

```
/ip service set api disabled=no port=8728 address=192.168.1.13/32
/ip service print where name~"api"
```

The second line should show `api 8728 tcp 192.168.1.13/32` **without an `X`** (X = disabled).

> Using `api-ssl` (8729) instead? lanpulse does not do TLS on the binary API yet — keep
> plain `api` restricted by `address=`, or put the two on the same trusted segment.

## 3. kid-control — required for per-device traffic

The **LAN device traffic** table (the one that shows who is using the bandwidth) reads
RouterOS's `kid-control` counters. There is no equivalent data anywhere else on the router,
so without this step that panel stays empty.

```
/ip kid-control add name=stats sun=0s-1d mon=0s-1d tue=0s-1d wed=0s-1d thu=0s-1d fri=0s-1d sat=0s-1d
```

> ⚠️ **Use the full-day ranges above.** A kid-control profile is a *parental control*
> feature: if you give it restricted hours **and assign devices to it**, those devices lose
> internet access outside those hours. `0s-1d` means "always allowed", so the profile only
> ever counts bytes and never blocks anything.

Devices show up automatically as dynamic entries. Check after a minute:

```
/ip kid-control device print count-only
```

If that returns 0, the profile was not created or no traffic has passed yet.

## 4. traffic-flow — optional, for the destination sankey

Only needed if you run the `netflow` profile.

```
/ip traffic-flow set enabled=yes interfaces=all cache-entries=64k active-flow-timeout=1m
/ip traffic-flow target add dst-address=192.168.1.13 port=2055 version=9
```

## 5. Verify before starting containers

```
/user print where name=mon
/ip service print where name~"api"
/ip kid-control device print count-only
```

You want: the user exists, `api` is enabled and address-restricted, and the device count is
greater than zero.

---

## What each panel needs

| Panel | Needs |
|---|---|
| WAN throughput, 24 h history | steps 1–2 |
| Flow diagram, WireGuard, OpenVPN, event stream | steps 1–2 |
| Device names | steps 1–2 + DHCP server on the router |
| **LAN device traffic** | **step 3** |
| Destination sankey | step 4 + `--profile netflow` |
| Ingress / branch tunnels / tailnet | textfile collectors — see [exporters/textfile](../exporters/textfile/README.md) |
| Hardware, Proxmox, NAS, Wi-Fi | the matching optional profile |

## Still empty?

Open `http://<host>:9132` — lanpulse runs its own checks on startup and tells you on the
page which data source is missing and why. If the page itself will not load, look at
`docker compose logs lanpulse` and `docker compose logs mktxp`; a router that cannot be
reached shows up there as `Connection to router ... has failed`.
