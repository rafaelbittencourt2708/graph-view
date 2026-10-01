// Read-only access to Fathom meeting recordings: the transcript, and a playable copy of the video,
// with an API key (`FATHOM_API_KEY`). The key's account must be able to see the recordings.

const API = 'https://api.fathom.ai/external/v1';
const VIDEO_TTL_MS = 20 * 3600 * 1000; // Fathom's signed file links last ~24 hours
const RESCAN_MS = 10 * 60 * 1000; // how often an unknown recording may trigger a new walk through the meetings
const DAY_MS = 24 * 3600 * 1000;
const WARM_EVERY_MS = 5 * 60 * 1000; // how often to check that watched meetings still have a copy
const WARM_FOR_MS = 7 * DAY_MS; // how long after a map was last opened its videos are kept ready
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

export class FathomError extends Error {
  constructor(status, message, path = '') {
    super(message);
    this.status = status;
    this.path = path.split('?')[0]; // for the logs; never the key
  }
}

// A Fathom link without its query (?timestamp=) or hash, or null if it isn't a recording link.
// Call links (/calls/123) and share links (/share/abc, /share/h/abc) name a recording.
export function recordingLink(url) {
  const m = String(url || '').match(/^https:\/\/fathom\.video\/(calls\/\d+|share\/(?:[a-z]\/)?[\w-]+)(?=$|[?#/])/);
  return m ? `https://fathom.video/${m[1]}` : null;
}

// Every recording link that appears in these notes (the only recordings a share may play), with the
// meeting's day when the line gives it, as the brain's quotes do: "— Ana, kickoff, 2026-09-29 (44:30) · [▶ Watch](...)".
export function recordingLinks(nodes) {
  const links = new Map(); // link -> "YYYY-MM-DD" or null
  for (const n of nodes) {
    const text = `${n.body}\n${n.video || ''}`;
    for (const m of text.matchAll(/https:\/\/fathom\.video\/[^\s)"'<>\]]+/g)) {
      const link = recordingLink(m[0]);
      if (!link) continue;
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index);
      const day = [...line.matchAll(/\b(20\d\d-\d\d-\d\d)\b/g)].pop()?.[1] || null;
      if (!links.get(link)) links.set(link, day);
    }
  }
  return links;
}

// "00:17:08" -> "17:08", "01:02:03" -> "1:02:03", the way the brain writes times.
function shortTime(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function createFathom(env = process.env, { fetch = globalThis.fetch } = {}) {
  const key = env.FATHOM_API_KEY;
  if (!key) return null;

  async function api(path, { method = 'GET' } = {}) {
    const res = await fetch(API + path, { method, headers: { 'X-Api-Key': key, Accept: 'application/json' } });
    if (!res.ok) throw new FathomError(res.status, res.status === 429 ? 'Fathom is busy. Try again in a minute.' : `Fathom answered ${res.status}.`, path);
    return res.json();
  }

  // Recording links -> { id, title, date }. Fathom lists meetings 10 at a time, newest first, and allows
  // 60 calls a minute, so a meeting months back is looked up by its day, not by paging back to it.
  const meetings = new Map();
  async function readPage(query, cursor) {
    const q = new URLSearchParams({ ...query, ...(cursor && { cursor }) });
    const page = await api(`/meetings${q.size ? `?${q}` : ''}`);
    for (const m of page.items || []) {
      const info = { id: m.recording_id, title: m.meeting_title || m.title || '', date: (m.recording_start_time || m.created_at || '').slice(0, 10) };
      for (const u of [m.url, m.share_url]) if (recordingLink(u)) meetings.set(recordingLink(u), info);
    }
    return page.next_cursor || null;
  }
  async function around(link, day) {
    const at = Date.parse(`${day}T12:00:00Z`);
    if (Number.isNaN(at)) return;
    const window = { created_after: new Date(at - 2 * DAY_MS).toISOString(), created_before: new Date(at + 2 * DAY_MS).toISOString() };
    let cursor = null;
    let pages = 0;
    do cursor = await readPage(window, cursor);
    while (cursor && !meetings.has(link) && ++pages < 10);
  }
  // Without a day, page back from the newest; a walk cut short by the rate limit resumes where it stopped.
  const walk = { cursor: null, doneAt: 0 };
  async function pageBack(link) {
    if (Date.now() - walk.doneAt < RESCAN_MS) return;
    do walk.cursor = await readPage({}, walk.cursor);
    while (walk.cursor && !meetings.has(link));
    if (!walk.cursor) walk.doneAt = Date.now();
  }
  const lookups = new Map(); // link -> the lookup in flight, so polls don't start another
  async function meeting(link, day = null) {
    if (!meetings.has(link) && !lookups.has(link)) {
      const p = (async () => {
        if (day) await around(link, day);
        if (!meetings.has(link)) await pageBack(link);
      })().finally(() => lookups.delete(link));
      lookups.set(link, p);
    }
    await lookups.get(link);
    return meetings.get(link) || null;
  }

  const transcripts = new Map(); // recording id -> Promise<turns>
  function transcript(id) {
    if (!transcripts.has(id)) {
      const p = api(`/recordings/${id}/transcript`).then((r) => (r.transcript || []).map((t) => {
        const ts = shortTime(t.timestamp);
        return { t: ts.split(':').reduce((n, x) => n * 60 + Number(x), 0), ts, speaker: t.speaker?.display_name || 'Someone', text: t.text };
      }));
      p.catch(() => transcripts.delete(id));
      transcripts.set(id, p);
    }
    return transcripts.get(id);
  }

  // Fathom makes the video file in the background: the first ask starts it, later asks check on it.
  const videos = new Map(); // recording id -> { downloadId } while pending, { file, until } once ready
  async function video(id) {
    const v = videos.get(id);
    if (v?.file && Date.now() < v.until) return { status: 'ready', file: v.file };
    const d = v?.downloadId
      ? await api(`/recordings/${id}/downloads/${encodeURIComponent(v.downloadId)}`)
      : await api(`/recordings/${id}/download`, { method: 'POST' });
    const file = d.video || d.audio;
    if (d.status === 'completed' && file?.url) {
      const expires = Date.parse(file.expires_at) - 10 * 60 * 1000;
      videos.set(id, { file, until: Math.min(Number.isNaN(expires) ? Infinity : expires, Date.now() + VIDEO_TTL_MS) });
      return { status: 'ready', file };
    }
    if (d.status === 'processing') {
      videos.set(id, { downloadId: d.download_id });
      return { status: 'pending' };
    }
    videos.delete(id); // failed or expired: the next ask starts over
    return { status: d.status === 'expired' ? 'pending' : 'failed' };
  }

  // The video file itself (or the byte range the browser asked for), or null while it isn't ready.
  async function fetchVideo(id, { range, signal } = {}) {
    const v = await video(id);
    if (v.status !== 'ready') return null;
    const res = await fetch(v.file.url, { headers: range ? { Range: range } : {}, signal });
    if (res.status === 403 || res.status === 404) videos.delete(id); // the signed link ran out early
    // The file is served as octet-stream, which Safari won't play; the download says what it is.
    const headers = new Headers(res.headers);
    if (v.file.content_type) headers.set('content-type', v.file.content_type);
    return new Response(res.body, { status: res.status, headers });
  }

  // Fathom takes a minute or more to make a meeting's video, but hands back a copy it made in the last
  // day at once. So opening a map gets its videos made ahead, and they're made again when a copy runs
  // out, one meeting at a time to stay inside Fathom's limits. "Watch" then rarely waits.
  const warm = new Map(); // link -> { day, seen }
  let warming = null;
  async function warmUp() {
    for (const [link, w] of warm) {
      if (Date.now() - w.seen > WARM_FOR_MS) { warm.delete(link); continue; }
      try {
        const m = await meeting(link, w.day);
        for (let i = 0; m && i < 60 && (await video(m.id)).status === 'pending'; i++) await sleep(5000);
      } catch (err) {
        console.warn(`Fathom: getting ${link} ready failed (${err.status || err.message})`);
      }
    }
  }
  function keepWarm(links) {
    for (const [link, day] of links) warm.set(link, { day, seen: Date.now() });
    warming ||= warmUp().finally(() => { warming = null; });
    return warming;
  }
  setInterval(() => { if (warm.size) warming ||= warmUp().finally(() => { warming = null; }); }, WARM_EVERY_MS).unref();

  return { meeting, transcript, video, fetchVideo, keepWarm };
}
