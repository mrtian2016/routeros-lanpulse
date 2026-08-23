import { initTheme } from './theme.js';
import { initI18n, t, applyLang, lang } from './i18n.js';

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
  const pullHist = async () => {
    if (STATIC_DEMO) { HIST = DEMO().history || HIST; return; }
    try {
      const r = await fetch('api/history.json', { cache: 'no-store' });
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
    internet: { x: 80, y: 250, w: 110, h: 48, name: 'Internet', sub: '公网 IPv4' },
    ros: { x: 330, y: 250, w: 140, h: 56, name: 'RouterOS', sub: '192.168.1.1 · NAT / FW / WG', core: true },
    edge: { x: 600, y: 395, w: 150, h: 56, name: 'edge', sub: '192.168.1.11 · 入口 / 组网', core: true },
    unifi: { x: 600, y: 110, w: 130, h: 48, name: 'UniFi AP', sub: '192.168.1.30 · 无线' },
    lan: { x: 600, y: 250, w: 140, h: 56, name: '内网', sub: '192.168.1.0/24', core: true },
    wgg: { x: 60, y: 40, w: 0, h: 0, name: 'WireGuard peers', group: true },
    ovg: { x: 60, y: 460, w: 0, h: 0, name: 'OpenVPN 用户', group: true },
    brg: { x: 830, y: 355, w: 0, h: 0, name: '分支站点', group: true },
    tsg: { x: 830, y: 470, w: 0, h: 0, name: 'tailnet', group: true },
    ing: { x: 830, y: 180, w: 0, h: 0, name: '入口 / 公网服务', group: true },
  };
  const side = (n, s) => s === 'l' ? { x: n.x, y: n.y + n.h / 2 } : s === 'r' ? { x: n.x + n.w, y: n.y + n.h / 2 } : s === 't' ? { x: n.x + n.w / 2, y: n.y } : { x: n.x + n.w / 2, y: n.y + n.h };
  const svg = document.getElementById('map'), NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, parent = svg) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
  const edgesLayer = el('g'), nodesLayer = el('g');
  const tip = document.getElementById('tip');
  function showTip(ev, html) { tip.innerHTML = html; tip.style.display = 'block'; const x = ev.clientX + 14, y = ev.clientY + 14; tip.style.left = Math.min(x, innerWidth - tip.offsetWidth - 12) + 'px'; tip.style.top = Math.min(y, innerHeight - tip.offsetHeight - 12) + 'px'; }
  function hideTip() { tip.style.display = 'none'; }

  const EDGES = [];
  const addEdge = (id, d, color, rateFn, labelAt, tipFn) => {
    el('path', { d, class: 'edge-bg' }, edgesLayer);
    const p = el('path', { d, class: 'edge', stroke: color, 'stroke-width': 2, 'stroke-dasharray': '6 8' }, edgesLayer);
    const t = el('text', { x: labelAt[0], y: labelAt[1], class: 'elabel', 'text-anchor': 'middle' }, edgesLayer);
    const e = { id, p, t, rateFn, off: 0, color };
    p.addEventListener('mousemove', ev => showTip(ev, tipFn(e.last || 0)));
    p.addEventListener('mouseleave', hideTip);
    EDGES.push(e); return e;
  };
  const CURVE = (a, b, bend = .5) => { const mx = a.x + (b.x - a.x) * bend; return `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`; };
  const s_ = (n, k) => side(NODES[n], k);

  addEdge('wan', CURVE(s_('internet', 'r'), s_('ros', 'l')), COLOR.wan, () => smooth('wan', wanD() + wanU()), [262, 292],
    () => `<div class="tt">Internet ↔ RouterOS (PPPoE)</div><b>↓ ${fmt(wanD())}</b> / <b>↑ ${fmt(wanU())}</b> Mbps<br><span class="d">${S.wan && S.wan.online ? '已连接' : '离线'}${S.wan && S.wan.ip ? ' · ' + S.wan.ip : ''}</span>`);
  addEdge('lan', CURVE(s_('ros', 'r'), s_('lan', 'l')), COLOR.wan, () => { const f = F(); return smooth('lan', f ? val(f.lan, 'down') + val(f.lan, 'up') : (S.lan && S.lan.devices || []).reduce((a, d) => a + d.down + d.up, 0)); }, [535, 238],
    r => `<div class="tt">RouterOS ↔ 内网</div><b>${fmt(r)} Mbps</b><br><span class="d">${(S.lan && S.lan.clients) || 0} 台在线 (DHCP 租约)</span>`);
  addEdge('dnat', CURVE(s_('ros', 'b'), s_('edge', 'l'), .35), COLOR.proxy, () => smooth('dnat', val(S.ingress, 'trojan') + val(S.ingress, 'https')), [470, 360],
    r => `<div class="tt">RouterOS → edge (dst-nat 32443/58443/3478)</div><b>${fmt(r)} Mbps</b><br><span class="d">公网入口转发</span>`);
  addEdge('wifi', CURVE(s_('lan', 't'), s_('unifi', 'b'), .5), COLOR.ts, () => smooth('wifi', (S.wifi || []).reduce((a, w) => a + (w.down || 0) + (w.up || 0), 0)), [660, 205],
    r => { const rs = S.radios || []; return `<div class="tt">内网 ↔ UniFi AP</div><b>${fmt(r)} Mbps</b><br><span class="d">${(S.wifi || []).length} 个无线客户端${rs.map(x => ` · ${x.band} 利用率 ${x.util}%`).join('')}</span>`; });

  wgPeers.forEach((p, i) => {
    const y = 32 + i * 26; p.node = { x: 30, y, w: 96, h: 20 };
    addEdge('wg-' + p.id, CURVE({ x: 126, y: y + 10 }, s_('ros', 'l'), .55), COLOR.wg, () => p.online ? smooth('wg' + p.id, p.down + p.up) : 0, [0, 0],
      () => `<div class="tt">WireGuard · ${p.id}</div>${p.online ? `<b>↓ ${fmt(p.down)}</b> / <b>↑ ${fmt(p.up)}</b> Mbps<br><span class="d">${p.ip} · 握手 ${p.hs}s 前</span>` : `<span class="d">${p.ip} · 未连接</span>`}`);
  });
  ovpnUsers.forEach((u, i) => {
    const y = 470 + i * 26; u.node = { x: 30, y, w: 96, h: 20 };
    addEdge('ov-' + u.id, CURVE({ x: 126, y: y + 10 }, s_('ros', 'l'), .55), COLOR.ovpn, () => smooth('ov' + u.id, u.down + u.up), [0, 0],
      () => `<div class="tt">OpenVPN 服务端 · ${u.id}</div><b>↓ ${fmt(u.down)}</b> / <b>↑ ${fmt(u.up)}</b> Mbps`);
  });
  branches.forEach((b, i) => {
    const y = 330 + i * 24; b.node = { x: 840, y, w: 110, h: 18 };
    addEdge('br-' + b.id, CURVE(s_('edge', 'r'), { x: 840, y: y + 9 }, .5), COLOR.branch, () => b.online ? smooth('br' + b.id, b.down + b.up) : 0, [0, 0],
      () => `<div class="tt">分支隧道 · ${b.id}${b.dev ? ' (' + b.dev + ')' : ''}</div>${b.online ? `<b>↓ ${fmt(b.down)}</b> / <b>↑ ${fmt(b.up)}</b> Mbps<br><span class="d">对端 ${b.peer || '?'} · ${b.net}</span>${(b.nets||[]).length ? `<br><span class="d">承载: ${b.nets.join(' ')}</span>` : ''}` : `<span class="d">${b.net} · 中断</span>`}`);
  });
  const tsNode = { id: 'tailnet', node: { x: 840, y: 470, w: 110, h: 18 }, online: true };
  addEdge('ts', CURVE(s_('edge', 'b'), { x: 840, y: 479 }, .5), COLOR.ts, () => 0.02, [0, 0],
    () => `<div class="tt">tailnet (headscale)</div><span class="d">${(S.tailnet && S.tailnet.online) || 0}/${(S.tailnet && S.tailnet.nodes) || 0} 在线 · edge 发布子网路由</span><br>${((S.tailnet && S.tailnet.peers) || []).map(p => `<span style="opacity:${p.online ? 1 : .4}">${p.id}</span>`).join(' · ')}`);
  ingLabels.forEach((c, i) => {
    const y = 190 + i * 24; c.node = { x: 840, y, w: 120, h: 18 };
    addEdge('in-' + i, CURVE(s_('edge', 't'), { x: 840, y: y + 9 }, .6), COLOR.proxy, () => smooth('in' + i, val(S.ingress, c.k)), [0, 0],
      r => `<div class="tt">入口 · ${c.id}</div><b>${fmt(r)} Mbps</b>`);
  });

  const drawNode = (n, cls = 'node') => {
    const g = el('g', { class: cls + (n.core ? ' core' : '') }, nodesLayer);
    el('rect', { x: n.x, y: n.y, width: n.w, height: n.h }, g);
    const t = el('text', { x: n.x + n.w / 2, y: n.y + n.h / 2 - 2, 'text-anchor': 'middle', class: 'name' }, g); t.textContent = n.name;
    if (n.sub) { const s2 = el('text', { x: n.x + n.w / 2, y: n.y + n.h / 2 + 12, 'text-anchor': 'middle', class: 'sub' }, g); s2.textContent = n.sub; }
    return g;
  };
  const groupLabel = (x, y, text, color) => { const t = el('text', { x, y, class: 'elabel' }, nodesLayer); t.textContent = text; t.setAttribute('fill', color); };
  const peerNode = (p, color, label, sub) => {
    const g = el('g', { class: 'node small' }, nodesLayer);
    el('rect', { x: p.node.x, y: p.node.y, width: p.node.w, height: p.node.h, rx: 4 }, g);
    const t = el('text', { x: p.node.x + 8, y: p.node.y + p.node.h / 2 + 3, class: 'sub' }, g); t.textContent = label; p.labelEl = t;
    p.dot = el('circle', { cx: p.node.x + p.node.w - 9, cy: p.node.y + p.node.h / 2, r: 3.5, fill: color }, g);
    g.addEventListener('mousemove', ev => showTip(ev, sub()));
    g.addEventListener('mouseleave', hideTip);
    return g;
  };
  Object.values(NODES).forEach(n => { if (!n.group) drawNode(n); });
  groupLabel(NODES.wgg.x, NODES.wgg.y - 8, 'WireGuard peers', COLOR.wg);
  groupLabel(NODES.ovg.x, NODES.ovg.y - 6, 'OpenVPN 用户', COLOR.ovpn);
  groupLabel(NODES.brg.x, NODES.brg.y - 8, '分支站点', COLOR.branch);
  groupLabel(NODES.tsg.x, NODES.tsg.y - 4, 'tailnet', COLOR.ts);
  groupLabel(NODES.ing.x, NODES.ing.y - 8, '入口 / 公网服务', COLOR.proxy);
  wgPeers.forEach(p => peerNode(p, COLOR.wg, p.id, () => `<div class="tt">${p.id}</div><span class="d">${p.ip} · ${p.online ? '在线' : '离线'}</span>`));
  ovpnUsers.forEach(u => peerNode(u, COLOR.ovpn, u.id, () => `<div class="tt">${u.id}</div><span class="d">OpenVPN 服务端用户</span>`));
  branches.forEach(b => peerNode(b, COLOR.branch, b.id + ' ' + (b.net || ''), () => `<div class="tt">${b.id}</div><span class="d">${b.net}</span>`));
  peerNode(tsNode, COLOR.ts, 'tailnet 节点', () => `<div class="tt">tailnet</div><span class="d">${(S.tailnet && S.tailnet.online) || 0}/${(S.tailnet && S.tailnet.nodes) || 0} 在线</span>`);
  ingLabels.forEach(c => peerNode(c, COLOR.proxy, c.id, () => {
    const rows = (S.ingress_detail || []).filter(r =>
      c.k === 'trojan' ? (r.type === 'trojan' || r.type === 'anytls') : (c.k === 'https' ? r.type === 'http' : false));
    let h = `<div class="tt">入口 · ${H(c.label || c.id)}</div><b>${fmt(val(S.ingress, c.k))} Mbps</b>`;
    if (rows.length) h += '<br>' + rows.map(r =>
      `<span class="d">${H(r.type)} :${H(r.port)} · ${r.conns} 连接 · ↓${fmt(r.rx)} / ↑${fmt(r.tx)} Mbps</span>`).join('<br>');
    return h;
  }));

  // ---------- 事件流 ----------
  const feed = document.getElementById('feed');
  let lastEvKey = '';
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
        `${hc.cores ? hc.cores + ' 核 ' : ''}${hc.threads || '?'} 线程 · ${(hi.ram || 0).toFixed(0)}G`,
        100, 'var(--text-muted)')];
      (hi.disks || []).slice(0, 5).forEach(d => rows.push(kvRow(d.model, `${d.size} ${d.kind}`, 100, 'var(--text-muted)')));
      (h.storage || []).forEach(x => rows.push(useRow(`${t('存储')} ${x.name}`, x)));
      (h.fs || []).forEach(x => rows.push(useRow(`${t('磁盘')} ${x.name}`, x)));
      if (h.sys) rows.push(kvRow('System', h.sys.toFixed(0) + ' °C', h.sys, tcolor(h.sys, 60, 70)));
      if (h.periph) rows.push(kvRow('Peripheral', h.periph.toFixed(0) + ' °C', h.periph, tcolor(h.periph, 70, 80)));
      if (h.dimm) rows.push(kvRow('DIMM A1', h.dimm.toFixed(0) + ' °C', h.dimm, tcolor(h.dimm, 75, 85)));
      if (h.nvme !== undefined) {
        rows.push(kvRow('NVMe 温度', (h.nvme || 0).toFixed(0) + ' °C', h.nvme, tcolor(h.nvme, 70, 80)));
        rows.push(kvRow('NVMe 寿命已用' + (h.nvme_hours ? ` · 通电 ${(h.nvme_hours / 8760).toFixed(1)} 年` : ''),
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
        ? `<li><span class="t">BMC</span><span>${H(h.bmc)} · ipmi 采集正常</span></li>` : '';
    });
  }

  function renderNAS() {
    const n = S.nas || {}, disks = n.disks || [];
    const bad = (n.raid || []).filter(r => !r.ok).length;
    document.getElementById('nas-vol').textContent = (n.temp || 0).toFixed(0);
    tempTag(document.getElementById('nas-tag'), bad ? 99 : (n.temp || 0), 60, 70);
    document.getElementById('nas-kv').innerHTML = [
      kvRow('系统温度', (n.temp || 0).toFixed(0) + ' °C', n.temp, tcolor(n.temp, 55, 65)),
      ...(n.model ? [kvRow('型号', n.model, 100, 'var(--text-muted)')] : []),
      ...(n.raid || []).map(r => kvRow(r.name, r.ok ? '正常' : '异常', 100, r.ok ? 'var(--good)' : 'var(--bad)')),
    ].join('');
    document.getElementById('nas-disks').innerHTML = disks.map(d => `<li><span class="t">${d.name}</span><span style="color:${tcolor(d.t, 45, 50)}">${d.t.toFixed(0)} °C</span></li>`).join('');
  }
  function renderOvpn() {
    const f = F(), ss = (f && f.ovpn_sessions) || [];
    const hint = document.getElementById('ov-hint');
    if (hint) hint.textContent = `服务端 60957 · ${ss.length} 个会话 · 一对端一账号`;
    const rate = ip => { const k = Object.keys((f && f.ifaces) || {}); return null; };
    document.querySelector('#ov-table tbody').innerHTML = ss.length ? ss.map(x => {
      return `<tr title="${H(x.note || '')}"><td>${H(x.user)}</td><td class="d">${H(x.caller)}</td><td>${H(x.ip)}</td><td>${H(x.uptime)}</td><td class="d">${H(x.enc || '')}</td></tr>`;
    }).join('') : '<tr><td colspan="5" class="d">当前无拨入会话</td></tr>';
  }

  function renderTailnet() {
    const tn = S.tailnet || {}, ps = tn.peers || [];
    const hint = document.getElementById('ts-hint');
    if (hint) hint.textContent = `headscale · ${tn.online || 0}/${tn.nodes || 0} 在线`;
    const dup = {}; ps.forEach(p => dup[p.id] = (dup[p.id] || 0) + 1);
    document.querySelector('#ts-table tbody').innerHTML = ps.length ? ps.map(p => {
      const name = H(p.id) + (dup[p.id] > 1 && p.ip ? ` <span class="d">(${H(p.ip.split('.').pop())})</span>` : '');
      return `<tr class="${p.online ? '' : 'off'}"><td>${name}</td><td><span class="dot" style="background:${p.online ? 'var(--good)' : 'var(--text-dim)'}"></span>${p.online ? '在线' : '离线'}</td><td class="d">${H(p.ip || '')}</td><td class="d">${H(p.os || '')}</td></tr>`;
    }).join('') : '<tr><td colspan="4" class="d">等待 tailscale 指标…</td></tr>';
  }

  function renderWifi() {
    const ap = (S.ap || [])[0];
    if (ap) {
      const box = document.querySelector('#wifi-table').closest('.panel, .card, section');
      const h = box && box.querySelector('h2 .hint');
      if (h && !h.dataset.done) { h.dataset.done = 1; h.textContent = `${ap.model} · ${ap.ip} · fw ${ap.fw}`; }
    }
    const w = S.wifi || [], r24 = (S.radios || []).find(x => x.band === '2.4G') || {}, r5 = (S.radios || []).find(x => x.band === '5G') || {};
    const uw = document.querySelector('#wifi-table').closest('.panel').querySelector('.util');
    const bar = (r, color) => r ? `<div><div class="lbl"><span>${r.band} · ch ${r.ch} · <b>${r.clients || 0}</b> 台</span><span>${r.util}%</span></div><div class="g"><i style="width:${Math.max(2, Math.min(100, r.util))}%;background:${color}"></i></div></div>` : '';
    if (uw) uw.innerHTML = bar(r24, 'var(--s-ovpn)') + bar(r5, 'var(--s-wan)');
    document.querySelector('#wifi-table tbody').innerHTML = w.map(x => `<tr><td>${H(x.name)}</td><td>${x.band || '—'}</td><td>${rssiBar(x.rssi || -99)}</td><td>${fmt(x.down)}</td><td>${fmt(x.up)}</td><td class="d">${x.sat != null ? x.sat + '%' : '—'}</td></tr>`).join('');
  }

  // ---------- 24h 曲线 ----------
  const hist = document.getElementById('hist');
  function drawHist() {
    hist.innerHTML = ''; const W = hist.clientWidth || 900, Hh = 170, L = 34, R = 8, T = 10, B = 22;
    const pts = HIST.down || []; if (!pts.length) { const t = el('text', { x: W / 2, y: Hh / 2, 'text-anchor': 'middle', class: 'sub' }, hist); t.textContent = '正在积累历史数据…'; return; }
    const max = Math.max(1, ...pts.map(p => p[1]), ...(HIST.up || []).map(p => p[1]));
    const x = i => L + i / Math.max(1, pts.length - 1) * (W - L - R), y = v => T + (1 - v / max) * (Hh - T - B);
    const g = el('g', { class: 'grid' }, hist); [0, .25, .5, .75, 1].forEach(f => { el('line', { x1: L, x2: W - R, y1: y(max * f), y2: y(max * f) }, g); });
    const ax = el('g', { class: 'axis' }, hist);
    [0, .5, 1].forEach(f => { const t = el('text', { x: 4, y: y(max * f) + 3 }, ax); t.textContent = (max * f).toFixed(0); });
    pts.filter((_, i) => i % Math.ceil(pts.length / 6) === 0).forEach((p, k, arr) => { const i = pts.indexOf(p); const t = el('text', { x: x(i), y: Hh - 6, 'text-anchor': 'middle' }, ax); t.textContent = new Date(p[0] * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); });
    const line = (arr, color) => { if (!arr || !arr.length) return; const d = arr.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p[1])}`).join(' '); el('path', { d, class: 'ln', stroke: color }, hist); };
    line(HIST.down, COLOR.wan); line(HIST.up, COLOR.proxy);
  }

  // ---------- 设备去向 (NetFlow 实时) ----------
  const skWrap = document.getElementById('sankey');
  function renderSankey() {
    const f = S.flows;
    skWrap.innerHTML = '';
    if (!f || !f.sources.length) { const t = el('text', { x: 300, y: 120, class: 'sub' }, skWrap); t.textContent = f ? '窗口内暂无流量样本…' : 'NetFlow 收集器未就绪'; return; }
    // 坐标必须用 viewBox 的用户坐标系 (SVG 里写死了 viewBox), 不能用像素宽度
    const vb = (skWrap.getAttribute('viewBox') || '0 0 560 260').split(/\s+/).map(Number);
    const W = vb[2] || 560, Hh = vb[3] || 260, pad = 14, MINH = 8, narrow = innerWidth < 640, lab = narrow ? 70 : 132, L = lab, R = Math.max(lab + 60, W - lab - 6), cut = narrow ? 9 : 17;
    const srcs = f.sources, dsts = f.dests.filter(d => f.links.some(l => l.dst === d.id));
    const sTot = srcs.reduce((a, x) => a + x.v, 0) || 1, dTot = dsts.reduce((a, x) => a + x.v, 0) || 1;
    const sScale = (Hh - pad * 2 - MINH * srcs.length) / sTot, dScale = (Hh - pad * 2 - MINH * dsts.length) / dTot;
    let y = pad; const sp = {}; srcs.forEach(x => { const h = MINH + x.v * sScale; sp[x.id] = { y, h, off: 0 }; y += h + 4; });
    y = pad; const dp = {}; const palette = [COLOR.wan, COLOR.proxy, COLOR.wg, COLOR.branch, COLOR.ts, COLOR.ovpn];
    dsts.forEach((x, i) => { const h = MINH + x.v * dScale; dp[x.id] = { y, h, off: 0, c: palette[i % palette.length] }; y += h + 4; });
    f.links.forEach(l => {
      const a = sp[l.src], b = dp[l.dst]; if (!a || !b) return;
      const ha = Math.max(1, l.v * sScale), hb = Math.max(1, l.v * dScale);
      const y1 = a.y + a.off + ha / 2, y2 = b.y + b.off + hb / 2; a.off += ha; b.off += hb;
      const mx = (L + R) / 2;
      const p = el('path', { d: `M${L},${y1} C${mx},${y1} ${mx},${y2} ${R},${y2}`, fill: 'none', stroke: b.c, 'stroke-width': Math.max(1, (ha + hb) / 2), opacity: .38 }, skWrap);
      p.addEventListener('mousemove', ev => showTip(ev, `<div class="tt">${l.src} → ${l.dst}</div><b>${fmt(l.v)} Mbps</b><br><span class="d">最近 ${(f.window / 60) | 0} 分钟均值</span>`));
      p.addEventListener('mouseleave', hideTip);
    });
    srcs.forEach(x => { el('rect', { x: L - 6, y: sp[x.id].y, width: 6, height: sp[x.id].h, fill: 'var(--text-muted)' }, skWrap);
      const t = el('text', { x: L - 12, y: sp[x.id].y + sp[x.id].h / 2 + 3, 'text-anchor': 'end', class: 'sub' }, skWrap); t.textContent = `${x.id.length > cut ? x.id.slice(0, cut - 1) + '…' : x.id} ${fmt(x.v)}`; });
    dsts.forEach(x => { el('rect', { x: R, y: dp[x.id].y, width: 6, height: dp[x.id].h, fill: dp[x.id].c }, skWrap);
      const t = el('text', { x: R + 12, y: dp[x.id].y + dp[x.id].h / 2 + 3, class: 'sub' }, skWrap); t.textContent = `${x.id.length > cut ? x.id.slice(0, cut - 1) + '…' : x.id} ${fmt(x.v)}`; });
  }

  // ---------- 主循环 ----------
  let wanMax = 0;
  function render() {
    if (!S.ready) { document.getElementById('t-wan-down').innerHTML = '—<small>后端未就绪</small>'; return; }
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
    wanMax = Math.max(wanMax, wd);
    document.getElementById('t-wan-down').innerHTML = `${fmt(wd)}<small>Mbps</small>`;
    document.getElementById('t-wan-down-max').textContent = fmt(wanMax);
    document.getElementById('t-wan-up').innerHTML = `${fmt(wu)}<small>Mbps</small>`;
    const nWg = wgPeers.filter(p => p.online).length, nTs = (S.tailnet && S.tailnet.online) || 0;
    document.getElementById('t-remote').innerHTML = `${nWg + ovpnUsers.length + nTs}<small>设备</small>`;
    document.getElementById('t-remote-d').textContent = `WG ${nWg} · OpenVPN ${ovpnUsers.length} · tailnet ${nTs}`;
    const nBr = branches.filter(b => b.online).length;
    document.getElementById('t-branch').innerHTML = `${nBr}<small>/ ${branches.length} 在线</small>`;
    (S.ingress_meta || []).forEach(m => {
      const c = ingLabels.find(x => x.k === m.k); if (!c) return;
      c.label = m.id;   // 后端已给出短标签; 端口清单在悬浮提示里, 拼上去会溢出节点框
      if (c.labelEl && c.labelEl.textContent !== c.label) c.labelEl.textContent = c.label;
    });
    const ingConns = (S.ingress_detail || []).reduce((a, r) => a + (+r.conns || 0), 0);
    const ingMbps = val(S.ingress, 'trojan') + val(S.ingress, 'https') + val(S.ingress, 'wg');
    document.getElementById('t-ingress').innerHTML = `${ingConns}<small>活跃连接</small>`;
    document.getElementById('t-ingress-d').textContent =
      `${fmt(ingMbps)} Mbps · ` + ((S.ingress_meta || []).map(m => m.id).join(' / ') || 'trojan / anytls / HTTPS');
    const t24 = (S.radios || []).reduce((a, r) => a + (+r.clients || 0), 0);
    document.getElementById('t-clash').innerHTML = `${t24}<small>无线客户端</small>`;
    document.getElementById('t-clash-n').textContent = (S.lan && S.lan.clients) || 0;
    const tn = S.tailnet || {};
    document.getElementById('t-remote-d').textContent = `WG ${wgPeers.filter(p => p.online).length} · OpenVPN ${ovpnUsers.length} · tailnet ${tn.online || 0}/${tn.nodes || 0}`;
    EDGES.forEach(e => { const r = e.rateFn(); e.last = r; e.rate = r; e.p.setAttribute('stroke-width', r <= 0.01 ? 1 : (1.2 + Math.log10(1 + r) * 2.2).toFixed(2)); e.p.classList.toggle('idle', r <= 0.01); });
    [...wgPeers, ...ovpnUsers, ...branches].forEach(p => { if (p.dot) p.dot.setAttribute('opacity', p.online === false ? .25 : 1); });
    for (const [n, f] of [['tables', renderTables], ['feed', renderFeed], ['hw', renderHW], ['nas', renderNAS], ['wifi', renderWifi], ['ovpn', renderOvpn], ['tailnet', renderTailnet], ['sankey', renderSankey]]) {
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
    document.title = site.title || 'lanpulse';
    setText('site-title', site.title || 'lanpulse');
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
  setInterval(async () => { await pullHist(); drawHist(); }, 60000);
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
