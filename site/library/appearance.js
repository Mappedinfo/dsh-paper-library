(() => {
  const key = 'paper-library.pages.palette';
  const theme = window.PaperLibraryTheme;
  const root = document.documentElement;

  function apply(value) {
    theme.setPalette(value);
    if (root.dataset.palette !== value) return;
    try { localStorage.setItem(key, value); } catch { /* 当前标签页仍可切换配色。 */ }
  }

  try { theme.setPalette(localStorage.getItem(key)); } catch { /* 使用工作台的默认配色。 */ }
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) theme.setPalette(event.newValue || 'jade');
  });
  window.PaperLibraryAppearance = { apply };
})();
