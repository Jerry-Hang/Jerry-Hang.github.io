(function() {
  const toggle = document.getElementById('theme-toggle');
  const body = document.body;

  // 读取用户之前的选择
  const saved = localStorage.getItem('theme');
  if (saved === 'dark') {
    body.classList.add('dark');
  } else if (saved === 'light') {
    body.classList.remove('dark');
  } else {
    // 跟随系统
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) body.classList.add('dark');
  }

  // 监听系统变化（当用户未手动选择时）
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (!localStorage.getItem('theme')) {
      body.classList.toggle('dark', e.matches);
    }
  });

  // 点击切换
  toggle.addEventListener('click', () => {
    body.classList.toggle('dark');
    const isDark = body.classList.contains('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });
})();