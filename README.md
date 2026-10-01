# brain-graph

Share a folder of linked markdown notes from a **private** GitHub repo as a navigable map,
with a link you can hand out (optionally with a password). The repo itself stays private.

- Paste a repo URL, pick a branch and folder, get an unguessable link (`/s/<id>`).
- Anyone with the link sees the notes in that folder and the links between them.
- Optional password per link: viewers type it once per browser and stay signed in for 30 days.
  Changing it signs everyone out; removing it makes the link open again.
- Links that point outside the folder are shown greyed out and are never fetched.
- Turn a link off at any time; it stops working immediately.
- The map follows the branch: new commits show up within a minute.
- Browse from a tree on the left: open a type to highlight its notes on the map, pick a note
  to read it and see its neighbors, type to filter (matches light up on the map too).
- Sections in the tree: the root `README.md` / `INDEX.md` can group types under headings, in its
  frontmatter (`sections: { Context: [department, person, system], Discovery: [job, pain] }`).
  Sections and their types show in that order; types no section lists go under "Other". Each
  section's eye shows or hides all its types on the map at once. Without `sections`, types are
  listed alphabetically.
- Tables read like a list view: a cell of links (`PAIN-001, PAIN-002`) shows as chips in each
  note's color that never split mid-ID and name the note on hover, the first column stays put
  while a wide table scrolls, and a table too wide for the note pane widens the pane.
- Transcripts (Fathom-style: speaker, time, text) are shown turn by turn, one color per speaker.
  A link ending in `#t=17:08` (the brain writes these on every quote) opens the transcript at that
  moment, highlights the quoted words, and says who said it, with a way back to the quoting note.
- Meetings on video: a note whose frontmatter has `fathom_share_url` or `fathom_url` (or `video`)
  gets a "Watch" link, each transcript turn gets a ▶, and Fathom links in a note's text (the
  brain's "▶ Watch" on quotes) show as buttons. With `FATHOM_API_KEY` set, "Watch" opens the
  recording in a panel over the note: the video on top, starting at the quoted moment, and the
  meeting's transcript below with the quoted words highlighted. The turn being said lights up as it
  plays; click a turn's time to jump there. Works even when the transcript isn't in the shared
  folder. Without the key, "Watch" opens Fathom in a new tab.
- 3D view by default, or flat (2D). 3D's library (~1.3 MB) loads on first view; if the browser
  can't do 3D, the map falls back to 2D. Choosing 2D is remembered per browser.

Works with any Obsidian-style vault: relative markdown links, `[[wikilinks]]`, and an optional
frontmatter `type` (colors the node), `title`, `id`, `status`, `last_updated`.

## How it works

```
browser ──/s/<id>──▶ brain-graph server ──GitHub App token──▶ GitHub (private repo)
                        │  looks up the share (repo, branch, folder) in SQLite
                        │  downloads one tarball per commit, keeps only <folder>/**/*.md
                        │  parses links → { nodes, edges }, caches per commit
                        ▼
                   viewer: 2D (Cytoscape.js) or 3D (3d-force-graph / three.js)
                           + note panel (marked + DOMPurify)
```

- `src/github.js`: GitHub access, as a GitHub App (production) or a plain token (local)
- `src/graph.js`: markdown → graph; link resolution is confined to the shared folder
- `src/fathom.js`: Fathom access (optional): finds a recording by its link, fetches its transcript,
  and has Fathom make a playable copy of the video. Making one takes about a minute, but a copy
  lasts a day and Fathom hands it back at once, so opening a map gets its videos made in the
  background and they're remade when a copy runs out (for maps opened in the last 7 days).
  Fathom lists meetings 10 at a time and allows 60 calls a minute, so a meeting is looked up by the
  day written on the quote's line ("kickoff, 2026-09-29 (44:30) · ▶ Watch"). Without a day it pages
  back from the newest, which for a meeting months old takes several tries.
- `src/db.js`: share links (SQLite, `node:sqlite`); schema changes run on start
- `src/access.js`: link passwords (scrypt hashes, signed 30-day cookie, wrong-guess throttle)
- `src/server.js`: routes; `/admin` and `/api/admin/*` sit behind basic auth
- `public/viewer.js`: shared viewer state, the notes tree, focus, note panel, 2D/3D switch
- `public/view2d.js`, `public/view3d.js`: the two map renderers, same small interface
  (`update`, `paint`, `fit`, `resize`, `show`)
- `public/admin.*`: admin UI. No build step anywhere.

## Run locally

Needs Node 22.13+.

```bash
npm install
GITHUB_TOKEN=$(gh auth token) npm run dev
```

Open http://localhost:3000/admin, paste `github.com/owner/notes-repo`, pick the notes folder.

```bash
npm test
```

## GitHub App

Create your own GitHub App and install it on the repos you want to share.
Permissions: **Contents: read-only** (plus the mandatory Metadata: read-only). No webhook.
It must be installed on every repo you want to share. Set `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` (never commit the `.pem`).

## Deploy (Railway)

Railway deploys `main`. Work happens on `dev` (branch from it, merge back into it); merging `dev` into `main` is the release.

1. New service from this repo. Railway runs `npm start`.
2. Add a volume mounted at `/data` and set `DATABASE_PATH=/data/brain-graph.db`.
3. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `ADMIN_PASSWORD`. Optional: `FATHOM_API_KEY`
   (made in Fathom's settings), from an account that can see the meetings the notes link to.
4. Health check path: `/healthz`.

## Security model

- **The link is the key** (plus its password, if set). Whoever has it sees the whole folder, so share narrow folders.
- Link passwords are stored only as scrypt hashes and never returned by any API. After 10 wrong
  tries from one address, that address waits 15 minutes.
- Share ids are 128-bit random. Pages send `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`.
- The public API never exposes the repo owner or name, only the title you chose.
- Rendered notes are sanitized (DOMPurify); CSP restricts scripts to this origin and jsdelivr.
- Recordings: a link plays only the Fathom meetings its notes link to (any other is refused), so
  the transcript of a linked meeting is shown even though it lives outside the folder. The video
  streams through this server; Fathom's signed file link never reaches the browser, so turning a
  link off stops its videos too.
- Admin is basic auth for the MVP. Swap for single sign-on restricted to your domain before wider use.
