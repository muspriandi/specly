const db = require('../db');
const { parseSpec, listEndpoints } = require('./spec');

// Parse + store a blueprint (create when id is null) and record a revision unless the
// content is identical to the latest one. Throws parseSpec errors (user-facing messages).
// Returns what happened, for the caller's audit entry: see describeSave().
// Browsers submit textareas with CRLF line endings and editors differ on the trailing newline, so
// "identical" means identical after normalising those: they must not create a new revision.
const canonical = (t) => String(t).replace(/\r\n?/g, '\n').replace(/\s+$/, '');

async function saveBlueprint(id, text, userId, note = null) {
  text = String(text).replace(/\r\n?/g, '\n');
  const { format, spec } = parseSpec(text);
  const endpoints = listEndpoints(spec);
  const title = spec.info.title.trim();
  const version = spec.info.version ? String(spec.info.version) : null;
  const description = typeof spec.info.description === 'string' ? spec.info.description : null;

  const saved = await db.tx(async (q) => {
    const isNew = !id;
    let before = null;
    const [latest] = id ? await q('SELECT version_no, source FROM blueprint_versions WHERE blueprint_id=$1 ORDER BY version_no DESC LIMIT 1', [id]) : [];
    const unchanged = !!latest && canonical(latest.source) === canonical(text);
    if (unchanged) {
      // Nothing to store: keep the current revision and the blueprint row exactly as they are.
      before = (await q('SELECT title, version FROM blueprints WHERE id=$1', [id]))[0] || null;
      return { id, isNew: false, unchanged: true, revision: latest.version_no, note, title, version, endpointCount: endpoints.length,
        fromTitle: before && before.title, fromVersion: before && before.version, prevSource: latest.source };
    }
    if (id) {
      before = (await q('SELECT title, version FROM blueprints WHERE id=$1', [id]))[0] || null;
      await q(`UPDATE blueprints SET title=$1,version=$2,description=$3,format=$4,spec=$5,updated_at=now() WHERE id=$6`,
        [title, version, description, format, JSON.stringify(spec), id]);
      await q('DELETE FROM endpoints WHERE blueprint_id=$1', [id]);
    } else {
      id = (await q(`INSERT INTO blueprints (title,version,description,format,spec)
        VALUES ($1,$2,$3,$4,$5) RETURNING id`, [title, version, description, format, JSON.stringify(spec)]))[0].id;
    }
    if (endpoints.length) { // one round trip instead of one INSERT per endpoint
      await q(`INSERT INTO endpoints (blueprint_id,method,path,summary,operation_id,tag,deprecated,status)
        SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[], $8::text[])
        ON CONFLICT DO NOTHING`,
        [id, endpoints.map((e) => e.method), endpoints.map((e) => e.path), endpoints.map((e) => e.summary),
          endpoints.map((e) => e.operation_id), endpoints.map((e) => e.tag), endpoints.map((e) => e.deprecated), endpoints.map((e) => e.status)]);
    }
    const revision = latest ? latest.version_no + 1 : 1;
    await q(`INSERT INTO blueprint_versions (blueprint_id,version_no,title,version,format,source,note,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, revision, title, version, format, text, note || (latest ? null : 'Initial version'), userId]);
    return { id, isNew, unchanged: false, revision, note, title, version, endpointCount: endpoints.length,
      fromTitle: before && before.title, fromVersion: before && before.version, prevSource: latest ? latest.source : null };
  });
  saved.diff = diffSpecs(saved.prevSource, text);
  delete saved.prevSource;
  return saved;
}

// Endpoint-level diff between two sources: operations added, removed or changed.
function diffSpecs(prevText, nextText) {
  const ops = (text) => {
    const out = new Map();
    try {
      const { spec } = parseSpec(text);
      for (const e of listEndpoints(spec)) out.set(`${e.method} ${e.path}`, JSON.stringify(spec.paths[e.path][e.method.toLowerCase()]));
    } catch { /* unparseable legacy content counts as empty */ }
    return out;
  };
  const a = prevText == null ? new Map() : ops(prevText), b = ops(nextText);
  const added = [], removed = [], changed = [], deprecated = [];
  const flag = (m, k) => { try { return JSON.parse(m.get(k)).deprecated === true; } catch { return false; } };
  for (const [k, v] of b) {
    if (!a.has(k)) added.push(k); else if (a.get(k) !== v) changed.push(k);
    if (flag(b, k) && !(a.has(k) && flag(a, k))) deprecated.push(k); // newly deprecated (or added already deprecated)
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);
  return { added, removed, changed, deprecated };
}

// The raw text is not a column of blueprints: `source` resolves to the latest revision's text.
const CURRENT_SOURCE = '(SELECT v.source FROM blueprint_versions v WHERE v.blueprint_id = blueprints.id ORDER BY v.version_no DESC LIMIT 1) AS source';
const getBlueprint = (id, columns = 'id,title,version,description,format') =>
  db.one(`SELECT ${columns.split(',').map((c) => (c.trim() === 'source' ? CURRENT_SOURCE : c)).join(',')} FROM blueprints WHERE id=$1 AND deleted_at IS NULL`, [id]);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ver = (v) => (v ? `v${String(v).replace(/^v/i, '')}` : 'no version');

// "+2 added, 1 changed, 1 removed" or "no endpoint changes".
function describeDiff(d) {
  const parts = [];
  if (d.added.length) parts.push(`${d.added.length} added`);
  if (d.changed.length) parts.push(`${d.changed.length} changed`);
  if (d.removed.length) parts.push(`${d.removed.length} removed`);
  return parts.length ? `endpoints: ${parts.join(', ')}` : 'no endpoint changes';
}

// One-sentence audit description of a saveBlueprint() result.
function describeSave(r, { restoredFrom = null } = {}) {
  const name = `"${r.title}"`;
  const note = r.note && !restoredFrom ? ` · note: "${r.note}"` : '';
  if (r.isNew) return `Created ${name} ${ver(r.version)} with ${plural(r.endpointCount, 'endpoint')} (revision 1)${note}`;
  const rename = r.fromTitle && r.fromTitle !== r.title ? ` (renamed from "${r.fromTitle}")` : '';
  if (restoredFrom) {
    return `Restored ${name} to revision ${restoredFrom.revision} (${ver(restoredFrom.version)})` +
      (r.unchanged ? ' · already current, nothing changed' : ` · saved as revision ${r.revision}, ${describeDiff(r.diff)}`);
  }
  if (r.unchanged) return `Re-saved ${name} ${ver(r.version)} with no changes`;
  const versions = r.fromVersion === r.version ? `${ver(r.version)} (version number unchanged)` : `from ${ver(r.fromVersion)} to ${ver(r.version)}`;
  return `Updated ${name}${rename} ${versions} · revision ${r.revision}, ${describeDiff(r.diff)}${note}`;
}

module.exports = { canonical, saveBlueprint, diffSpecs, getBlueprint, describeSave, ver };
