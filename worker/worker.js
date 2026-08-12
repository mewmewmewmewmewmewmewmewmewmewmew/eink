/* E-Ink Cam project storage — a Cloudflare Worker backed by R2.
 *
 * Routes (all under the Worker's origin):
 *   GET    /projects            -> { projects: [meta, …] }, newest first
 *   PUT    /projects/:id        -> multipart: meta (JSON string) + blob (file)
 *   GET    /projects/:id/blob   -> the background image
 *   DELETE /projects/:id        -> removes metadata and background
 *
 * Bindings: BUCKET (R2). Optional vars: TOKEN (bearer secret),
 * ALLOW_ORIGIN (defaults to *), KEEP (how many projects to retain).
 */

const META = 'meta/', BLOB = 'blob/';
const DEFAULT_KEEP = 12;

function cors(env) {
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOW_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    /* The client re-reads this list to show what is stored; a cached copy
       would show projects that have since been deleted. */
    'Cache-Control': 'no-store',
  };
}

function json(body, env, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors(env)),
  });
}

/* 204 is a null-body status: handing it a string body — even an empty one —
   is a TypeError, which would have thrown on every CORS preflight. */
function preflight(env) {
  return new Response(null, { status: 204, headers: cors(env) });
}

function authorised(request, env) {
  if (!env.TOKEN) return true;                 // open instance
  const h = request.headers.get('Authorization') || '';
  return h === 'Bearer ' + env.TOKEN;
}

/* Ids are generated client-side from a timestamp; keep them to that shape so
   nothing can reach outside the two prefixes this Worker owns. */
function safeId(id) {
  return /^[0-9]{1,20}$/.test(id || '') ? id : null;
}

async function listProjects(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: META, cursor });
    for (const obj of page.objects) {
      const rec = await env.BUCKET.get(obj.key);
      if (!rec) continue;
      try { out.push(JSON.parse(await rec.text())); } catch (_) { /* skip */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  out.sort((a, b) => Number(b.id) - Number(a.id));
  return out;
}

async function prune(env) {
  const keep = Number(env.KEEP || DEFAULT_KEEP);
  const all = await listProjects(env);
  for (const rec of all.slice(keep)) {
    await env.BUCKET.delete(META + rec.id + '.json');
    await env.BUCKET.delete(BLOB + rec.id);
  }
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') return preflight(env);
  if (!authorised(request, env)) return json({ error: 'unauthorised' }, env, 401);

  if (path === '/projects' && request.method === 'GET') {
    return json({ projects: await listProjects(env) }, env);
  }

  const m = path.match(/^\/projects\/([^/]+)(\/blob)?$/);
  if (m) {
    const id = safeId(m[1]);
    if (!id) return json({ error: 'bad id' }, env, 400);

    if (m[2] && request.method === 'GET') {
      const obj = await env.BUCKET.get(BLOB + id);
      if (!obj) return json({ error: 'not found' }, env, 404);
      const h = Object.assign({
        'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
      }, cors(env));
      return new Response(obj.body, { headers: h });
    }

    if (request.method === 'PUT') {
      let form;
      try { form = await request.formData(); }
      catch (_) { return json({ error: 'expected multipart form data' }, env, 400); }

      const metaRaw = form.get('meta');
      const blob = form.get('blob');
      if (!metaRaw || !blob) return json({ error: 'meta and blob are required' }, env, 400);

      let meta;
      try { meta = JSON.parse(metaRaw); }
      catch (_) { return json({ error: 'meta is not JSON' }, env, 400); }
      meta.id = id;

      await env.BUCKET.put(BLOB + id, blob.stream ? blob.stream() : blob, {
        httpMetadata: { contentType: blob.type || 'application/octet-stream' },
      });
      await env.BUCKET.put(META + id + '.json', JSON.stringify(meta), {
        httpMetadata: { contentType: 'application/json' },
      });
      await prune(env);
      return json({ ok: true, id }, env);
    }

    if (request.method === 'DELETE') {
      await env.BUCKET.delete(META + id + '.json');
      await env.BUCKET.delete(BLOB + id);
      return json({ ok: true }, env);
    }
  }

  return json({ error: 'not found' }, env, 404);
}

export default {
  fetch: (request, env) => handle(request, env).catch(
    err => json({ error: String(err && err.message || err) }, env, 500)
  ),
};
