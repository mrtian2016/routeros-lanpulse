#!/usr/bin/env python3
"""脱敏自检: 在脱敏后的输出里搜真实标识, 搜到就是漏了。

    python3 scripts/leakscan.py http://127.0.0.1:9132/api/state.json
    python3 scripts/leakscan.py docs/demo                      # 也可以扫目录
    python3 scripts/leakscan.py <目标> --extra "MyNAS|机房A|AA:BB:CC"

内置的是**通用**规则(公网 IP / 真实 MAC / 域名 / 密钥样式)。
你自己网络里的专有名词(主机名、设备型号、SSID)用 --extra 传进来 ——
把它们写死在脚本里既没意义, 也等于把这些名字发布出去。
"""
import json, os, re, sys, urllib.request

# 通用规则。刻意放宽: 宁可误报让人看一眼, 也别漏。
PATTERNS = {
    "公网 IP": (
        r"\b(?!203\.0\.113\.)(?!198\.51\.100\.)(?!192\.0\.2\.)"      # RFC5737 文档网段
        r"(?!0\.)(?!10\.)(?!127\.)(?!192\.168\.)(?!255\.)"
        r"(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!100\.6[4-9]\.)"          # RFC1918 / CGNAT
        r"(?:\d{1,3}\.){3}\d{1,3}\b"),
    "真实 MAC": r"\b(?!02:00)(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b",
    # 不含 .top: 它和 JS 的 style.top / offset.top 撞车, 误报比命中多得多
    "域名": r"\b(?!example\.(?:com|org|net))[a-z0-9][a-z0-9-]{2,}\.(?:cn|com|net|org|io|xyz|me)\b",
    "密钥样式": r"(?i)(?:password|passwd|api[_-]?key|secret|token|bearer)\s*[:=]\s*[\"'][^\"']{6,}",
}
# 明显不是泄漏的: 协议 OID、广播地址、以及项目自己要用到的公开服务域名
ALLOW = re.compile(r"^(?:1\.3\.6|0\.0\.0\.0|255\.255|224\.0\.0)|"
                   r"^(?:api\.day\.app|(?:api\.)?telegram\.org|github\.(?:com|io)|docs\.github\.com|"
                   r"ghcr\.io|fonts\.googleapis\.com|fonts\.gstatic\.com)$")


def read(target):
    if target.startswith(("http://", "https://")):
        with urllib.request.urlopen(target, timeout=30) as r:
            return r.read().decode("utf-8", "ignore")
    if os.path.isdir(target):
        out = []
        for dp, _, fs in os.walk(target):
            for f in fs:
                try:
                    out.append(open(os.path.join(dp, f), encoding="utf-8", errors="ignore").read())
                except OSError:
                    pass
        return "\n".join(out)
    return open(target, encoding="utf-8", errors="ignore").read()


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    blob = read(sys.argv[1])
    pats = dict(PATTERNS)
    if "--extra" in sys.argv:
        pats["自定义"] = sys.argv[sys.argv.index("--extra") + 1]

    bad = 0
    for name, pat in pats.items():
        hits = sorted({m if isinstance(m, str) else m[0] for m in re.findall(pat, blob)})
        hits = [h for h in hits if not ALLOW.match(h)]
        if hits:
            bad += 1
            print(f"  ✗ {name}: {len(hits)} 种 -> {hits[:8]}")
        else:
            print(f"  ✓ {name}")
    print("\n结论:", "未发现泄漏" if not bad else f"{bad} 类可疑, 逐条确认后再发布")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
