(function() {
  const postsPerPage = 12;
  const dataEl = document.getElementById('post-data');
  if (!dataEl) return;
  
  const allPosts = JSON.parse(dataEl.textContent);
  // 按置顶优先、日期倒序排序（日期越新越靠前）
  allPosts.sort((a, b) => {
    if (a.pin && !b.pin) return -1;
    if (!a.pin && b.pin) return 1;
    return new Date(b.date) - new Date(a.date);
  });

  let currentPage = 1;
  let pinnedPosts = allPosts.filter(p => p.pin);
  let normalPosts = allPosts.filter(p => !p.pin);
  let totalPages = Math.ceil(normalPosts.length / postsPerPage);

  function renderPostCard(post) {
    const tagsHtml = post.tags.length > 0 
      ? `<div class="capsule-tags">${post.tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` 
      : '';
    return `
      <li>
        <a href="${post.url}" class="post-capsule">
          <span class="capsule-title">${post.title}</span>
          <p class="capsule-excerpt">${post.excerpt}</p>
          ${tagsHtml}
          <span class="capsule-meta">
            <time datetime="${post.date}">${post.date.slice(5)}</time>
            <span class="meta-sep">·</span>
            <span>${post.wordCount} 字</span>
            <span class="meta-sep">·</span>
            <span>${post.readingTime} 分钟</span>
            <span class="meta-sep">·</span>
            <span class="pageviews">-- 阅读</span>
          </span>
          <span class="resume-link" data-post-url="${post.url}">↻ 继续阅读</span>
        </a>
      </li>
    `;
  }

  function renderPinned() {
    const container = document.getElementById('pinned-posts');
    if (!container || pinnedPosts.length === 0) {
      if (container) container.style.display = 'none';
      return;
    }
    container.innerHTML = `
      <h3>📌 置顶文章</h3>
      <ul class="post-list">
        ${pinnedPosts.map(post => renderPostCard(post)).join('')}
      </ul>
    `;
  }

  function renderPage(page) {
    const start = (page - 1) * postsPerPage;
    const pagePosts = normalPosts.slice(start, start + postsPerPage);
    document.getElementById('post-list').innerHTML = pagePosts.map(renderPostCard).join('');
    renderPagination();
  }

  function renderPagination() {
    const container = document.getElementById('pagination');
    if (!container || totalPages <= 1) {
      if (container) container.innerHTML = '';
      return;
    }
    let html = `<span>第 ${currentPage} 页 / 共 ${totalPages} 页</span>`;
    if (currentPage > 1) {
      html += `<a href="#" class="page-link" data-page="${currentPage - 1}">上一页</a>`;
    }
    if (currentPage < totalPages) {
      html += `<a href="#" class="page-link" data-page="${currentPage + 1}">下一页</a>`;
    }
    container.innerHTML = html;

    document.querySelectorAll('.page-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        const p = parseInt(link.dataset.page);
        if (p >= 1 && p <= totalPages) {
          currentPage = p;
          renderPage(p);
          document.getElementById('post-list-container').scrollIntoView({ behavior: 'smooth' });
        }
      });
    });
  }

  // 启动
  renderPinned();
  renderPage(1);
})();