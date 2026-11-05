// Home page: client-side filter by title/description and an "only mine" toggle.
(function () {
  const input = document.getElementById('bp-filter');
  const mine = document.getElementById('bp-mine');
  const items = Array.from(document.querySelectorAll('#bp-grid [data-bp]'));
  const none = document.getElementById('bp-none');
  if (!input) return;
  const apply = () => {
    const q = input.value.trim().toLowerCase();
    const only = mine && mine.getAttribute('aria-pressed') === 'true';
    let shown = 0;
    items.forEach((el) => {
      const ok = (!q || el.dataset.bp.includes(q)) && (!only || el.dataset.granted === 'true');
      el.hidden = !ok;
      el.classList.toggle('contents', ok);
      if (ok) shown++;
    });
    none.classList.toggle('hidden', shown > 0);
  };
  input.addEventListener('input', apply);
  if (mine) mine.addEventListener('click', () => { mine.setAttribute('aria-pressed', mine.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); apply(); });
})();
