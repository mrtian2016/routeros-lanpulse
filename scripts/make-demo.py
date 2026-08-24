#!/usr/bin/env python3
"""从一个**开着脱敏**的运行实例抓一份快照, 生成 docs/demo/ 静态演示站。

    python3 scripts/make-demo.py http://192.168.1.13:9132

生成的目录是纯静态的, 直接扔到 GitHub Pages / 任意静态托管就能看到完整效果,
不需要后端、不需要 Prometheus。这样别人不用先装一堆 exporter 才知道好不好看。
"""
import json, os, shutil, sys, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, "lanpulse", "web")
OUT = os.path.join(BASE, "docs", "demo")


def get(url, path):
    with urllib.request.urlopen(url.rstrip("/") + path, timeout=30) as r:
        return json.loads(r.read().decode())


LEAK_PATTERNS = {
    "疑似公网 IP": r"\b(?!203\.0\.113\.)(?!10\.)(?!127\.)(?!192\.168\.)(?!0\.)"
                   r"(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!100\.6[4-9]\.)(?:\d{1,3}\.){3}\d{1,3}\b",
    "疑似域名": r"\b(?!example\.com)(?!fonts\.g)(?!github\.com)(?!ghcr\.io)[a-z0-9-]{3,}\.(?:cn|com|net|org|io)\b",
    "疑似真实 MAC": r"\b(?!02:00)(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b",
    "疑似密钥": r"(?i)(?:password|api[_-]?key|secret|token)\s*[:=]\s*[\'\"][^\'\"]{6,}",
}


def scan_leaks(root):
    import re
    blob = ""
    for dp, _, fs in os.walk(root):
        for f in fs:
            blob += open(os.path.join(dp, f), encoding="utf-8", errors="ignore").read()
    out = {}
    for name, pat in LEAK_PATTERNS.items():
        hits = sorted({m if isinstance(m, str) else m[0] for m in re.findall(pat, blob)})
        hits = [h for h in hits if h not in ("10.0.0.0", "0.0.0.0")]
        if hits:
            out[name] = hits
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    url = sys.argv[1]
    cfg = get(url, "/api/config.json")
    state = get(url, "/api/state.json")
    hist = get(url, "/api/history.json")
    i18n = get(url, "/api/i18n.json")     # 翻译表也要带上, 否则演示站只有中文

    if not state.get("redacted"):
        sys.exit("!! 这个实例没开脱敏 ([redact] enabled = true), 拒绝用真实数据生成演示站")

    shutil.rmtree(OUT, ignore_errors=True)
    shutil.copytree(SRC, OUT)

    fixture = (
        "// 由 scripts/make-demo.py 生成 —— 一份脱敏快照, 用于没有后端时的静态演示。\n"
        "window.__CFG__ = window.__CFG__ || %s;\n"
        "window.__I18N__ = window.__I18N__ || %s;\n"
        "window.__DEMO__ = { state: %s, history: %s };\n"
        % (json.dumps(cfg, ensure_ascii=False),
           json.dumps(i18n, ensure_ascii=False),
           json.dumps(state, ensure_ascii=False, separators=(",", ":")),
           json.dumps(hist, ensure_ascii=False, separators=(",", ":")))
    )
    os.makedirs(os.path.join(OUT, "demo"), exist_ok=True)
    with open(os.path.join(OUT, "demo", "fixture.js"), "w", encoding="utf-8") as f:
        f.write(fixture)

    # fixture 必须在页面脚本之前执行 (app.js 初始化时就要读 window.__CFG__)。
    # 设置页也要注入 —— 它同样靠 window.__I18N__ 翻译, 漏掉的话演示站的设置页
    # 会永远是中文, 而且这种漏法不会报错, 只会"看起来没翻译"。
    for page, script in (("index.html", "js/app.js"), ("settings.html", "js/settings.js")):
        path = os.path.join(OUT, page)
        html = open(path, encoding="utf-8").read()
        tag = '<script type="module" src="%s"></script>' % script
        if tag not in html:
            sys.exit("!! %s 里找不到 %s 的 script 标签, 注入失败" % (page, script))
        html = html.replace(tag, '<script src="demo/fixture.js"></script>\n' + tag, 1)
        open(path, "w", encoding="utf-8").write(html)

    # 二道保险: 光看 redacted 标记不够 —— 万一某个字段没被脱敏池覆盖到, 标记照样是 True。
    # 这里对**即将发布的文件**再扫一遍, 有嫌疑就删掉产物, 不给"以为脱敏了"的机会。
    leaks = scan_leaks(OUT)
    if leaks:
        shutil.rmtree(OUT, ignore_errors=True)
        print("!! 生成的文件里仍能搜到疑似真实标识, 已删除产物:")
        for k, v in leaks.items():
            print(f"   {k}: {v[:6]}")
        sys.exit("   请在 agent.py 的 _NAME_POOLS / _KEY_NAME_POOLS 里补上对应字段后重试")

    size = sum(os.path.getsize(os.path.join(dp, f))
               for dp, _, fs in os.walk(OUT) for f in fs)
    print(f"演示站已生成: docs/demo/  ({size / 1024:.0f} KB)")
    print(f"  设备 {len((state.get('fast') or {}).get('dev') or {})} · "
          f"事件 {len(state.get('events') or [])} · 硬件面板 {len(state.get('hw') or [])}")
    print("  本地预览: python3 -m http.server -d docs/demo 8000")


if __name__ == "__main__":
    main()
