// Compares ONE operation between two versions of a spec and says what changed for the people who call it.
// Each change is { level: 'breaking' | 'change', text }. "Breaking" means an existing, correct client can start failing:
//   - a parameter became required, was added as required, or changed type
//   - the request body became required, gained a required field, lost a media type, or a field changed type
//   - a success (2xx) response disappeared, or a response field was removed or changed type
// Everything else that differs (new optional things, new responses, wording) is reported as an ordinary change.
// Works on OpenAPI 3.x and Swagger 2.0, resolves local $refs, and looks at most 3 levels into a schema.

const DEPTH = 3;
const METHODS_WITH_BODY = new Set(['post', 'put', 'patch', 'delete', 'options', 'trace']);

function deref(spec, node) {
  for (let i = 0; i < 12 && node && typeof node === 'object' && typeof node.$ref === 'string'; i++) {
    if (!node.$ref.startsWith('#/')) return {};
    node = node.$ref.slice(2).split('/').reduce((n, k) => (n == null ? n : n[k.replace(/~1/g, '/').replace(/~0/g, '~')]), spec);
  }
  return node && typeof node === 'object' ? node : {};
}

const typeOf = (s) => {
  const t = s.type || (s.properties ? 'object' : s.items ? 'array' : s.allOf ? 'object' : s.oneOf || s.anyOf ? 'oneOf' : 'any');
  const inner = t === 'array' && s.items ? `<${s.items.type || (s.items.$ref ? String(s.items.$ref).split('/').pop() : 'any')}>` : '';
  return `${t}${inner}${s.format ? `:${s.format}` : ''}`;
};

// { name -> { type, required } } for the fields of a schema, dotted for nested objects ("address.city").
function fields(spec, schema, depth = 0, seen = new Set(), prefix = '', required = true) {
  const out = new Map();
  const s = deref(spec, schema);
  if (!s || seen.has(s) || depth >= DEPTH) return out;
  seen = new Set(seen).add(s);
  if (s.type === 'array' && s.items) return fields(spec, s.items, depth, seen, prefix, required);
  const merged = { properties: { ...(s.properties || {}) }, required: [...(s.required || [])] };
  for (const part of s.allOf || []) {
    const p = deref(spec, part);
    Object.assign(merged.properties, p.properties || {});
    merged.required.push(...(p.required || []));
  }
  for (const [name, raw] of Object.entries(merged.properties)) {
    const prop = deref(spec, raw);
    const key = prefix + name;
    out.set(key, { type: typeOf(prop), required: required && merged.required.includes(name) });
    if (prop.type === 'object' || prop.properties || prop.allOf) {
      for (const [k, v] of fields(spec, prop, depth + 1, seen, `${key}.`, out.get(key).required)) out.set(k, v);
    } else if (prop.type === 'array' && prop.items) {
      for (const [k, v] of fields(spec, prop.items, depth + 1, seen, `${key}[].`, false)) out.set(k, v);
    }
  }
  return out;
}

function parameters(spec, item, op) {
  const out = new Map();
  for (const raw of [...(item.parameters || []), ...(op.parameters || [])]) {
    const p = deref(spec, raw);
    if (!p.name || p.in === 'body') continue;
    const schema = deref(spec, p.schema || p);
    out.set(`${p.in}:${p.name}`, { name: p.name, where: p.in, required: p.in === 'path' || p.required === true, type: typeOf(schema), enum: Array.isArray(schema.enum) ? schema.enum : null });
  }
  return out;
}

function requestBody(spec, op) {
  const rb = deref(spec, op.requestBody);
  if (rb && rb.content) {
    const types = Object.keys(rb.content);
    const json = types.find((t) => /json/i.test(t)) || types[0];
    return { required: rb.required === true, types: new Set(types), fields: json ? fields(spec, deref(spec, rb.content[json]).schema || {}) : new Map() };
  }
  const sw = (op.parameters || []).map((p) => deref(spec, p)).find((p) => p.in === 'body');
  if (sw) return { required: sw.required === true, types: new Set(op.consumes || []), fields: fields(spec, sw.schema || {}) };
  return null;
}

function responses(spec, op) {
  const out = new Map();
  for (const [code, raw] of Object.entries(op.responses || {})) {
    const r = deref(spec, raw);
    let schema = r.schema; // Swagger 2.0
    if (r.content) { const t = Object.keys(r.content).find((x) => /json/i.test(x)) || Object.keys(r.content)[0]; schema = t && r.content[t] ? r.content[t].schema : undefined; }
    out.set(code, { fields: schema ? fields(spec, schema) : new Map() });
  }
  return out;
}

function compareOperation(oldSpec, newSpec, path, method) {
  const changes = [];
  const add = (level, text) => changes.push({ level, text });
  const oldItem = (oldSpec.paths || {})[path] || {}, newItem = (newSpec.paths || {})[path] || {};
  const a = oldItem[method] || {}, b = newItem[method] || {};

  // parameters
  const pa = parameters(oldSpec, oldItem, a), pb = parameters(newSpec, newItem, b);
  for (const [k, n] of pb) {
    const o = pa.get(k);
    const label = `${n.where} parameter "${n.name}"`;
    if (!o) add(n.required ? 'breaking' : 'change', n.required ? `Required ${label} added` : `Optional ${label} added`);
    else {
      if (!o.required && n.required) add('breaking', `${label} is now required`);
      if (o.required && !n.required) add('change', `${label} is no longer required`);
      if (o.type !== n.type) add('breaking', `${label} changed type from ${o.type} to ${n.type}`);
      if (o.enum && n.enum && o.enum.some((v) => !n.enum.includes(v))) add('breaking', `${label} no longer accepts ${o.enum.filter((v) => !n.enum.includes(v)).join(', ')}`);
    }
  }
  for (const [k, o] of pa) if (!pb.has(k)) add('change', `${o.where} parameter "${o.name}" removed`);

  // request body
  const ba = requestBody(oldSpec, a), bb = requestBody(newSpec, b);
  if (!ba && bb) add(bb.required ? 'breaking' : 'change', bb.required ? 'A required request body was added' : 'An optional request body was added');
  else if (ba && !bb) add('change', 'The request body was removed');
  else if (ba && bb) {
    if (!ba.required && bb.required) add('breaking', 'The request body is now required');
    for (const t of ba.types) if (bb.types.size && !bb.types.has(t)) add('breaking', `Request media type ${t} is no longer accepted`);
    for (const [name, nf] of bb.fields) {
      const of = ba.fields.get(name);
      if (!of) add(nf.required ? 'breaking' : 'change', nf.required ? `Required request field "${name}" added` : `Optional request field "${name}" added`);
      else {
        if (!of.required && nf.required) add('breaking', `Request field "${name}" is now required`);
        if (of.type !== nf.type) add('breaking', `Request field "${name}" changed type from ${of.type} to ${nf.type}`);
      }
    }
    for (const name of ba.fields.keys()) if (!bb.fields.has(name)) add('change', `Request field "${name}" removed`);
  } else if (!METHODS_WITH_BODY.has(method)) { /* GET and HEAD carry no body: nothing to compare */ }

  // responses
  const ra = responses(oldSpec, a), rb = responses(newSpec, b);
  for (const [code, o] of ra) {
    const n = rb.get(code);
    if (!n) { add(/^2/.test(code) ? 'breaking' : 'change', `Response ${code} removed`); continue; }
    for (const [name, of] of o.fields) {
      const nf = n.fields.get(name);
      if (!nf) add(/^2/.test(code) ? 'breaking' : 'change', `Response ${code} field "${name}" removed`);
      else if (of.type !== nf.type) add(/^2/.test(code) ? 'breaking' : 'change', `Response ${code} field "${name}" changed type from ${of.type} to ${nf.type}`);
    }
    for (const name of n.fields.keys()) if (!o.fields.has(name)) add('change', `Response ${code} field "${name}" added`);
  }
  for (const code of rb.keys()) if (!ra.has(code)) add('change', `Response ${code} added`);

  // flags and wording
  if (!a.deprecated && b.deprecated) add('change', 'Marked deprecated');
  if (a.deprecated && !b.deprecated) add('change', 'No longer deprecated');
  if ((a['x-status'] || '') !== (b['x-status'] || '')) add('change', b['x-status'] ? `Status is now "${b['x-status']}"` : 'Status flag removed');
  if ((a.summary || '') !== (b.summary || '')) add('change', 'Summary changed');
  if ((a.description || '') !== (b.description || '')) add('change', 'Description changed');
  return changes;
}

module.exports = { compareOperation };
