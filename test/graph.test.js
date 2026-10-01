import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, resolveInside, splitFrontmatter, splitTranscript } from '../src/graph.js';
import { parseRepoUrl } from '../src/github.js';

const files = new Map([
  ['pains/PAIN-001.md', '---\nid: PAIN-001\ntype: pain\ntitle: "Reports take too long"\nlast_updated: 2026-09-25\n---\n# PAIN-001\nSee [the job](../jobs/JOB-001.md), [[marta-quinn|Marta]], [a source](../../sources/SRC-1.md) and [web](https://example.com).\n\n`[not a link](../jobs/JOB-001.md)`\n'],
  ['jobs/JOB-001.md', '---\ntype: job\n---\n# Build a report\nBack to [pain](../pains/PAIN-001.md#top).\n'],
  ['people/marta-quinn.md', '# Marta Quinn\n'],
  ['README.md', 'No frontmatter. [[Missing note]] ![img](diagram.png)\n'],
]);

test('frontmatter is parsed, dates become ISO strings, malformed YAML is ignored', () => {
  assert.equal(splitFrontmatter('---\na: 1\n---\nbody').data.a, 1);
  assert.deepEqual(splitFrontmatter('---\n: : :\n---\nbody').data, {});
  const pain = buildGraph(files).nodes.find((n) => n.id === 'pains/PAIN-001.md');
  assert.equal(pain.updated, '2026-09-25');
  assert.equal(pain.label, "Reports take too long");
  assert.equal(pain.ref, 'PAIN-001');
});

test('links inside the folder become edges; a link and its backlink are one edge', () => {
  const { edges } = buildGraph(files);
  const pairs = edges.map((e) => [e.source, e.target].sort().join(' | ')).sort();
  assert.deepEqual(pairs, ['jobs/JOB-001.md | pains/PAIN-001.md', 'pains/PAIN-001.md | people/marta-quinn.md']);
});

test('links leaving the folder are marked outside and never resolved', () => {
  assert.equal(resolveInside('pains/PAIN-001.md', '../../sources/SRC-1.md', files), null);
  assert.equal(resolveInside('a.md', '/../../etc/passwd', files), null);
  assert.equal(resolveInside('a.md', '..%2F..%2Fetc', files), null);
  const pain = buildGraph(files).nodes.find((n) => n.id === 'pains/PAIN-001.md');
  assert.match(pain.body, /\[a source\]\(#outside\)/);
  assert.match(pain.body, /\[the job\]\(#n=jobs%2FJOB-001\.md\)/);
  assert.match(pain.body, /\[Marta\]\(#n=people%2Fmarta-quinn\.md\)/);
  assert.match(pain.body, /https:\/\/example\.com/);
  assert.match(pain.body, /`\[not a link\]\(\.\.\/jobs\/JOB-001\.md\)`/, 'links in code are left alone');
});

test('untyped notes fall back to "note"; missing wikilinks and images are neutralised', () => {
  const readme = buildGraph(files).nodes.find((n) => n.id === 'README.md');
  assert.equal(readme.type, 'note');
  assert.match(readme.body, /\[Missing note\]\(#missing\)/);
  assert.match(readme.body, /\*\[image: img\]\*/);
});

test('a link into a spot of a note keeps that spot as "&f=", so a quote can jump to its moment', () => {
  const g = buildGraph(new Map([
    ['pains/P.md', '> "Hola"\n>\n> — Marta, call (17:08) [SRC-1](../sources/SRC-1.md#t=17:08)\n[[SRC-1#Digest]]'],
    ['sources/SRC-1.md', '# Call\n'],
  ]));
  const body = g.nodes.find((n) => n.id === 'pains/P.md').body;
  assert.match(body, /\(#n=sources%2FSRC-1\.md&f=t%3D17%3A08\)/);
  assert.match(body, /\(#n=sources%2FSRC-1\.md&f=Digest\)/);
});

const TRANSCRIPT = `# Call

Digest on top, with a time that isn't a turn:
10:00

<!-- RAW -->

MQ
Marta Quinn
0:01

Hola, hola.
¿Me escuchan?

Tomas Reyes
Tomas Reyes
0:37
¿Alo?

Ignacio
1:02:03
Sí.
`;

test('Fathom-style transcripts become turns: speaker, time, what they said', () => {
  const { body, transcript } = splitTranscript(TRANSCRIPT);
  assert.deepEqual(transcript, [
    { t: 1, ts: '0:01', speaker: 'Marta Quinn', text: 'Hola, hola.\n¿Me escuchan?' },
    { t: 37, ts: '0:37', speaker: 'Tomas Reyes', text: '¿Alo?' },
    { t: 3723, ts: '1:02:03', speaker: 'Ignacio', text: 'Sí.' },
  ]);
  assert.match(body, /Digest on top/);
  assert.match(body, /<!-- RAW -->\s*$/, 'the body stops where the transcript starts');
  const node = buildGraph(new Map([['s.md', TRANSCRIPT]])).nodes[0];
  assert.equal(node.transcript.length, 3);
  assert.doesNotMatch(node.body, /Hola/);
});

test("a meeting note's recording comes from its frontmatter, share link first, https only", () => {
  const graph = (fm) => buildGraph(new Map([['m.md', `---\n${fm}\n---\n# M`]])).nodes[0].video;
  assert.equal(graph('fathom_url: https://fathom.video/calls/1\nfathom_share_url: https://fathom.video/share/abc'), 'https://fathom.video/share/abc');
  assert.equal(graph('fathom_url: https://fathom.video/calls/1\nfathom_share_url:'), 'https://fathom.video/calls/1');
  assert.equal(graph('video: javascript:alert(1)'), undefined);
  assert.equal(graph('title: M'), undefined);
});

test('a note with only a couple of times on their own lines is not a transcript', () => {
  assert.equal(splitTranscript('Ana\n9:00\nstart\n\nBen\n9:30\nend').transcript, null);
  assert.equal(buildGraph(new Map([['a.md', '# A']])).nodes[0].transcript, undefined);
});

test('repo URLs in the usual shapes are understood', () => {
  assert.deepEqual(parseRepoUrl('acme/notes'), { owner: 'acme', repo: 'notes', rest: null });
  assert.deepEqual(parseRepoUrl('https://github.com/acme/notes/tree/main/brain'), { owner: 'acme', repo: 'notes', rest: 'main/brain' });
  assert.equal(parseRepoUrl('git@github.com:a/b.git').repo, 'b');
  assert.equal(parseRepoUrl('https://gitlab.com/a/b'), null);
});

test('sidebar sections come from the root index page, in order, each type in one section', () => {
  const sections = (fm, name = 'INDEX.md') => buildGraph(new Map([[name, `---\n${fm}\n---\n# Home`]])).sections;
  assert.deepEqual(sections('sections:\n  Context: [System, person]\n  Discovery: [job, pain, system]\n  Empty: []'), [
    { name: 'Context', types: ['system', 'person'] },
    { name: 'Discovery', types: ['job', 'pain'] },
  ]);
  assert.deepEqual(sections('sections:\n  Solo: job', 'README.md'), [{ name: 'Solo', types: ['job'] }]);
  assert.equal(sections('sections:\n  Context: [system]', 'people/README.md'), undefined); // not the root
  assert.equal(sections('sections: [system, job]'), undefined);
  assert.equal(sections('sections: context'), undefined);
  assert.equal(sections('title: Home'), undefined);
});
