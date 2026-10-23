// 安装框：切换包管理器、点一下复制。没有 JS 时页面照常显示 npm 那条命令，只是不能切换。

const COMMANDS = {
  npm: 'npm i -g difftab',
  pnpm: 'pnpm add -g difftab',
  npx: 'npx difftab',
};

const tabs = document.querySelectorAll('[data-pm]');
const copy = document.querySelector('[data-copy]');
const cmd = document.querySelector('[data-cmd]');
const hint = document.querySelector('[data-hint]');

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    for (const t of tabs) t.setAttribute('aria-pressed', String(t === tab));
    cmd.textContent = COMMANDS[tab.dataset.pm];
  });
}

let reset;
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cmd.textContent);
    hint.textContent = 'Copied';
  } catch {
    // 非安全上下文或权限被拒：命令本身就在框里，手动选中即可
    hint.textContent = 'Select to copy';
  }
  clearTimeout(reset);
  reset = setTimeout(() => {
    hint.textContent = 'Copy';
  }, 1600);
});
