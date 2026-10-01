// A fake Fathom API: three meetings listed one per page, newest first (filterable by day), one
// transcript, and a video that takes one check to be ready. `busyAt`: the nth meetings call gets a 429.
const MEETINGS = [
  { recording_id: 7, created_at: '2026-09-30T10:00:00Z', url: 'https://fathom.video/calls/999', share_url: 'https://fathom.video/share/zzz' },
  { recording_id: 42, meeting_title: 'Kickoff', recording_start_time: '2026-09-29T15:00:00Z', created_at: '2026-09-29T16:00:00Z', url: 'https://fathom.video/calls/111', share_url: 'https://fathom.video/share/abc' },
  { recording_id: 5, meeting_title: 'Scoping', created_at: '2026-05-22T17:00:00Z', url: 'https://fathom.video/calls/555' },
];

export function fakeFathomFetch({ busyAt = 0 } = {}) {
  const calls = [];
  let meetingCalls = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, { method = 'GET', headers = {} } = {}) => {
    const path = url.replace('https://api.fathom.ai/external/v1', '');
    calls.push(`${method} ${path}`);
    if (url.startsWith('https://media.fathom.ai/')) {
      return headers.Range
        ? new Response('ideo', { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 1-4/5', 'content-length': '4', 'accept-ranges': 'bytes' } })
        : new Response('video', { headers: { 'content-type': 'video/mp4', 'content-length': '5' } });
    }
    if (headers['X-Api-Key'] !== 'key') return json({}, 401);
    if (path.startsWith('/meetings')) {
      if (++meetingCalls === busyAt) return json({}, 429);
      const q = new URL(url).searchParams;
      const after = Date.parse(q.get('created_after') || 0);
      const before = Date.parse(q.get('created_before') || '3000-01-01');
      const list = MEETINGS.filter((m) => Date.parse(m.created_at) > after && Date.parse(m.created_at) < before);
      const i = Number(q.get('cursor') || 0);
      return json({ items: list.slice(i, i + 1), next_cursor: i + 1 < list.length ? String(i + 1) : null });
    }
    if (path === '/recordings/42/transcript') {
      return json({ transcript: [
        { speaker: { display_name: 'Ana' }, text: 'Hola a todos.', timestamp: '00:00:04' },
        { speaker: { display_name: 'Ben' }, text: 'We want to ship faster.', timestamp: '01:02:03' },
      ] });
    }
    if (method === 'POST' && path === '/recordings/42/download') return json({ download_id: 'dl_1', recording_id: 42, status: 'processing' }, 202);
    if (path === '/recordings/42/downloads/dl_1') {
      return json({ download_id: 'dl_1', recording_id: 42, status: 'completed', video: { url: 'https://media.fathom.ai/downloads/x.mp4', content_type: 'video/mp4', file_size_bytes: 5, expires_at: new Date(Date.now() + 86400e3).toISOString() } });
    }
    return json({}, 404);
  };
  return { fetch, calls };
}
