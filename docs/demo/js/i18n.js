// 中英双语。
//
// 词条数据不在这个文件里 —— 在 lanpulse/i18n/en.json, 由后端注入成 window.__I18N__。
// 这么做是因为**后端也要用同一份翻译**: 告警外发(Bark/Telegram)的文案要按配置的语言发,
// 如果前后端各存一份对照表, 迟早会对不上。
//
// 用**中文原文当 key**, 而不是 t('panel.lan.title') 这种抽象键:
//   - 代码读起来还是中文, 不用来回查字典
//   - 字典里漏掉的条目自动回退到中文, 不会出现刺眼的 "panel.lan.title"
//   - 翻译文件就是一张对照表, 非程序员也能提 PR
//
// HTML 里的静态文案不需要加 data-i18n 标记: 首次运行时遍历一遍文本节点,
// 把原文存进 WeakMap, 之后切换语言就在原文和译文之间来回替换。
const KEY = 'lanpulse.lang';
const DICT = (window.__I18N__ || {});
const UI = DICT.ui || {};
// 长的短语先替换, 免得 "恢复" 把 "恢复转动" 切碎
const EV = (DICT.events || []).slice().sort((a, b) => b[0].length - a[0].length);

let LANG = localStorage.getItem(KEY) || (navigator.language.startsWith('zh') ? 'zh' : 'en');
const originals = new WeakMap();   // 事件列表每秒重建, 用 WeakMap 免得攒垃圾

export const lang = () => LANG;
// p 是占位符表: t('{n} 分钟均值', {n: 5})。带数字的句子必须整句进词典,
// 拆成 “分钟均值” + 数字拼接的话, 英文语序 ("5-minute average") 就拼不出来。
export const t = (s, p) => {
  let out = (LANG === 'en' && UI[s]) ? UI[s] : s;
  if (p) for (const k in p) out = out.split('{' + k + '}').join(p[k]);
  return out;
};

// 事件文案是后端拼出来的句子 (模板 + 设备名), 没法整句查表, 所以按短语替换。
// 设备名/IP 不在表里, 会原样保留 —— 这正是想要的。
export function translateEvent(text) {
  if (LANG !== 'en') return text;
  let out = text;
  for (const [zh, en] of EV) out = out.split(zh).join(en);
  // 量词 "条" 单独出现时去掉。注意不能写 /条\b/ —— JS 的 \b 判定的是 ASCII 词边界,
  // 中文字符两侧永远不成立, 那样这条规则等于没写。用后瞻限定它后面是空格/箭头/结尾。
  return out.replace(/\s*条(?=[\s→]|$)/g, '').replace(/\s{2,}/g, ' ').trim();
}

// 带 data-i18n 的元素整块翻译 innerHTML。
// 原因: 说明性文字里常夹着 <code> 标签, 逐文本节点翻译会被切成"按"、"里设置"
// 这种没法翻的碎片。整块查表则以完整句子为单位, 译文里也能保留标记。
function walkBlocks(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    if (!originals.has(el)) originals.set(el, el.innerHTML);
    const raw = originals.get(el);
    const key = raw.trim().replace(/\s+/g, ' ');
    el.innerHTML = (LANG === 'en' && UI[key]) ? UI[key] : raw;
  }
}

// placeholder / title / aria-label 这些属性里也有文案, TreeWalker 只看文本节点, 看不到它们。
const ATTRS = ['placeholder', 'title', 'aria-label'];
const attrOrig = new WeakMap();
function walkAttrs(root) {
  for (const el of root.querySelectorAll('[placeholder],[title],[aria-label]')) {
    let o = attrOrig.get(el);
    if (!o) { o = {}; for (const a of ATTRS) { const v = el.getAttribute(a); if (v) o[a] = v; } attrOrig.set(el, o); }
    for (const a in o) el.setAttribute(a, (LANG === 'en' && UI[o[a]]) ? UI[o[a]] : o[a]);
  }
}

// 页面标题也要翻, 但**不能抢**: 面板会按 site.title 改标题, 而那是用户自己写的字,
// 不该被翻译、更不该被这里覆盖回去。所以只在没人动过标题时才接管。
const TITLE0 = document.title;
const titleNow = () => (LANG === 'en' && UI[TITLE0]) ? UI[TITLE0] : TITLE0;

function walk(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
  for (const n of nodes) {
    const par = n.parentElement;
    if (par && par.closest('[data-i18n]')) continue;   // 整块翻译的子树不再逐节点处理
    // 事件正文 (.m) 走短语翻译, 其余走整串查表
    if (par && par.classList.contains('m')) {
      if (!originals.has(n)) originals.set(n, n.nodeValue);
      n.nodeValue = translateEvent(originals.get(n));
      continue;
    }
    if (!originals.has(n)) {
      const raw = n.nodeValue.trim();
      if (!raw) continue;
      originals.set(n, n.nodeValue);
    }
    const raw = originals.get(n);
    const key = raw.trim();
    if (UI[key] === undefined) continue;
    n.nodeValue = LANG === 'en' ? raw.replace(key, UI[key]) : raw;
  }
}

export function applyLang() {
  if (document.title === TITLE0 || document.title === UI[TITLE0]) document.title = titleNow();
  walkBlocks(document.body);
  walkAttrs(document.body);
  walk(document.body);
  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
}

export function initI18n(btn, onChange) {
  const sync = () => { btn.textContent = LANG === 'en' ? '中' : 'EN'; };
  applyLang(); sync();
  btn.addEventListener('click', () => {
    LANG = LANG === 'en' ? 'zh' : 'en';
    localStorage.setItem(KEY, LANG);
    applyLang(); sync();
    if (onChange) onChange();
  });
}
