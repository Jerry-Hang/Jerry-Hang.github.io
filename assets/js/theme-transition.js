(function() {
  const checkbox = document.getElementById('theme-toggle-checkbox');
  const body = document.body;

  // 创建扩散圈
  const circle = document.createElement('div');
  circle.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 0; height: 0;
    border-radius: 50%;
    pointer-events: none;
    z-index: 9999;
    transform: translate(-50%, -50%);
    background: #000; /* 临时色，会动态更新 */
    transition: none;
  `;
  document.body.appendChild(circle);

  checkbox.addEventListener('change', function(e) {
    const toggleLabel = checkbox.closest('.ios-toggle');
    const rect = toggleLabel.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // 最大半径覆盖屏幕对角线
    const maxRadius = Math.sqrt(
      Math.pow(Math.max(x, window.innerWidth - x), 2) +
      Math.pow(Math.max(y, window.innerHeight - y), 2)
    );

    // 重置扩散圈
    circle.style.transition = 'none';
    circle.style.left = x + 'px';
    circle.style.top = y + 'px';
    circle.style.width = '0';
    circle.style.height = '0';
    // 根据将要切换到的主题，提前设置扩散圈颜色为相反主题背景色，让扩散过程清晰
    const isDark = body.classList.contains('dark'); // 当前是暗色，将切换到亮色
    circle.style.background = isDark ? '#f2f2f7' : '#0a0a0a'; // 亮/暗背景色
    circle.offsetHeight; // 强制回流

    // 开始扩散
    circle.style.transition = 'width 0.6s cubic-bezier(0.25, 0.1, 0.25, 1), height 0.6s cubic-bezier(0.25, 0.1, 0.25, 1)';
    circle.style.width = maxRadius * 2 + 'px';
    circle.style.height = maxRadius * 2 + 'px';

    // 扩散到一半时切换主题，并在动画完成后收回
    setTimeout(() => {
      body.classList.toggle('dark');
      localStorage.setItem('theme', body.classList.contains('dark') ? 'dark' : 'light');
      // 主题切换后，更新扩散圈颜色为新背景，准备收回
      circle.style.background = getComputedStyle(body).getPropertyValue('--ios-bg').trim();
    }, 250);

    setTimeout(() => {
      circle.style.width = '0';
      circle.style.height = '0';
    }, 600);
  });
})();