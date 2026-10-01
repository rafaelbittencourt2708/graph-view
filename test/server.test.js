import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createFathom } from '../src/fathom.js';
import { fakeFathomFetch } from './fake-fathom.js';

// A fake GitHub that records which paths were requested, so we can prove nothing outside the folder is fetched.
function fakeGitHub() {
  const repoFiles = {
    'brain/a.md': '---\ntype: pain\n---\n# A\n[b](b.md) [secret](../internal/secret.md)',
    'brain/b.md': '# B\n> "We want to ship faster."\n>\n> — Ben, kickoff (1:02:03) · [▶ Watch](https://fathom.video/calls/111?timestamp=3723)',
    'internal/secret.md': 'TOP SECRET',
  };
  return {
    fetched: [],
    async resolveCommit() { return 'abc1234def'; },
    async listFolders() { return { folders: [{ path: '', md: 3 }, { path: 'brain', md: 2 }, { path: 'internal', md: 1 }] }; },
    async fetchFolder(owner, repo, sha, folder) {
      this.fetched.push(folder);
      return new Map(Object.entries(repoFiles).filter(([p]) => p.startsWith(`${folder}/`)).map(([p, t]) => [p.slice(folder.length + 1), t]));
    },
  };
}

test('share lifecycle: create, view, revoke', async () => {
  const github = fakeGitHub();
  const app = createApp({ github, db: openDb(':memory:') });
  const create = await app.request('/api/admin/shares', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'o', repo: 'r', ref: 'main', folder: 'brain', title: 'Test' }),
  });
  assert.equal(create.status, 201);
  const { id } = await create.json();
  assert.ok(id.length >= 22);

  const graph = await (await app.request(`/api/s/${id}/graph`)).json();
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.sections, null);
  assert.ok(!JSON.stringify(graph).includes('TOP SECRET'));
  assert.ok(!JSON.stringify(graph).includes('"o"'), 'repo owner is not exposed publicly');
  assert.deepEqual(github.fetched, ['brain']);

  assert.equal((await app.request(`/api/admin/shares/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await app.request(`/api/s/${id}/graph`)).status, 404);
  assert.equal((await app.request(`/s/${id}`)).status, 404);
});

test('rejects folders that do not exist or try to escape', async () => {
  const app = createApp({ github: fakeGitHub(), db: openDb(':memory:') });
  for (const folder of ['../etc', 'nope', 'brain/../internal']) {
    const res = await app.request('/api/admin/shares', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'o', repo: 'r', ref: 'main', folder }),
    });
    assert.equal(res.status, 400, folder);
  }
});

test('unknown share ids get a 404', async () => {
  const app = createApp({ github: fakeGitHub(), db: openDb(':memory:') });
  assert.equal((await app.request('/api/s/doesnotexist/graph')).status, 404);
});

async function createShare(app, extra = {}) {
  const res = await app.request('/api/admin/shares', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'o', repo: 'r', ref: 'main', folder: 'brain', ...extra }),
  });
  return { status: res.status, body: await res.json() };
}

function login(app, id, password, ip = '1.2.3.4') {
  return app.request(`/s/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': ip },
    body: new URLSearchParams({ password }).toString(),
  });
}

test('password-protected link: locked until the right password, then a cookie opens it', async () => {
  const app = createApp({ github: fakeGitHub(), db: openDb(':memory:') });
  const { status, body } = await createShare(app, { password: 'correct horse' });
  assert.equal(status, 201);
  assert.equal(body.has_password, true);
  assert.ok(!('password_hash' in body), 'the hash never leaves the server');

  const page = await app.request(`/s/${body.id}`);
  assert.match(await page.text(), /needs a password/);
  assert.equal((await app.request(`/api/s/${body.id}/graph`)).status, 401);

  const wrong = await login(app, body.id, 'wrong password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);

  const right = await login(app, body.id, 'correct horse');
  assert.equal(right.status, 303);
  const cookie = right.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  const pair = cookie.split(';')[0];

  const graph = await app.request(`/api/s/${body.id}/graph`, { headers: { cookie: pair } });
  assert.equal(graph.status, 200);
  assert.match(await (await app.request(`/s/${body.id}`, { headers: { cookie: pair } })).text(), /Loading…/);

  const list = await (await app.request('/api/admin/shares')).json();
  assert.ok(!JSON.stringify(list).includes('scrypt'), 'admin list does not include hashes');
});

test('changing a password signs out old cookies; removing it opens the link', async () => {
  const app = createApp({ github: fakeGitHub(), db: openDb(':memory:') });
  const { body } = await createShare(app, { password: 'first-password' });
  const pair = (await login(app, body.id, 'first-password')).headers.get('set-cookie').split(';')[0];

  const setPw = (password) => app.request(`/api/admin/shares/${body.id}/password`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  });
  assert.equal((await setPw('short')).status, 400);
  assert.equal((await setPw('second-password')).status, 204);
  assert.equal((await app.request(`/api/s/${body.id}/graph`, { headers: { cookie: pair } })).status, 401);

  assert.equal((await setPw('')).status, 204);
  assert.equal((await app.request(`/api/s/${body.id}/graph`)).status, 200);
});

test('links without a password stay open, and short passwords are refused', async () => {
  const app = createApp({ github: fakeGitHub(), db: openDb(':memory:') });
  const open = await createShare(app);
  assert.equal(open.body.has_password, false);
  assert.equal((await app.request(`/api/s/${open.body.id}/graph`)).status, 200);
  assert.equal((await createShare(app, { password: 'abc' })).status, 400);
});

test('too many wrong passwords from one address get throttled', async () => {
  const app = createApp({ github: fakeGitHub(), db: openDb(':memory:') });
  const { body } = await createShare(app, { password: 'correct horse' });
  for (let i = 0; i < 10; i++) assert.equal((await login(app, body.id, `nope-${i}-xx`)).status, 401);
  assert.equal((await login(app, body.id, 'correct horse')).status, 429, 'even the right one waits');
  assert.equal((await login(app, body.id, 'correct horse', '5.6.7.8')).status, 303, 'other addresses are unaffected');
});

test('an older database without the password column is upgraded in place', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bg-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE shares (id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, ref TEXT NOT NULL,
    folder TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)`);
  old.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run('oldid', 'o', 'r', 'main', 'brain', 'Old', '2026-09-28');
  old.close();

  const db = openDb(file);
  assert.equal(db.list()[0].has_password, false);
  assert.equal(db.setPassword('oldid', 'now-protected'), true);
  assert.equal(openDb(file).cookieSecret, db.cookieSecret, 'the cookie key survives a restart');
});

test('recordings: only ones the shared notes link to, with transcript and a video that streams through us', async () => {
  const fake = fakeFathomFetch();
  const app = createApp({ github: fakeGitHub(), db: openDb(':memory:'), fathom: createFathom({ FATHOM_API_KEY: 'key' }, fake) });
  const { body } = await createShare(app);
  const rec = (url, path = '') => app.request(`/api/s/${body.id}/recording${path}?url=${encodeURIComponent(url)}`);
  assert.equal((await (await app.request(`/api/s/${body.id}/graph`)).json()).recordings, true);
  // opening the map asks Fathom to make the linked videos, before anyone clicks "Watch"
  for (let i = 0; i < 50 && !fake.calls.includes('POST /recordings/42/download'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fake.calls.includes('POST /recordings/42/download'));

  const first = await (await rec('https://fathom.video/calls/111?timestamp=3723')).json();
  assert.equal(first.title, 'Kickoff');
  assert.equal(first.transcript[1].ts, '1:02:03');
  assert.equal(first.video, 'ready');
  assert.ok(!JSON.stringify(first).includes('media.fathom.ai'), 'the signed file link stays on the server');

  const part = await app.request(`/api/s/${body.id}/recording/video?url=${encodeURIComponent('https://fathom.video/calls/111')}`, { headers: { range: 'bytes=1-' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 1-4/5');
  assert.equal(await part.text(), 'ideo');

  assert.equal((await rec('https://fathom.video/calls/999')).status, 404, 'a recording the notes never link to');
  assert.equal((await rec('https://example.com/calls/111')).status, 400);
  await app.request(`/api/admin/shares/${body.id}`, { method: 'DELETE' });
  assert.equal((await rec('https://fathom.video/calls/111', '/video')).status, 404, 'turning the link off stops the video');
});

test('recordings need the link\'s password, and say so when Fathom isn\'t set up', async () => {
  const locked = createApp({ github: fakeGitHub(), db: openDb(':memory:'), fathom: createFathom({ FATHOM_API_KEY: 'key' }, fakeFathomFetch()) });
  const { body } = await createShare(locked, { password: 'correct horse' });
  assert.equal((await locked.request(`/api/s/${body.id}/recording?url=${encodeURIComponent('https://fathom.video/calls/111')}`)).status, 401);

  const off = createApp({ github: fakeGitHub(), db: openDb(':memory:'), fathom: null });
  const open = (await createShare(off)).body;
  assert.equal((await (await off.request(`/api/s/${open.id}/graph`)).json()).recordings, false);
  assert.equal((await off.request(`/api/s/${open.id}/recording?url=${encodeURIComponent('https://fathom.video/calls/111')}`)).status, 404);
});
