// OpenAPI 3.x / Swagger 2.0 -> Postman Collection v2.1 (import it with Postman's "Import" button).
// One folder per tag, one request per operation, {{baseUrl}} as a collection variable, example bodies built from the schemas.
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const SCHEMA_URL = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

// Follows a local "$ref": "#/components/schemas/Pet" (anything else is left as is).
function deref(spec, node, depth = 0) {
  while (node && typeof node === 'object' && typeof node.$ref === 'string' && depth++ < 10) {
    if (!node.$ref.startsWith('#/')) return {};
    node = node.$ref.slice(2).split('/').reduce((n, k) => (n == null ? n : n[k.replace(/~1/g, '/').replace(/~0/g, '~')]), spec);
  }
  return node && typeof node === 'object' ? node : {};
}

const FORMATS = { 'date-time': '2024-01-01T00:00:00Z', date: '2024-01-01', uuid: '00000000-0000-0000-0000-000000000000', email: 'user@example.com', uri: 'https://example.com', url: 'https://example.com' };

// A small example value for a schema: explicit example/default/enum first, then something sensible for the type.
function example(spec, schema, depth = 0) {
  const s = deref(spec, schema);
  if (depth > 5) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Array.isArray(s.allOf)) return Object.assign({}, ...s.allOf.map((x) => { const v = example(spec, x, depth + 1); return v && typeof v === 'object' ? v : {}; }));
  if (Array.isArray(s.oneOf) && s.oneOf.length) return example(spec, s.oneOf[0], depth + 1);
  if (Array.isArray(s.anyOf) && s.anyOf.length) return example(spec, s.anyOf[0], depth + 1);
  const type = s.type || (s.properties ? 'object' : s.items ? 'array' : 'string');
  if (type === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(s.properties || {})) out[k] = example(spec, v, depth + 1);
    return out;
  }
  if (type === 'array') return [example(spec, s.items || {}, depth + 1)];
  if (type === 'integer' || type === 'number') return s.minimum !== undefined ? s.minimum : 0;
  if (type === 'boolean') return false;
  return FORMATS[s.format] || 'string';
}

function baseUrlOf(spec) {
  if (Array.isArray(spec.servers) && spec.servers[0] && spec.servers[0].url) {
    const srv = spec.servers[0];
    return String(srv.url).replace(/\{(\w+)\}/g, (m, k) => (srv.variables && srv.variables[k] && srv.variables[k].default) || m);
  }
  if (spec.host) return `${(spec.schemes && spec.schemes[0]) || 'https'}://${spec.host}${spec.basePath || ''}`;
  return 'http://localhost';
}

function requestOf(spec, path, method, item, op) {
  const params = new Map(); // path-level parameters first; an operation's own parameter with the same name+in wins
  for (const p of [...(item.parameters || []), ...(op.parameters || [])]) { const d = deref(spec, p); if (d.name) params.set(`${d.in}:${d.name}`, d); }
  const list = [...params.values()];
  const of = (where) => list.filter((p) => p.in === where);
  const desc = (p) => p.description || '';
  const val = (p) => { const v = example(spec, p.schema || p, 3); return v == null || typeof v === 'object' ? '' : String(v); };

  const header = of('header').map((p) => ({ key: p.name, value: val(p), description: desc(p), disabled: !p.required }));
  const query = of('query').map((p) => ({ key: p.name, value: val(p), description: desc(p), disabled: !p.required }));
  const variable = of('path').map((p) => ({ key: p.name, value: val(p) || p.name, description: desc(p) }));

  let body;
  const rb = deref(spec, op.requestBody);
  const sw2 = list.find((p) => p.in === 'body');
  const form = of('formData');
  if (rb && rb.content) {
    const types = Object.keys(rb.content);
    const type = types.find((t) => /json/i.test(t)) || types[0];
    const media = deref(spec, rb.content[type]);
    const sample = media.example !== undefined ? media.example : example(spec, media.schema || {});
    if (/json/i.test(type)) body = { mode: 'raw', raw: JSON.stringify(sample, null, 2), options: { raw: { language: 'json' } } };
    else if (/x-www-form-urlencoded|multipart/i.test(type) && sample && typeof sample === 'object') {
      body = { mode: /multipart/i.test(type) ? 'formdata' : 'urlencoded', [/multipart/i.test(type) ? 'formdata' : 'urlencoded']: Object.entries(sample).map(([key, value]) => ({ key, value: String(value) })) };
    } else body = { mode: 'raw', raw: typeof sample === 'string' ? sample : JSON.stringify(sample, null, 2) };
    if (!header.some((h) => h.key.toLowerCase() === 'content-type')) header.push({ key: 'Content-Type', value: type });
  } else if (sw2) {
    body = { mode: 'raw', raw: JSON.stringify(example(spec, sw2.schema || {}), null, 2), options: { raw: { language: 'json' } } };
    if (!header.some((h) => h.key.toLowerCase() === 'content-type')) header.push({ key: 'Content-Type', value: 'application/json' });
  } else if (form.length) {
    body = { mode: 'urlencoded', urlencoded: form.map((p) => ({ key: p.name, value: val(p), description: desc(p), disabled: !p.required })) };
  }

  const segments = path.split('/').filter(Boolean).map((s) => s.replace(/\{([^}]+)\}/g, ':$1'));
  const qs = query.filter((q) => !q.disabled).map((q) => `${q.key}=${q.value}`).join('&');
  return {
    name: op.summary || op.operationId || `${method.toUpperCase()} ${path}`,
    request: {
      method: method.toUpperCase(),
      header,
      url: { raw: `{{baseUrl}}/${segments.join('/')}${qs ? `?${qs}` : ''}`, host: ['{{baseUrl}}'], path: segments, query, variable },
      description: [op.description || op.summary || '', op['x-status'] ? `Status: ${op['x-status']}${op['x-status-description'] ? ` — ${op['x-status-description']}` : ''}` : '', op.deprecated ? 'Deprecated.' : ''].filter(Boolean).join('\n\n'),
      ...(body ? { body } : {}),
    },
    response: [],
  };
}

function toPostman(spec) {
  const folders = new Map();
  for (const [path, item] of Object.entries(spec.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const tag = Array.isArray(op.tags) && op.tags[0] ? String(op.tags[0]) : 'default';
      if (!folders.has(tag)) folders.set(tag, []);
      folders.get(tag).push(requestOf(spec, path, method, item, op));
    }
  }
  const info = spec.info || {};
  return {
    info: { name: info.title || 'API', description: typeof info.description === 'string' ? info.description : '', version: info.version ? String(info.version) : undefined, schema: SCHEMA_URL },
    variable: [{ key: 'baseUrl', value: baseUrlOf(spec).replace(/\/+$/, '') }],
    item: [...folders].map(([name, item]) => ({ name, item })),
  };
}

module.exports = { toPostman, example };
