import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFathom, recordingLink, recordingLinks } from '../src/fathom.js';
import { fakeFathomFetch } from './fake-fathom.js';

test('recording links: call and share links, without ?timestamp=, nothing else', () => {
  assert.equal(recordingLink('https://fathom.video/calls/123456789?timestamp=193'), 'https://fathom.video/calls/123456789');
  assert.equal(recordingLink('https://fathom.video/share/fakeShare01?timestamp=2670'), 'https://fathom.video/share/fakeShare01');
  assert.equal(recordingLink('https://fathom.video/share/h/abc'), 'https://fathom.video/share/h/abc');
  assert.equal(recordingLink('https://fathom.video/users/sign_in'), null);
  assert.equal(recordingLink('https://evil.example/calls/1'), null);
  assert.equal(recordingLink('http://fathom.video/calls/1'), null);
  const links = recordingLinks([
    { body: '> — Ana (3:13) · [▶ Watch](https://fathom.video/calls/123456789?timestamp=193)' },
    { body: 'none', video: 'https://fathom.video/share/abc' },
  ]);
  assert.deepEqual([...links.keys()], ['https://fathom.video/calls/123456789', 'https://fathom.video/share/abc']);
  assert.equal(links.has('https://fathom.video/calls/12'), false, 'a link is matched whole, not by prefix');
});

test("a quote's line gives its meeting's day, so the recording can be found by date", () => {
  const links = recordingLinks([{ body: [
    'Updated 2026-09-01.',
    '> — Marta Quinn, scoping call, 2026-05-22 (5:25) [SRC-20260522-01](#outside) · [▶ Watch](https://fathom.video/calls/123456789?timestamp=325)',
    'Also [the kickoff](https://fathom.video/share/abc).',
  ].join('\n') }]);
  assert.equal(links.get('https://fathom.video/calls/123456789'), '2026-05-22');
  assert.equal(links.get('https://fathom.video/share/abc'), null, 'a day on another line is not used');
});

test('no API key, no Fathom', () => {
  assert.equal(createFathom({}), null);
});

test('finds a recording by its call or share link, across pages of meetings', async () => {
  const { fetch, calls } = fakeFathomFetch();
  const fathom = createFathom({ FATHOM_API_KEY: 'key' }, { fetch });
  assert.deepEqual(await fathom.meeting('https://fathom.video/calls/111'), { id: 42, title: 'Kickoff', date: '2026-09-29' });
  assert.equal((await fathom.meeting('https://fathom.video/share/abc')).id, 42);
  assert.equal(calls.length, 2, 'stops paging once found; then remembered');
  assert.equal(await fathom.meeting('https://fathom.video/calls/404'), null);
  assert.equal(calls.length, 3, 'an unknown link pages on from where the last walk stopped');
  assert.equal(await fathom.meeting('https://fathom.video/calls/405'), null);
  assert.equal(calls.length, 3, 'and not again right away');
});

test('a meeting months back is found by its day in one call, not by paging back to it', async () => {
  const { fetch, calls } = fakeFathomFetch();
  const fathom = createFathom({ FATHOM_API_KEY: 'key' }, { fetch });
  assert.equal((await fathom.meeting('https://fathom.video/calls/555', '2026-05-22')).id, 5);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /created_after=2026-05-20.*created_before=2026-05-24/);
});

test('a walk cut short by the rate limit picks up where it stopped', async () => {
  const { fetch, calls } = fakeFathomFetch({ busyAt: 2 });
  const fathom = createFathom({ FATHOM_API_KEY: 'key' }, { fetch });
  await assert.rejects(fathom.meeting('https://fathom.video/calls/555'), /busy/);
  assert.equal((await fathom.meeting('https://fathom.video/calls/555')).id, 5);
  assert.deepEqual(calls, ['GET /meetings', 'GET /meetings?cursor=1', 'GET /meetings?cursor=1', 'GET /meetings?cursor=2']);
});

test('transcripts come back in the brain\'s shape: speaker, short time, seconds, text', async () => {
  const fathom = createFathom({ FATHOM_API_KEY: 'key' }, fakeFathomFetch());
  assert.deepEqual(await fathom.transcript(42), [
    { t: 4, ts: '0:04', speaker: 'Ana', text: 'Hola a todos.' },
    { t: 3723, ts: '1:02:03', speaker: 'Ben', text: 'We want to ship faster.' },
  ]);
});

test('the video is pending while Fathom makes it, then ready and remembered', async () => {
  const { fetch, calls } = fakeFathomFetch();
  const fathom = createFathom({ FATHOM_API_KEY: 'key' }, { fetch });
  assert.deepEqual(await fathom.video(42), { status: 'pending' });
  assert.equal((await fathom.video(42)).status, 'ready');
  assert.equal((await fathom.video(42)).status, 'ready');
  assert.deepEqual(calls, ['POST /recordings/42/download', 'GET /recordings/42/downloads/dl_1']);
  const part = await fathom.fetchVideo(42, { range: 'bytes=1-' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-type'), 'video/mp4', "the download's type, not the file host's octet-stream");
  assert.equal(await part.text(), 'ideo');
});
