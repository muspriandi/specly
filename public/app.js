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
  window.toast = function (msg, type) {
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
    t.append(ico, text, close);
    box.append(t);
    // Errors stay longer; hovering a toast pauses its timer.
    let timer = setTimeout(dismiss, type === 'error' ? 8000 : 4500);
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
    if (btn) setTimeout(() => btn.setAttribute('aria-busy', 'true'), 0); // after submit starts, so the click still counts
  });
  window.addEventListener('pageshow', () => $$('[aria-busy]').forEach((b) => b.removeAttribute('aria-busy'))); // back button

  function openConfirm(form, msg, submitter) {
    const danger = form.querySelector('.link-danger') || /delete|revoke/i.test(msg);
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menus.forEach((m) => { if (m.open) { m.open = false; $('summary', m).focus(); } });
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

  // ---- global search shortcuts: "/" or Ctrl/Cmd+K ----
  document.addEventListener('keydown', (e) => {
    const input = $('[data-global-search]');
    if (!input) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey)) {
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
  if (flash) { window.toast(flash.textContent.trim(), flash.dataset.flashType || toneOf(flash.textContent)); flash.remove(); }


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


  // ---- bulk selection on the requests page ----
  const all = $('[data-bulk-all]');
  if (all) {
    const rows = $$('[data-bulk-row]');
    const sync = () => {
      const n = rows.filter((r) => r.checked).length;
      $('[data-bulk-count]').textContent = `${n} selected`;
      $$('[data-bulk-btn]').forEach((b) => { b.disabled = n === 0; });
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
    const gutter = el('div', 'min-w-[3rem] shrink-0 select-none overflow-hidden whitespace-pre bg-slate-50 py-2 pl-3 pr-2 text-right font-mono text-xs leading-5 text-slate-500 dark:bg-slate-900 dark:text-slate-400');
    gutter.setAttribute('aria-hidden', 'true');
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
    ta.style.height = 'clamp(16rem, 58vh, 40rem)'; // follows the window instead of a fixed 22 rows; still drag-resizable
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
          const m = /^(\s*(?:-\s+)*)([^\s"'#:{[\-][^:#]*?)(:)(?=\s|$)/.exec(line);
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
    ta.addEventListener('input', () => errBar.classList.add('hidden'));
    // Insert through the browser's editing pipeline so Ctrl/Cmd+Z keeps working; fall back to setRangeText.
    const insert = (txt, from, to) => {
      ta.focus(); ta.setSelectionRange(from, to);
      if (!document.execCommand || !document.execCommand('insertText', false, txt)) { ta.setRangeText(txt, from, to, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    const set = (v) => { ta.focus(); ta.select(); if (!document.execCommand || !document.execCommand(v ? 'insertText' : 'delete', false, v)) { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); } };
    const refresh = () => {
      const lines = ta.value.split('\n').length;
      if (gutter.dataset.n !== String(lines)) { gutter.dataset.n = lines; gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n'); }
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
    refresh(); repaint();
  });

  // ---- blueprint form: Edit / Preview / Changes views, live validation, diff and a sticky save bar ----
  const bpForm = $('form[data-preview]');
  if (bpForm) {
    const box = $('#bp-preview'), bar = $('#bar-summary'), save = $('[data-save]', bpForm), note = $('[data-note]', bpForm);
    const frame = $('#bp-frame'), pvEmpty = $('#pv-empty'), changesBody = $('#changes-body'), count = $('[data-changes-count]');
    const views = $$('[data-views] [role=tab]');
    const area = () => $('textarea[name=content]', bpForm);
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const METHOD = (k) => { const m = k.split(' ')[0]; return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? m.toLowerCase() : 'other'; };
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    let timer = 0, seq = 0, last = null, previewStale = true;

    const view = (id) => {
      views.forEach((t) => {
        const on = t.id === id;
        t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (id === 'view-preview') { syncPreview(); if (last && last.ok && (!rendered || previewStale)) renderPreview(); }
    };
    $$('[data-goto]', bpForm).forEach((b) => b.addEventListener('click', () => { view(b.dataset.goto); window.scrollTo({ top: 0 }); }));
    views.forEach((t) => {
      t.addEventListener('click', () => view(t.id));
      t.addEventListener('keydown', (e) => {
        const i = views.indexOf(t), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault(); const n = views[(i + d + views.length) % views.length]; n.focus(); view(n.id);
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
    const group = (title, cls, list) => {
      const g = mk('section', 'mt-4');
      g.append(mk('h3', `mb-1 text-sm font-semibold ${cls}`, `${title} (${list.length})`));
      const ul = mk('ul', 'divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700');
      list.forEach((k) => {
        const li = mk('li', 'flex items-center gap-3 px-3 py-1.5');
        const sp = k.indexOf(' ');
        li.append(mk('span', `method m-${METHOD(k)} shrink-0`, k.slice(0, sp)), mk('span', 'min-w-0 truncate font-mono text-xs', k.slice(sp + 1)));
        li.title = k; ul.append(li);
      });
      g.append(ul); return g;
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
      if (d.added.length) changesBody.append(group('Added', 'text-emerald-700 dark:text-emerald-400', d.added));
      if (d.changed.length) changesBody.append(group('Changed', 'text-amber-700 dark:text-amber-400', d.changed));
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
          const more = mk('button', 'link text-xs', 'Review'); more.type = 'button'; more.addEventListener('click', () => view('view-changes')); bar.append(more);
        } else bar.append(mk('span', 'font-medium', `${r.title}${r.version ? ' · v' + r.version : ''} · ${plural(r.endpointCount, 'endpoint')}`));
      }
      save.disabled = !ok;
      $$('[data-goto]', bpForm).forEach((b) => { b.disabled = !(r && r.ok); });
      const n = r && r.ok && r.diff && !r.diff.same ? r.diff.added.length + r.diff.changed.length + r.diff.removed.length : 0;
      count.textContent = String(n); count.classList.toggle('hidden', !n);
      if (note && !note.dataset.touched) note.value = r && r.ok && r.diff && !r.diff.same ? suggest(r.diff) : '';
    };

    // ---- Preview view: rendered only when asked (button). Posts the draft into the iframe and keeps the open endpoint ----
    const pvHint = $('#pv-hint');
    let rendered = false;
    function syncPreview() {
      const ok = !!(last && last.ok);
      frame.classList.toggle('hidden', !rendered); pvEmpty.hidden = rendered;
      pvEmpty.textContent = ok ? 'The preview appears here when you open this tab.' : last ? 'Fix the error in the Edit tab to preview it.' : 'Add valid content in the Edit tab, to preview it.';
      pvHint.textContent = !rendered ? '' : !ok ? 'The draft has an error; showing the last render.' : previewStale ? 'Out of date.' : 'Up to date.';
    }
    function renderPreview() {
      if (!(last && last.ok)) return;
      let hash = '';
      try { hash = frame.contentWindow.location.hash; } catch { /* first load */ }
      frame.dataset.hash = hash;
      rendered = true; previewStale = false;
      pvHint.textContent = 'Rendering…'; frame.classList.remove('hidden'); pvEmpty.hidden = true;
      const was = { action: bpForm.getAttribute('action'), target: bpForm.getAttribute('target') };
      bpForm.action = bpForm.dataset.previewRender; bpForm.target = 'bp-frame';
      bpForm.submit(); // plain submit into the iframe: nothing is saved
      bpForm.setAttribute('action', was.action); if (was.target) bpForm.target = was.target; else bpForm.removeAttribute('target');
    }
    frame.addEventListener('load', () => {
      if (rendered) syncPreview();
      try { if (frame.dataset.hash) frame.contentWindow.location.hash = frame.dataset.hash; } catch { /* ignore */ }
    });

    // ---- validation / diff round-trip ----
    const run = async () => {
      const ta = area();
      if (!ta.value.trim()) { last = null; box.className = 'hidden'; renderBar(null); renderChanges(null); syncPreview(); return; }
      const mine = ++seq;
      const fd = new FormData();
      fd.append('content', ta.value);
      try {
        const r = await (await fetch(bpForm.dataset.preview, { method: 'POST', body: fd, credentials: 'same-origin' })).json();
        if (mine !== seq) return;
        last = r; previewStale = true;
        if (!r.ok) { const m = mk('div', null, '✕ ' + r.error); if (r.line) m.append(goBtn(r)); tone('bad', m); }
        else tone('ok', mk('div', 'font-medium', `✓ Valid · ${r.standard} · ${plural(r.endpointCount, 'endpoint')} in ${plural(r.folders, 'folder')}`));
        renderBar(r); renderChanges(r);
        syncPreview();
      } catch (err) { console.error(err); if (mine === seq) { box.className = 'hidden'; save.disabled = false; } }
    };
    const later = () => { clearTimeout(timer); save.disabled = true; timer = setTimeout(run, 500); };
    bpForm.addEventListener('input', (e) => { if (e.target === note) { note.dataset.touched = note.value ? '1' : ''; return; } later(); });
    bpForm.addEventListener('change', (e) => { if (e.target !== note) later(); });
    bpForm.addEventListener('submit', (e) => {
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!save.disabled) bpForm.requestSubmit(save); else window.toast('Nothing to publish yet', 'info'); }
    });
    renderBar(null); renderChanges(null); syncPreview();
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
        el.title = `${e.method} ${e.path} · ${e.blueprint}`;
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

  // ---- copy buttons: <button data-copy="text"> ----
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); window.toast('Copied to clipboard'); } catch { window.toast('Press Ctrl+C to copy', 'info'); }
  });
})();
