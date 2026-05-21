(function() {
  const toggle = document.getElementById('theme-toggle');
  const body = document.body;

  // 创建扩散圈元素
  const circle = document.createElement('div');
  circle.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 0; height: 0;
    border-radius: 50%;
    background: var(--ios-bg);
    pointer-events: none;
    z-index: 9999;
    transition: all 0.5s cubic-bezier(0.25, 0.1, 0.25, 1);
  `;
  document.body.appendChild(circle);

  toggle.addEventListener('click', function(e) {
    // 获取按钮中心坐标
    const rect = toggle.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // 计算扩散最大半径（覆盖对角线）
    const maxRadius = Math.sqrt(
      Math.pow(Math.max(x, window.innerWidth - x), 2) +
      Math.pow(Math.max(y, window.innerHeight - y), 2)
    );

    // 设置扩散圈初始状态（位于按钮中心，0半径）
    circle.style.left = x + 'px';
    circle.style.top = y + 'px';
    circle.style.width = '0px';
    circle.style.height = '0px';
    circle.style.transform = 'translate(-50%, -50%)';
    circle.style.background = getComputedStyle(body).getPropertyValue('--ios-bg').trim();
    circle.style.transition = 'none';
    circle.offsetHeight; // 强制回流
    circle.style.transition = 'all 0.5s cubic-bezier(0.25, 0.1, 0.25, 1)';

    // 扩散到全屏
    circle.style.width = maxRadius * 2 + 'px';
    circle.style.height = maxRadius * 2 + 'px';

    // 在动画一半时切换主题
    setTimeout(() => {
      body.classList.toggle('dark');
      const isDark = body.classList.contains('dark');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      // 更新扩散圈颜色为新主题背景
      circle.style.background = getComputedStyle(body).getPropertyValue('--ios-bg').trim();
    }, 250);

    // 动画结束后收起扩散圈
    setTimeout(() => {
      circle.style.width = '0px';
      circle.style.height = '0px';
    }, 500);
  });
})();