(function() {
  const repo = 'Jerry-Hang/Jerry-Hang.github.io'; // 你的仓库
  const statsPanel = document.createElement('div');
  statsPanel.className = 'stats-panel';
  statsPanel.innerHTML = `
    <div class="stats-header">博客状态</div>
    <div class="stats-body">
      <p>⭐ Stars: <span id="stats-stars">加载中...</span></p>
      <p>🍴 Forks: <span id="stats-forks">...</span></p>
      <p>📅 最近更新: <span id="stats-updated">...</span></p>
      <p>📝 文章数量: ${document.querySelectorAll('.post-capsule').length}</p>
    </div>
  `;
  document.body.appendChild(statsPanel);

  // 触发按钮（可以放在侧边栏底部）
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'stats-toggle';
  toggleBtn.innerHTML = '📊';
  document.querySelector('.sidebar').appendChild(toggleBtn);

  toggleBtn.addEventListener('click', () => {
    statsPanel.classList.toggle('visible');
  });

  // 获取 GitHub 数据
  fetch(`https://api.github.com/repos/${repo}`)
    .then(res => res.json())
    .then(data => {
      document.getElementById('stats-stars').textContent = data.stargazers_count;
      document.getElementById('stats-forks').textContent = data.forks_count;
      document.getElementById('stats-updated').textContent = new Date(data.updated_at).toLocaleDateString('zh-CN');
    })
    .catch(() => {
      document.getElementById('stats-stars').textContent = '获取失败';
    });
})();