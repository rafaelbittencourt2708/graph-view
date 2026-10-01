// Turns a folder of markdown files into a graph: one node per note, one edge per link
// between two notes inside the folder. Links that leave the folder are never followed.

import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const posix = path.posix;
const MD_LINK = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const WIKI_LINK = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: text };
  let data = {};
  try { data = parseYaml(m[1]) || {}; } catch { /* malformed frontmatter: treat as none */ }
  if (typeof data !== 'object' || Array.isArray(data)) data = {};
  return { data, body: text.slice(m[0].length) };
}

// Resolve a relative link written in `fromFile` to a path inside the folder, or null if it leaves it.
export function resolveInside(fromFile, target, files) {
  let t;
  try { t = decodeURIComponent(target.split('#')[0].split('?')[0]); } catch { return null; }
  if (!t) return null;
  const joined = t.startsWith('/') ? t.slice(1) : posix.join(posix.dirname(fromFile), t);
  const p = posix.normalize(joined);
  if (p.startsWith('../') || p === '..' || posix.isAbsolute(p)) return null;
  for (const candidate of [p, `${p}.md`, posix.join(p, 'README.md'), posix.join(p, 'index.md')]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function scalar(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v == null || typeof v === 'object') return null;
  return String(v);
}

// A recording of the note (a meeting), from its frontmatter. Fathom's share link opens for anyone,
// so it beats the team-only call link. Only https links, since the viewer puts it in an href.
const VIDEO_FIELDS = ['video', 'fathom_share_url', 'fathom_url'];
function videoOf(data) {
  for (const f of VIDEO_FIELDS) {
    const v = scalar(data[f]);
    if (v && /^https:\/\/\S+$/i.test(v)) return v;
  }
  return null;
}

// Fathom-style transcripts: an optional avatar line (initials, or the name again), the speaker's
// name, the time on its own line, then what they said. From the first such turn to the end of the
// note, the body is replaced by a list of turns the viewer can jump to and highlight.
const TS_LINE = /^(\d{1,2}:\d{2}(?::\d{2})?)$/;
const MIN_TURNS = 3;
const isName = (s) => s.length > 0 && s.length <= 60 && !/[.?!,;:]$/.test(s) && !TS_LINE.test(s);
const isAvatar = (s, name) => s === name || /^[A-Z]{1,3}$/.test(s);
const seconds = (ts) => ts.split(':').reduce((n, part) => n * 60 + Number(part), 0);

export function splitTranscript(body) {
  const lines = body.split(/\r?\n/);
  const blank = (i) => i < 0 || !lines[i].trim();
  const heads = []; // { at: first line of the turn, name, ts, textFrom }
  for (let i = 1; i < lines.length; i++) {
    const ts = lines[i].trim();
    const name = lines[i - 1].trim();
    if (!TS_LINE.test(ts) || !isName(name)) continue;
    const avatar = i - 2 >= 0 ? lines[i - 2].trim() : '';
    if (avatar && isAvatar(avatar, name) && blank(i - 3)) heads.push({ at: i - 2, name, ts, textFrom: i + 1 });
    else if (blank(i - 2)) heads.push({ at: i - 1, name, ts, textFrom: i + 1 });
  }
  if (heads.length < MIN_TURNS) return { body, transcript: null };
  const turns = heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].at : lines.length;
    const text = lines.slice(h.textFrom, end).join('\n').trim().replace(/\n\s*\n+/g, '\n');
    return { t: seconds(h.ts), ts: h.ts, speaker: h.name, text };
  });
  return { body: lines.slice(0, heads[0].at).join('\n'), transcript: turns };
}

// Sidebar sections, declared on the root README / INDEX as `sections: { Context: [system, person] }`:
// an ordered list of { name, types }. A type listed twice stays in its first section.
const INDEX_FILE = /^(readme|index)\.md$/i;
function sectionsOf(notes) {
  for (const [p, n] of notes) {
    const s = n.data.sections;
    if (!INDEX_FILE.test(p) || !s || typeof s !== 'object' || Array.isArray(s)) continue;
    const seen = new Set();
    const out = [];
    for (const [name, list] of Object.entries(s)) {
      const types = [].concat(list ?? []).map(scalar).filter(Boolean).map((t) => t.trim().toLowerCase())
        .filter((t) => t && !seen.has(t) && seen.add(t));
      if (name.trim() && types.length) out.push({ name: name.trim(), types });
    }
    if (out.length) return out;
  }
  return null;
}

// Mask fenced and inline code so links inside code samples aren't treated as links.
function maskCode(body) {
  return body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, (s) => s.replace(/[[\]()]/g, ' '));
}

export function buildGraph(files) {
  const notes = new Map();
  const byName = new Map(); // lowercased basename / id / alias -> path (for wikilinks)
  const addName = (key, p) => {
    const k = String(key).toLowerCase();
    if (!byName.has(k)) byName.set(k, p);
  };

  for (const [p, text] of files) {
    const { data, body: full } = splitFrontmatter(text);
    const { body, transcript } = splitTranscript(full);
    const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const base = posix.basename(p, posix.extname(p));
    notes.set(p, { data, body, transcript, h1, base });
    addName(p.replace(/\.md$/i, ''), p);
    addName(base, p);
    if (scalar(data.id)) addName(data.id, p);
    for (const a of [].concat(data.aliases || [])) if (scalar(a)) addName(a, p);
  }

  const edges = new Map();
  const nodes = [];
  for (const [p, n] of notes) {
    const addEdge = (target) => {
      // Undirected: a link and its backlink are one edge.
      if (target && target !== p) edges.set([p, target].sort().join('\u0000'), { source: p, target });
    };

    // Rewrite links so the viewer can navigate: in-folder notes become "#n=<path>", plus "&f=<fragment>"
    // when the link points somewhere inside the note (a quote's "#t=17:08");
    // relative links that leave the folder become "#outside" (shown, never fetched).
    const here = (hit, frag) => `#n=${encodeURIComponent(hit)}${frag ? `&f=${encodeURIComponent(frag)}` : ''}`;
    const fragOf = (target) => target.split('#').slice(1).join('#');
    const masked = maskCode(n.body);
    let out = '';
    let last = 0;
    const replacements = [];
    for (const m of masked.matchAll(MD_LINK)) {
      const [whole, bang, label, target] = m;
      if (SCHEME.test(target) || target.startsWith('#')) continue;
      const hit = resolveInside(p, target, files);
      if (bang) {
        replacements.push([m.index, whole.length, label ? `*[image: ${label}]*` : '']);
        continue;
      }
      addEdge(hit);
      replacements.push([m.index, whole.length, `[${label}](${hit ? here(hit, fragOf(target)) : '#outside'})`]);
    }
    for (const m of masked.matchAll(WIKI_LINK)) {
      const [whole, name, heading, alias] = m;
      const key = name.trim().toLowerCase().replace(/\.md$/, '');
      const hit = byName.get(key) || byName.get(posix.basename(key));
      addEdge(hit);
      replacements.push([m.index, whole.length, `[${(alias || name).trim()}](${hit ? here(hit, (heading || '').slice(1)) : '#missing'})`]);
    }
    replacements.sort((a, b) => a[0] - b[0]);
    for (const [at, len, text] of replacements) {
      if (at < last) continue;
      out += n.body.slice(last, at) + text;
      last = at + len;
    }
    out += n.body.slice(last);

    const type = scalar(n.data.type) || scalar(n.data.kind) || 'note';
    nodes.push({
      id: p,
      label: scalar(n.data.title) || n.h1 || n.base,
      ref: scalar(n.data.id) || n.base,
      type: type.toLowerCase(),
      status: scalar(n.data.status),
      updated: scalar(n.data.last_updated) || scalar(n.data.updated) || scalar(n.data.date),
      body: out,
      ...(n.transcript && { transcript: n.transcript }),
      ...(videoOf(n.data) && { video: videoOf(n.data) }),
    });
  }

  const sections = sectionsOf(notes);
  return { nodes, edges: [...edges.values()], ...(sections && { sections }) };
}
