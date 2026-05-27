(async function() {
  const postsPerPage = 12;
  let allPosts = [];
  let pinnedPosts = [];
  let currentPage = 1;

  // 从现有侧边栏胶囊数据获取文章信息（或者你可以在页面中通过模板输出 JSON）
  // 这里我们采用更直接的方式：解析侧边栏中的胶囊数据来构建列表（仅限首页）
  const sidebarCapsules = document.querySelectorAll('.post-capsule');
  if (sidebarCapsules.length === 0) {
    // 如果侧边栏没有胶囊（比如文章页），就不显示分页
    return;
  }

  // 构建文章数据数组
  sidebarCapsules.forEach(cap => {
    const title = cap.querySelector('.capsule-title').textContent;
    const excerpt = cap.querySelector('.capsule-excerpt')?.innerHTML || '';
    const tags = cap.querySelector('.capsule-tags')?.innerHTML || '';
    const meta = cap.querySelector('.capsule-meta')?.innerHTML || '';
    const resume = cap.querySelector('.resume-link')?.outerHTML || '';
    const url = cap.getAttribute('href');
    const pin = cap.getAttribute('data-pin') === 'true'; // 可在胶囊上添加 data-pin 属性
    const post = { title, excerpt, tags, meta, resume, url, pin };
    if (pin) pinnedPosts.push(post);
    else allPosts.push(post);
  });

  // 合并：置顶在前，普通在后
  const mergedPosts = [...pinnedPosts, ...allPosts];
  const totalPages = Math.ceil(mergedPosts.length / postsPerPage);

  function renderPosts(page) {
    const start = (page - 1) * postsPerPage;
    const end = start + postsPerPage;
    const pagePosts = mergedPosts.slice(start, end);
    const list = document.getElementById('post-list');
    if (!list) return;
    list.innerHTML = pagePosts.map(post => `
      <li>
        <a href="${post.url}" class="post-capsule">
          <span class="capsule-title">${post.title}</span>
          <p class="capsule-excerpt">${post.excerpt}</p>
          ${post.tags ? `<div class="capsule-tags">${post.tags}</div>` : ''}
          <span class="capsule-meta">${post.meta}</span>
          <span class="resume-link" data-post-url="${post.url}">↻ 继续阅读</span>
        </a>
      </li>
    `).join('');
    // 渲染分页导航
    renderPagination(page, totalPages);
  }

  function renderPagination(current, total) {
    const container = document.getElementById('pagination');
    if (!container) return;
    let html = '';
    html += `<span>第 ${current} 页 / 共 ${total} 页</span>`;
    if (current > 1) html += `<a href="#" class="page-link" data-page="${current-1}">上一页</a>`;
    if (current < total) html += `<a href="#" class="page-link" data-page="${current+1}">下一页</a>`;
    container.innerHTML = html;

    // 绑定点击事件
    document.querySelectorAll('.page-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        const page = parseInt(link.dataset.page);
        if (page >= 1 && page <= total) {
          currentPage = page;
          renderPosts(page);
        }
      });
    });
  }

  // 初始渲染第1页
  renderPosts(currentPage);
})();