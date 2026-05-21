(function() {
  const checkbox = document.getElementById('theme-toggle-checkbox');
  const body = document.body;

  // 初始化：根据存储或系统偏好设置开关状态和主题
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  if (saved === 'dark' || (!saved && prefersDark)) {
    body.classList.add('dark');
    checkbox.checked = true;
  } else {
    body.classList.remove('dark');
    checkbox.checked = false;
  }

  // 监听系统主题变化（仅在用户未手动选择时）
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (!localStorage.getItem('theme')) {
      body.classList.toggle('dark', e.matches);
      checkbox.checked = e.matches;
    }
  });

  // 切换开关时更换主题并保存选择
  checkbox.addEventListener('change', () => {
    body.classList.toggle('dark', checkbox.checked);
    localStorage.setItem('theme', checkbox.checked ? 'dark' : 'light');
    // 注意：如果你还保留了 theme-transition.js 的侵蚀动画，它会继续处理过渡效果
  });
})();