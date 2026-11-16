const yaml = require('js-yaml');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// Parse an OpenAPI/Swagger document given as YAML or JSON text.
// Returns { format, spec } or throws an Error with a user-facing message.
// Syntax errors carry `line` / `column` (1-based, in the original text) so the editor can jump to them.
function syntaxError(message, line, column) {
  const err = new Error(message);
  if (line) { err.line = line; err.column = column || 1; }
  return err;
}

// Index of the first character that makes `src` invalid JSON, or -1. Only used to point at the error:
// the engine's own message has no position on newer Node versions.
function jsonErrorAt(src) {
  let i = 0;
  const ws = () => { while (/\s/.test(src[i] || '')) i++; };
  const fail = () => { throw i; };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') {
      i++; ws();
      if (src[i] === '}') { i++; return; }
      for (;;) { ws(); if (src[i] !== '"') fail(); str(); ws(); if (src[i] !== ':') fail(); i++; value(); ws();
        if (src[i] === ',') { i++; continue; } if (src[i] === '}') { i++; return; } fail(); }
    } else if (c === '[') {
      i++; ws();
      if (src[i] === ']') { i++; return; }
      for (;;) { value(); ws(); if (src[i] === ',') { i++; continue; } if (src[i] === ']') { i++; return; } fail(); }
    } else if (c === '"') str();
    else {
      const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(src.slice(i));
      if (!m) fail();
      i += m[0].length;
    }
  };
  const str = () => {
    i++;
    for (;;) {
      const c = src[i];
      if (c === undefined || c === '\n') fail();
      if (c === '\\') { i += 2; continue; }
      i++;
      if (c === '"') return;
    }
  };
  try { value(); ws(); if (i < src.length) fail(); return -1; } catch (at) { return typeof at === 'number' ? at : -1; }
}

// YAML aliases are shared references, so a tiny file can describe a document that is astronomically large once it is
// walked or stringified ("billion laughs"): a 600-byte file made JSON.stringify exhaust memory and kill the process.
// This measures the EXPANDED size (memoised per object, so the check itself is linear) and rejects documents that are
// too big, too deep or circular, before anything else touches them.
const MAX_NODES = 1_500_000, MAX_DEPTH = 120;
function assertBounded(root) {
  const memo = new Map(), active = new Set();
  const size = (node, depth) => {
    if (node === null || typeof node !== 'object') return 1;
    if (memo.has(node)) return memo.get(node);
    if (active.has(node)) throw new Error('The document contains a circular reference (a YAML alias that points at its own parent).');
    if (depth > MAX_DEPTH) throw new Error(`The document is nested more than ${MAX_DEPTH} levels deep.`);
    active.add(node);
    let n = 1;
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      n += size(v, depth + 1);
      if (n > MAX_NODES) throw new Error(`The document expands to more than ${MAX_NODES.toLocaleString('en-US')} values (a YAML alias bomb?) and was rejected.`);
    }
    active.delete(node);
    memo.set(node, n);
    return n;
  };
  size(root, 0);
}

function parseSpec(text) {
  const trimmed = String(text || '').trim();
  const lead = (String(text || '').match(/^\s*/)[0].match(/\n/g) || []).length; // blank lines removed by trim()
  if (!trimmed) throw new Error('The document is empty.');

  let spec, format;
  if (trimmed.startsWith('{')) {
    format = 'json';
    try { spec = JSON.parse(trimmed); }
    catch (e) {
      let line, column;
      const pos = /position (\d+)/.exec(e.message), lc = /line (\d+) column (\d+)/.exec(e.message);
      const guess = jsonErrorAt(trimmed);
      if (!lc && !pos && guess >= 0) { const before = trimmed.slice(0, guess).split('\n'); line = before.length + lead; column = before[before.length - 1].length + 1; }
      else if (lc) { line = Number(lc[1]) + lead; column = Number(lc[2]); }
      else if (pos) { const before = trimmed.slice(0, Number(pos[1])).split('\n'); line = before.length + lead; column = before[before.length - 1].length + 1; }
      throw syntaxError('Invalid JSON: ' + e.message, line, column);
    }
  } else {
    format = 'yaml';
    try { spec = yaml.load(trimmed, { schema: yaml.JSON_SCHEMA }); }
    catch (e) { throw syntaxError('Invalid YAML: ' + e.message.split('\n')[0], e.mark ? e.mark.line + 1 + lead : 0, e.mark ? e.mark.column + 1 : 0); }
  }

  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('The document must be an object.');
  }
  assertBounded(spec);
  const version = String(spec.openapi || spec.swagger || '');
  if (!/^(2\.0|3\.\d+(\.\d+)?)/.test(version)) {
    throw new Error('Missing or unsupported "openapi" / "swagger" version field.');
  }
  if (!spec.info || typeof spec.info.title !== 'string' || !spec.info.title.trim()) {
    throw new Error('"info.title" is required.');
  }
  if (!spec.paths || typeof spec.paths !== 'object') {
    throw new Error('"paths" is required.');
  }
  return { format, spec };
}

function listEndpoints(spec) {
  const out = [];
  for (const [p, item] of Object.entries(spec.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== 'object') continue;
      out.push({
        method: m.toUpperCase(),
        path: p,
        summary: typeof op.summary === 'string' ? op.summary : '',
        operation_id: typeof op.operationId === 'string' ? op.operationId : '',
        tag: Array.isArray(op.tags) && op.tags[0] ? String(op.tags[0]) : 'default',
        deprecated: op.deprecated === true,
        status: typeof op['x-status'] === 'string' ? op['x-status'].trim().slice(0, 30) : '',
      });
    }
  }
  return out;
}

module.exports = { parseSpec, listEndpoints, assertBounded, MAX_NODES };
