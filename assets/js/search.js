document.getElementById('post-search').addEventListener('input', function(e) {
  const term = e.target.value.toLowerCase().trim();
  const capsules = document.querySelectorAll('.post-capsule');
  capsules.forEach(cap => {
    const title = cap.querySelector('.capsule-title').textContent.toLowerCase();
    const excerpt = cap.querySelector('.capsule-excerpt')?.textContent.toLowerCase() || '';
    const visible = title.includes(term) || excerpt.includes(term);
    cap.closest('li').style.display = visible ? '' : 'none';
  });
});