// Gentle checks on a valid spec: things that still work but read worse (no summary) or link badly (no operationId).
// Each warning carries the source line of the operation so the editor can mark it.
const { listEndpoints } = require('./spec');

const MAX_WARNINGS = 100;

// 1-based line of `method:` under `path:` (falls back to the path line, then null).
function locate(lines, path, method) {
  const keyOf = (l) => l.trim().replace(/^["']/, '');
  const at = lines.findIndex((l) => { const k = keyOf(l); return k.startsWith(path) && /^["']?\s*:/.test(k.slice(path.length)); });
  if (at < 0) return null;
  const indent = lines[at].length - lines[at].trimStart().length;
  for (let i = at + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.trim()) continue;
    const k = keyOf(l);
    if (k.toLowerCase().startsWith(method.toLowerCase()) && /^["']?\s*:/.test(k.slice(method.length))) return i + 1;
    if (l.length - l.trimStart().length <= indent) break; // left the path's block
  }
  return at + 1;
}

function lintSpec(source, spec) {
  const lines = String(source).split('\n');
  const out = [], seen = new Map();
  for (const e of listEndpoints(spec)) {
    const where = () => locate(lines, e.path, e.method);
    if (!e.summary) out.push({ kind: 'summary', method: e.method, path: e.path, line: where(), message: 'No summary: the sidebar falls back to the path.' });
    if (!e.operation_id) out.push({ kind: 'operationId', method: e.method, path: e.path, line: where(), message: 'No operationId: its link changes if the path changes.' });
    else if (seen.has(e.operation_id)) out.push({ kind: 'duplicate', method: e.method, path: e.path, line: where(), message: `operationId “${e.operation_id}” is already used by ${seen.get(e.operation_id)}.` });
    else seen.set(e.operation_id, `${e.method} ${e.path}`);
  }
  return { warnings: out.slice(0, MAX_WARNINGS), warningCount: out.length };
}

module.exports = { lintSpec };
