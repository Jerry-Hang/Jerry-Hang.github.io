// 计算文章真实字数（剔除空白和标点的纯字符数，可自行调整）
function countChars(text) {
  // 只保留中文字、英文字母、数字，过滤掉空格换行和标点符号
  const cleaned = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  return cleaned.length;
}

// 获取文章内容并更新对应胶囊的字数
async function updateCharCounts() {
  const charSpans = document.querySelectorAll('.char-count');
  for (const span of charSpans) {
    const url = span.getAttribute('data-article-url');
    if (!url) continue;
    try {
      const response = await fetch(url);
      const html = await response.text();
      // 从返回的 HTML 中提取文章主体（假设在 .glass-panel 或 .post-content 中）
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const contentEl = doc.querySelector('.glass-panel, .post-content, .page-content');
      if (contentEl) {
        const text = contentEl.textContent;
        const charNum = countChars(text);
        span.textContent = charNum + ' 字';
      } else {
        span.textContent = '-- 字';
      }
    } catch (e) {
      span.textContent = '-- 字';
    }
  }
}

// 页面加载完成后执行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateCharCounts);
} else {
  updateCharCounts();
}