import { initTheme } from './theme.js';
import { initI18n, t, applyLang } from './i18n.js';

const $ = id => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hide', !on);
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify(body || {}) });
  return [r.ok, await r.json().catch(() => ({}))];
};

async function refresh() {
  let auth;
  try {
    const r = await fetch('api/auth.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    auth = await r.json();
  } catch (e) {
    // 静态演示站没有后端, 设置页只能说明情况, 不能假装能用
    document.querySelector('.wrap').insertAdjacentHTML('beforeend',
      `<div class="card"><h2>需要后端</h2><p class="note" data-i18n>这是静态演示站，没有运行中的 routeros-lanpulse 后端，所以设置页不可用。<br>部署之后（<code>docker compose up -d</code>）这里就是配置编辑器和告警开关。</p></div>`);
    applyLang();
    return;
  }
  show('disabled', !auth.enabled);
  show('login', auth.enabled && !auth.authed);
  show('editor', auth.enabled && auth.authed);
  show('alerts', auth.enabled && auth.authed);
  show('btn-logout', auth.authed);
  if (auth.authed) { await loadToml(); await loadKinds(); }
}

async function loadToml() {
  const r = await fetch('api/settings.json', { cache: 'no-store' });
  if (!r.ok) return refresh();
  const d = await r.json();
  $('toml').value = d.toml;
  $('cfg-path').textContent = d.path;
  $('save-msg').textContent = '';
}

$('btn-login').onclick = async () => {
  const [ok, d] = await post('api/login', { password: $('pw').value });
  $('login-msg').textContent = ok ? '' : (d.error || t('登录失败'));
  $('login-msg').className = 'msg ' + (ok ? 'ok' : 'err');
  if (ok) { $('pw').value = ''; refresh(); }
};
$('pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-login').click(); });

$('btn-save').onclick = async () => {
  const b = $('btn-save'); b.disabled = true;
  const [ok, d] = await post('api/settings', { toml: $('toml').value });
  $('save-msg').textContent = d.message || d.error || (ok ? t('已保存') : t('保存失败'));
  $('save-msg').className = 'msg ' + (ok ? 'ok' : 'err');
  b.disabled = false;
};
async function loadKinds() {
  const r = await fetch('api/alerts/kinds.json', { cache: 'no-store' });
  if (!r.ok) return;
  const d = await r.json();
  $('kinds').innerHTML = (d.kinds || []).map(k => `
    <label class="kind">
      <span class="sw"><input type="checkbox" data-k="${k.key}" ${k.on ? 'checked' : ''}><i></i></span>
      <b>${k.key}</b><span class="desc">${t(k.desc)}</span>
    </label>`).join('');
  // 每次点击都把**全部**开关一起提交, 保证配置文件和界面始终一致
  $('kinds').querySelectorAll('input').forEach(el => el.onchange = saveKinds);
  applyLang();
}

async function saveKinds() {
  const kinds = {};
  $('kinds').querySelectorAll('input').forEach(el => { kinds[el.dataset.k] = el.checked; });
  const [ok, d] = await post('api/alerts/kinds', { kinds });
  $('test-msg').textContent = ok ? t('开关已保存') : (d.error || d.message || t('保存失败'));
  $('test-msg').className = 'msg ' + (ok ? 'ok' : 'err');
  if (!ok) loadKinds();          // 保存失败就退回服务端的真实状态, 别让界面骗人
}

$('btn-test').onclick = async () => {
  const b = $('btn-test'); b.disabled = true;
  $('test-msg').textContent = t('发送中…'); $('test-msg').className = 'msg';
  const [ok, d] = await post('api/alerts/test');
  const r = d.result || {};
  $('test-msg').textContent = ok
    ? Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' · ')
    : (d.error || t('测试失败'));
  // 只要有一个渠道报失败就标红, 免得"未启用"被当成成功
  const bad = !ok || Object.values(r).some(v => String(v).startsWith('失败'));
  $('test-msg').className = 'msg ' + (bad ? 'err' : 'ok');
  b.disabled = false;
};
$('btn-reload').onclick = loadToml;
$('btn-logout').onclick = async () => { await post('api/logout'); refresh(); };

initTheme($('btn-theme'));
initI18n($('btn-lang'), () => { loadKinds(); });
refresh();
