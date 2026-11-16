// Small progressive enhancements shared by every page. No inline handlers: the CSP blocks them.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---- toasts: window.toast('Saved', 'success' | 'error' | 'info'); shown top right under the navbar ----
  const ICON = {
    success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>',
  };
  window.toast = function (msg, type, undo) {
    const box = $('#toasts');
    if (!box || !msg) return;
    type = ICON[type] ? type : 'success';
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ico.setAttribute('viewBox', '0 0 24 24'); ico.setAttribute('class', 'mt-0.5 size-5 shrink-0'); ico.setAttribute('aria-hidden', 'true');
    ico.setAttribute('fill', 'none'); ico.setAttribute('stroke', 'currentColor'); ico.setAttribute('stroke-width', '2');
    ico.setAttribute('stroke-linecap', 'round'); ico.setAttribute('stroke-linejoin', 'round');
    ico.innerHTML = ICON[type]; // static strings above, never user input
    const text = document.createElement('span');
    text.className = 'flex-1';
    text.textContent = msg;
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    const dismiss = () => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 200); };
    close.addEventListener('click', dismiss);
    t.append(ico, text);
    if (undo) { // "Undo" posts the reverse action, then reloads so the page shows the restored state
      const u = document.createElement('button');
      u.type = 'button'; u.className = 'toast-undo'; u.textContent = 'Undo';
      u.addEventListener('click', async () => {
        u.disabled = true; u.textContent = 'Undoing…';
        try {
          const token = ($('meta[name=csrf-token]') || {}).content || '';
          // redirect: 'manual' keeps the server's confirmation (its flash cookie is set on the 302) for the reload below
          const r = await fetch(undo.url, { method: 'POST', credentials: 'same-origin', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `_csrf=${encodeURIComponent(token)}${undo.body ? '&' + undo.body : ''}` });
          if (!r.ok && r.type !== 'opaqueredirect') throw new Error('failed');
          location.reload();
        } catch { u.disabled = false; u.textContent = 'Undo'; window.toast('Could not undo. Try again from the Trash.', 'error'); }
      });
      text.after(u);
    }
    t.append(close);
    box.append(t);
    // Errors stay longer; hovering a toast pauses its timer.
    let timer = setTimeout(dismiss, type === 'error' ? 8000 : undo ? 9000 : 4500);
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 2500); });
  };
  // The server only sends a plain message, so pick the tone from its wording.
  const toneOf = (m) => /cannot|can't|not found|fail|invalid|error|expired|too large|denied|select at least|incorrect|unable/i.test(m) ? 'error'
    : /already|no changes|identical/i.test(m) ? 'info' : 'success';

  // ---- confirm dialog: <form data-confirm="Delete X?" data-confirm-action="Delete"> ----
  let confirmed = null;
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const msg = form.dataset && form.dataset.confirm;
    if (msg && confirmed !== form) {
      e.preventDefault();
      openConfirm(form, msg, e.submitter);
      return;
    }
    confirmed = null;
    const btn = e.submitter || $('button:not([type=button])', form);
    if (btn) {
      const w = btn.offsetWidth; // keep the width so the button does not jump when the label changes
      setTimeout(() => {
        btn.setAttribute('aria-busy', 'true');
        if (w) btn.style.minWidth = w + 'px';
        if (btn.dataset.busy) { btn.dataset.label = btn.innerHTML; btn.textContent = btn.dataset.busy; }
      }, 0); // after submit starts, so the click still counts
    }
  });
  window.addEventListener('pageshow', () => $$('[aria-busy]').forEach((b) => { // back button
    b.removeAttribute('aria-busy'); b.style.minWidth = '';
    if (b.dataset.label) { b.innerHTML = b.dataset.label; delete b.dataset.label; }
  }));

  function openConfirm(form, msg, submitter) {
    // Red confirm button for anything destructive: judged by the trigger's style and by the wording of the dialog.
    const danger = form.querySelector('.link-danger, .btn-danger, .ibtn-danger') || /delete|revoke|trash|remove|un-assign/i.test(`${msg} ${form.dataset.confirmTitle || ''} ${form.dataset.confirmAction || ''}`);
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.setAttribute('aria-labelledby', 'confirm-title');
    const wrap = document.createElement('div');
    wrap.className = 'p-5';
    const h = document.createElement('h2');
    h.id = 'confirm-title';
    h.className = 'text-base font-semibold';
    h.textContent = form.dataset.confirmTitle || 'Are you sure?';
    const p = document.createElement('p');
    p.className = 'mt-2 text-sm text-slate-600 dark:text-slate-300';
    p.textContent = msg;
    const row = document.createElement('div');
    row.className = 'mt-5 flex justify-end gap-2';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn' + (danger ? ' btn-danger' : '');
    ok.textContent = form.dataset.confirmAction || (danger ? 'Delete' : 'Confirm');
    row.append(cancel, ok);
    wrap.append(h, p, row);
    d.append(wrap);
    document.body.append(d);
    const close = () => { d.close(); d.remove(); };
    cancel.addEventListener('click', close);
    d.addEventListener('cancel', () => setTimeout(() => d.remove(), 0));
    d.addEventListener('click', (ev) => { if (ev.target === d) close(); });
    ok.addEventListener('click', () => { confirmed = form; close(); form.requestSubmit(submitter || undefined); });
    if (d.showModal) d.showModal(); else if (window.confirm(msg)) { d.remove(); confirmed = form; form.requestSubmit(submitter || undefined); }
    cancel.focus();
  }

  // ---- header menus (<details data-menu>): one open at a time, close on outside click / Esc ----
  const menus = $$('details[data-menu]');
  menus.forEach((m) => m.addEventListener('toggle', () => { if (m.open) menus.forEach((o) => { if (o !== m) o.open = false; }); }));
  document.addEventListener('click', (e) => menus.forEach((m) => { if (m.open && !m.contains(e.target)) m.open = false; }));
  menus.forEach((m) => m.addEventListener('keydown', (e) => { // arrow keys move through the items
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const items = $$('a, button', m).filter((x) => x.offsetParent);
    if (!items.length) return;
    if (!m.open && e.target === $('summary', m) && e.key === 'ArrowDown') m.open = true;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
    items[n].focus();
  }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menus.forEach((m) => { if (m.open) { m.open = false; $('summary', m).focus(); } });
  });

  // Sticky table headers sit just below the sticky page header, whatever height it has (it wraps on phones).
  const pageHeader = $('body > header');
  if (pageHeader) {
    const setHdr = () => document.documentElement.style.setProperty('--hdr', `${pageHeader.offsetHeight}px`);
    setHdr();
    if (window.ResizeObserver) new ResizeObserver(setHdr).observe(pageHeader); else window.addEventListener('resize', setHdr);
  }

  // Row menus sit inside scrolling tables, so they are positioned against the viewport instead of the cell.
  $$('details.rowmenu').forEach((m) => {
    const menu = $('.menu', m);
    const place = () => {
      const r = $('summary', m).getBoundingClientRect();
      const up = r.bottom + menu.offsetHeight + 12 > innerHeight && r.top > menu.offsetHeight + 12;
      Object.assign(menu.style, { position: 'fixed', left: 'auto', right: `${Math.max(8, innerWidth - r.right)}px`, top: up ? `${r.top - menu.offsetHeight - 4}px` : `${r.bottom + 4}px`, marginTop: '0' });
    };
    m.addEventListener('toggle', () => { if (m.open) place(); });
    ['scroll', 'resize'].forEach((ev) => window.addEventListener(ev, () => { if (m.open) m.open = false; }, { passive: true }));
  });

  // ---- theme toggle ----
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const root = document.documentElement;
    const dark = !root.classList.contains('dark');
    const apply = () => root.classList.toggle('dark', dark);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) apply();
    else if (document.startViewTransition) document.startViewTransition(apply); // cross-fades the whole page at once
    else { // fallback: briefly animate colours on every element so they change together
      root.classList.add('theme-anim');
      apply();
      setTimeout(() => root.classList.remove('theme-anim'), 400);
    }
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* storage unavailable */ }
  });

  // ---- command palette: Ctrl/Cmd+K jumps to any page, blueprint or endpoint ----
  (function palette() {
    const data = $('#cmd-data');
    if (!data || typeof HTMLDialogElement === 'undefined') return;
    let cmds = [];
    try { cmds = JSON.parse(data.dataset.cmds); } catch { return; }
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const dlg = mk('dialog', 'm-auto mt-[12vh] w-[min(36rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100');
    dlg.setAttribute('aria-label', 'Command palette');
    const input = mk('input', 'w-full rounded-t-xl border-0 border-b border-slate-200 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-slate-500 dark:border-slate-700');
    input.type = 'text'; input.placeholder = 'Jump to a page, blueprint or endpoint…'; input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'palette-list'); input.setAttribute('aria-label', 'Search commands');
    const list = mk('div', 'max-h-[50vh] overflow-auto p-1.5'); list.id = 'palette-list'; list.setAttribute('role', 'listbox');
    const foot = mk('div', 'border-t border-slate-200 px-4 py-2 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-400', '↑ ↓ to move · Enter to open · Esc to close');
    dlg.append(input, list, foot);
    document.body.append(dlg);
    let items = [], at = 0, remote = [], seq = 0, timer;
    const run = (it) => {
      dlg.close();
      if (it.a === 'theme') { const b = $('[data-theme-toggle]'); if (b) b.click(); } else if (it.h) location.href = it.h;
    };
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      const local = cmds.filter((c) => !q || c.t.toLowerCase().includes(q) || c.g.toLowerCase().includes(q));
      items = local.concat(remote);
      at = Math.min(at, Math.max(0, items.length - 1));
      list.replaceChildren(...(items.length ? items.map((it, i) => {
        const row = mk('div', `flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm ${i === at ? 'bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-400' : ''}`);
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === at)); row.id = `pal-${i}`;
        row.append(mk('span', 'min-w-0 truncate', it.t), mk('span', 'shrink-0 text-xs text-slate-500 dark:text-slate-400', it.g));
        row.addEventListener('mousemove', () => { if (at !== i) { at = i; paint(); } });
        row.addEventListener('click', () => run(it));
        return row;
      }) : [mk('p', 'px-3 py-4 text-sm text-slate-600 dark:text-slate-400', 'No matches.')]));
      input.setAttribute('aria-activedescendant', items.length ? `pal-${at}` : '');
      const cur = $(`#pal-${at}`, list); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => {
      at = 0; paint(); clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { remote = []; paint(); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const d = await (await fetch(`/search/suggest?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' })).json();
          if (mine !== seq) return;
          remote = d.blueprints.map((b) => ({ t: b.title, h: `/blueprints/${b.id}`, g: 'Blueprint' }))
            .concat(d.endpoints.map((e) => ({ t: `${e.method} ${e.path}`, h: e.href, g: e.blueprint })));
          paint();
        } catch { /* offline: local commands still work */ }
      }, 180);
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { at = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; paint(); } }
      else if (e.key === 'Enter' && items[at]) { e.preventDefault(); run(items[at]); }
    });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (dlg.open) { dlg.close(); return; }
        input.value = ''; remote = []; at = 0; paint(); dlg.showModal(); input.focus();
      }
    });
  })();

  // ---- global search shortcuts: "/" focuses the search box ----
  document.addEventListener('keydown', (e) => {
    const input = $('[data-global-search]');
    if (!input) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  // ---- password fields: show/hide toggle + confirm-match check ----
  $$('input[type=password]').forEach((input) => {
    const wrap = document.createElement('span');
    wrap.className = 'relative block';
    input.before(wrap);
    wrap.append(input);
    input.classList.add('!pr-16');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'absolute right-2 top-1/2 mt-0.5 -translate-y-1/2 rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800';
    b.textContent = 'Show';
    b.setAttribute('aria-label', 'Show password');
    b.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    wrap.append(b);
  });
  $$('input[name=confirm]').forEach((c) => {
    const p = c.form && $('input[name=password]', c.form);
    if (!p) return;
    const check = () => c.setCustomValidity(c.value && c.value !== p.value ? 'Passwords do not match' : '');
    c.addEventListener('input', check); p.addEventListener('input', check);
  });

  // ---- inline validity: mark invalid fields after the first blur, focus the first one on a failed submit ----
  document.addEventListener('invalid', (e) => {
    const f = e.target;
    f.setAttribute('aria-invalid', 'true');
    f.addEventListener('input', () => f.removeAttribute('aria-invalid'), { once: true });
  }, true);

  // ---- server messages: flash (cookie) and form errors become toasts; errors also stay inline beside the form ----
  const err = $('.alert-error');
  if (err) { err.setAttribute('role', 'alert'); window.toast(err.textContent.trim(), 'error'); }
  const flash = $('[data-flash]');
  if (flash) {
    window.toast(flash.textContent.trim(), flash.dataset.flashType || toneOf(flash.textContent), flash.dataset.undoUrl ? { url: flash.dataset.undoUrl, body: flash.dataset.undoBody || '' } : null);
    flash.remove();
  }


  // ---- sortable tables: <table data-sortable>; header click toggles ascending/descending ----
  $$('table[data-sortable]').forEach((table) => {
    const body = table.tBodies[0];
    $$('thead th', table).forEach((th, col) => {
      const label = th.textContent.trim();
      if (!label) return;
      th.setAttribute('aria-sort', 'none');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-slate-900 dark:hover:text-white';
      const arrow = document.createElement('span');
      arrow.setAttribute('aria-hidden', 'true');
      b.append(label, arrow);
      th.replaceChildren(b);
      b.addEventListener('click', () => {
        const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
        $$('thead th', table).forEach((o) => { o.setAttribute('aria-sort', 'none'); const a = o.querySelector('span'); if (a) a.textContent = ''; });
        th.setAttribute('aria-sort', dir);
        arrow.textContent = dir === 'ascending' ? '↑' : '↓';
        const val = (tr) => (tr.cells[col] ? tr.cells[col].textContent.trim() : '');
        const rows = Array.from(body.rows).sort((a, c) => {
          const x = val(a), y = val(c);
          const n = Number(x) - Number(y);
          return (Number.isNaN(n) || x === '' || y === '' ? x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) : n) * (dir === 'ascending' ? 1 : -1);
        });
        rows.forEach((r) => body.append(r));
      });
    });
  });

  // ---- table filter: <input data-table-filter="#tableId"> hides non-matching rows ----
  $$('[data-table-filter]').forEach((input) => {
    const table = $(input.dataset.tableFilter);
    if (!table) return;
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      Array.from(table.tBodies[0].rows).forEach((r) => { r.hidden = !!q && !r.textContent.toLowerCase().includes(q); });
    });
  });

  // File drop strip: the file's text is loaded into the editor, so it is validated and editable like pasted text.
  $$('[data-drop]').forEach((zone) => {
    const input = $('input[type=file]', zone);
    const ta = $('textarea[data-editor]');
    const MAX = 5 * 1024 * 1024;
    const on = ['border-brand-500', 'bg-brand-50', 'dark:bg-slate-800'];
    const load = async (f) => {
      if (!f) return;
      if (f.size > MAX) return window.toast('File is larger than 5 MB.', 'error');
      if (ta.value.trim() && ta.value !== ta.defaultValue && !confirm(`Replace the current content with ${f.name}?`)) return;
      ta.dispatchEvent(new CustomEvent('editor:load', { detail: await f.text() }));
      window.toast(`Loaded ${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`);
    };
    input.addEventListener('change', async () => { await load(input.files[0]); input.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add(...on); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove(...on)));
    zone.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) load(e.dataTransfer.files[0]); });
  });

  // ---- email chips preview for the invite form: valid emails neutral, invalid ones red ----
  $$('[data-email-chips]').forEach((ta) => {
    const box = $(ta.dataset.emailChips);
    const render = () => {
      const items = ta.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      const seen = new Set();
      box.replaceChildren(...items.map((x) => {
        const bad = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
        const dup = seen.has(x.toLowerCase());
        seen.add(x.toLowerCase());
        const c = document.createElement('span');
        c.className = 'badge ' + (bad || dup ? 'badge-bad' : 'badge-neutral');
        c.textContent = (bad ? '✕ ' : dup ? '✕ ' : '') + x + (bad ? ' (invalid)' : dup ? ' (duplicate)' : '');
        return c;
      }));
    };
    ta.addEventListener('input', render);
    render();
  });

  // ---- tag picker: type a few letters, pick from a short list, get a removable chip (one hidden input per chip) ----
  // <div data-tag-picker data-src="/url" data-name="field" data-min="3">: the endpoint answers { items: [{ id, title }] } and takes ?q= and ?exclude=1,2.
  $$('[data-tag-picker]').forEach((box) => {
    const input = $('input[type=text]', box), tags = $('[data-tags]', box), list = $('[role=listbox]', box), status = $('[data-tag-status]', box);
    const min = Number(box.dataset.min) || 3, name = box.dataset.name, src = box.dataset.src;
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const hint = status.textContent;
    let items = [], at = -1, seq = 0, timer = 0;
    const picked = () => $$(`[data-tag] input[name="${name}"]`, box).map((i) => i.value);
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); at = -1; };
    const mark = (i) => {
      at = i;
      $$('[role=option]', list).forEach((o, k) => { o.setAttribute('aria-selected', String(k === i)); o.classList.toggle('bg-brand-50', k === i); o.classList.toggle('dark:bg-slate-800', k === i); });
      if (i >= 0) { input.setAttribute('aria-activedescendant', `${list.id}-${i}`); const cur = $(`#${list.id}-${i}`, list); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' }); }
    };
    const add = (it) => {
      if (picked().includes(String(it.id))) return;
      const chip = mk('span', 'chip'); chip.setAttribute('data-tag', '');
      const hid = mk('input'); hid.type = 'hidden'; hid.name = name; hid.value = String(it.id);
      const x = mk('button', null, '×'); x.type = 'button'; x.setAttribute('aria-label', `Remove ${it.title}`);
      const label = mk('span', 'max-w-56 truncate', it.title); label.title = it.title;
      chip.append(hid, label, x); input.before(chip);
      input.value = ''; close(); input.focus(); status.textContent = `Added ${it.title}.`;
    };
    tags.addEventListener('click', (e) => { // drop a chip (works for the server-rendered ones too)
      const b = e.target.closest('[data-tag] button');
      if (b) { const chip = b.closest('[data-tag]'); const t = chip.querySelector('span').textContent; chip.remove(); status.textContent = `Removed ${t}.`; }
      input.focus();
    });
    const paint = () => {
      list.replaceChildren(...(items.length ? items.map((it, i) => {
        const o = mk('div', 'flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800');
        o.id = `${list.id}-${i}`; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', 'false');
        const text = mk('span', 'min-w-0 flex-1');
        text.append(mk('span', 'block truncate font-medium', it.title), mk('span', 'block truncate text-xs text-slate-600 dark:text-slate-400', (it.description || '').replace(/\s+/g, ' ').trim() || 'No description'));
        o.title = it.description ? `${it.title}: ${it.description}` : it.title;
        o.append(text, mk('span', 'shrink-0 self-start text-xs text-slate-600 dark:text-slate-400', it.version ? `v${it.version}` : ''));
        o.addEventListener('mousedown', (e) => { e.preventDefault(); add(it); }); // mousedown: runs before the input loses focus
        return o;
      }) : [mk('p', 'px-3 py-2 text-sm text-slate-600 dark:text-slate-400', 'No blueprints match.')]));
      list.hidden = false; input.setAttribute('aria-expanded', 'true'); mark(items.length ? 0 : -1);
      status.textContent = items.length ? `${items.length} match${items.length === 1 ? '' : 'es'}. Use the arrow keys and Enter.` : 'No blueprints match.';
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < min) { close(); status.textContent = q ? `Type ${min - q.length} more letter${min - q.length === 1 ? '' : 's'}.` : hint; return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const r = await (await fetch(`${src}?q=${encodeURIComponent(q)}&exclude=${picked().join(',')}`, { credentials: 'same-origin' })).json();
          if (mine !== seq) return;
          items = r.items || []; paint();
        } catch { close(); status.textContent = 'Could not load blueprints. Try again.'; }
      }, 200);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!list.hidden && items.length) { e.preventDefault(); mark((at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (!list.hidden && items[at]) add(items[at]); } // Enter never submits the form from this field
      else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); } }
      else if (e.key === 'Backspace' && !input.value) { const last = $$('[data-tag]', box).pop(); if (last) last.remove(); }
    });
    input.addEventListener('blur', close);
  });


  // ---- bulk selection on the requests page ----
  const all = $('[data-bulk-all]');
  if (all) {
    const rows = $$('[data-bulk-row]');
    const sync = () => {
      const n = rows.filter((r) => r.checked).length;
      $('[data-bulk-count]').textContent = `${n} selected`;
      $$('[data-bulk-btn]').forEach((b) => { b.disabled = n === 0; });
      $$('[data-bulk-autohide]').forEach((f) => { f.hidden = n === 0; }); // lists with many rows: show the bar only once something is ticked
      all.checked = n === rows.length;
      all.indeterminate = n > 0 && n < rows.length;
    };
    all.addEventListener('change', () => { rows.forEach((r) => { r.checked = all.checked; }); sync(); });
    rows.forEach((r) => r.addEventListener('change', sync));
  }

  // ---- spec editor: <textarea data-editor> gets line numbers, indent keys, a toolbar and a status bar ----
  $$('textarea[data-editor]').forEach((ta) => {
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    const STARTER = 'openapi: 3.0.3\ninfo:\n  title: My API\n  version: 1.0.0\npaths:\n  /health:\n    get:\n      summary: Health check\n      responses:\n        "200":\n          description: OK\n';
    const wrap = el('div', 'mb-4 mt-1 overflow-hidden rounded-lg border border-slate-300 bg-white focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950');
    const bar = el('div', 'flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900');
    const body = el('div', 'flex items-start');
    const gutter = el('div', 'relative min-w-[3rem] shrink-0 select-none overflow-hidden whitespace-pre bg-slate-50 py-2 pl-3 pr-2 text-right font-mono text-xs leading-5 text-slate-500 dark:bg-slate-900 dark:text-slate-400');
    gutter.setAttribute('aria-hidden', 'true');
    const nums = el('span'); gutter.append(nums);
    const status = el('div', 'flex flex-wrap justify-between gap-2 border-t border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400');
    const pos = el('span'), size = el('span');
    const hint = el('span', 'hidden sm:inline', 'Tab indents · Esc then Tab leaves the editor');
    status.append(pos, hint, size);
    const tool = (label, title, fn) => {
      const b = el('button', 'rounded px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-brand-500 dark:text-slate-300 dark:hover:bg-slate-800', label);
      b.type = 'button'; b.title = title; b.addEventListener('click', () => { fn(); ta.focus(); });
      bar.append(b); return b;
    };
    // Syntax colours: a <pre> sits behind the (transparent-text) textarea and is scrolled in step with it.
    ta.className = 'editor-ta relative block w-full resize-y border-0 bg-transparent px-3 py-2 font-mono text-xs leading-5 text-transparent caret-slate-900 outline-none selection:bg-brand-500/30 dark:caret-slate-100';
    ta.style.height = 'clamp(18rem, 55vh, 38rem)'; // follows the window instead of a fixed 22 rows; still drag-resizable
    const field = el('div', 'relative min-w-0 flex-1');
    const layer = el('div', 'pointer-events-none absolute inset-0 overflow-hidden');
    layer.setAttribute('aria-hidden', 'true');
    const errBar = el('div', 'absolute inset-x-0 hidden h-5 bg-red-500/15');
    const pre = el('pre', 'px-3 py-2 font-mono text-xs leading-5 text-slate-800 dark:text-slate-200');
    const inner = el('div', 'relative min-w-max'); inner.append(errBar, pre); layer.append(inner);
    ta.parentNode.insertBefore(wrap, ta);
    const empty = el('div', 'pointer-events-none absolute inset-x-0 top-0 px-3 py-2 text-xs leading-5 text-slate-400 dark:text-slate-500');
    empty.textContent = ta.getAttribute('placeholder') || ''; ta.removeAttribute('placeholder'); empty.setAttribute('aria-hidden', 'true');
    field.append(layer, ta, empty);
    body.append(gutter, field); wrap.append(bar, body, status);
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const COLORS = { key: 'text-sky-700 dark:text-sky-300', str: 'text-emerald-700 dark:text-emerald-300', num: 'text-amber-700 dark:text-amber-300', kw: 'text-rose-700 dark:text-rose-300', com: 'italic text-slate-500 dark:text-slate-400' };
    const TOKEN = /("(?:\\.|[^"\\\n])*"|'[^'\n]*')(\s*:(?=\s|$))?|(#.*$)|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g;
    const paint = (code, cls) => `<span class="${COLORS[cls]}">${esc(code)}</span>`;
    const colour = (text) => {
      if (text.length > 300000) return esc(text); // very large files: skip colouring to stay responsive
      const json = /^\s*[{[]/.test(text);
      return text.split('\n').map((line) => {
        let head = '', rest = line;
        if (!json) { // YAML: unquoted keys at the start of a line
          const m = /^(\s*(?:-\s+)*)([^\s"'#:{[-][^:#]*?)(:)(?=\s|$)/.exec(line);
          if (m) { head = esc(m[1]) + paint(m[2], 'key') + esc(m[3]); rest = line.slice(m[0].length); }
        }
        let out = '', last = 0, t;
        TOKEN.lastIndex = 0;
        while ((t = TOKEN.exec(rest))) {
          out += esc(rest.slice(last, t.index));
          if (t[1]) out += paint(t[1], t[2] ? 'key' : 'str') + esc(t[2] || '');
          else if (t[3]) out += paint(t[3], 'com');
          else if (t[4]) out += paint(t[4], 'kw');
          else out += paint(t[5], 'num');
          last = TOKEN.lastIndex;
        }
        return head + out + esc(rest.slice(last));
      }).join('\n');
    };
    let raf = 0;
    const repaint = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { pre.innerHTML = colour(ta.value) + '\n'; }); };
    // The gutter holds every line number, so give it the textarea's height or it stretches the whole editor to the file's length.
    const sync = () => { inner.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`; gutter.style.height = `${ta.offsetHeight}px`; gutter.scrollTop = ta.scrollTop; };
    if (window.ResizeObserver) new ResizeObserver(sync).observe(ta);
    // Jump to a line (used by the validation message) and shade it red until the text changes.
    const goTo = (line, col) => {
      const rows = ta.value.split('\n');
      const n = Math.min(Math.max(1, line), rows.length);
      const at = rows.slice(0, n - 1).reduce((a, r) => a + r.length + 1, 0) + Math.min((col || 1) - 1, rows[n - 1].length);
      ta.focus(); ta.setSelectionRange(at, at);
      ta.scrollTop = Math.max(0, (n - 4) * 20);
      errBar.style.top = `${8 + (n - 1) * 20}px`; errBar.classList.remove('hidden');
      refresh(); sync();
    };
    ta.addEventListener('editor:load', (e) => set(e.detail));
    ta.addEventListener('editor:goto', (e) => goTo(e.detail.line, e.detail.column));
    // Markers beside the line numbers: ✕ for a syntax error, ! for a suggestion. Sent by the form after each validation.
    const markEls = [];
    ta.addEventListener('editor:marks', (e) => {
      markEls.splice(0).forEach((n) => n.remove());
      const list = e.detail || [];
      list.forEach((m) => {
        if (!m.line) return;
        const d = el('span', `absolute left-0.5 grid h-5 w-3.5 place-items-center text-[10px] font-bold ${m.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`, m.kind === 'error' ? '✕' : '!');
        d.style.top = `${8 + (m.line - 1) * 20}px`; d.title = m.message; gutter.append(d); markEls.push(d);
      });
      const bad = list.find((m) => m.kind === 'error' && m.line);
      if (bad) { errBar.style.top = `${8 + (bad.line - 1) * 20}px`; errBar.classList.remove('hidden'); } else errBar.classList.add('hidden');
    });
    ta.addEventListener('input', () => errBar.classList.add('hidden'));
    // Insert through the browser's editing pipeline so Ctrl/Cmd+Z keeps working; fall back to setRangeText.
    const insert = (txt, from, to) => {
      ta.focus(); ta.setSelectionRange(from, to);
      if (!document.execCommand || !document.execCommand('insertText', false, txt)) { ta.setRangeText(txt, from, to, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    const set = (v) => { ta.focus(); ta.select(); if (!document.execCommand || !document.execCommand(v ? 'insertText' : 'delete', false, v)) { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); } };
    const refresh = () => {
      const lines = ta.value.split('\n').length;
      if (gutter.dataset.n !== String(lines)) { gutter.dataset.n = lines; nums.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n'); }
      const before = ta.value.slice(0, ta.selectionStart).split('\n');
      pos.textContent = `Ln ${before.length}, Col ${before[before.length - 1].length + 1}`;
      size.textContent = `${lines} line${lines === 1 ? '' : 's'} · ${(new Blob([ta.value]).size / 1024).toFixed(1)} KB`;
      empty.hidden = !!ta.value;
      sync();
    };
    tool('Format JSON', 'Pretty-print JSON with 2-space indent', () => {
      try { set(JSON.stringify(JSON.parse(ta.value), null, 2) + '\n'); window.toast('Formatted'); }
      catch { window.toast(ta.value.trim() ? 'Not valid JSON. Formatting works for JSON only.' : 'Nothing to format', ta.value.trim() ? 'error' : 'info'); }
    });
    tool('Starter', 'Insert a minimal OpenAPI 3 skeleton', () => {
      if (ta.value.trim() && !confirm('Replace the current content with a starter template?')) return;
      set(STARTER);
    });
    tool('Load file…', 'Open a .yaml/.yml/.json file into the editor', () => picker.click());
    tool('Copy', 'Copy all content', async () => { try { await navigator.clipboard.writeText(ta.value); window.toast('Copied to clipboard'); } catch { ta.select(); } });
    tool('Clear', 'Remove all content', () => { if (!ta.value || confirm('Clear the editor?')) set(''); });
    const picker = el('input'); picker.type = 'file'; picker.accept = '.yaml,.yml,.json,application/json'; picker.hidden = true;
    picker.addEventListener('change', async () => { if (picker.files[0]) set(await picker.files[0].text()); picker.value = ''; });
    bar.append(picker);
    ta.addEventListener('input', () => { refresh(); repaint(); });
    ta.addEventListener('scroll', sync);
    ['keyup', 'click', 'select', 'focus'].forEach((ev) => ta.addEventListener(ev, refresh));
    // Tab / Shift+Tab indent the selected lines; Enter keeps the current indent. Esc then Tab leaves the field.
    let escaped = false;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { escaped = true; return; }
      const v = ta.value, a = ta.selectionStart, z = ta.selectionEnd;
      if (e.key === 'Tab' && !escaped && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const start = v.lastIndexOf('\n', a - 1) + 1;
        if (a === z && !e.shiftKey) { insert('  ', a, z); }
        else {
          const block = v.slice(start, z).split('\n');
          const out = block.map((l) => e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l);
          insert(out.join('\n'), start, z);
          ta.setSelectionRange(start, start + out.join('\n').length);
        }
      } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && a === z) {
        e.preventDefault();
        const line = v.slice(v.lastIndexOf('\n', a - 1) + 1, a);
        const indent = line.match(/^\s*/)[0] + (/[:{[]\s*$/.test(line) ? '  ' : '');
        insert('\n' + indent, a, z);
      }
      escaped = false;
    });
    // ---- Find / replace (Ctrl/Cmd+F inside the editor): every match is shaded, the current one is selected and scrolled into view ----
    const marks = el('pre', 'pointer-events-none absolute left-0 top-0 px-3 py-2 font-mono text-xs leading-5 text-transparent');
    inner.insertBefore(marks, pre);
    const fbar = el('div', 'hidden flex-wrap items-center gap-1.5 border-b border-slate-200 bg-white px-2 py-1.5 text-xs dark:border-slate-800 dark:bg-slate-950');
    fbar.setAttribute('role', 'search');
    const fIn = el('input', 'field !mt-0 !w-44 !py-1 text-xs'); fIn.type = 'text'; fIn.placeholder = 'Find'; fIn.setAttribute('aria-label', 'Find in the editor'); fIn.autocomplete = 'off'; fIn.spellcheck = false;
    const rIn = el('input', 'field !mt-0 !w-44 !py-1 text-xs'); rIn.type = 'text'; rIn.placeholder = 'Replace with'; rIn.setAttribute('aria-label', 'Replace with'); rIn.autocomplete = 'off'; rIn.spellcheck = false;
    const fCount = el('span', 'min-w-16 text-slate-600 dark:text-slate-400'); fCount.setAttribute('aria-live', 'polite');
    const fBtn = (label, title, fn, aria) => { const b = el('button', 'rounded px-2 py-1 font-medium text-slate-700 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-brand-500 aria-pressed:bg-brand-600 aria-pressed:text-white dark:text-slate-300 dark:hover:bg-slate-800', label); b.type = 'button'; b.title = title; b.setAttribute('aria-label', aria || title); b.addEventListener('click', fn); return b; };
    let found = [], at = -1, matchCase = false;
    const norm = (t) => (matchCase ? t : t.toLowerCase());
    const paintMarks = () => {
      if (fbar.classList.contains('hidden') || !found.length) { marks.innerHTML = ''; return; }
      const v = ta.value, n = fIn.value.length;
      let out = '', last = 0;
      found.forEach((i, k) => { out += esc(v.slice(last, i)) + `<mark class="rounded-sm ${k === at ? 'bg-orange-400/70' : 'bg-yellow-300/60 dark:bg-yellow-400/40'} text-transparent">${esc(v.slice(i, i + n))}</mark>`; last = i + n; });
      marks.innerHTML = out + esc(v.slice(last)) + '\n';
    };
    const showCount = () => { fCount.textContent = !fIn.value ? '' : found.length ? `${at + 1} of ${found.length}` : 'No results'; };
    const scan = (keep) => {
      found = [];
      const q = norm(fIn.value), v = norm(ta.value);
      if (q) { for (let i = v.indexOf(q); i !== -1 && found.length < 5000; i = v.indexOf(q, i + q.length)) found.push(i); }
      const from = ta.selectionStart;
      at = found.length ? (keep ? Math.max(0, found.findIndex((i) => i >= from)) : 0) : -1;
      if (found.length && at === -1) at = 0;
      showCount(); paintMarks();
    };
    const reveal = () => {
      if (at < 0) return;
      const i = found[at], before = ta.value.slice(0, i), line = before.split('\n').length - 1, col = i - (before.lastIndexOf('\n') + 1);
      ta.setSelectionRange(i, i + fIn.value.length);
      const top = line * 20, view = ta.clientHeight;
      if (top < ta.scrollTop + 20 || top > ta.scrollTop + view - 60) ta.scrollTop = Math.max(0, top - Math.round(view / 3));
      const x = col * 7.3;
      if (x < ta.scrollLeft || x > ta.scrollLeft + ta.clientWidth - 80) ta.scrollLeft = Math.max(0, x - 80);
      sync(); showCount(); paintMarks();
    };
    const step = (d) => { if (!found.length) return; at = (at + d + found.length) % found.length; reveal(); };
    const replaceOne = () => {
      if (at < 0) return;
      const i = found[at]; insert(rIn.value, i, i + fIn.value.length);
      scan(true); reveal();
    };
    const replaceAll = () => {
      if (!found.length) return;
      const n = found.length, v = ta.value, len = fIn.value.length;
      let out = '', last = 0; found.forEach((i) => { out += v.slice(last, i) + rIn.value; last = i + len; });
      set(out + v.slice(last)); scan(false); window.toast(`Replaced ${n} match${n === 1 ? '' : 'es'}`);
    };
    const closeFind = () => { fbar.classList.add('hidden'); fbar.classList.remove('flex'); marks.innerHTML = ''; ta.focus(); };
    const openFind = () => {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel && !sel.includes('\n')) fIn.value = sel;
      fbar.classList.remove('hidden'); fbar.classList.add('flex');
      scan(true); fIn.focus(); fIn.select();
    };
    fbar.append(fIn, fCount,
      fBtn('↑', 'Previous match (Shift+Enter)', () => step(-1), 'Previous match'), fBtn('↓', 'Next match (Enter)', () => step(1), 'Next match'),
      (() => { const b = fBtn('Aa', 'Match case', () => { matchCase = !matchCase; b.setAttribute('aria-pressed', String(matchCase)); scan(true); reveal(); }, 'Match case'); b.setAttribute('aria-pressed', 'false'); return b; })(),
      rIn, fBtn('Replace', 'Replace this match', replaceOne), fBtn('All', 'Replace all matches', replaceAll, 'Replace all matches'), fBtn('✕', 'Close (Esc)', closeFind, 'Close find'));
    body.before(fbar);
    fIn.addEventListener('input', () => { scan(true); reveal(); });
    fbar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (e.target === rIn) replaceOne(); else step(e.shiftKey ? -1 : 1); }
    });
    ta.addEventListener('input', () => { if (!fbar.classList.contains('hidden')) scan(true); });
    wrap.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
      else if ((mod && e.key.toLowerCase() === 'g') || e.key === 'F3') { e.preventDefault(); if (fbar.classList.contains('hidden')) openFind(); else step(e.shiftKey ? -1 : 1); }
    });
    const findBtn = tool('Find', 'Find and replace (Ctrl/Cmd+F)', () => setTimeout(openFind, 0));
    bar.prepend(findBtn);
    refresh(); repaint();
  });

  // ---- blueprint form: Edit / Preview / Changes views, live validation, diff and a sticky save bar ----
  const bpForm = $('form[data-preview]');
  if (bpForm) {
    const box = $('#bp-preview'), bar = $('#bar-summary'), save = $('[data-save]', bpForm), note = $('[data-note]', bpForm);
    const back = $('[data-back]', bpForm), next = $('[data-next]', bpForm), cancel = $('[data-cancel]', bpForm);
    const frame = $('#bp-frame'), stage = $('#pv-stage'), pvEmpty = $('#pv-empty'), changesBody = $('#changes-body'), count = $('[data-changes-count]');
    const views = $$('[data-views] [role=tab]');
    const area = () => $('textarea[name=content]', bpForm);
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const METHOD = (k) => { const m = k.split(' ')[0]; return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? m.toLowerCase() : 'other'; };
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    let timer = 0, seq = 0, last = null, previewStale = true, warnOpen = false, forceHash = '';

    let step = 0, reached = 0, pending = false; // reached: furthest step visited in order; editing resets it, so Preview can't be skipped
    const NEXT = ['Next: Preview →', 'Next: Review changes →'];
    const canGo = () => !!(last && last.ok) && !pending;
    const refreshNav = () => {
      views.forEach((t, i) => {
        t.disabled = i > 0 && (!canGo() || i > reached);
        if (i < step && canGo()) t.setAttribute('data-done', ''); else t.removeAttribute('data-done');
        $('.step-n', t).textContent = i < step && canGo() ? '✓' : String(i + 1);
      });
      back.hidden = step === 0; cancel.hidden = step !== 0;
      next.hidden = step === 2; next.disabled = !canGo(); next.textContent = NEXT[step] || '';
      save.hidden = step !== 2;
    };
    const go = (i) => { view(views[i].id); window.scrollTo({ top: 0 }); views[i].focus(); };
    next.addEventListener('click', () => { if (canGo() && step < 2) go(step + 1); });
    back.addEventListener('click', () => { if (step > 0) go(step - 1); });
    const view = (id) => {
      views.forEach((t) => {
        const on = t.id === id;
        t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      step = views.findIndex((t) => t.id === id);
      reached = Math.max(reached, step);
      refreshNav();
      if (id === 'view-preview') { syncPreview(); if (last && last.ok && (!rendered || previewStale)) renderPreview(); }
    };
    views.forEach((t) => {
      t.addEventListener('click', () => { if (!t.disabled) view(t.id); });
      t.addEventListener('keydown', (e) => {
        const i = views.indexOf(t), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault(); const n = views[(i + d + views.length) % views.length]; if (n.disabled) return; n.focus(); view(n.id);
      });
    });

    const tone = (kind, ...kids) => {
      box.className = 'mb-4 rounded-lg border px-4 py-2.5 text-sm ' + ({
        ok: 'border-emerald-600/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
        bad: 'border-red-400 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200',
      })[kind];
      box.replaceChildren(...kids);
    };
    const goToLine = (r) => {
      view('view-edit');
      area().dispatchEvent(new CustomEvent('editor:goto', { detail: { line: r.line, column: r.column } }));
    };
    const goBtn = (r) => {
      const b = mk('button', 'ml-2 font-semibold underline', `Go to line ${r.line}`); b.type = 'button';
      b.addEventListener('click', () => goToLine(r));
      return b;
    };

    // ---- Changes view ----
    const row = (label, from, to) => {
      const d = mk('div', 'flex flex-wrap items-baseline gap-2 py-1');
      d.append(mk('span', 'w-16 text-xs font-semibold uppercase tracking-wide text-slate-500', label));
      if (from == null || from === to) d.append(mk('span', 'font-medium', to || '—'));
      else d.append(mk('span', 'text-slate-500 line-through', from || '—'), mk('span', 'text-slate-400', '→'), mk('span', 'font-medium', to || '—'));
      return d;
    };
    const group = (title, cls, list, link) => {
      const g = mk('section', 'mt-4');
      g.append(mk('h3', `mb-1 text-sm font-semibold ${cls}`, `${title} (${list.length})`));
      const ul = mk('ul', 'divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700');
      const LIMIT = 30; // big imports can add hundreds of endpoints: show the first few, reveal the rest on request
      const add = (k) => {
        const li = mk('li', 'flex items-center gap-3 px-3 py-1.5');
        const sp = k.indexOf(' ');
        li.append(mk('span', `method m-${METHOD(k)} shrink-0`, k.slice(0, sp)), mk('span', 'min-w-0 truncate font-mono text-xs', k.slice(sp + 1)));
        if (link) { // jump to this endpoint in the Preview step
          const b = mk('button', 'link ml-auto shrink-0 !text-xs', 'Preview'); b.type = 'button'; b.setAttribute('aria-label', `Preview ${k}`);
          b.addEventListener('click', () => openInPreview(k)); li.append(b);
        }
        li.title = k; ul.append(li);
      };
      list.slice(0, LIMIT).forEach(add);
      g.append(ul);
      if (list.length > LIMIT) {
        const more = mk('button', 'link mt-2 text-xs', `Show ${list.length - LIMIT} more`); more.type = 'button';
        more.addEventListener('click', () => { list.slice(LIMIT).forEach(add); more.remove(); });
        g.append(more);
      }
      return g;
    };
    const renderChanges = (r) => {
      changesBody.replaceChildren();
      if (!r || !r.ok) { changesBody.append(mk('p', 'empty', r ? 'Fix the error in the Edit tab to see what changed.' : 'Add content in the Edit tab to see what changed.')); return; }
      const d = r.diff, c = r.current;
      if (!d) { // new blueprint
        changesBody.append(row('Title', null, r.title), row('Version', null, r.version ? 'v' + r.version : 'none'), row('Contents', null, `${plural(r.endpointCount, 'endpoint')} in ${plural(r.folders, 'folder')}`));
        return;
      }
      if (d.same) { changesBody.append(mk('p', 'empty', 'No changes: this is identical to the current revision, so publishing would not create a new version.')); return; }
      changesBody.append(row('Title', c && c.title, r.title), row('Version', c && (c.version ? 'v' + c.version : 'none'), r.version ? 'v' + r.version : 'none'));
      if (d.added.length) changesBody.append(group('Added', 'text-emerald-700 dark:text-emerald-400', d.added, true));
      if (d.changed.length) changesBody.append(group('Changed', 'text-amber-700 dark:text-amber-400', d.changed, true));
      if (d.deprecated && d.deprecated.length) changesBody.append(group('Newly deprecated', 'text-slate-700 dark:text-slate-300', d.deprecated));
      if (d.removed.length) {
        changesBody.append(group('Removed', 'text-red-700 dark:text-red-400', d.removed));
        changesBody.append(mk('p', 'mt-2 text-xs text-red-700 dark:text-red-400', 'Removed endpoints can break clients that still call them.'));
      }
      if (!d.added.length && !d.changed.length && !d.removed.length) changesBody.append(mk('p', 'mt-3 text-slate-600 dark:text-slate-400', 'Only metadata or text outside the endpoints changed.'));
    };

    // ---- sticky bar + Save state ----
    const suggest = (d) => {
      const p = [];
      if (d.added.length) p.push(`added ${plural(d.added.length, 'endpoint')}`);
      if (d.changed.length) p.push(`changed ${d.changed.length}`);
      if (d.removed.length) p.push(`removed ${d.removed.length}`);
      return p.length ? p.join(', ').replace(/^./, (c) => c.toUpperCase()) : '';
    };
    const renderBar = (r) => {
      bar.replaceChildren();
      let ok = false;
      if (!r) bar.append(mk('span', 'text-slate-500', 'Add content to continue.'));
      else if (!r.ok) { bar.append(mk('span', 'font-medium text-red-700 dark:text-red-400', '✕ Fix the error to continue')); if (r.line) bar.append(goBtn(r)); }
      else if (r.diff && r.diff.same) bar.append(mk('span', 'text-slate-500', 'No changes yet.'));
      else {
        ok = true;
        const v = (x) => (x ? 'v' + x : 'no version');
        if (r.diff) {
          const d = r.diff, c = r.current;
          if (c && c.version !== r.version) bar.append(mk('span', 'mr-2 font-medium', `${v(c.version)} → ${v(r.version)}`));
          const n = (sym, len, cls) => { const s = mk('span', `mr-2 font-mono text-xs font-semibold ${cls}`, `${sym}${len}`); s.title = ({ '+': 'added', '~': 'changed', '−': 'removed' })[sym]; return s; };
          bar.append(n('+', d.added.length, 'text-emerald-700 dark:text-emerald-400'), n('~', d.changed.length, 'text-amber-700 dark:text-amber-400'), n('−', d.removed.length, 'text-red-700 dark:text-red-400'));
        } else bar.append(mk('span', 'font-medium', `${r.title}${r.version ? ' · v' + r.version : ''} · ${plural(r.endpointCount, 'endpoint')}`));
      }
      save.disabled = !ok;
      refreshNav();
      const n = r && r.ok && r.diff && !r.diff.same ? r.diff.added.length + r.diff.changed.length + r.diff.removed.length : 0;
      count.textContent = String(n); count.classList.toggle('hidden', !n);
      if (note && !note.dataset.touched) note.value = r && r.ok && r.diff && !r.diff.same ? suggest(r.diff) : '';
    };

    // ---- Preview view: rendered only when asked (button). Posts the draft into the iframe and keeps the open endpoint ----
    const pvHint = $('#pv-hint');
    let rendered = false;
    function syncPreview() {
      const ok = !!(last && last.ok);
      stage.classList.toggle('hidden', !rendered); pvEmpty.hidden = rendered;
      pvEmpty.textContent = ok ? 'The preview appears here when you open this tab.' : last ? 'Fix the error in the Edit tab to preview it.' : 'Add valid content in the Edit tab, to preview it.';
      pvHint.textContent = !rendered ? '' : !ok ? 'The draft has an error; showing the last render.' : previewStale ? 'Out of date.' : 'Up to date.';
    }
    function renderPreview() {
      if (!(last && last.ok)) return;
      let hash = '';
      try { hash = frame.contentWindow.location.hash; } catch { /* first load */ }
      frame.dataset.hash = forceHash || hash; forceHash = '';
      rendered = true; previewStale = false;
      pvHint.textContent = 'Rendering…'; stage.classList.remove('hidden'); pvEmpty.hidden = true;
      const was = { action: bpForm.getAttribute('action'), target: bpForm.getAttribute('target') };
      bpForm.action = bpForm.dataset.previewRender; bpForm.target = 'bp-frame';
      bpForm.submit(); // plain submit into the iframe: nothing is saved
      bpForm.setAttribute('action', was.action); if (was.target) bpForm.target = was.target; else bpForm.removeAttribute('target');
    }
    // From the Changes step: open the Preview step on one endpoint (#/?op=GET%20%2Ftasks, understood by the viewer).
    function openInPreview(key) {
      forceHash = `#/?op=${encodeURIComponent(key)}`;
      go(1);
      if (forceHash) { // preview was already rendered and up to date: just move the viewer
        try { frame.contentWindow.location.hash = forceHash; } catch { /* not loaded yet */ }
        forceHash = '';
      }
    }
    // Device width: the iframe's own width is the page's viewport, so the viewer lays out exactly as it would on that screen.
    const DEVICES = { desktop: 1440, tablet: 768, phone: 390 };
    const pad = $('#pv-pad'), scaleNote = $('#pv-scale');
    const store = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } } };
    let device = 'desktop';
    // The iframe is laid out at the device's real width, then scaled down when the stage is narrower (so "Desktop" really is a desktop layout).
    const fit = () => {
      const w = DEVICES[device], gap = device === 'desktop' ? 0 : 24;
      const avail = Math.max(240, stage.clientWidth - gap);
      const scale = Math.min(1, avail / w);
      const visible = Math.round(Math.min(Math.max(576, window.innerHeight * 0.88), 1440));
      frame.style.width = `${w}px`; frame.style.height = `${Math.round(visible / scale)}px`;
      frame.style.transform = scale < 1 ? `scale(${scale})` : '';
      pad.style.width = `${Math.round(w * scale)}px`; pad.style.height = `${visible}px`;
      stage.style.padding = gap ? '12px' : '0';
      scaleNote.textContent = scale < 1 ? `${w}px wide, shown at ${Math.round(scale * 100)}%` : `${w}px wide`;
    };
    const setDevice = (d) => {
      device = DEVICES[d] ? d : 'desktop';
      deviceBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.device === device)));
      store.set('bp.device', device);
      fit();
    };
    window.addEventListener('resize', fit);
    if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
    const deviceBtns = $$('[data-device]', bpForm);
    deviceBtns.forEach((b) => b.addEventListener('click', () => setDevice(b.dataset.device)));
    setDevice(store.get('bp.device', 'desktop'));
    // The preview follows the page theme, including when it is toggled while the preview is open.
    // Auto follows the page; Light / Dark pins the preview to one theme (handy for checking both) without changing the page.
    let pvTheme = store.get('bp.pvtheme', 'auto');
    const syncTheme = () => {
      const dark = pvTheme === 'auto' ? document.documentElement.classList.contains('dark') : pvTheme === 'dark';
      try { frame.contentDocument.documentElement.classList.toggle('dark', dark); } catch { /* not loaded yet */ }
      $$('[data-pvtheme]', bpForm).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pvtheme === pvTheme)));
    };
    $$('[data-pvtheme]', bpForm).forEach((b) => b.addEventListener('click', () => { pvTheme = b.dataset.pvtheme; store.set('bp.pvtheme', pvTheme); syncTheme(); }));
    syncTheme();
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    frame.addEventListener('load', () => {
      syncTheme();
      if (rendered) syncPreview();
      try { if (frame.dataset.hash) frame.contentWindow.location.hash = frame.dataset.hash; } catch { /* ignore */ }
    });

    // ---- validation / diff round-trip ----
    const run = async () => {
      const ta = area();
      if (!ta.value.trim()) { pending = false; last = null; box.className = 'hidden'; renderBar(null); renderChanges(null); syncPreview(); return; }
      const mine = ++seq;
      const fd = new FormData();
      fd.append('content', ta.value);
      try {
        const r = await (await fetch(bpForm.dataset.preview, { method: 'POST', body: fd, credentials: 'same-origin' })).json();
        if (mine !== seq) return;
        pending = false; last = r; previewStale = true;
        if (!r.ok) { const m = mk('div', null, '✕ ' + r.error); if (r.line) m.append(goBtn(r)); tone('bad', m); }
        else {
          const ok = mk('div', null); ok.append(mk('div', 'font-medium', `✓ Valid · ${r.standard} · ${plural(r.endpointCount, 'endpoint')} in ${plural(r.folders, 'folder')}`));
          if (r.warningCount) {
            const d = mk('details', 'mt-1.5'); d.open = warnOpen; d.addEventListener('toggle', () => { warnOpen = d.open; });
            d.append(mk('summary', 'cursor-pointer text-amber-800 dark:text-amber-300', `! ${plural(r.warningCount, 'suggestion')} (optional, you can still publish)`));
            const ul = mk('ul', 'mt-1 max-h-40 space-y-1 overflow-auto text-xs');
            r.warnings.forEach((w) => {
              const li = mk('li', 'flex flex-wrap items-baseline gap-x-2'); li.append(mk('span', 'font-mono', `${w.method} ${w.path}`), mk('span', null, w.message));
              if (w.line) { const b = mk('button', 'link !text-xs', `line ${w.line}`); b.type = 'button'; b.addEventListener('click', () => goToLine(w)); li.append(b); }
              ul.append(li);
            });
            if (r.warningCount > r.warnings.length) ul.append(mk('li', null, `…and ${r.warningCount - r.warnings.length} more.`));
            d.append(ul); ok.append(d);
          }
          tone('ok', ok);
        }
        area().dispatchEvent(new CustomEvent('editor:marks', { detail: r.ok ? (r.warnings || []).filter((w) => w.line).map((w) => ({ line: w.line, kind: 'warn', message: `${w.method} ${w.path}: ${w.message}` })) : (r.line ? [{ line: r.line, kind: 'error', message: r.error }] : []) }));
        renderBar(r); renderChanges(r);
        syncPreview();
      } catch (err) { console.error(err); if (mine === seq) { pending = false; box.className = 'hidden'; save.disabled = false; refreshNav(); } }
    };
    const later = () => { clearTimeout(timer); save.disabled = true; pending = true; reached = Math.min(reached, step); refreshNav(); timer = setTimeout(run, 500); };
    bpForm.addEventListener('input', (e) => { if (e.target === note) { note.dataset.touched = note.value ? '1' : ''; return; } later(); });
    bpForm.addEventListener('change', (e) => { if (e.target !== note) later(); });
    bpForm.addEventListener('submit', (e) => {
      if (step !== 2) { e.preventDefault(); if (canGo()) go(step + 1); return; } // Enter in a field must not publish before the review
      const gone = last && last.ok && last.diff && last.diff.removed;
      if (gone && gone.length && !confirm(`This removes ${plural(gone.length, 'endpoint')}, which can break clients that use them.\n\nPublish anyway?`)) { e.preventDefault(); view('view-changes'); return; }
      box.className = 'hidden';
    });
    // Leaving with unsaved edits asks first; Cmd/Ctrl+S publishes when allowed.
    const start = area().value;
    let leaving = false;
    window.addEventListener('beforeunload', (e) => { if (!leaving && area().value !== start) { e.preventDefault(); e.returnValue = ''; } });
    bpForm.addEventListener('submit', (e) => { if (!e.defaultPrevented) leaving = true; });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (step === 2 && !save.disabled) bpForm.requestSubmit(save); else if (step < 2 && canGo()) { go(step + 1); window.toast(step === 2 ? 'Review the changes, then publish' : 'Check the preview first', 'info'); } else window.toast('Nothing to publish yet', 'info'); }
    });
    renderBar(null); renderChanges(null); syncPreview(); refreshNav();
    if (area().value.trim()) later();
  }

  // ---- header search type-ahead ----
  const sInput = $('[data-global-search]');
  const sList = $('#search-suggest');
  if (sInput && sList) {
    let items = [], active = -1, timer = 0, seq = 0;
    const scopeQs = sInput.dataset.scope ? `&bp=${encodeURIComponent(sInput.dataset.scope)}` : '';
    const close = () => { sList.hidden = true; sInput.setAttribute('aria-expanded', 'false'); sInput.removeAttribute('aria-activedescendant'); active = -1; };
    const setActive = (i) => {
      active = i;
      items.forEach((el, k) => { el.setAttribute('aria-selected', String(k === i)); el.classList.toggle('bg-slate-100', k === i); el.classList.toggle('dark:bg-slate-800', k === i); });
      if (i >= 0) sInput.setAttribute('aria-activedescendant', items[i].id); else sInput.removeAttribute('aria-activedescendant');
    };
    const row = (id, href, ...kids) => {
      const a = document.createElement('a');
      a.id = id; a.href = href; a.setAttribute('role', 'option'); a.setAttribute('aria-selected', 'false');
      a.className = 'flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800';
      a.append(...kids);
      return a;
    };
    const span = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
    const heading = (t) => { const d = document.createElement('div'); d.className = 'eyebrow px-3 pb-1 pt-2'; d.setAttribute('role', 'presentation'); d.textContent = t; return d; };
    const render = (data, q) => {
      sList.replaceChildren();
      items = [];
      if (data.blueprints.length) sList.append(heading('Blueprints'));
      data.blueprints.forEach((b, i) => { const el = row(`sg-b${i}`, `/blueprints/${b.id}`, span('truncate font-medium', b.title)); items.push(el); sList.append(el); });
      if (data.endpoints.length) sList.append(heading('Endpoints'));
      data.endpoints.forEach((e, i) => {
        const k = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method) ? e.method.toLowerCase() : 'other';
        const el = row(`sg-e${i}`, e.href, span(`method m-${k} !w-14 shrink-0`, e.method), span('min-w-0 flex-1 truncate font-mono text-xs', e.path), span('max-w-[40%] shrink-0 truncate text-xs text-slate-600 dark:text-slate-400', e.blueprint));
        if (e.deprecated) { el.querySelector('.font-mono').classList.add('line-through'); el.append(span('flag flag-dep shrink-0', 'deprecated')); }
        if (e.status) el.append(span('flag flag-wip shrink-0', e.status));
        el.title = `${e.method} ${e.path} · ${e.blueprint}${e.deprecated ? ' (deprecated)' : ''}${e.status ? ` (${e.status})` : ''}`;
        items.push(el); sList.append(el);
      });
      const all = document.createElement('a');
      all.href = `/search?q=${encodeURIComponent(q)}${scopeQs}`;
      all.className = 'block border-t border-slate-200 px-3 py-2 text-sm font-medium text-brand-600 hover:bg-slate-100 dark:border-slate-700 dark:text-brand-400 dark:hover:bg-slate-800';
      all.id = 'sg-all'; all.setAttribute('role', 'option'); all.setAttribute('aria-selected', 'false');
      all.textContent = `See all results for “${q}”`;
      items.push(all); sList.append(all);
      sList.hidden = false; sInput.setAttribute('aria-expanded', 'true'); active = -1;
    };
    sInput.addEventListener('input', () => {
      clearTimeout(timer);
      const q = sInput.value.trim();
      if (q.length < 2) return close();
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const data = await (await fetch(`/search/suggest?q=${encodeURIComponent(q)}${scopeQs}`, { credentials: 'same-origin' })).json();
          if (mine !== seq || sInput.value.trim() !== q) return;
          if (!data.blueprints.length && !data.endpoints.length) return close();
          render(data, q);
        } catch { close(); }
      }, 180);
    });
    sInput.addEventListener('keydown', (e) => {
      if (sList.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % items.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + items.length) % items.length); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); location.href = items[active].href; }
      else if (e.key === 'Escape') close();
    });
    document.addEventListener('click', (e) => { if (!sList.contains(e.target) && e.target !== sInput) close(); });
  }

  // ---- <input data-select-all>: selects its whole value on focus (read-only fields such as a share link) ----
  document.addEventListener('focusin', (e) => { if (e.target.matches && e.target.matches('input[data-select-all]')) e.target.select(); });

  // ---- copy buttons: <button data-copy="text"> ----
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); window.toast('Copied to clipboard'); } catch { window.toast('Press Ctrl+C to copy', 'info'); }
  });
})();
