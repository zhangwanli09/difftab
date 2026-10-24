// 安装框：每条命令旁一个 Copy 按钮。命令放在按钮外面的普通 <code> 里，没有 JS 时也能手动选中——
// 按钮里的文字 Firefox 拖不中、Chromium 拖动常被当成点击。按钮在 HTML 里是 hidden，由这里揭开，
// 没有 JS 时就不露出一个点了没反应的按钮。

for (const copy of document.querySelectorAll('[data-copy]')) {
  const cmd = copy.querySelector('[data-cmd]');
  const hint = copy.querySelector('[data-hint]');
  let reset;
  hint.hidden = false;
  hint.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(cmd.textContent);
      hint.textContent = 'Copied';
    } catch {
      // 非安全上下文或权限被拒：替用户选中命令，接着按一下复制键即可
      const range = document.createRange();
      range.selectNodeContents(cmd);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      hint.textContent = 'Selected';
    }
    clearTimeout(reset);
    reset = setTimeout(() => {
      hint.textContent = 'Copy';
    }, 1600);
  });
}
