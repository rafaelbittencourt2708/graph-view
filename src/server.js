import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { getCookie, setCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createGitHub, parseRepoUrl, GitHubError } from './github.js';
import { buildGraph } from './graph.js';
import { createFathom, recordingLink, recordingLinks, FathomError } from './fathom.js';
import { openDb } from './db.js';
import { verifyPassword, accessToken, tokenMatches, createLimiter } from './access.js';

const env = process.env;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const production = env.NODE_ENV === 'production' || Boolean(env.RAILWAY_ENVIRONMENT);
const REF_TTL_MS = Number(env.REF_TTL_SECONDS || 60) * 1000;
const NAME = /^[\w.-]+$/;
const REF = /^[\w./-]+$/;
const FOLDER = /^(?:[\w .@()+-]+(?:\/[\w .@()+-]+)*)?$/;
const ACCESS_DAYS = 30;

if (production && !env.ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD must be set in production.');
  process.exit(1);
}

export function createApp({ github = createGitHub(env), db = openDb(env.DATABASE_PATH || path.join(root, 'data', 'brain-graph.db')), fathom = createFathom(env) } = {}) {
  const app = new Hono();
  const page = (name) => fs.readFileSync(path.join(root, 'public', name), 'utf8');

  // Graph cache: per share we remember the commit we last resolved; per commit+folder, the built graph.
  const heads = new Map(); // share id -> { sha, at }
  const graphs = new Map(); // "owner/repo@sha:folder" -> Promise<graph>

  async function graphFor(share) {
    let head = heads.get(share.id);
    if (!head || Date.now() - head.at > REF_TTL_MS) {
      head = { sha: await github.resolveCommit(share.owner, share.repo, share.ref), at: Date.now() };
      heads.set(share.id, head);
    }
    const key = `${share.owner}/${share.repo}@${head.sha}:${share.folder}`;
    if (!graphs.has(key)) {
      const p = github.fetchFolder(share.owner, share.repo, head.sha, share.folder).then((files) => buildGraph(files));
      p.catch(() => graphs.delete(key));
      graphs.set(key, p);
      while (graphs.size > 50) graphs.delete(graphs.keys().next().value);
    }
    return { sha: head.sha, ...(await graphs.get(key)) };
  }

  app.use('*', secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
    referrerPolicy: 'no-referrer', // share links must not leak through the Referer header
  }));
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Robots-Tag', 'noindex, nofollow');
  });

  app.onError((err, c) => {
    if (err instanceof GitHubError) {
      const status = err.status === 404 ? 404 : 502;
      return c.json({ error: `GitHub: ${err.message}` }, status);
    }
    if (err instanceof FathomError) {
      console.warn(`Fathom: ${err.status} ${err.path}`);
      return c.json({ error: err.message }, 502);
    }
    if (err.status && err.getResponse) return err.getResponse();
    console.error(err);
    return c.json({ error: err.message || 'Something went wrong.' }, 500);
  });

  app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), path.join(root, 'public')) || '.', rewriteRequestPath: (p) => p.replace(/^\/assets/, '') }));
  app.get('/healthz', (c) => c.text('ok'));

  // ---- Public: anyone with the link (and its password, if it has one) ----

  const limiter = createLimiter();
  const cookieName = (share) => `bg_${share.id}`;
  const unlocked = (c, share) => !share.password_hash
    || tokenMatches(getCookie(c, cookieName(share)), accessToken(db.cookieSecret, share));
  // Railway's edge sets X-Real-IP; the last X-Forwarded-For hop is the fallback (earlier ones are client-supplied).
  const clientIp = (c) => c.req.header('x-real-ip') || (c.req.header('x-forwarded-for') || '').split(',').pop().trim() || 'local';
  const loginPage = (error) => page('login.html').replace('<!--error-->', error ? `<div class="error">${error}</div>` : '');

  app.get('/s/:id', (c) => {
    const share = db.get(c.req.param('id'));
    if (!share) return c.html(page('gone.html'), 404);
    if (!unlocked(c, share)) return c.html(loginPage());
    return c.html(page('viewer.html'));
  });

  app.post('/s/:id', async (c) => {
    const share = db.get(c.req.param('id'));
    if (!share) return c.html(page('gone.html'), 404);
    if (!share.password_hash) return c.redirect(`/s/${share.id}`, 303);
    const key = `${share.id}|${clientIp(c)}`;
    if (limiter.blocked(key)) return c.html(loginPage('Too many wrong tries. Wait 15 minutes, then try again.'), 429);
    const { password } = await c.req.parseBody();
    if (typeof password !== 'string' || !verifyPassword(password, share.password_hash)) {
      limiter.fail(key);
      return c.html(loginPage('That password isn\'t right.'), 401);
    }
    limiter.clear(key);
    setCookie(c, cookieName(share), accessToken(db.cookieSecret, share), {
      path: '/', httpOnly: true, secure: production, sameSite: 'Lax', maxAge: ACCESS_DAYS * 24 * 3600,
    });
    return c.redirect(`/s/${share.id}`, 303);
  });

  app.get('/api/s/:id/graph', async (c) => {
    const share = db.get(c.req.param('id'));
    if (!share) return c.json({ error: 'This link has been turned off or never existed.' }, 404);
    if (!unlocked(c, share)) return c.json({ error: 'This map needs a password.' }, 401);
    const g = await graphFor(share);
    if (fathom) fathom.keepWarm(linksIn(g.nodes)); // in the background: someone may watch soon
    c.header('Cache-Control', 'private, max-age=30');
    return c.json({ title: share.title, sha: g.sha.slice(0, 7), nodes: g.nodes, edges: g.edges, sections: g.sections || null, recordings: Boolean(fathom) });
  });

  // ---- Meeting recordings (Fathom): only the ones the shared notes link to ----

  const linksOf = new WeakMap(); // a graph's nodes -> the recording links in them
  const linksIn = (nodes) => {
    if (!linksOf.has(nodes)) linksOf.set(nodes, recordingLinks(nodes));
    return linksOf.get(nodes);
  };
  async function recordingFor(c) {
    const share = db.get(c.req.param('id'));
    if (!share) return { error: c.json({ error: 'This link has been turned off or never existed.' }, 404) };
    if (!unlocked(c, share)) return { error: c.json({ error: 'This map needs a password.' }, 401) };
    const link = recordingLink(c.req.query('url'));
    if (!link) return { error: c.json({ error: 'That isn\'t a Fathom recording link.' }, 400) };
    if (!fathom) return { error: c.json({ error: 'Recordings can\'t be played here.' }, 404) };
    const { nodes } = await graphFor(share);
    const links = linksIn(nodes);
    if (!links.has(link)) return { error: c.json({ error: 'These notes don\'t link to that recording.' }, 404) };
    const meeting = await fathom.meeting(link, links.get(link));
    if (!meeting) return { error: c.json({ error: 'Fathom couldn\'t find this recording.' }, 404) };
    return { meeting };
  }

  // The transcript, and whether the video can play yet (Fathom prepares it the first time).
  app.get('/api/s/:id/recording', async (c) => {
    const { error, meeting } = await recordingFor(c);
    if (error) return error;
    const [transcript, video] = await Promise.all([fathom.transcript(meeting.id), fathom.video(meeting.id)]);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ title: meeting.title, date: meeting.date, transcript, video: video.status });
  });

  // The video goes through here rather than to Fathom directly, so turning a link off stops it too.
  app.get('/api/s/:id/recording/video', async (c) => {
    const { error, meeting } = await recordingFor(c);
    if (error) return error;
    const res = await fathom.fetchVideo(meeting.id, { range: c.req.header('range'), signal: c.req.raw.signal });
    if (!res) return c.json({ error: 'The video isn\'t ready yet.' }, 409);
    if (!res.ok) return c.json({ error: 'Fathom didn\'t send the video. Try again.' }, 502);
    const headers = new Headers({ 'Cache-Control': 'private, max-age=3600' });
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (res.headers.has(h)) headers.set(h, res.headers.get(h));
    return new Response(res.body, { status: res.status, headers });
  });

  // ---- Admin: create and revoke links ----

  if (env.ADMIN_PASSWORD) {
    const auth = basicAuth({ username: env.ADMIN_USER || 'admin', password: env.ADMIN_PASSWORD });
    app.use('/admin', auth);
    app.use('/api/admin/*', auth);
  } else {
    console.warn('ADMIN_PASSWORD is not set: the admin page is open (fine locally, never in production).');
  }

  app.get('/', (c) => c.redirect('/admin'));
  app.get('/admin', (c) => c.html(page('admin.html')));

  app.get('/api/admin/repo', async (c) => {
    const parsed = parseRepoUrl(c.req.query('url'));
    if (!parsed) return c.json({ error: 'That doesn\'t look like a GitHub repo. Paste something like github.com/owner/repo.' }, 400);
    const repo = await github.getRepo(parsed.owner, parsed.repo);
    const branches = await github.listBranches(repo.owner, repo.repo);
    return c.json({ ...repo, branches, hint: parsed.rest });
  });

  app.get('/api/admin/folders', async (c) => {
    const { owner, repo, ref } = c.req.query();
    if (!NAME.test(owner || '') || !NAME.test(repo || '') || !REF.test(ref || '')) return c.json({ error: 'Bad repo or branch.' }, 400);
    const sha = await github.resolveCommit(owner, repo, ref);
    return c.json({ sha, ...(await github.listFolders(owner, repo, sha)) });
  });

  app.get('/api/admin/shares', (c) => c.json(db.list()));

  app.post('/api/admin/shares', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const folder = String(b.folder || '').replace(/^\/+|\/+$/g, '');
    if (!NAME.test(b.owner || '') || !NAME.test(b.repo || '') || !REF.test(b.ref || '') || !FOLDER.test(folder)) {
      return c.json({ error: 'Bad repo, branch or folder.' }, 400);
    }
    const sha = await github.resolveCommit(b.owner, b.repo, b.ref);
    const { folders } = await github.listFolders(b.owner, b.repo, sha);
    if (!folders.some((f) => f.path === folder)) return c.json({ error: `No markdown found in "${folder || '/'}".` }, 400);
    const title = String(b.title || '').trim().slice(0, 120) || `${b.repo}${folder ? ` / ${folder}` : ''}`;
    const password = checkPassword(b.password);
    if (password instanceof Error) return c.json({ error: password.message }, 400);
    return c.json(db.summary(db.create({ owner: b.owner, repo: b.repo, ref: b.ref, folder, title, password })), 201);
  });

  // Set, change or remove (empty) a link's password. Changing it signs out everyone who had the old one.
  app.put('/api/admin/shares/:id/password', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const password = checkPassword(b.password);
    if (password instanceof Error) return c.json({ error: password.message }, 400);
    return db.setPassword(c.req.param('id'), password) ? c.body(null, 204) : c.json({ error: 'No such link.' }, 404);
  });

  app.delete('/api/admin/shares/:id', (c) => {
    return db.revoke(c.req.param('id')) ? c.body(null, 204) : c.json({ error: 'No such link.' }, 404);
  });

  return app;
}

// Empty means "no password". Otherwise at least 8 characters, so it can't be guessed in a few tries.
function checkPassword(value) {
  const password = String(value ?? '');
  if (!password) return null;
  if (password.length < 8) return new Error('Passwords need at least 8 characters.');
  if (password.length > 200) return new Error('That password is too long.');
  return password;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(env.PORT || 3000);
  serve({ fetch: app.fetch, port }, () => console.log(`brain-graph on http://localhost:${port}`));
}
