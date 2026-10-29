/* The caller owns draft protection and supplies the appropriate toolbar. */
(() => {
  function create({ host, prepare, onError = () => {} }) {
    const embedded = window.parent !== window;
    const hostedPage = !embedded && window.location.pathname.startsWith('/api/paper-library/');
    if (!host || !embedded && !hostedPage) return null;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'button subtle return-to-dsh';
    button.textContent = '返回 DSH'; button.title = '返回 DSH 主界面';
    button.setAttribute('aria-label', '返回 DSH 主界面');
    window.PaperIcons?.decorate(button, 'arrow-left');
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        if (await prepare() === true) {
          if (embedded) window.parent.postMessage({ type: 'paper-library:return-to-dsh', version: 1 }, window.location.origin);
          else window.location.assign('/');
        }
      } catch (error) { onError(error); }
      finally { button.disabled = false; }
    });
    host.prepend(button);
    return button;
  }
  window.PaperReturnToDsh = Object.freeze({ create });
})();
