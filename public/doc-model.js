// Pure logic for the Postman-style viewer: reads an OpenAPI 3.x / Swagger 2.0 document and produces
// requests, example bodies and code samples. No DOM here, so it also runs under Node (see test/).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocModel = factory();
})(this, function () {
  const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
  const keyOf = (method, path, op) => op.operationId || method + path.replace(/[^\w]/g, '_'); // same rule as search

  function createModel(spec) {
    const isV2 = !!spec.swagger;

    // Optional lifecycle flag: `x-status: wip` (or beta, planned, "under development"...) on an operation.
    const statusOf = (op) => (typeof op['x-status'] === 'string' ? op['x-status'].trim().slice(0, 30) : '');

    // Optional explanation shown with the status: `x-status-description: Request body may still change.`
    const statusNoteOf = (op) => (typeof op['x-status-description'] === 'string' ? op['x-status-description'].trim() : '');

    // ---- $ref handling (local refs only) ----
    const lookup = (ref) => {
      if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
      return ref.slice(2).split('/').map((k) => decodeURIComponent(k).replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce((o, k) => (o == null ? o : o[k]), spec);
    };
    function deref(o) {
      for (let i = 0; o && o.$ref && i < 20; i++) o = lookup(o.$ref) || {};
      return o || {};
    }

    // ---- example generation from a schema ----
    const STRING_FORMATS = {
      'date-time': '2026-01-01T09:00:00Z', date: '2026-01-01', uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      email: 'user@example.com', uri: 'https://example.com', url: 'https://example.com', hostname: 'example.com',
      ipv4: '192.0.2.1', password: '********', byte: 'U3BlY2x5', binary: '(binary)',
    };
    function example(schema, seen = [], depth = 0) {
      if (!schema || depth > 6) return null;
      if (schema.$ref) {
        if (seen.includes(schema.$ref)) return null;
        seen = [...seen, schema.$ref];
      }
      const s = deref(schema);
      if (s.example !== undefined) return s.example;
      if (s.default !== undefined) return s.default;
      if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
      if (s.allOf) {
        const out = {};
        for (const part of s.allOf) {
          const e = example(part, seen, depth + 1);
          if (e && typeof e === 'object' && !Array.isArray(e)) Object.assign(out, e);
        }
        if (s.properties) Object.assign(out, example({ type: 'object', properties: s.properties }, seen, depth + 1));
        return out;
      }
      if (s.oneOf || s.anyOf) return example((s.oneOf || s.anyOf)[0], seen, depth + 1);
      const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type || (s.properties ? 'object' : s.items ? 'array' : undefined);
      switch (type) {
        case 'object': {
          const out = {};
          for (const [k, v] of Object.entries(s.properties || {})) out[k] = example(v, seen, depth + 1);
          if (!Object.keys(out).length && s.additionalProperties && typeof s.additionalProperties === 'object') {
            out.key = example(s.additionalProperties, seen, depth + 1);
          }
          return out;
        }
        case 'array': return [example(s.items, seen, depth + 1)];
        case 'integer': case 'number': return s.minimum !== undefined ? s.minimum : 0;
        case 'boolean': return true;
        case 'string': return STRING_FORMATS[s.format] || 'string';
        default: return null;
      }
    }
    // ---- schema -> flat field rows (name, type, required, description, enum, default) ----
    function typeLabel(s) {
      if (s.enum && !s.type) return 'enum';
      let t = Array.isArray(s.type) ? s.type.filter((x) => x !== 'null').join(' | ') : s.type || (s.properties ? 'object' : s.items ? 'array' : '');
      if (t === 'array' && s.items) { const it = deref(s.items); t = `array<${it.type || (it.properties ? 'object' : 'any')}>`; }
      return s.format ? `${t} (${s.format})` : t;
    }
    function fields(schema, prefix = '', seen = [], depth = 0, required = []) {
      if (!schema || depth > 5) return [];
      if (schema.$ref) {
        if (seen.includes(schema.$ref)) return [];
        seen = [...seen, schema.$ref];
      }
      const s = deref(schema);
      let rows = [];
      if (s.allOf) { s.allOf.forEach((part) => { rows = rows.concat(fields(part, prefix, seen, depth, required)); }); }
      const alt = s.oneOf || s.anyOf;
      if (alt && !s.properties) return alt.length ? fields(alt[0], prefix, seen, depth, required) : [];
      if (s.type === 'array' && s.items && !prefix) return fields(s.items, '[]', seen, depth + 1);
      const req = s.required || [];
      for (const [name, prop0] of Object.entries(s.properties || {})) {
        const prop = deref(prop0);
        const path = prefix ? `${prefix}.${name}` : name;
        rows.push({
          name: path, type: typeLabel(prop), required: req.includes(name), description: prop.description || '',
          enum: Array.isArray(prop.enum) ? prop.enum : null, default: prop.default,
        });
        if (prop.properties || prop.allOf) rows = rows.concat(fields(prop0, path, seen, depth + 1));
        else if (prop.type === 'array' && prop.items && (deref(prop.items).properties || deref(prop.items).allOf)) rows = rows.concat(fields(prop.items, `${path}[]`, seen, depth + 1));
      }
      return rows;
    }
    const stringify = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

    // ---- servers ----
    function servers() {
      let list;
      if (isV2) {
        const host = spec.host || '';
        list = host ? [{ url: `${(spec.schemes && spec.schemes[0]) || 'https'}://${host}${spec.basePath || ''}`.replace(/\/$/, '') }] : [];
      } else {
        list = (spec.servers || []).map((s) => ({
          url: String(s.url).replace(/\{(\w+)\}/g, (m, v) => (s.variables && s.variables[v] ? s.variables[v].default : m)).replace(/\/$/, ''),
          description: s.description,
        }));
      }
      return list.length ? list : [{ url: '{{baseUrl}}', description: 'Set this to your API host' }];
    }

    // ---- auth ----
    function authFor(op) {
      const reqs = op.security !== undefined ? op.security : spec.security;
      if (!reqs || !reqs.length) return [];
      const defs = (isV2 ? spec.securityDefinitions : spec.components && spec.components.securitySchemes) || {};
      return Object.keys(reqs[0]).map((name) => {
        const d = deref(defs[name]);
        if (d.type === 'http' && /^bearer$/i.test(d.scheme)) return { name, label: 'Bearer Token', in: 'header', key: 'Authorization', value: 'Bearer <token>' };
        if (d.type === 'http' && /^basic$/i.test(d.scheme) || d.type === 'basic') return { name, label: 'Basic Auth', in: 'header', key: 'Authorization', value: 'Basic <credentials>' };
        if (d.type === 'apiKey') return { name, label: 'API Key', in: d.in, key: d.name, value: '<api-key>' };
        return { name, label: d.type === 'oauth2' ? 'OAuth 2.0' : (d.type || 'Auth'), in: 'header', key: 'Authorization', value: 'Bearer <token>' };
      });
    }

    // ---- operations ----
    function responsesOf(op) {
      return Object.entries(op.responses || {}).map(([code, r0]) => {
        const r = deref(r0);
        let contentType = null, body = null, schema = null;
        if (r.content) {
          contentType = Object.keys(r.content).find((c) => /json/.test(c)) || Object.keys(r.content)[0];
          body = mediaExample(r.content[contentType]);
          schema = r.content[contentType] && r.content[contentType].schema;
        } else if (r.schema) {
          contentType = (op.produces || spec.produces || ['application/json'])[0];
          schema = r.schema;
          body = r.examples && r.examples[contentType] !== undefined ? r.examples[contentType] : example(r.schema);
        }
        return { code, description: r.description || '', contentType, body: body === null ? null : stringify(body), fields: schema ? fields(schema) : [] };
      });
    }
    function mediaExample(media) {
      if (!media) return null;
      if (media.example !== undefined) return media.example;
      if (media.examples) { const first = Object.values(media.examples)[0]; if (first) return deref(first).value; }
      return example(media.schema);
    }
    function bodyOf(op, params) {
      if (op.requestBody) {
        const rb = deref(op.requestBody);
        const types = Object.keys(rb.content || {});
        const contentType = types.find((c) => /json/.test(c)) || types[0];
        if (!contentType) return null;
        const v = mediaExample(rb.content[contentType]);
        return { contentType, required: !!rb.required, description: rb.description, text: v === null ? '' : stringify(v), fields: fields(rb.content[contentType].schema) };
      }
      const p = params.find((x) => x.in === 'body');
      if (p) {
        const v = example(p.schema);
        return { contentType: (op.consumes || spec.consumes || ['application/json'])[0], required: !!p.required, description: p.description, text: v === null ? '' : stringify(v), fields: fields(p.schema) };
      }
      return null;
    }

    function operations() {
      const out = [];
      for (const [path, item0] of Object.entries(spec.paths || {})) {
        const item = deref(item0);
        for (const method of METHODS) {
          const op = item[method];
          if (!op || typeof op !== 'object') continue;
          const merged = new Map();
          for (const p of [...(item.parameters || []), ...(op.parameters || [])]) { const d = deref(p); merged.set(`${d.in}:${d.name}`, d); }
          const params = [...merged.values()].map((p) => {
            const s = isV2 && p.in !== 'body' ? p : deref(p.schema);
            const ex = p.example !== undefined ? p.example : example(p.schema || p);
            return { name: p.name, in: p.in, required: !!p.required || p.in === 'path', description: p.description || '', type: s.type || '', example: ex, schema: p.schema };
          });
          const tag = (op.tags && op.tags[0]) || 'default';
          const auth = authFor(op);
          const body = bodyOf(op, params);
          const headerParams = params.filter((p) => p.in === 'header');
          const headers = [
            ...auth.filter((a) => a.in === 'header').map((a) => ({ key: a.key, value: a.value, description: a.label, required: true })),
            ...(body ? [{ key: 'Content-Type', value: body.contentType, description: '', required: true }] : []),
            ...headerParams.map((p) => ({ key: p.name, value: String(p.example ?? ''), description: p.description, required: p.required })),
          ];
          out.push({
            method: method.toUpperCase(), path, tag, key: keyOf(method, path, op),
            name: op.summary || `${method.toUpperCase()} ${path}`, summary: op.summary || '', description: op.description || '',
            deprecated: !!op.deprecated, status: statusOf(op), statusNote: statusNoteOf(op), auth, headers, body, responses: responsesOf(op),
            pathParams: params.filter((p) => p.in === 'path'),
            queryParams: params.filter((p) => p.in === 'query'),
            authQuery: auth.filter((a) => a.in === 'query'),
          });
        }
      }
      return out;
    }

    // Folders in spec.tags order, then any others.
    function folders(ops) {
      const names = [...(spec.tags || []).map((t) => t.name), ...ops.map((o) => o.tag)];
      return [...new Set(names)].map((name) => ({
        name, description: ((spec.tags || []).find((t) => t.name === name) || {}).description || '',
        items: ops.filter((o) => o.tag === name),
      })).filter((f) => f.items.length);
    }

    // Full URL + headers + body for a request, with example values filled in.
    function buildRequest(op, serverUrl) {
      let path = op.path;
      for (const p of op.pathParams) path = path.replace(`{${p.name}}`, encodeURIComponent(String(p.example ?? p.name)));
      const query = [...op.queryParams.filter((p) => p.required).map((p) => [p.name, String(p.example ?? '')]),
        ...op.authQuery.map((a) => [a.key, a.value])];
      const qs = query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      return {
        method: op.method,
        url: serverUrl + path + (qs ? `?${qs}` : ''),
        headers: op.headers.filter((h) => h.required).map((h) => [h.key, h.value]),
        body: op.body && op.body.text ? op.body.text : null,
      };
    }

    return { spec, isV2, servers, operations, folders, buildRequest, example };
  }

  // ---- code samples ----
  const shq = (s) => String(s).replace(/'/g, `'\\''`);
  const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const indent = (s, n) => s.replace(/\n/g, '\n' + ' '.repeat(n));
  const generators = {
    cURL(r) {
      const parts = [`curl --request ${r.method}`, `--url '${shq(r.url)}'`];
      r.headers.forEach(([k, v]) => parts.push(`--header '${shq(k)}: ${shq(v)}'`));
      if (r.body) parts.push(`--data '${shq(r.body)}'`);
      return parts.join(' \\\n  ');
    },
    'JavaScript (fetch)'(r) {
      const opts = [`  method: ${JSON.stringify(r.method)},`];
      if (r.headers.length) opts.push(`  headers: ${indent(JSON.stringify(Object.fromEntries(r.headers), null, 2), 2)},`);
      if (r.body) {
        const obj = tryJson(r.body);
        opts.push(`  body: ${obj === undefined ? JSON.stringify(r.body) : `JSON.stringify(${indent(JSON.stringify(obj, null, 2), 2)})`},`);
      }
      return `const response = await fetch(${JSON.stringify(r.url)}, {\n${opts.join('\n')}\n});\nconst data = await response.json();\nconsole.log(data);`;
    },
    'Python (requests)'(r) {
      const args = [`    ${JSON.stringify(r.url)}`];
      if (r.headers.length) args.push(`    headers=${indent(JSON.stringify(Object.fromEntries(r.headers), null, 4), 4)}`);
      if (r.body) args.push(`    data=\'\'\'${r.body}\'\'\'`);
      return `import requests\n\nresponse = requests.request(\n    ${JSON.stringify(r.method)},\n${args.join(',\n')}\n)\nprint(response.status_code)\nprint(response.text)`;
    },
  };

  return { createModel, generators, METHODS };
});
