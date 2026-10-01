// Read-only access to GitHub repos, either as a GitHub App (production) or with a
// plain token (local development, e.g. `GITHUB_TOKEN=$(gh auth token)`).

import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import tar from 'tar-stream';

const API = 'https://api.github.com';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  return `${unsigned}.${sig}`;
}

function loadPrivateKey(env) {
  if (env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (env.GITHUB_APP_PRIVATE_KEY_PATH) return fs.readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
  return null;
}

async function request(path, token, { accept = 'application/vnd.github+json', method = 'GET' } = {}) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'brain-graph',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* not JSON */ }
    throw new GitHubError(res.status, detail || res.statusText);
  }
  return res;
}

export function createGitHub(env = process.env) {
  const privateKey = loadPrivateKey(env);
  const appId = env.GITHUB_APP_ID;
  const mode = appId && privateKey ? 'app' : env.GITHUB_TOKEN ? 'token' : null;
  if (!mode) {
    throw new Error('Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY(_PATH), or GITHUB_TOKEN for local development.');
  }

  const installations = new Map(); // owner -> installation id
  const tokens = new Map(); // installation id -> { token, expires }

  async function tokenFor(owner, repo) {
    if (mode === 'token') return env.GITHUB_TOKEN;
    let id = installations.get(owner);
    if (!id) {
      try {
        const res = await request(`/repos/${owner}/${repo}/installation`, appJwt(appId, privateKey));
        id = (await res.json()).id;
      } catch (e) {
        if (e.status === 404) {
          throw new GitHubError(404, `The GitHub App isn't installed on ${owner}/${repo}. Install it on that repo first.`);
        }
        throw e;
      }
      installations.set(owner, id);
    }
    const cached = tokens.get(id);
    if (cached && cached.expires - Date.now() > 5 * 60 * 1000) return cached.token;
    const res = await request(`/app/installations/${id}/access_tokens`, appJwt(appId, privateKey), { method: 'POST' });
    const { token, expires_at } = await res.json();
    tokens.set(id, { token, expires: Date.parse(expires_at) });
    return token;
  }

  async function api(owner, repo, path, opts) {
    return request(`/repos/${owner}/${repo}${path}`, await tokenFor(owner, repo), opts);
  }

  return {
    mode,

    async getRepo(owner, repo) {
      const r = await (await api(owner, repo, '')).json();
      return { owner: r.owner.login, repo: r.name, defaultBranch: r.default_branch, private: r.private };
    },

    async listBranches(owner, repo) {
      const list = await (await api(owner, repo, '/branches?per_page=100')).json();
      return list.map((b) => b.name);
    },

    async resolveCommit(owner, repo, ref) {
      const res = await api(owner, repo, `/commits/${encodeURIComponent(ref)}`, { accept: 'application/vnd.github.sha' });
      return (await res.text()).trim();
    },

    // Every folder in the repo that contains markdown, with how many notes it holds (recursively).
    async listFolders(owner, repo, sha) {
      const tree = await (await api(owner, repo, `/git/trees/${sha}?recursive=1`)).json();
      const counts = new Map([['', 0]]);
      for (const e of tree.tree) {
        if (e.type === 'tree') counts.set(e.path, counts.get(e.path) || 0);
        if (e.type !== 'blob' || !e.path.toLowerCase().endsWith('.md')) continue;
        const parts = e.path.split('/');
        for (let i = 0; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/');
          counts.set(dir, (counts.get(dir) || 0) + 1);
        }
      }
      const folders = [...counts]
        .filter(([path, md]) => md > 0 && !path.split('/').some((p) => p.startsWith('.')))
        .map(([path, md]) => ({ path, md }))
        .sort((a, b) => a.path.localeCompare(b.path));
      return { folders, truncated: tree.truncated };
    },

    // Markdown files under `folder` at commit `sha`, keyed by path relative to the folder.
    // Downloads one tarball and discards everything outside the folder before it's kept in memory.
    async fetchFolder(owner, repo, sha, folder) {
      const res = await api(owner, repo, `/tarball/${sha}`);
      const prefix = folder ? `${folder}/` : '';
      const files = new Map();
      let total = 0;
      const extract = tar.extract();
      const done = new Promise((resolve, reject) => {
        extract.on('entry', (header, stream, next) => {
          const path = header.name.split('/').slice(1).join('/'); // drop "owner-repo-sha/"
          const keep = header.type === 'file' && path.startsWith(prefix) && path.toLowerCase().endsWith('.md')
            && header.size <= MAX_FILE_BYTES;
          if (!keep) { stream.resume(); stream.on('end', next); return; }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            total += header.size;
            if (total > MAX_TOTAL_BYTES) return reject(new Error('Folder is too large to display (over 25 MB of markdown).'));
            files.set(path.slice(prefix.length), Buffer.concat(chunks).toString('utf8'));
            next();
          });
        });
        extract.on('finish', resolve);
        extract.on('error', reject);
      });
      Readable.fromWeb(res.body).pipe(zlib.createGunzip()).on('error', (e) => extract.destroy(e)).pipe(extract);
      await done;
      return files;
    },
  };
}

// Accepts "owner/repo", "https://github.com/owner/repo", ".../tree/branch/folder", "git@github.com:owner/repo.git".
export function parseRepoUrl(input) {
  const s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = s.match(/^(?:(?:https?:\/\/)?(?:www\.)?github\.com[/:]|git@github\.com:)?([\w.-]+)\/([\w.-]+)(?:\/tree\/(.+))?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], rest: m[3] || null };
}
