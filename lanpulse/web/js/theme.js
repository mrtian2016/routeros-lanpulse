// 主题: 暗/亮两套。默认跟随系统, 用户点过之后记在 localStorage。
// 真正的颜色全在 css/style.css 的 :root 和 :root[data-theme="light"] 里, 这里只管切换。
const KEY = 'lanpulse.theme';

export function currentTheme() {
  return localStorage.getItem(KEY)
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}

export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(KEY, t);
}

export function initTheme(btn) {
  const sync = () => { btn.textContent = currentTheme() === 'light' ? '🌙' : '☀'; };
  applyTheme(currentTheme());
  sync();
  btn.addEventListener('click', () => {
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    sync();
  });
}
