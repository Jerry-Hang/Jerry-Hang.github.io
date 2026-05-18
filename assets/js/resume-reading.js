// 保存阅读位置
function saveReadingPosition() {
  const url = window.location.pathname;
  const scrollY = window.scrollY;
  if (scrollY > 200) {  // 滚动超过200px才保存
    localStorage.setItem('pos_' + url, scrollY);
  }
}

// 恢复阅读位置
function restoreReadingPosition() {
  const url = window.location.pathname;
  const saved = localStorage.getItem('pos_' + url);
  if (saved) {
    window.scrollTo({ top: parseInt(saved), behavior: 'smooth' });
  }
}

// 监听滚动事件（防抖）
let timer;
window.addEventListener('scroll', () => {
  clearTimeout(timer);
  timer = setTimeout(saveReadingPosition, 200);
});

// 页面加载时如果 URL 带 ?resume=1 就恢复位置
if (window.location.search.includes('resume=1')) {
  window.addEventListener('load', () => {
    setTimeout(restoreReadingPosition, 300); // 等渲染完
  });
}

// 处理“继续阅读”点击：跳转到文章并带上 resume 参数
document.querySelectorAll('.resume-link').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const url = link.getAttribute('data-post-url');
    window.location.href = url + '?resume=1';
  });
});