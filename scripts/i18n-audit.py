#!/usr/bin/env python3
"""Find UI strings that have no English translation.

Two sources of translatable text:
  1. t('...') calls in the JS
  2. Chinese text nodes in the HTML (the tree-walker translates these by exact match)
Anything present there but missing from lanpulse/i18n/en.json shows up as Chinese
for English users, which is the bug this catches.
"""
import io, json, os, re, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CJK = re.compile(r'[一-鿿]')
en = json.load(io.open(os.path.join(BASE, "lanpulse/i18n/en.json"), encoding="utf-8"))
ui = en.get("ui", {})

wanted = {}          # string -> where it came from
for rel in ("lanpulse/web/js/app.js", "lanpulse/web/js/settings.js", "lanpulse/web/js/i18n.js"):
    src = io.open(os.path.join(BASE, rel), encoding="utf-8").read()
    for m in re.finditer(r"\bt\(\s*'((?:[^'\\]|\\.)*)'\s*[,)]", src):
        wanted.setdefault(m.group(1), rel)

for rel in ("lanpulse/web/index.html", "lanpulse/web/settings.html"):
    html = io.open(os.path.join(BASE, rel), encoding="utf-8").read()
    html = re.sub(r"<(script|style)[\s\S]*?</\1>", "", html)
    for m in re.finditer(r"<(\w+)[^>]*\sdata-i18n[^>]*>([\s\S]*?)</\1>", html):
        blk = " ".join(m.group(2).split())
        if blk and CJK.search(blk): wanted.setdefault(blk, rel)
    html = re.sub(r"<(\w+)[^>]*\sdata-i18n[^>]*>[\s\S]*?</\1>", "", html)
    for m in re.finditer(r">([^<>{}]+)<", html):
        txt = m.group(1).strip()
        if txt and CJK.search(txt):
            wanted.setdefault(txt, rel)

missing = {k: v for k, v in wanted.items() if CJK.search(k) and not ui.get(k)}
unused = [k for k in ui if k not in wanted]

print(f"可翻译字符串 {len(wanted)} 条 · 词条表 {len(ui)} 条")
if missing:
    print(f"\n缺翻译 {len(missing)} 条:")
    for k, v in sorted(missing.items()):
        print(f"  ✗ {k!r}  ({v.split('/')[-1]})")
else:
    print("\n✓ 无缺失")
if unused:
    print(f"\n词条表里有 {len(unused)} 条当前没被用到 (可能是事件短语或已删除的界面):")
    for k in sorted(unused)[:12]:
        print(f"    {k!r}")
sys.exit(1 if missing else 0)
