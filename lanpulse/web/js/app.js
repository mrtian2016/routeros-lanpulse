import { initTheme } from './theme.js';
import { initI18n, t, applyLang, lang, translateEvent as TE } from './i18n.js';

const fmtUptime = sec => {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600);
  return lang() === 'en' ? `${d}d ${h}h` : `${d}天${h}小时`;
};
const setText = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

// 配置由后端在返回页面时注入到这里 (见 agent.py 的 do_GET)
  const CFG = window.__CFG__ || {};
(async () => {
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const COLOR = { wan: css('--s-wan'), wg: css('--s-wg'), ovpn: css('--s-ovpn'), ts: css('--s-ts'), branch: css('--s-branch'), proxy: css('--s-proxy') };
  const fmt = v => (v = +v || 0) >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  const dur = s => { s = Math.max(0, s | 0); const d = s / 86400 | 0, h = s % 86400 / 3600 | 0, m = s % 3600 / 60 | 0; return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const H = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------- 数据源: 后端聚合的 Prometheus 实况 ----------
  let S = { ready: false }, HIST = { down: [], up: [] };
  // 拿不到后端时回退到演示数据 (window.__DEMO__ 由 demo/fixture.js 提供)。
  // 这样 docs/demo/ 那份可以直接扔到 GitHub Pages 上, 没有后端也能看到完整效果。
  const DEMO = () => window.__DEMO__ || null;
  // 静态演示站(GitHub Pages)根本没有后端, 没必要每秒去打一个必然 404 的请求 ——
  // 既浪费, 控制台里一片红也会让人以为坏了。
  const STATIC_DEMO = !window.__CFG_FROM_SERVER__ && !!window.__DEMO__;
  const pull = async () => {
    if (STATIC_DEMO) { S = DEMO().state; S.demo = true; return; }
    try {
      const r = await fetch('api/state.json', { cache: 'no-store' });
      if (r.ok) { S = await r.json(); return; }
      throw new Error(r.status);
    } catch (e) {
      const d = DEMO();
      if (d && d.state) { S = d.state; S.demo = true; } else { S.ready = false; }
    }
  };
  // WAN 曲线的时间档位。默认值和可选项都来自后端配置, 前端不写死。
  const HR_KEY = 'lanpulse.hist.range';
  let HIST_RANGE = localStorage.getItem(HR_KEY) || CFG.hist_default || '1h';
  const pullHist = async () => {
    if (STATIC_DEMO) { HIST = DEMO().history || HIST; return; }
    try {
      const r = await fetch('api/history.json?range=' + encodeURIComponent(HIST_RANGE), { cache: 'no-store' });
      if (r.ok) { HIST = await r.json(); return; }
      throw new Error(r.status);
    } catch (e) {
      const d = DEMO();
      if (d && d.history) HIST = d.history;
    }
  };
  await pull(); await pullHist();

  // 平滑器: 真实值 -> 视觉上的缓动 (避免 2s 轮询造成跳变)
  const sm = new Map();
  const smooth = (k, v) => { v = +v || 0; const c = sm.get(k); const n = c === undefined ? v : c + (v - c) * 0.55; sm.set(k, n); return n; };

  // ---------- 实体 (全部来自 API) ----------
  const wgPeers = (S.wg || []).map(p => ({ ...p, hist: Array(30).fill(0) }));
  const ovpnUsers = (S.ovpn || []).map(u => ({ ...u }));
  const branches = (S.branches || []).map(b => ({ ...b, hist: Array(30).fill(0) }));
  const ingLabels = [{ id: 'trojan / anytls', k: 'trojan' }, { id: 'HTTPS 32443', k: 'https' }, { id: 'WireGuard 62226', k: 'wg' }];
  const val = (o, k) => (o && +o[k]) || 0;
  const F = () => (S.fast && S.fast.ready) ? S.fast : null;                    // 1 秒粒度快车道
  const wanD = () => { const f = F(); return f ? val(f.wan, 'down') : val(S.wan, 'down'); };
  const wanU = () => { const f = F(); return f ? val(f.wan, 'up') : val(S.wan, 'up'); };

  // ---------- 拓扑 ----------
  // 拓扑节点来自 config.toml 的 [topology.nodes]; 没配就用这套默认布局
  const NODES = (CFG.topology && Object.keys(CFG.topology).length) ? CFG.topology : {
    internet: { x: 200, y: 240, w: 110, h: 48, name: 'Internet', sub: '公网 IPv4' },
    ros:      { x: 380, y: 240, w: 140, h: 56, name: 'RouterOS', sub: '192.168.1.1 · NAT / FW / WG', core: true },
    unifi:    { x: 640, y: 20,  w: 130, h: 48, name: 'UniFi AP', sub: '192.168.1.30 · 无线' },
    lan:      { x: 640, y: 100, w: 140, h: 56, name: '内网', sub: '192.168.1.0/24', core: true },
    edge:     { x: 640, y: 340, w: 150, h: 56, name: 'edge', sub: '192.168.1.11 · 入口 / 组网', core: true },
    // 组: x/y 是第一格的左上角, gap 是行距 —— 组员位置全部由此推出, 不再散落在代码里
    wgg:  { x: 30,  y: 40,  w: 96,  h: 20, gap: 26, group: true, name: 'WireGuard peers' },
    ovg:  { x: 30,  y: 430, w: 96,  h: 20, gap: 26, group: true, name: 'OpenVPN 用户' },
    lang: { x: 950, y: 40,  w: 150, h: 20, gap: 26, group: true, name: '内网 Top 设备' },
    bypg: { x: 950, y: 205, w: 150, h: 18, gap: 24, group: true, name: '走代理的终端' },
    ing:  { x: 950, y: 340, w: 120, h: 18, gap: 24, group: true, name: '入口 / 公网服务' },
    brg:  { x: 950, y: 445, w: 120, h: 18, gap: 24, group: true, name: '分支站点' },
    tsg:  { x: 950, y: 600, w: 120, h: 18, gap: 24, group: true, name: 'tailnet' },
  };
  // 组员格位。老配置里的组只有 x/y, 这里给出尺寸兜底。
  const GDEF = { wgg: [96, 20, 26], ovg: [96, 20, 26], lang: [150, 20, 26], bypg: [150, 18, 24],
                 ing: [120, 18, 24], brg: [110, 18, 24], tsg: [110, 18, 24] };
  const slot = (g, i) => {
    const n = NODES[g] || {}, d = GDEF[g] || [110, 18, 24];
    return { x: n.x || 0, y: (n.y || 0) + i * (n.gap || d[2]), w: n.w || d[0], h: n.h || d[1] };
  };
  // 旁路由节点: 分流的执行体。位置可由 [topology.nodes] 的 byp 指定, 没指定就放在内网正下方
  if (CFG.panels && CFG.panels.bypass && !NODES.byp && NODES.lan) {
    NODES.byp = { x: NODES.lan.x, y: NODES.lan.y + NODES.lan.h + 60, w: NODES.lan.w, h: 52,
                  name: (CFG.bypass && CFG.bypass.label) || '旁路由', sub: 'MosDNS + mihomo' };
  }
  const side = (n, s) => s === 'l' ? { x: n.x, y: n.y + n.h / 2 } : s === 'r' ? { x: n.x + n.w, y: n.y + n.h / 2 } : s === 't' ? { x: n.x + n.w / 2, y: n.y } : { x: n.x + n.w / 2, y: n.y + n.h };
  const svg = document.getElementById('map'), NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, parent = svg) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
  const edgesLayer = el('g'), nodesLayer = el('g');
  const tip = document.getElementById('tip');
  function showTip(ev, html) { tip.innerHTML = html; tip.style.display = 'block'; const x = ev.clientX + 14, y = ev.clientY + 14; tip.style.left = Math.min(x, innerWidth - tip.offsetWidth - 12) + 'px'; tip.style.top = Math.min(y, innerHeight - tip.offsetHeight - 12) + 'px'; }
  function hideTip() { tip.style.display = 'none'; }

  const EDGES = [];
  const addEdge = (id, d, color, rateFn, labelAt, tipFn) => {
    const bg = el('path', { d, class: 'edge-bg' }, edgesLayer);
    const p = el('path', { d, class: 'edge', stroke: color, 'stroke-width': 2, 'stroke-dasharray': '6 8' }, edgesLayer);
    const t = el('text', { x: labelAt[0], y: labelAt[1], class: 'elabel', 'text-anchor': 'middle' }, edgesLayer);
    // 可见线只有 1-6px, 空闲边基本悬停不到 —— 命中区用一条 14px 的透明副本承担
    const hit = el('path', { d, class: 'edge-hit' }, edgesLayer);
    const e = { id, p, t, bg, hit, rateFn, off: 0, color,
                // 空槽位的边要整体藏起来 (节点 opacity=0 时线还在会露马脚)
                show(on) { for (const el2 of [bg, p, hit]) el2.setAttribute('visibility', on ? 'visible' : 'hidden'); } };
    hit.addEventListener('mousemove', ev => showTip(ev, tipFn(e.last || 0)));
    hit.addEventListener('mouseleave', hideTip);
    EDGES.push(e); return e;
  };
  const CURVE = (a, b, bend = .5) => { const mx = a.x + (b.x - a.x) * bend; return `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`; };
  const s_ = (n, k) => side(NODES[n], k);
  let internetSubEl = null;
  // "2d14h58m2s" -> "2天14小时58分" (不到秒)
  const zhDur = raw => {
    if (!raw) return '';
    const g = u => { const m = new RegExp('(\\d+)' + u).exec(raw); return m ? +m[1] : 0; };
    const d = g('d'), h = g('h'), mi = g('m');
    let out = '';
    if (d) out += d + t('天');
    if (h) out += h + t('小时');
    if (mi || !out) out += mi + t('分');
    return out;
  };
  // 公网 IP 打码: 215.11.22.14 -> 215.***.***.14 ; v6 留头尾段
  const maskIp = ip => {
    if (!ip) return '';
    if (ip.indexOf('.') >= 0) { const p2 = ip.split('.'); return p2.length === 4 ? `${p2[0]}.***.***.${p2[3]}` : ip; }
    const p2 = ip.split(':').filter(Boolean); return p2.length > 2 ? `${p2[0]}:***:${p2[p2.length-1]}` : ip;
  };
  const leftOf  = b => ({ x: b.x, y: b.y + b.h / 2 });
  const rightOf = b => ({ x: b.x + b.w, y: b.y + b.h / 2 });
  const mid = (a, b, dy = -7) => [(a.x + b.x) / 2, (a.y + b.y) / 2 + dy];

  addEdge('wan', CURVE(s_('internet', 'r'), s_('ros', 'l')), COLOR.wan, () => smooth('wan', wanD() + wanU()), mid(s_('internet', 'r'), s_('ros', 'l')),
    () => `<div class="tt">Internet ↔ RouterOS (PPPoE)</div><b>↓ ${fmt(wanD())}</b> / <b>↑ ${fmt(wanU())}</b> Mbps<br><span class="d">${S.wan && S.wan.online ? '已连接' : '离线'}${S.wan && S.wan.ip ? ' · ' + S.wan.ip : ''}</span>`);
  addEdge('lan', CURVE(s_('ros', 'r'), s_('lan', 'l')), COLOR.wan, () => { const f = F(); return smooth('lan', f ? val(f.lan, 'down') + val(f.lan, 'up') : (S.lan && S.lan.devices || []).reduce((a, d) => a + d.down + d.up, 0)); }, mid(s_('ros', 'r'), s_('lan', 'l')),
    r => `<div class="tt">RouterOS ↔ 内网</div><b>${fmt(r)} Mbps</b><br><span class="d">${t('{n} 台在线 (DHCP 租约)', { n: (S.lan && S.lan.clients) || 0 })}</span>`);
  addEdge('dnat', CURVE(s_('ros', 'b'), s_('edge', 'l'), .35), COLOR.proxy, () => smooth('dnat', val(S.ingress, 'trojan') + val(S.ingress, 'https')), mid(s_('ros', 'b'), s_('edge', 'l')),
    r => `<div class="tt">RouterOS → edge (dst-nat 32443/58443/3478)</div><b>${fmt(r)} Mbps</b><br><span class="d">公网入口转发</span>`);
  if (NODES.byp) {
    addEdge('byp', CURVE(s_('lan', 'b'), s_('byp', 't'), .5), COLOR.proxy,
      () => smooth('byp', val(S.bypass, 'down') + val(S.bypass, 'up')),
      mid(s_('lan', 'b'), s_('byp', 't'), 0),
      () => {
        const b = S.bypass || {};
        if (b.stale) return `<div class="tt">${t('内网 → 旁路由 · fake-ip 分流')}</div><span class="d">${t('mihomo API 不可达')}</span>`;
        let h = `<div class="tt">${t('内网 → 旁路由 · fake-ip 分流')}</div>`
          + `<b>↓ ${fmt(b.down || 0)}</b> / <b>↑ ${fmt(b.up || 0)}</b> Mbps`
          + `<br><span class="d">${t('{n} 条连接 · 代理 {p} · 直连 {d}', { n: b.conns || 0, p: b.proxied || 0, d: b.direct || 0 })}</span>`;
        for (const sc of (b.sources || [])) h += `<br><span class="d">${H(sc.name)} · ${t('{n} 条', { n: sc.conns })} · ${fmt(sc.rate)} Mbps</span>`;
        for (const g of (b.groups || [])) h += `<br><span class="d">→ ${H(g[0])} · ${g[1]}</span>`;
        return h;
      });
  }
  addEdge('wifi', CURVE(s_('lan', 't'), s_('unifi', 'b'), .5), COLOR.ts, () => smooth('wifi', (S.wifi || []).reduce((a, w) => a + (w.down || 0) + (w.up || 0), 0)), mid(s_('lan', 't'), s_('unifi', 'b')),
    r => { const rs = S.radios || []; return `<div class="tt">内网 ↔ UniFi AP</div><b>${fmt(r)} Mbps</b><br><span class="d">${(S.wifi || []).length} 个无线客户端${rs.map(x => ` · ${x.band} 利用率 ${x.util}%`).join('')}</span>`; });

  wgPeers.forEach((p, i) => {
    p.node = slot('wgg', i);
    addEdge('wg-' + p.id, CURVE(rightOf(p.node), s_('ros', 't'), .55), COLOR.wg, () => p.online ? smooth('wg' + p.id, p.down + p.up) : 0, [0, 0],
      () => `<div class="tt">WireGuard · ${p.id}</div>${p.online ? `<b>↓ ${fmt(p.down)}</b> / <b>↑ ${fmt(p.up)}</b> Mbps<br><span class="d">${p.ip} · 握手 ${p.hs}s 前</span>` : `<span class="d">${p.ip} · 未连接</span>`}`);
  });
  ovpnUsers.forEach((u, i) => {
    u.node = slot('ovg', i);
    addEdge('ov-' + u.id, CURVE(rightOf(u.node), s_('ros', 'l'), .55), COLOR.ovpn, () => smooth('ov' + u.id, u.down + u.up), [0, 0],
      () => `<div class="tt">OpenVPN 服务端 · ${u.id}</div><b>↓ ${fmt(u.down)}</b> / <b>↑ ${fmt(u.up)}</b> Mbps`);
  });
  branches.forEach((b, i) => {
    b.node = slot('brg', i);
    addEdge('br-' + b.id, CURVE(s_('edge', 'r'), leftOf(b.node), .5), COLOR.branch, () => b.online ? smooth('br' + b.id, b.down + b.up) : 0, [0, 0],
      () => `<div class="tt">分支隧道 · ${b.id}${b.dev ? ' (' + b.dev + ')' : ''}</div>${b.online ? `<b>↓ ${fmt(b.down)}</b> / <b>↑ ${fmt(b.up)}</b> Mbps<br><span class="d">对端 ${b.peer || '?'} · ${b.net}</span>${(b.nets||[]).length ? `<br><span class="d">承载: ${b.nets.join(' ')}</span>` : ''}` : `<span class="d">${b.net} · 中断</span>`}`);
  });
  const tsNode = { id: 'tailnet', node: slot('tsg', 0), online: true };
  addEdge('ts', CURVE(s_('edge', 'b'), leftOf(tsNode.node), .5), COLOR.ts, () => 0.02, [0, 0],
    () => `<div class="tt">tailnet (headscale)</div><span class="d">${(S.tailnet && S.tailnet.online) || 0}/${(S.tailnet && S.tailnet.nodes) || 0} 在线 · edge 发布子网路由</span><br>${((S.tailnet && S.tailnet.peers) || []).map(p => `<span style="opacity:${p.online ? 1 : .4}">${p.id}</span>`).join(' · ')}`);
  ingLabels.forEach((c, i) => {
    c.node = slot('ing', i);
    addEdge('in-' + i, CURVE(s_('edge', 't'), leftOf(c.node), .6), COLOR.proxy, () => smooth('in' + i, val(S.ingress, c.k)), [0, 0],
      r => `<div class="tt">入口 · ${c.id}</div><b>${fmt(r)} Mbps</b>`);
  });

  // 内网 Top 设备。地图上原本一条粗线进"内网"就断了 —— 看得见内网在跑 150 Mbps,
  // 看不见是谁在跑。速率取 ROS kid-control 的实时值(和"内网设备流量"面板同源),
  // 不用 NetFlow: 那是 5 分钟平均, 下载刚起来时会低得离谱。
  if (!NODES.lang) {
    // 老配置里没有这个组。放在内网右边, 竖直居中对齐, 和其它组保持一列。
    const others = [...branches, ...ingLabels, tsNode].map(o => o.node);
    const right = Math.max(...others.map(b => b.x), (NODES.lan.x + NODES.lan.w + 40));
    NODES.lang = { x: right, y: NODES.lan.y + NODES.lan.h / 2 - 5 * 26 / 2,
                   w: 150, h: 20, gap: 26, group: true, name: '内网 Top 设备' };
  }
  const LAN_TOP = Array.from({ length: 5 }, (_, i) => ({ i, name: '', down: 0, up: 0, node: slot('lang', i) }));

  // 走代理的终端: 谁正在经旁路由分流, 直接画在图上 —— 每台一条边, 粗细/流速 = 它的代理速率
  let BYP_TOP = [];
  if (NODES.byp) {
    if (!NODES.bypg) {
      NODES.bypg = { x: NODES.lang.x, y: NODES.lang.y + 5 * 26 + 35, w: 150, h: 18, gap: 24,
                     group: true, name: '走代理的终端' };
    }
    BYP_TOP = Array.from({ length: 4 }, (_, i) => ({ i, name: '', down: 0, up: 0, conns: 0, node: slot('bypg', i) }));
    BYP_TOP.forEach(d => {
      d.edge = addEdge('bt-' + d.i, CURVE(s_('byp', 'r'), leftOf(d.node), .55), COLOR.proxy,
        () => d.name ? smooth('bt' + d.i, d.down + d.up) : 0, [0, 0],
        () => d.name
          ? `<div class="tt">${H(d.name)} → ${t('旁路由')}</div><b>↓ ${fmt(d.down)}</b> / <b>↑ ${fmt(d.up)}</b> Mbps<br><span class="d">${t('{n} 条连接走代理', { n: d.conns })}</span>`
          : `<span class="d">${t('暂无数据')}</span>`);
    });
  }
  LAN_TOP.forEach(d => {
    d.edge = addEdge('lt-' + d.i, CURVE(s_('lan', 'r'), leftOf(d.node), .5),
      COLOR.wan, () => d.name ? smooth('lt' + d.i, d.down + d.up) : 0, [0, 0],
      () => d.name ? `<div class="tt">${H(d.name)}</div><b>↓ ${fmt(d.down)}</b> / <b>↑ ${fmt(d.up)}</b> Mbps`
                   : `<span class="d">${t('暂无数据')}</span>`);
  });

  const drawNode = (n, cls = 'node') => {
    const g = el('g', { class: cls + (n.core ? ' core' : '') }, nodesLayer);
    el('rect', { x: n.x, y: n.y, width: n.w, height: n.h }, g);
    const t = el('text', { x: n.x + n.w / 2, y: n.y + n.h / 2 - 2, 'text-anchor': 'middle', class: 'name' }, g); t.textContent = n.name;
    if (n.sub) { const s2 = el('text', { x: n.x + n.w / 2, y: n.y + n.h / 2 + 12, 'text-anchor': 'middle', class: 'sub' }, g); s2.textContent = n.sub; g.subEl = s2; }
    return g;
  };
  const groupLabel = (x, y, text, color) => { const t = el('text', { x, y, class: 'elabel' }, nodesLayer); t.textContent = text; t.setAttribute('fill', color); };
  // 9.5px 等宽字约 5.7px 一个字符; 左边距 8, 右侧还要给状态点留 16
  const fitLabel = (s2, w) => {
    const max = Math.max(4, Math.floor((w - 24) / 5.7));
    return s2.length > max ? s2.slice(0, max - 1) + '…' : s2;
  };
  const peerNode = (p, color, label, sub) => {
    const g = el('g', { class: 'node small' }, nodesLayer);
    el('rect', { x: p.node.x, y: p.node.y, width: p.node.w, height: p.node.h, rx: 4 }, g);
    const t = el('text', { x: p.node.x + 8, y: p.node.y + p.node.h / 2 + 3, class: 'sub' }, g);
    t.textContent = fitLabel(label, p.node.w); p.labelEl = t;
    p.dot = el('circle', { cx: p.node.x + p.node.w - 9, cy: p.node.y + p.node.h / 2, r: 3.5, fill: color }, g);
    g.addEventListener('mousemove', ev => showTip(ev, sub()));
    g.addEventListener('mouseleave', hideTip);
    return g;
  };
  Object.entries(NODES).forEach(([k, n]) => {
    if (n.group) return;
    const g = drawNode(n);
    if (k === 'internet') {
      internetSubEl = g.subEl;
      g.addEventListener('mousemove', ev2 => {
        const w = (S.fast && S.fast.wan) || S.wan || {};
        const gb = b => b ? (b / 1073741824).toFixed(1) + ' GB' : '0 GB';
        showTip(ev2, `<div class="tt">${H(n.name)}</div>`
          + `<b>${H(w.ip || (S.wan && S.wan.ip) || t('未拨号'))}</b>`
          + (w.uptime ? `<br><span class="d">${t('已连接')} ${H(zhDur(w.uptime))}</span>` : '')
          + `<br><span class="d">${t('累计')} ↓ ${gb(w.rx_total)} / ↑ ${gb(w.tx_total)}</span>`);
      });
      g.addEventListener('mouseleave', hideTip);
    }
    if (k === 'ros') {
      // 路由器节点悬停: 连接跟踪实况 (分流流量走 raw notrack, 不在此数)
      g.addEventListener('mousemove', ev2 => {
        const rc = S.ros_conns || {};
        showTip(ev2, `<div class="tt">${H(n.name)}</div>`
          + `<b>${rc.total || 0}</b> ${t('条连接跟踪')} (v4 ${rc.v4 || 0} · v6 ${rc.v6 || 0})`
          + `<br><span class="d">${t('不含旁路由分流 (raw notrack)')}</span>`);
      });
      g.addEventListener('mouseleave', hideTip);
    }
  });
  // 组标签贴着该组第一个节点的上沿, 而不是取组节点自己的 y。两者对不上时标签会被
  // 节点盖住 —— "分支站点" 以前就只露出一个 "分" 字。顺带: 空组不再画孤零零的标签。
  const groupTag = (g, boxes, text, color) => {
    const first = boxes[0]; if (!first) return;
    groupLabel(NODES[g] ? NODES[g].x : first.x, first.y - 6, text, color);
  };
  groupTag('wgg', wgPeers.map(p => p.node), 'WireGuard peers', COLOR.wg);
  groupTag('ovg', ovpnUsers.map(u => u.node), 'OpenVPN 用户', COLOR.ovpn);
  groupTag('brg', branches.map(b => b.node), '分支站点', COLOR.branch);
  groupTag('tsg', [tsNode.node], 'tailnet', COLOR.ts);
  groupTag('ing', ingLabels.map(c => c.node), '入口 / 公网服务', COLOR.proxy);
  groupTag('lang', LAN_TOP.map(d => d.node), '内网 Top 设备', COLOR.wan);
  groupTag('bypg', BYP_TOP.map(d => d.node), '走代理的终端', COLOR.proxy);
  wgPeers.forEach(p => peerNode(p, COLOR.wg, p.id, () => `<div class="tt">${p.id}</div><span class="d">${p.ip} · ${p.online ? '在线' : '离线'}</span>`));
  ovpnUsers.forEach(u => peerNode(u, COLOR.ovpn, u.id, () => `<div class="tt">${u.id}</div><span class="d">OpenVPN 服务端用户</span>`));
  branches.forEach(b => peerNode(b, COLOR.branch, b.id + ' ' + (b.net || ''), () => `<div class="tt">${b.id}</div><span class="d">${b.net}</span>`));
  LAN_TOP.forEach(d => {
    const g = el('g', { class: 'node small' }, nodesLayer), n = d.node;
    el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 4 }, g);
    d.nameEl = el('text', { x: n.x + 8, y: n.y + n.h / 2 + 3, class: 'sub' }, g);
    d.rateEl = el('text', { x: n.x + n.w - 8, y: n.y + n.h / 2 + 3, class: 'sub', 'text-anchor': 'end' }, g);
    d.g = g;
    g.addEventListener('mousemove', ev => d.name && showTip(ev,
      `<div class="tt">${H(d.name)}</div><b>↓ ${fmt(d.down)}</b> / <b>↑ ${fmt(d.up)}</b> Mbps`));
    g.addEventListener('mouseleave', hideTip);
  });
  BYP_TOP.forEach(d => {
    const g = el('g', { class: 'node small' }, nodesLayer), n = d.node;
    el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 4 }, g);
    d.nameEl = el('text', { x: n.x + 8, y: n.y + n.h / 2 + 3, class: 'sub' }, g);
    d.rateEl = el('text', { x: n.x + n.w - 8, y: n.y + n.h / 2 + 3, class: 'sub', 'text-anchor': 'end' }, g);
    d.g = g;
    g.addEventListener('mousemove', ev => d.name && showTip(ev,
      `<div class="tt">${H(d.name)} → ${t('旁路由')}</div><b>↓ ${fmt(d.down)}</b> / <b>↑ ${fmt(d.up)}</b> Mbps<br><span class="d">${t('{n} 条连接走代理', { n: d.conns })}${d.exitNode ? ' · ' + H(d.exitNode) : ''}</span>`));
    g.addEventListener('mouseleave', hideTip);
  });
  peerNode(tsNode, COLOR.ts, t('tailnet 节点'), () => `<div class="tt">tailnet</div><span class="d">${t('{n}/{m} 在线', { n: (S.tailnet && S.tailnet.online) || 0, m: (S.tailnet && S.tailnet.nodes) || 0 })}</span>`);
  ingLabels.forEach(c => peerNode(c, COLOR.proxy, c.id, () => {
    const rows = (S.ingress_detail || []).filter(r =>
      c.k === 'trojan' ? (r.type === 'trojan' || r.type === 'anytls') : (c.k === 'https' ? r.type === 'http' : false));
    let h = `<div class="tt">入口 · ${H(c.label || c.id)}</div><b>${fmt(val(S.ingress, c.k))} Mbps</b>`;
    if (rows.length) h += '<br>' + rows.map(r =>
      `<span class="d">${H(r.type)} :${H(r.port)} · ${r.conns} 连接 · ↓${fmt(r.rx)} / ↑${fmt(r.tx)} Mbps</span>`).join('<br>');
    return h;
  }));

  // viewBox 按实际画出来的东西算。写死 980x560 的话, peer 一多就被切,
  // 换个 topology 更是直接跑出画布。
  (() => {
    const boxes = [...Object.values(NODES).filter(n => !n.group).map(n => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
                   ...wgPeers.map(p => p.node), ...ovpnUsers.map(u => u.node),
                   ...branches.map(b => b.node), ...ingLabels.map(c => c.node),
                   tsNode.node, ...LAN_TOP.map(d => d.node), ...BYP_TOP.map(d => d.node)];
    const maxX = Math.max(...boxes.map(b => b.x + b.w)), maxY = Math.max(...boxes.map(b => b.y + b.h));
    svg.setAttribute('viewBox', `0 0 ${Math.ceil(maxX + 30)} ${Math.ceil(maxY + 30)}`);
  })();

  // ---------- 事件流 ----------
  const feed = document.getElementById('feed');
  let lastEvKey = '';
  // 数据源自检。只列没通过的项 —— 全绿时这块完全不出现, 不占地方。
  const REPO = 'https://github.com/mrtian2016/routeros-lanpulse/blob/main/';
  let healthCollapsed = localStorage.getItem('lanpulse.health.collapsed') === '1';
  function renderHealth() {
    const box = document.getElementById('health');
    if (!box) return;
    const bad = (S.health || []).filter(h => !h.ok);
    box.classList.toggle('hide', bad.length === 0);
    if (!bad.length) return;
    const list = healthCollapsed ? '' : `<ul>${bad.map(h => `<li>
        <span class="lbl">${H(TE(h.label))}</span>
        <span class="hint">${H(TE(h.hint))}${h.doc ? ` · <a href="${REPO}${H(h.doc)}" target="_blank" rel="noreferrer">${t('查看文档')}</a>` : ''}</span>
      </li>`).join('')}</ul>`;
    box.innerHTML = `<h3>⚠ ${t('{n} 项数据源没通', { n: bad.length })}
        <button id="health-toggle">${healthCollapsed ? t('展开') : t('收起')}</button></h3>${list}`;
    document.getElementById('health-toggle').onclick = () => {
      healthCollapsed = !healthCollapsed;
      localStorage.setItem('lanpulse.health.collapsed', healthCollapsed ? '1' : '0');
      renderHealth();
    };
  }

  function renderFeed() {
    const evs = S.events || [];
    const key = evs.map(e => e.t + e.text).join('|');
    if (key === lastEvKey) return; lastEvKey = key;
    const EK = { wan: COLOR.wan, wg: COLOR.wg, ovpn: COLOR.ovpn, branch: COLOR.branch, ts: COLOR.ts,
                 ingress: COLOR.proxy, wifi: 'var(--s-ts)', lan: 'var(--text-secondary)', vm: 'var(--s-wan)',
                 burst: 'var(--warn)', hw: 'var(--bad)' };
    const LV = { warn: 'var(--warn)', bad: 'var(--bad)' };
    feed.innerHTML = evs.length ? evs.map(e => `<li><span class="t">${e.t}</span><span class="c" style="background:${LV[e.level] || EK[e.kind] || 'var(--text-muted)'}"></span><span class="m">${H(e.text)}</span></li>`).join('')
      : `<li><span class="t">--:--:--</span><span class="c" style="background:var(--good)"></span><span class="m">监控已启动，等待状态变化事件</span></li>`;
  }

  // ---------- 表格 ----------
  // 内网设备表排序状态: k=排序字段, d=方向(1 升 / -1 降)
  const topSort = { k: 'rate', d: -1 };
  const fmtB = b => { b = +b || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(i >= 2 ? 2 : 0) + ' ' + u[i]; };
  // 紧凑版: .kv 的值列是 auto 宽度, 值写太长会把 1fr 的标签列挤成省略号
  const fmtB1 = b => { b = +b || 0; const u = ['B', 'K', 'M', 'G', 'T']; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (b >= 100 ? b.toFixed(0) : b.toFixed(1)) + u[i]; };
  const useRow = (label, o2) => kvRow(label, `${fmtB1(o2.used)}/${fmtB1(o2.total)} · ${Math.round(o2.pct)}%`,
                                      o2.pct, tcolor(o2.pct, 75, 90));
  document.querySelectorAll('#top-table th.s').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.k;
    // 点同一列翻转方向; 换列时数值默认降序、名字默认升序
    if (topSort.k === k) topSort.d = -topSort.d; else { topSort.k = k; topSort.d = k === 'name' ? 1 : -1; }
    renderTables();   // renderTables 无缓存, 直接重画即可
  }));

  const spark = (arr, color) => { const max = Math.max(0.01, ...arr); const d = arr.map((v, i) => `${i ? 'L' : 'M'}${(i / (arr.length - 1) * 100).toFixed(1)},${(19 - v / max * 17).toFixed(1)}`).join(' '); return `<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none"><path d="${d}" stroke="${color}"/></svg>`; };
  function renderTables() {
    document.querySelector('#wg-table tbody').innerHTML = wgPeers.map(p => `<tr class="${p.online ? '' : 'off'}"><td>${H(p.id)}</td><td><span class="dot" style="background:${p.online ? 'var(--good)' : 'var(--text-dim)'}"></span>${p.online ? '在线' : '离线'}</td><td>${p.hs ? p.hs + 's' : '—'}</td><td>${fmt(p.down)}</td><td>${fmt(p.up)}</td><td>${spark(p.hist, COLOR.wg)}</td></tr>`).join('');
    document.querySelector('#br-table tbody').innerHTML = branches.map(b => `<tr class="${b.online ? '' : 'off'}"><td>${H(b.id)}</td><td><span class="dot" style="background:${b.online ? 'var(--good)' : 'var(--bad)'}"></span>${b.online ? '在线' : '中断'}</td><td class="d">${H(b.net)}${(b.nets && b.nets.length) ? ` +${b.nets.length}` : ''}</td><td>${fmt(b.down)}</td><td>${fmt(b.up)}</td><td>${spark(b.hist, COLOR.branch)}</td></tr>`).join('');
    const ff = F();
    let devs = (S.lan && S.lan.devices) || [];
    if (ff && ff.dev) {
      const byName = {}; devs.forEach(d => byName[d.name] = d);
      devs = Object.entries(ff.dev).map(([n, v]) => ({
        name: (byName[n] && byName[n].name) || n,
        ip: ((v.ip || (byName[n] && byName[n].ip) || '').split(',').find(x => /^\d+\.\d+\.\d+\.\d+$/.test(x.trim())) || '').trim(),
        down: v.down, up: v.up, rxb: +v.rxb || 0, txb: +v.txb || 0
      })).filter(d => d.rxb || d.txb || d.down || d.up);
    }
    const sk = topSort.k, sd = topSort.d;
    devs.sort((a, b) => {
      const va = sk === 'rate' ? a.down + a.up : sk === 'name' ? a.name : a[sk] || 0;
      const vb = sk === 'rate' ? b.down + b.up : sk === 'name' ? b.name : b[sk] || 0;
      return (typeof va === 'string' ? va.localeCompare(vb, 'zh') : va - vb) * sd;
    });
    document.querySelectorAll('#top-table th.s').forEach(th => {
      const on = th.dataset.k === sk; th.classList.toggle('on', on);
      th.querySelector('.ar').textContent = on ? (sd < 0 ? '▼' : '▲') : '↕';
    });
    const up = (S.ros_uptime || 0);
    document.getElementById('top-hint').textContent = up
      ? `${t('来自 ROS kid-control')} · ${t('累计自路由器启动')} ${fmtUptime(up)}`
      : t('来自 ROS kid-control');
    document.querySelector('#top-table tbody').innerHTML = devs.length ? devs.map(d =>
      `<tr><td title="${H(d.name)}${d.ip ? ' · ' + H(d.ip) : ''}">${H(d.name)}` +
      `${d.ip ? `<span class="ipl">${H(d.ip)}</span>` : ''}</td>` +
      `<td class="num d">${fmt(d.down)} / ${fmt(d.up)}</td>` +
      `<td class="num">${fmtB(d.rxb)}</td><td class="num">${fmtB(d.txb)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="d">等待 kid-control 统计…</td></tr>';
  }

  // ---------- 硬件 / NAS / VM / 无线 ----------
  const tcolor = (v, warn, bad) => v >= bad ? 'var(--bad)' : v >= warn ? 'var(--warn)' : 'var(--good)';
  const tempTag = (e, v, warn, bad) => { e.className = 'tag ' + (v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok'); e.textContent = v >= bad ? '过热' : v >= warn ? '偏高' : '正常'; };
  const kvRow = (k, v, pct, color) => `<span class="k">${k}</span><span class="v">${v}</span><span class="g"><i style="width:${Math.max(2, Math.min(100, pct))}%;background:${color}"></i></span>`;
  const rssiBar = r => { const pct = Math.max(0, Math.min(100, (r + 90) * 1.8)); const c = r > -60 ? 'var(--good)' : r > -70 ? 'var(--warn)' : 'var(--bad)'; return `<span class="rssi"><i style="width:${pct}%;background:${c}"></i></span> ${r} dBm`; };

  // 硬件面板按 [[hardware]] 生成 —— 0 台就整块不出现, n 台就 n 块, 不再写死两台。
  function renderHW() {
    const hws = S.hw || [], host = document.getElementById('hw-panels');
    if (!host) return;
    if (host.childElementCount !== hws.length) {
      host.innerHTML = hws.map(h => `<div class="panel">
        <h2>${H(h.title || h.key)} <span class="hint">${H(h.hint || '')}</span></h2>
        <div class="hero"><span class="n">--</span><span class="u">°C CPU</span><span class="tag ok">正常</span></div>
        <div class="kv"></div><div class="cores"></div><ul class="sel"></ul></div>`).join('');
    }
    hws.forEach((h, i) => {
      const p = host.children[i]; if (!p) return;
      p.querySelector('.hero .n').textContent = (h.cpu || 0).toFixed(0);
      tempTag(p.querySelector('.hero .tag'), h.cpu || 0, 80, 90);
      const hi = h.info || {}, hc = hi.cpu || {};
      const rows = [kvRow(hc.model || 'CPU',
        (hc.cores ? t('{n} 核', { n: hc.cores }) + ' ' : '') + t('{n} 线程', { n: hc.threads || '?' }) + ` · ${(hi.ram || 0).toFixed(0)}G`,
        100, 'var(--text-muted)')];
      (hi.disks || []).slice(0, 5).forEach(d => rows.push(kvRow(d.model, `${d.size} ${d.kind}`, 100, 'var(--text-muted)')));
      (h.storage || []).forEach(x => rows.push(useRow(`${t('存储')} ${x.name}`, x)));
      (h.fs || []).forEach(x => rows.push(useRow(`${t('磁盘')} ${x.name}`, x)));
      if (h.sys) rows.push(kvRow('System', h.sys.toFixed(0) + ' °C', h.sys, tcolor(h.sys, 60, 70)));
      if (h.periph) rows.push(kvRow('Peripheral', h.periph.toFixed(0) + ' °C', h.periph, tcolor(h.periph, 70, 80)));
      if (h.dimm) rows.push(kvRow('DIMM A1', h.dimm.toFixed(0) + ' °C', h.dimm, tcolor(h.dimm, 75, 85)));
      if (h.nvme !== undefined) {
        rows.push(kvRow('NVMe 温度', (h.nvme || 0).toFixed(0) + ' °C', h.nvme, tcolor(h.nvme, 70, 80)));
        rows.push(kvRow(t('NVMe 寿命已用') + (h.nvme_hours ? ' · ' + t('通电 {n} 年', { n: (h.nvme_hours / 8760).toFixed(1) }) : ''),
          (h.nvme_pct || 0).toFixed(0) + '%', h.nvme_pct, tcolor(h.nvme_pct || 0, 60, 85)));
      }
      if (h.load !== undefined) rows.push(kvRow('宿主机 load1', (h.load || 0).toFixed(2), (h.load || 0) * 12, 'var(--good)'));
      (h.fans || []).filter(f => f.rpm > 0 || f.name).forEach(f => rows.push(
        kvRow(f.name, f.rpm > 0 ? f.rpm.toFixed(0) + ' RPM' : '未接', (f.rpm || 0) / 60,
              f.rpm > 0 ? 'var(--good)' : 'var(--text-muted)')));
      p.querySelector('.kv').innerHTML = rows.join('');
      // 虚拟机 CPU 条只画在跑 PVE 的那台上 (配置里 storage = "pve")
      p.querySelector('.cores').innerHTML = (h.storage && (S.vms || []).length)
        ? (S.vms || []).filter(v => v.on).map(v =>
            `<div class="core">${H(v.name)}<b style="background:${tcolor(v.cpu, 60, 85)};width:${Math.min(100, v.cpu)}%"></b><i>${v.cpu}%</i></div>`).join('')
        : '';
      p.querySelector('.sel').innerHTML = h.bmc
        ? `<li><span class="t">BMC</span><span>${H(h.bmc)} · ${t('ipmi 采集正常')}</span></li>` : '';
    });
  }

  // 虚拟机列表。**单独成函数** —— 它原先和硬件面板挤在同一个 renderHW 里,
  // 改成按配置生成硬件面板时整块被替换, 这张表就悄悄没了(线上切换后才发现)。
  function renderVMs() {
    const tb = document.querySelector('#vm-table tbody');
    if (!tb) return;
    const vms = S.vms || [];
    tb.innerHTML = vms.length ? vms.map(v => `<tr class="${v.on ? '' : 'off'}">
        <td>${H(v.id)} ${H(v.name)}</td>
        <td><span class="dot" style="background:${v.on ? 'var(--good)' : 'var(--text-dim)'}"></span>${v.on ? '运行' : '停机'}</td>
        <td class="num">${v.on ? v.cpu + '%' : '—'}</td>
        <td>${v.on ? v.mem + ' / ' + v.memmax + ' G' : '—'}</td>
        <td class="d">${H(v.ip || '')}</td></tr>`).join('')
      : '<tr><td colspan="5" class="d">等待 pve-exporter 数据…</td></tr>';
    const on = vms.filter(v => v.on);
    const used = on.reduce((a, v) => a + (v.mem || 0), 0);
    const total = CFG.pve_mem_total || 32;     // 分母来自配置, 不写死
    const kv = document.getElementById('pve-kv');
    if (kv) kv.innerHTML = [
      kvRow(t('VM 已用内存'), `${used.toFixed(1)} / ${total} G`, used / total * 100, 'var(--s-wan)'),
      kvRow(t('运行中 VM'), `${on.length} / ${vms.length}`, vms.length ? on.length / vms.length * 100 : 0, 'var(--good)'),
    ].join('');
  }

  function renderNAS() {
    const n = S.nas || {}, disks = n.disks || [];
    const bad = (n.raid || []).filter(r => !r.ok).length;
    document.getElementById('nas-vol').textContent = (n.temp || 0).toFixed(0);
    tempTag(document.getElementById('nas-tag'), bad ? 99 : (n.temp || 0), 60, 70);
    document.getElementById('nas-kv').innerHTML = [
      kvRow(t('系统温度'), (n.temp || 0).toFixed(0) + ' °C', n.temp, tcolor(n.temp, 55, 65)),
      ...(n.model ? [kvRow('型号', n.model, 100, 'var(--text-muted)')] : []),
      ...(n.raid || []).map(r => kvRow(r.name, r.ok ? '正常' : '异常', 100, r.ok ? 'var(--good)' : 'var(--bad)')),
    ].join('');
    document.getElementById('nas-disks').innerHTML = disks.map(d => `<li><span class="t">${d.name}</span><span style="color:${tcolor(d.t, 45, 50)}">${d.t.toFixed(0)} °C</span></li>`).join('');
  }
  function renderOvpn() {
    const f = F(), ss = (f && f.ovpn_sessions) || [];
    const hint = document.getElementById('ov-hint');
    const port = S.ovpn_port ? ' :' + S.ovpn_port : '';    // 端口来自 ROS, 不写死
    if (hint) hint.textContent = t('服务端') + port + ' · ' + t('{n} 个会话 · 一对端一账号', { n: ss.length });
    // 速率按用户名对到 <ovpn-用户名> 这个 ROS 动态接口上。
    // 这一列以前渲染的是加密方式(表头却写着 ↓/↑ Mbps) —— 速率根本没接。
    const rateOf = user => {
      const d = ((f && f.ifaces) || {})[`<ovpn-${user}>`];
      if (d) return `${fmt(d.down)} / ${fmt(d.up)}`;
      const o = (S.ovpn || []).find(x => x.id === user);
      return o ? `${fmt(o.down)} / ${fmt(o.up)}` : '—';
    };
    document.querySelector('#ov-table tbody').innerHTML = ss.length
      ? ss.map(x => `<tr title="${H([x.note, x.enc].filter(Boolean).join(' · '))}">
          <td>${H(x.user)}</td><td class="d">${H(x.caller)}</td><td>${H(x.ip)}</td>
          <td>${H(x.uptime)}</td><td class="num">${rateOf(x.user)}</td></tr>`).join('')
      : `<tr><td colspan="5" class="d">${t('当前无拨入会话')}</td></tr>`;
  }

  function renderTailnet() {
    const tn = S.tailnet || {}, ps = tn.peers || [];
    const hint = document.getElementById('ts-hint');
    if (hint) hint.textContent = 'headscale · ' + t('{n}/{m} 在线', { n: tn.online || 0, m: tn.nodes || 0 });
    const dup = {}; ps.forEach(p => dup[p.id] = (dup[p.id] || 0) + 1);
    document.querySelector('#ts-table tbody').innerHTML = ps.length ? ps.map(p => {
      const name = H(p.id) + (dup[p.id] > 1 && p.ip ? ` <span class="d">(${H(p.ip.split('.').pop())})</span>` : '');
      return `<tr class="${p.online ? '' : 'off'}"><td>${name}</td><td><span class="dot" style="background:${p.online ? 'var(--good)' : 'var(--text-dim)'}"></span>${p.online ? '在线' : '离线'}</td><td class="d">${H(p.ip || '')}</td><td class="d">${H(p.os || '')}</td></tr>`;
    }).join('') : '<tr><td colspan="4" class="d">等待 tailscale 指标…</td></tr>';
  }

  function renderWifi() {
    // 直接按 id 写, 不再用 closest() 摸索父容器 —— 这样"哪个元素由谁填充"是可审计的
    const ap = (S.ap || [])[0];
    if (ap) {
      setText('wifi-title', `${t('无线接入')} · ${ap.model}`);
      setText('wifi-hint', `${ap.ip} · fw ${ap.fw}`);
    }
    const w = S.wifi || [], r24 = (S.radios || []).find(x => x.band === '2.4G') || {}, r5 = (S.radios || []).find(x => x.band === '5G') || {};
    const uw = document.querySelector('#wifi-table').closest('.panel').querySelector('.util');
    const bar = (r, color) => r ? `<div><div class="lbl"><span>${r.band} · ch ${r.ch} · <b>${r.clients || 0}</b> ${t('台')}</span><span>${r.util}%</span></div><div class="g"><i style="width:${Math.max(2, Math.min(100, r.util))}%;background:${color}"></i></div></div>` : '';
    if (uw) uw.innerHTML = bar(r24, 'var(--s-ovpn)') + bar(r5, 'var(--s-wan)');
    document.querySelector('#wifi-table tbody').innerHTML = w.map(x => `<tr><td>${H(x.name)}</td><td>${x.band || '—'}</td><td>${rssiBar(x.rssi || -99)}</td><td>${fmt(x.down)}</td><td>${fmt(x.up)}</td><td class="d">${x.sat != null ? x.sat + '%' : '—'}</td></tr>`).join('');
  }

  // ---------- 24h 曲线 ----------
  const hist = document.getElementById('hist');
  const RANGE_LABEL = { '30m': '30 分钟', '1h': '1 小时', '12h': '12 小时' };
  function buildRangeButtons() {
    const box = document.getElementById('hist-range');
    if (!box) return;
    const rs = CFG.hist_ranges || [{ k: '1h', step: 30 }];
    box.innerHTML = rs.map(r =>
      `<button data-k="${r.k}" class="${r.k === HIST_RANGE ? 'on' : ''}">${RANGE_LABEL[r.k] || r.k}</button>`).join('');
    box.querySelectorAll('button').forEach(b => b.onclick = async () => {
      HIST_RANGE = b.dataset.k;
      localStorage.setItem(HR_KEY, HIST_RANGE);
      box.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.k === HIST_RANGE));
      await pullHist(); drawHist(); applyLang();
    });
  }

  // 后端给的是 PromQL 的 rate 窗口写法 ("30s"/"1m"/"5m"), 翻成读得懂的均值说明。
  function winLabel(w) {
    const m = /^(\d+)([smh])$/.exec(w || '');
    if (!m) return '';
    const n = +m[1];
    return m[2] === 's' ? t('{n} 秒均值', { n }) : m[2] === 'h' ? t('{n} 小时均值', { n }) : t('{n} 分钟均值', { n });
  }

  function drawHist() {
    const rs = (CFG.hist_ranges || []).find(r => r.k === HIST_RANGE);
    const hint = document.getElementById('hist-hint');
    if (hint && rs) hint.textContent =
      (rs.step < 60 ? t('{n} 秒粒度', { n: rs.step }) : t('{n} 分钟粒度', { n: rs.step / 60 }))
      + ` · ${t('悬停看数值')}`;
    hist.innerHTML = '';
    // viewBox 必须等于元素的真实像素尺寸。之前写死 viewBox="0 0 1200 170" 配
    // preserveAspectRatio="none", 容器一旦不是 1200 宽, 整幅图 —— 连同坐标轴上的
    // 文字 —— 就被非等比拉伸。让 1 用户单位 = 1 CSS px 就没有缩放可言了。
    const W = Math.max(320, Math.round(hist.clientWidth || 1200));
    const Hh = Math.max(120, Math.round(hist.clientHeight || 170));
    hist.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    const L = 34, R = 8, T = 10, B = 22;
    const pts = HIST.down || [];
    if (!pts.length) {
      const t0 = el('text', { x: W / 2, y: Hh / 2, 'text-anchor': 'middle', class: 'sub' }, hist);
      t0.textContent = t('暂无 24 小时数据'); return;
    }
    const ups = HIST.up || [];
    const max = Math.max(1, ...pts.map(p => p[1]), ...ups.map(p => p[1]));
    const x = i => L + i / Math.max(1, pts.length - 1) * (W - L - R);
    const y = v => T + (1 - v / max) * (Hh - T - B);
    const g = el('g', { class: 'grid' }, hist);
    [0, .25, .5, .75, 1].forEach(f => el('line', { x1: L, x2: W - R, y1: y(max * f), y2: y(max * f) }, g));
    const ax = el('g', { class: 'axis' }, hist);
    [0, .5, 1].forEach(f => { const t1 = el('text', { x: 4, y: y(max * f) + 3 }, ax); t1.textContent = (max * f).toFixed(0); });
    const step = Math.ceil(pts.length / Math.max(4, Math.min(12, Math.floor(W / 110))));
    pts.forEach((p, i) => {
      if (i % step) return;
      const t2 = el('text', { x: x(i), y: Hh - 6, 'text-anchor': 'middle' }, ax);
      t2.textContent = new Date(p[0] * 1000).toTimeString().slice(0, 5);
    });
    const line = (arr, color) => {
      if (!arr || !arr.length) return;
      const d = arr.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p[1])}`).join(' ');
      el('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.6 }, hist);
    };
    line(pts, COLOR.wan); line(ups, COLOR.proxy);

    // ---- 悬浮读数: 十字准线 + 两条曲线上的点 + 提示框 ----
    const cross = el('line', { y1: T, y2: Hh - B, stroke: 'var(--text-muted)', 'stroke-width': 1,
                              'stroke-dasharray': '3 3', opacity: 0 }, hist);
    const dotD = el('circle', { r: 3, fill: COLOR.wan, opacity: 0 }, hist);
    const dotU = el('circle', { r: 3, fill: COLOR.proxy, opacity: 0 }, hist);
    const hit = el('rect', { x: L, y: T, width: Math.max(0, W - L - R), height: Math.max(0, Hh - T - B),
                            fill: 'transparent' }, hist);
    const show = (on, i, ev) => {
      [cross, dotD, dotU].forEach(e => e.setAttribute('opacity', on ? 1 : 0));
      if (!on) return hideTip();
      const px = x(i);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px);
      dotD.setAttribute('cx', px); dotD.setAttribute('cy', y(pts[i][1]));
      const u = ups[i];
      if (u) { dotU.setAttribute('cx', px); dotU.setAttribute('cy', y(u[1])); }
      else dotU.setAttribute('opacity', 0);
      const ts = new Date(pts[i][0] * 1000);
      showTip(ev, `<div class="tt">${ts.toLocaleString()}</div>`
        + `<b>↓ ${fmt(pts[i][1])}</b> / <b>↑ ${fmt(u ? u[1] : 0)}</b> Mbps`
        + `<br><span class="d">${winLabel(HIST.win || (rs && rs.win))}</span>`);
    };
    hit.addEventListener('mousemove', ev => {
      // 用 SVG 自己的坐标反算, 别用像素 —— 元素宽度和 viewBox 宽度不是一回事
      const r = hist.getBoundingClientRect();
      const ux = (ev.clientX - r.left) / r.width * W;
      const i = Math.max(0, Math.min(pts.length - 1,
        Math.round((ux - L) / Math.max(1, W - L - R) * (pts.length - 1))));
      show(true, i, ev);
    });
    hit.addEventListener('mouseleave', () => show(false));
  }

  // ---------- 设备去向 (NetFlow 实时) ----------
  const skWrap = document.getElementById('sankey');
  function renderSankey() {
    const f = S.flows;
    skWrap.innerHTML = '';
    if (!f || !f.sources.length) { const tx = el('text', { x: 300, y: 120, class: 'sub' }, skWrap);
      tx.textContent = t(f ? '窗口内暂无流量样本…' : 'NetFlow 收集器未就绪'); return; }
    // viewBox 跟随元素真实像素尺寸 (1 用户单位 = 1 CSS px), 宽面板下标签有地方展开
    const W = Math.max(320, Math.round(skWrap.clientWidth || 560));
    const Hh = Math.max(180, Math.round(skWrap.clientHeight || 300));
    skWrap.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    const pad = 14, MINH = 8, narrow = innerWidth < 640,
          lab = narrow ? 70 : Math.min(200, Math.round(W * 0.24)),
          L = lab, R = Math.max(lab + 60, W - lab - 6),
          cut = narrow ? 9 : Math.max(12, Math.floor((lab - 46) / 6.5));
    // 接近零的长尾分类各占一行只会挤出一堆 0.00 —— 收拢成"其余"
    const squash = (rows, key, othersLabel) => {
      const keep = rows.filter((x, i) => i < 6 && x.v >= 0.01);
      const rest = rows.filter(x => !keep.includes(x));
      if (rest.length < 2) return { rows: rows.slice(0, 8), remap: {} };
      const remap = {};
      rest.forEach(x => remap[x.id] = '__' + key);
      keep.push({ id: '__' + key, label: othersLabel(rest.length), v: rest.reduce((a, x) => a + x.v, 0) });
      return { rows: keep, remap };
    };
    const sq_s = squash(f.sources, 'os', n2 => t('其余 {n} 台', { n: n2 }));
    const sq_d = squash(f.dests.filter(d => f.links.some(l => l.dst === d.id)), 'od', () => t('其余'));
    const srcs = sq_s.rows, dsts = sq_d.rows;
    // 链接按收拢后的端点重新聚合
    const lagg = {};
    f.links.forEach(l => {
      const a2 = sq_s.remap[l.src] || l.src, b2 = sq_d.remap[l.dst] || l.dst;
      lagg[a2 + '\u0000' + b2] = (lagg[a2 + '\u0000' + b2] || 0) + l.v;
    });
    const links = Object.entries(lagg).map(([k, v]) => { const [src, dst] = k.split('\u0000'); return { src, dst, v }; });
    const sTot = srcs.reduce((a, x) => a + x.v, 0) || 1, dTot = dsts.reduce((a, x) => a + x.v, 0) || 1;
    // 节点之间还有 GAP 的间隔, 分配高度时必须扣掉 —— 原来没扣, 5 个节点起总高就
    // 超出 viewBox(8 个溢出 14px), 上下被切掉。节点很多时 MINH 也要让步,
    // 否则 avail 变负数, 条形高度算出来是负的。
    const GAP = 4;
    const fit = (n, tot) => {
      const minh = Math.max(2, Math.min(MINH, (Hh - pad * 2 - GAP * Math.max(0, n - 1)) / Math.max(1, n)));
      const avail = Hh - pad * 2 - minh * n - GAP * Math.max(0, n - 1);
      return { minh, scale: Math.max(0, avail) / tot };
    };
    const sf = fit(srcs.length, sTot), df = fit(dsts.length, dTot);
    const sScale = sf.scale, dScale = df.scale;
    let y = pad; const sp = {}; srcs.forEach(x => { const h = sf.minh + x.v * sScale; sp[x.id] = { y, h, off: 0 }; y += h + GAP; });
    y = pad; const dp = {}; const palette = [COLOR.wan, COLOR.proxy, COLOR.wg, COLOR.branch, COLOR.ts, COLOR.ovpn];
    dsts.forEach((x, i) => { const h = df.minh + x.v * dScale; dp[x.id] = { y, h, off: 0, c: palette[i % palette.length] }; y += h + GAP; });
    links.forEach(l => {
      const a = sp[l.src], b = dp[l.dst]; if (!a || !b) return;
      const ha = Math.max(1, l.v * sScale), hb = Math.max(1, l.v * dScale);
      const y1 = a.y + a.off + ha / 2, y2 = b.y + b.off + hb / 2; a.off += ha; b.off += hb;
      const mx = (L + R) / 2;
      const p = el('path', { d: `M${L},${y1} C${mx},${y1} ${mx},${y2} ${R},${y2}`, fill: 'none', stroke: b.c, 'stroke-width': Math.max(1, (ha + hb) / 2), opacity: .38 }, skWrap);
      p.addEventListener('mousemove', ev => showTip(ev, `<div class="tt">${H(t(l.src))} → ${H(t(l.dst))}</div><b>${fmt(l.v)} Mbps</b><br><span class="d">${t('最近 {n} 分钟均值', { n: (f.window / 60) | 0 })}</span>`));
      p.addEventListener('mouseleave', hideTip);
    });
    const clip = s2 => s2.length > cut ? s2.slice(0, cut - 1) + '…' : s2;
    srcs.forEach(x => { el('rect', { x: L - 6, y: sp[x.id].y, width: 6, height: sp[x.id].h, fill: 'var(--text-muted)' }, skWrap);
      const tx = el('text', { x: L - 12, y: sp[x.id].y + sp[x.id].h / 2 + 3, 'text-anchor': 'end', class: 'sub' }, skWrap);
      tx.textContent = `${clip(x.label || t(x.id))} ${fmt(x.v)}`; });
    dsts.forEach(x => { el('rect', { x: R, y: dp[x.id].y, width: 6, height: dp[x.id].h, fill: dp[x.id].c }, skWrap);
      const tx = el('text', { x: R + 12, y: dp[x.id].y + dp[x.id].h / 2 + 3, class: 'sub' }, skWrap);
      tx.textContent = `${clip(x.label || t(x.id))} ${fmt(x.v)}`; });

    // ---- Top 会话: NetFlow 里一直有但没上屏的精华 ----
    const sb = document.querySelector('#sess-table tbody');
    if (sb) {
      const rows = (f.top || []).slice(0, 12);
      sb.innerHTML = rows.length ? rows.map(r2 =>
        `<tr><td>${H(r2.src)}</td><td>${H(r2.dst)}</td><td class="num">${H(String(r2.port))}</td><td class="num">${(+r2.mb).toFixed(1)} MB</td></tr>`).join('')
        : `<tr><td colspan="4" class="sub">${t('窗口内暂无流量样本…')}</td></tr>`;
    }
  }

  // ---------- 主循环 ----------
  let wanMax = 0, wanUpMax = 0;
  const EDGE_LABEL = (CFG.edge && CFG.edge.label) || 'edge';   // 主机名来自配置, 不写死
  function render() {
    if (!S.ready) { document.getElementById('t-wan-down').innerHTML = `—<small>${t('后端未就绪')}</small>`; return; }
    // 实体值更新
    const byId = (arr, id) => (arr || []).find(x => x.id === id) || {};
    const f = F();
    wgPeers.forEach(p => { const n = byId(S.wg, p.id), q2 = f && f.wg && f.wg[p.id];
      p.online = n.online; p.down = q2 ? q2.down : (n.down || 0); p.up = q2 ? q2.up : (n.up || 0); p.hs = n.hs;
      p.hist.push(p.online ? p.down + p.up : 0); p.hist.shift(); });
    ovpnUsers.forEach(u => { const n = byId(S.ovpn, u.id), k = '<ovpn-' + u.id + '>', q2 = f && f.ifaces && f.ifaces[k];
      u.down = q2 ? q2.down : (n.down || 0); u.up = q2 ? q2.up : (n.up || 0); });
    branches.forEach(b => { const n = byId(S.branches, b.id); b.online = n.online; b.down = n.down || 0; b.up = n.up || 0; b.hist.push(b.online ? b.down + b.up : 0); b.hist.shift(); });
    const wd = wanD(), wu = wanU();
    wanMax = Math.max(wanMax, wd); wanUpMax = Math.max(wanUpMax, wu);
    if (internetSubEl) {
      const wip = (S.fast && S.fast.wan && S.fast.wan.ip) || (S.wan && S.wan.ip);
      internetSubEl.textContent = wip ? maskIp(wip) : (NODES.internet && NODES.internet.sub) || '';
    }
    document.getElementById('t-wan-down').innerHTML = `${fmt(wd)}<small>Mbps</small>`;
    document.getElementById('t-wan-up').innerHTML = `${fmt(wu)}<small>Mbps</small>`;
    document.getElementById('t-wan-down-d').textContent = t('峰值 {n} Mbps', { n: fmt(wanMax) });
    document.getElementById('t-wan-up-d').textContent = t('峰值 {n} Mbps', { n: fmt(wanUpMax) });
    const nWg = wgPeers.filter(p => p.online).length, nTs = (S.tailnet && S.tailnet.online) || 0;
    document.getElementById('t-remote').innerHTML = `${nWg + ovpnUsers.length + nTs}<small>设备</small>`;
    document.getElementById('t-remote-d').textContent = `WG ${nWg} · OpenVPN ${ovpnUsers.length} · tailnet ${nTs}`;
    // 地图右侧的内网 Top 设备槽位。名字可能变长, 按节点宽度截断而不是写死字数。
    const lanDevs = ((S.lan && S.lan.devices) || []).slice()
      .sort((a, b2) => (b2.down + b2.up) - (a.down + a.up));
    LAN_TOP.forEach((d, i) => {
      const src = lanDevs[i];
      d.name = src ? src.name : ''; d.down = src ? src.down : 0; d.up = src ? src.up : 0;
      d.g.setAttribute('opacity', src ? 1 : 0);
      if (d.edge) d.edge.show(!!src);
      if (!src) return;
      const nm = fitLabel(d.name, d.node.w - 42);   // 右侧速率列占掉一块
      if (d.nameEl.textContent !== nm) d.nameEl.textContent = nm;
      d.rateEl.textContent = fmt(d.down + d.up);
    });
    // 走代理的终端槽位。没人走代理时留一个"暂无"占位, 别让这条带凭空消失
    const bsrc = ((S.bypass && S.bypass.sources) || []);
    BYP_TOP.forEach((d, i) => {
      const src = bsrc[i];
      const placeholder = !src && i === 0 && bsrc.length === 0;
      d.name = src ? src.name : ''; d.down = src ? (src.down || 0) : 0;
      d.up = src ? (src.up || 0) : 0; d.conns = src ? src.conns : 0;
      d.exitNode = src ? (src.node || '') : '';
      if (placeholder) {
        d.g.setAttribute('opacity', 0.5);
        if (d.edge) d.edge.show(true);
        if (d.nameEl.textContent !== t('暂无')) d.nameEl.textContent = t('暂无');
        d.rateEl.textContent = '—';
        return;
      }
      d.g.setAttribute('opacity', src ? 1 : 0);
      if (d.edge) d.edge.show(!!src);
      if (!src) return;
      const nm = fitLabel(d.name, d.node.w - 40);
      if (d.nameEl.textContent !== nm) d.nameEl.textContent = nm;
      d.rateEl.textContent = fmt(d.down + d.up);
    });
    const nBr = branches.filter(b => b.online).length;
    document.getElementById('t-branch').innerHTML = `${nBr}<small>${t('/ {n} 在线', { n: branches.length })}</small>`;
    document.getElementById('t-branch-d').textContent = t('{host} 上的 OpenVPN 客户端', { host: EDGE_LABEL });
    const brh = document.getElementById('br-hint');
    if (brh) brh.textContent = t('{host} 上的 {n} 条 OpenVPN', { host: EDGE_LABEL, n: branches.length });
    (S.ingress_meta || []).forEach(m => {
      const c = ingLabels.find(x => x.k === m.k); if (!c) return;
      c.label = m.id;   // 后端已给出短标签; 端口清单在悬浮提示里, 拼上去会溢出节点框
      const lb = fitLabel(c.label, c.node.w);
      if (c.labelEl && c.labelEl.textContent !== lb) c.labelEl.textContent = lb;
    });
    const ingConns = (S.ingress_detail || []).reduce((a, r) => a + (+r.conns || 0), 0);
    const ingMbps = val(S.ingress, 'trojan') + val(S.ingress, 'https') + val(S.ingress, 'wg');
    const rc = S.ros_conns || {};
    document.getElementById('t-ingress').innerHTML =
      `${ingConns}<small>${t('活跃')}${rc.total ? ' / ' + rc.total + ' ' + t('总连接') : ''}</small>`;
    document.getElementById('t-ingress-d').textContent =
      `${fmt(ingMbps)} Mbps · ` + ((S.ingress_meta || []).map(m => m.id).join(' / ') || 'trojan / anytls / HTTPS');
    const t24 = (S.radios || []).reduce((a, r) => a + (+r.clients || 0), 0);
    document.getElementById('t-clash').innerHTML = `${t24}<small>无线客户端</small>`;
    document.getElementById('t-clash-d').textContent =
      t('内网 DHCP · {n} 台设备', { n: (S.lan && S.lan.clients) || 0 });
    const tn = S.tailnet || {};
    document.getElementById('t-remote-d').textContent = `WG ${wgPeers.filter(p => p.online).length} · OpenVPN ${ovpnUsers.length} · tailnet ${tn.online || 0}/${tn.nodes || 0}`;
    EDGES.forEach(e => { const r = e.rateFn(); e.last = r; e.rate = r;
      // 幂函数拉开层级但收着画: 1 Mbps≈2.1px, 10≈3.5, 50≈5.5, 100≈6.9 (封顶 8)
      e.p.setAttribute('stroke-width', r <= 0.01 ? 1 : Math.min(8, 1.2 + Math.pow(r, 0.40) * 0.9).toFixed(2));
      e.p.classList.toggle('idle', r <= 0.01); });
    [...wgPeers, ...ovpnUsers, ...branches].forEach(p => { if (p.dot) p.dot.setAttribute('opacity', p.online === false ? .25 : 1); });
    for (const [n, f] of [['health', renderHealth], ['tables', renderTables], ['feed', renderFeed], ['vms', renderVMs], ['hw', renderHW], ['nas', renderNAS], ['wifi', renderWifi], ['ovpn', renderOvpn], ['tailnet', renderTailnet], ['sankey', renderSankey]]) {
      try { f(); } catch (err) { console.error('render ' + n + ' failed:', err); }
    }
    document.getElementById('clock').textContent = clock();
  }

  // 表格与拓扑图套横向滚动容器 (移动端不撑破页面)
  document.querySelectorAll('.panel table, section table').forEach(t => {
    if (t.parentElement.classList.contains('tw')) return;
    const w = document.createElement('div'); w.className = 'tw';
    t.parentNode.insertBefore(w, t); w.appendChild(t);
  });
  if (svg.parentElement && !svg.parentElement.classList.contains('mapwrap')) {
    const w = document.createElement('div'); w.className = 'mapwrap';
    svg.parentNode.insertBefore(w, svg); w.appendChild(svg);
  }

  render(); drawHist();
  // ---------- 启动: 主题 / 语言 / 按配置装配页面 ----------
  (() => {
    const P = CFG.panels || {};
    // 没装 IPMI/群晖/UniFi 的人不该看到一排空面板
    const gate = { 'p-wg': 'router', 'p-lan': 'router', 'p-wan24': 'router', 'p-br': 'edge',
                   'p-nas': 'nas', 'p-pve': 'pve', 'p-unifi': 'unifi', 'p-netflow': 'netflow' };
    for (const [id, key] of Object.entries(gate)) {
      const el2 = document.getElementById(id);
      if (el2 && P[key] === false) el2.style.display = 'none';
    }
    const site = CFG.site || {};
    const st = site.title || 'routeros-lanpulse';
    document.title = st; setText('site-title', st);
    if (site.note) document.getElementById('live').textContent = '● ' + site.note;
    setText('nas-title', (CFG.nas && CFG.nas.title) || 'NAS');
    setText('nas-hint', (CFG.nas && CFG.nas.hint) || '');
    // 页脚说明按实际启用的模块生成, 不写死
    const src = [];
    if (P.router !== false) src.push('RouterOS (mktxp)');
    if (P.pve) src.push('Proxmox VE (pve-exporter)');
    if (P.edge) src.push('edge (node_exporter)');
    if (P.nas) src.push('NAS (SNMP)');
    if (P.unifi) src.push('UniFi (API)');
    if (P.netflow) src.push('NetFlow v9');
    document.getElementById('site-footer').textContent =
      t('数据源') + '：' + src.join(' · ') + '。' + t('采集 Prometheus，本页每秒刷新（WAN / 每设备速率直连路由器取 1 秒粒度，其余走 Prometheus）。');
    if (window.__DEMO__ && !window.__CFG_FROM_SERVER__) {
      const b = document.createElement('span');
      b.className = 'topbtn'; b.textContent = 'DEMO · 演示数据';
      b.style.cssText = 'color:var(--s-proxy);border-color:var(--s-proxy)';
      document.querySelector('.topright').prepend(b);
    }
    if (CFG.redact) {
      const b = document.createElement('span');
      b.className = 'topbtn'; b.textContent = '脱敏模式';
      b.style.cssText = 'color:var(--warn);border-color:var(--warn)';
      document.querySelector('.topright').prepend(b);
    }
    initTheme(document.getElementById('btn-theme'));
    initI18n(document.getElementById('btn-lang'), () => render());
  })();

  setInterval(async () => { await pull(); render(); applyLang(); }, 1000);
  buildRangeButtons();
  // 刷新间隔跟着档位走: 30 分钟档没必要 60 秒才动一次
  let histTimer = null;
  const scheduleHist = () => {
    if (histTimer) clearInterval(histTimer);
    const rs = (CFG.hist_ranges || []).find(r => r.k === HIST_RANGE);
    const ms = Math.max(10000, ((rs && rs.step) || 30) * 1000);
    histTimer = setInterval(async () => { await pullHist(); drawHist(); }, ms);
  };
  scheduleHist();
  document.getElementById('hist-range')?.addEventListener('click', () => setTimeout(scheduleHist, 50));
  addEventListener('resize', drawHist);

  // 流动动画
  let last = performance.now();
  function animate(now) {
    const dt = (now - last) / 1000; last = now;
    EDGES.forEach(e => { const v = e.rate || 0; if (v > 0.01) { e.off -= dt * Math.min(60, 6 + Math.log10(1 + v) * 22); e.p.setAttribute('stroke-dashoffset', e.off.toFixed(1)); } });
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
})();
