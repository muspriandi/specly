// Postman-style documentation UI: sidebar of folders/requests, details in the middle,
// example request/response on the right. All text is inserted as text nodes (never innerHTML),
// except markdown descriptions, which are sanitised with DOMPurify first.
(function () {
  const { createModel, generators } = window.DocModel;
  const root = document.getElementById('doc');

  // ---- tiny DOM helper: h('div', 'classes' | {class, href, ...}, ...children) ----
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (typeof props === 'string') el.className = props;
    else if (props) for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    const add = (k) => {
      if (k == null || k === false) return;
      if (Array.isArray(k)) return k.forEach(add);
      el.append(k.nodeType ? k : document.createTextNode(String(k)));
    };
    kids.forEach(add);
    return el;
  }
  const md = (src) => {
    const d = h('div', 'md');
    if (src) d.innerHTML = DOMPurify.sanitize(marked.parse(String(src)), { FORBID_TAGS: ['style'] });
    return d;
  };
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  const mkey = (m) => (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? m.toLowerCase() : 'other');
  const methodText = (m) => h('span', `font-mono text-[11px] font-bold mt-${mkey(m)}`, m);
  const CARD = 'rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
  const SECTION = 'mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400';

  // ---- JSON highlighting (token -> span, all via text nodes) ----
  function highlight(text) {
    const frag = document.createDocumentFragment();
    const re = /("(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const t = m[0];
      const cls = t.startsWith('"') ? (m[2] ? 'text-[#7ec7ff]' : 'text-[#a5e075]') : /^(true|false|null)$/.test(t) ? 'text-[#ff9d5c]' : 'text-[#e6c07b]';
      frag.append(h('span', cls, t));
      last = re.lastIndex;
    }
    frag.append(text.slice(last));
    return frag;
  }
  // Line numbers live in a separate non-selectable gutter so copying and screen readers only get the code.
  const codeBlock = (text, json) => {
    const n = String(text).split('\n').length;
    const nums = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    return h('pre', { tabindex: '0', class: 'flex overflow-auto rounded-b-lg bg-[#212121] py-4 font-mono text-xs leading-relaxed text-slate-100' },
      h('span', { 'aria-hidden': 'true', class: 'sticky left-0 shrink-0 select-none bg-[#212121] pl-4 pr-3 text-right text-slate-400' }, nums),
      h('code', 'pr-4', json ? highlight(text) : text));
  };

  function copyButton(getText, label) {
    const b = h('button', { class: 'rounded px-2 py-1 text-xs font-medium text-slate-300 hover:bg-white/10', type: 'button', 'aria-label': label || 'Copy to clipboard' }, 'Copy');
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(getText()); b.textContent = 'Copied'; if (window.toast) window.toast('Copied to clipboard'); } catch { b.textContent = 'Press Ctrl+C'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    });
    return b;
  }
  const select = (options, value, onchange, label, light) => {
    const s = h('select', { class: light ? 'max-w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100' : 'rounded border border-white/20 bg-[#2b2b2b] px-2 py-1 text-xs text-slate-100', 'aria-label': label },
      options.map((o) => h('option', { value: o, selected: o === value }, o)));
    s.addEventListener('change', () => onchange(s.value));
    return s;
  };

  function table(heads, rows) {
    return h('div', `overflow-x-auto ${CARD}`, h('table', 'w-full text-sm',
      h('thead', 'border-b border-slate-200 text-left text-xs uppercase text-slate-600 dark:border-slate-800 dark:text-slate-400', h('tr', null, heads.map((x) => h('th', 'px-3 py-2 font-semibold', x)))),
      h('tbody', null, rows.map((r) => h('tr', 'border-b border-slate-100 align-top last:border-0 dark:border-slate-800', r.map((c) => h('td', 'px-3 py-2', c)))))));
  }
  const keyCell = (name, required, type) => h('div', null,
    h('span', 'font-mono text-[13px] font-semibold', name),
    required ? h('span', 'ml-1 text-xs text-red-700 dark:text-red-400', 'required') : null,
    type ? h('div', 'text-xs text-slate-600 dark:text-slate-400', type) : null);
  const mono = (v) => h('code', 'rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-slate-800', v === null || v === undefined ? '' : String(v));
  const statusColor = (c) => (/^2/.test(c) ? 'text-green-700 dark:text-green-400' : /^[45]/.test(c) ? 'text-red-700 dark:text-red-400' : 'text-slate-600 dark:text-slate-400');
  const statusMark = (c) => (/^2/.test(c) ? '✓ ' : /^[45]/.test(c) ? '✕ ' : '');

  // ---- state ----
  let model, ops, folders, serverIdx = 0, lang = store.get('doc.lang', 'cURL'), respCode = null, current = null;
  const enc = encodeURIComponent;
  const STATUS_CLS = 'rounded-full border border-orange-500 bg-orange-50 px-1.5 py-0 text-[10px] font-semibold uppercase text-orange-700 dark:bg-orange-950 dark:text-orange-300';
  const statusBadge = (o, extra = '') => (o.status ? h('span', { class: `${STATUS_CLS} ${extra}`, title: 'Not final: this endpoint may still change' }, o.status) : null);
  const linkFor = (o) => `#/${enc(o.tag)}/${enc(o.key)}`;
  const serverUrl = () => model.servers()[serverIdx].url;

  // ---- sidebar ----
  const openState = {};
  function sidebar() {
    const list = h('div', 'mt-3');
    const input = h('input', { type: 'search', placeholder: 'Filter requests, fields…', 'aria-label': 'Filter requests by name, path or field', class: 'field !mt-0 !py-1.5' });
    // What the filter searches: name, path, method, description, parameter names and body/response field names.
    const cache = new Map();
    const haystack = (o) => {
      if (!cache.has(o)) {
        const fl = (list) => (list || []).map((f) => f.name).join(' ');
        cache.set(o, [o.name, o.path, o.method, o.tag, o.description, fl(o.pathParams), fl(o.queryParams), fl(o.headers.map((x) => ({ name: x.key }))),
          o.body ? fl(o.body.fields) : '', o.responses.map((r) => `${r.code} ${r.description} ${fl(r.fields)}`).join(' ')].join(' ').toLowerCase());
      }
      return cache.get(o);
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      let count = 0;
      list.replaceChildren(h('a', { href: '#/', 'aria-current': current ? null : 'page', class: `mb-1 block rounded px-2 py-2 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800 ${current ? '' : 'bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-400'}` }, 'Overview'),
        ...folders.map((f) => {
          const items = f.items.filter((o) => !q || haystack(o).includes(q));
          if (!items.length) return null;
          count += items.length;
          return h('details', { open: q ? true : openState[f.name] !== false, ontoggle: (e) => { if (!q) openState[f.name] = e.target.open; }, class: 'mb-1' },
            h('summary', 'flex cursor-pointer select-none items-center justify-between rounded px-2 py-2 text-sm font-semibold hover:bg-slate-100 dark:hover:bg-slate-800', f.name, h('span', 'text-xs font-normal text-slate-600 dark:text-slate-400', String(items.length))),
            items.map((o) => h('a', { href: linkFor(o), title: `${o.method} ${o.path}`, 'aria-current': current === o ? 'page' : null,
              class: `ml-3 flex items-baseline gap-2 rounded px-2 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${current === o ? 'bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-400' : ''}` },
              h('span', 'w-12 shrink-0', methodText(o.method)),
                h('span', 'min-w-0 flex-1', h('span', 'block truncate', o.name), statusBadge(o, 'mt-0.5 inline-block')))));
        }).filter(Boolean), q && !count ? h('p', 'px-2 py-3 text-sm text-slate-600 dark:text-slate-400', `No requests match “${input.value.trim()}”.`) : []);
      const active = list.querySelector('[aria-current=page]');
      if (active && !q && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', render);
    sidebar.render = render;
    render();
    const info = model.spec.info || {};
    // Below lg the list collapses behind a toggle so readers reach the request without scrolling past it.
    const body = h('div', null, h('div', 'mt-3', input), list);
    const wrap = h('nav', { 'aria-label': 'Requests', class: `${CARD} p-3 lg:row-span-2 lg:sticky lg:top-16 lg:max-h-[calc(100vh-5rem)] lg:self-start lg:overflow-auto xl:row-span-1` },
      h('div', 'px-2 text-base font-bold', info.title),
      info.version ? h('div', 'px-2 text-xs text-slate-600 dark:text-slate-400', `Version ${info.version}`) : null,
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm mt-3 w-full lg:hidden', 'aria-expanded': 'false', onclick: (e) => {
        const open = body.classList.toggle('hidden') === false;
        e.currentTarget.setAttribute('aria-expanded', String(open));
        e.currentTarget.textContent = open ? 'Hide requests' : `Browse ${ops.length} requests`;
      } }, `Browse ${ops.length} requests`), body);
    body.className = 'hidden lg:block';
    return wrap;
  }

  // ---- centre: overview ----
  function overview() {
    const info = model.spec.info || {};
    const servers = model.servers();
    return h('div', null,
      h('h1', { id: 'page-title', tabindex: '-1', class: 'text-2xl font-bold outline-none' }, info.title),
      info.version ? h('span', 'mt-1 inline-block rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-600 dark:text-slate-400 dark:border-slate-700', `v${info.version}`) : null,
      md(info.description),
      h('div', SECTION, 'Base URL'),
      table(['URL', 'Description'], servers.map((s) => [mono(s.url), s.description || ''])),
      h('div', SECTION, `Folders (${folders.length})`),
      h('div', 'grid gap-3 sm:grid-cols-2', folders.map((f) => {
        const mix = {};
        f.items.forEach((o) => { mix[o.method] = (mix[o.method] || 0) + 1; });
        return h('a', { href: linkFor(f.items[0]), class: `${CARD} block p-4 transition hover:border-brand-500/60 hover:shadow-sm` },
          h('div', 'flex items-baseline justify-between gap-2', h('span', 'font-semibold', f.name), h('span', 'text-xs text-slate-600 dark:text-slate-400', `${f.items.length} request${f.items.length === 1 ? '' : 's'}`)),
          f.description ? h('p', 'mt-1 line-clamp-2 text-sm text-slate-600 dark:text-slate-400', f.description) : null,
          h('div', 'mt-3 flex flex-wrap gap-x-3 gap-y-1', Object.entries(mix).map(([m, n]) => h('span', `font-mono text-[11px] font-bold mt-${mkey(m)}`, `${n} ${m}`))));
      })),
      h('div', SECTION, 'All requests'),
      table(['Method', 'Request', 'Folder'], ops.map((o) => [methodText(o.method),
        h('a', { href: linkFor(o), class: 'text-brand-600 hover:underline dark:text-brand-400' }, o.name, h('div', 'font-mono text-xs text-slate-600 dark:text-slate-400', o.path)), o.tag])));
  }

  // ---- centre: one request ----
  const paramTable = (title, params) => params.length ? [h('div', SECTION, title),
    table(['Key', 'Example value', 'Description'], params.map((p) => [keyCell(p.name, p.required, p.type), p.example === null || p.example === undefined ? '' : mono(typeof p.example === 'object' ? JSON.stringify(p.example) : p.example), p.description]))] : [];

  // Field-level schema table (name, type, required, description), shown under a body/response example.
  const fieldTable = (fields) => !fields || !fields.length ? null : h('details', { class: 'mt-3', open: fields.length <= 12 },
    h('summary', 'cursor-pointer select-none text-sm font-medium text-brand-600 dark:text-brand-400', `Schema (${fields.length} field${fields.length === 1 ? '' : 's'})`),
    h('div', 'mt-2', table(['Field', 'Type', 'Description'], fields.map((f) => [
      keyCell(f.name, f.required),
      h('span', 'font-mono text-xs', f.type || ''),
      h('div', null, f.description,
        f.enum ? h('div', 'mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-600 dark:text-slate-400', 'One of: ', f.enum.map((e) => mono(e))) : null,
        f.default !== undefined ? h('div', 'mt-1 text-xs text-slate-600 dark:text-slate-400', 'Default: ', mono(typeof f.default === 'object' ? JSON.stringify(f.default) : f.default)) : null)]))));

  function request(o) {
    const servers = model.servers();
    const urlBar = h('div', `flex flex-wrap items-center gap-3 ${CARD} px-3 py-2`,
      h('span', `rounded px-2 py-1 font-mono text-xs font-bold text-white m-${mkey(o.method)}`, o.method),
      servers.length > 1
        ? select(servers.map((s) => s.url), serverUrl(), (v) => { serverIdx = servers.findIndex((s) => s.url === v); show(); }, 'Server', true)
        : h('span', 'font-mono text-sm text-slate-600 dark:text-slate-400', serverUrl()),
      h('span', 'min-w-0 break-all font-mono text-sm font-semibold', o.path),
      h('button', { type: 'button', class: 'ml-auto rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800', 'aria-label': 'Copy full URL', onclick: async () => { const u = serverUrl().replace(/\/$/, '') + o.path; try { await navigator.clipboard.writeText(u); if (window.toast) window.toast('URL copied'); } catch { /* clipboard unavailable */ } } }, 'Copy URL'));
    return h('div', null,
      h('div', 'text-xs text-slate-600 dark:text-slate-400', `${o.tag} / ${o.name}`),
      h('h1', { id: 'page-title', tabindex: '-1', class: 'mt-1 text-2xl font-bold outline-none' }, o.name, o.deprecated ? h('span', 'ml-2 rounded-full border border-amber-500 px-2 py-0.5 align-middle text-xs font-medium text-amber-600', 'deprecated') : null, statusBadge(o, 'ml-2 align-middle !text-xs !px-2 !py-0.5')),
      o.status ? h('div', 'mt-3 rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200',
        h('div', 'font-semibold', `Status: ${o.status}`),
        h('div', null, o.statusNote || 'This endpoint is not final and may change before release.')) : null,
      h('div', 'mt-4', urlBar),
      md(o.description),
      o.auth.length ? [h('div', SECTION, 'Authorization'), h('p', 'text-sm', o.auth.map((a) => a.label).join(' + '), h('span', 'text-slate-600 dark:text-slate-400', o.auth[0].in === 'header' ? ` — sent in the ${o.auth[0].key} header` : ` — sent as the "${o.auth[0].key}" ${o.auth[0].in} parameter`))] : null,
      paramTable('Path variables', o.pathParams), paramTable('Query params', o.queryParams),
      o.headers.length ? [h('div', SECTION, 'Headers'), table(['Key', 'Value', 'Description'], o.headers.map((x) => [keyCell(x.key, false), mono(x.value), x.description]))] : null,
      o.body ? [h('div', SECTION, 'Body'), h('p', 'mb-2 text-sm text-slate-600 dark:text-slate-400', o.body.contentType, o.body.required ? ' · required' : '', o.body.description ? ` · ${o.body.description}` : ''),
        h('div', CARD, codeBlock(o.body.text || '(empty)', /json/.test(o.body.contentType))), fieldTable(o.body.fields)] : null,
      o.responses.length ? [h('div', SECTION, 'Responses'), table(['Status', 'Description', 'Type'], o.responses.map((r) => [
        h('button', { type: 'button', 'aria-pressed': String((respCode || o.responses[0].code) === r.code), title: 'Show this example', class: `cursor-pointer rounded px-2 py-1 font-mono text-xs font-bold hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-500 aria-pressed:bg-brand-50 aria-pressed:ring-1 aria-pressed:ring-brand-500/40 dark:hover:bg-slate-800 dark:aria-pressed:bg-slate-800 ${statusColor(r.code)}`, onclick: () => pickResp(r.code) }, statusMark(r.code) + r.code), r.description, r.contentType || ''])),
        fieldTable((o.responses.find((x) => x.code === (respCode || o.responses[0].code)) || {}).fields)] : null);
  }

  // ---- right pane: example request / response ----
  let rightEl;
  function example() {
    if (!current) { rightEl.replaceChildren(); return; }
    const o = current;
    const req = model.buildRequest(o, serverUrl());
    const gen = generators[lang] || generators.cURL;
    const reqText = gen(req);
    const resp = o.responses.find((r) => r.code === respCode) || o.responses[0];
    const head = (...kids) => h('div', 'flex items-center justify-between gap-2 rounded-t-lg bg-[#2b2b2b] px-3 py-2', kids);
    const tabs = (label, items, active, onpick) => h('div', { role: 'group', 'aria-label': label, class: 'flex flex-wrap gap-1 bg-[#2b2b2b] px-3 pb-2' }, items.map((g) =>
      h('button', { type: 'button', 'aria-pressed': String(g === active), class: 'rounded px-2 py-1 text-xs font-medium text-slate-400 hover:text-white aria-pressed:bg-white/15 aria-pressed:text-white', onclick: () => onpick(g) }, g)));
    const title = (t) => h('span', 'text-xs font-semibold uppercase tracking-wide text-slate-300', t);
    rightEl.replaceChildren(
      h('div', 'overflow-hidden rounded-lg', head(title('Example request'), h('div', 'flex items-center gap-2',
        copyButton(() => reqText, 'Copy example request'))),
        tabs('Language', Object.keys(generators), lang, (g) => { lang = g; store.set('doc.lang', g); example(); }),
        codeBlock(reqText, false)),
      h('div', 'mt-4 overflow-hidden rounded-lg', head(title('Example response'), resp ? h('div', 'flex items-center gap-2',
        resp.body ? copyButton(() => resp.body, 'Copy example response') : null) : null),
        resp ? [tabs('Status code', o.responses.map((r) => r.code), resp.code, pickResp),h('div', 'bg-[#212121] px-4 pt-3 text-xs text-slate-400', h('span', `font-bold ${resp.code.startsWith('2') ? 'text-green-400' : resp.code.startsWith('4') || resp.code.startsWith('5') ? 'text-red-400' : 'text-slate-300'}`, resp.code), ' ', resp.description, resp.contentType ? ` · ${resp.contentType}` : ''),
          codeBlock(resp.body || '(no body)', !!resp.body && /^\s*[[{]/.test(resp.body))] : h('div', 'bg-[#212121] p-4 text-xs text-slate-400', 'No responses documented.')));
  }

  // ---- routing ----
  let centerEl, navigated = false;
  // Choosing a status code redraws both panes and records it in the URL (#/Tag/op?r=404) so the link can be shared.
  function pickResp(code) {
    respCode = code;
    example();
    centerEl.replaceChildren(request(current));
    const base = location.hash.split('?')[0];
    history.replaceState(null, '', `${base}?r=${encodeURIComponent(code)}`);
  }
  function show() {
    const [path, query = ''] = location.hash.split('?');
    const parts = path.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    current = parts.length >= 1 ? ops.find((o) => o.key === parts[parts.length - 1] && (parts.length < 2 || o.tag === parts[0])) || ops.find((o) => o.key === parts[parts.length - 1]) || null : null;
    const wanted = new URLSearchParams(query).get('r');
    respCode = current && wanted && current.responses.some((r) => r.code === wanted) ? wanted : null;
    centerEl.replaceChildren(current ? request(current) : overview());
    example();
    sidebar.render();
    const t = document.getElementById('page-title');
    document.title = `${current ? current.name : (model.spec.info || {}).title || 'Documentation'} · Specly`;
    window.scrollTo({ top: 0 });
    if (t && navigated) t.focus({ preventScroll: true });
    navigated = true;
  }

  function init(spec) {
    model = createModel(spec);
    ops = model.operations();
    folders = model.folders(ops);
    rightEl = h('aside', { 'aria-label': 'Example request and response', class: 'min-w-0 lg:col-start-2 xl:col-start-3 xl:row-start-1 xl:sticky xl:top-16 xl:max-h-[calc(100vh-5rem)] xl:self-start xl:overflow-auto' });
    centerEl = h('section', 'min-w-0 lg:col-start-2');
    root.replaceChildren(h('div', 'grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_minmax(0,26rem)]', sidebar(), centerEl, rightEl));
    window.addEventListener('hashchange', show);
    show();
  }

  const inline = document.getElementById('doc-spec'); // preview panel: the spec is embedded in the page
  (inline ? Promise.resolve(JSON.parse(inline.textContent)) : fetch(root.dataset.spec, { credentials: 'same-origin' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }))
    .then(init)
    .catch((e) => root.replaceChildren(h('div', { role: 'alert', class: 'alert-error' },
      h('p', 'font-medium', `Could not load this documentation (${e.message}).`),
      h('div', 'mt-3 flex gap-2', h('button', { type: 'button', class: 'btn btn-sm', onclick: () => location.reload() }, 'Try again'), h('a', { href: '/', class: 'btn btn-sm btn-ghost' }, 'Back to all blueprints')))));
})();
