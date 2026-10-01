(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const linkFor = (id) => `${location.origin}/s/${id}`;
  let repo = null; // { owner, repo, defaultBranch, branches, hint }
  let folder = null;

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  function showError(id, msg) { $(id).hidden = !msg; $(id).textContent = msg || ''; }
  function toast(msg) {
    $('toast').textContent = msg;
    $('toast').hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { $('toast').hidden = true; }, 2200);
  }
  function enable(stepId, on) { $(stepId).classList.toggle('disabled', !on); }
  // Four groups of four, no look-alike characters, so it survives being read out or typed from a message.
  function generatePassword() {
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => abc[b % abc.length]).join('').match(/.{4}/g).join('-');
  }

  $('repo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('repo-error', '');
    $('load-btn').disabled = true;
    $('load-btn').textContent = 'Loading…';
    try {
      repo = await api(`/api/admin/repo?url=${encodeURIComponent($('repo-url').value)}`);
      let ref = repo.defaultBranch;
      let hintFolder = null;
      if (repo.hint) {
        const b = repo.branches.find((x) => repo.hint === x || repo.hint.startsWith(`${x}/`));
        if (b) { ref = b; hintFolder = repo.hint.slice(b.length + 1) || null; }
      }
      $('branch').innerHTML = repo.branches.map((b) => `<option ${b === ref ? 'selected' : ''}>${esc(b)}</option>`).join('');
      await loadFolders(hintFolder);
      enable('step-folder', true);
    } catch (err) {
      showError('repo-error', err.message);
    } finally {
      $('load-btn').disabled = false;
      $('load-btn').textContent = 'Load folders';
    }
  });

  $('branch').addEventListener('change', () => loadFolders(folder).catch((err) => showError('repo-error', err.message)));

  async function loadFolders(preselect) {
    const { folders } = await api(`/api/admin/folders?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}&ref=${encodeURIComponent($('branch').value)}`);
    $('folders').innerHTML = folders.map((f) => `
      <li><label>
        <input type="radio" name="folder" value="${esc(f.path)}">
        <span>${f.path ? esc(f.path) : '/ (whole repository)'}</span>
        <span class="count">${f.md} ${f.md === 1 ? 'note' : 'notes'}</span>
      </label></li>`).join('');
    const pre = $('folders').querySelector(`input[value="${CSS.escape(preselect ?? '')}"]`);
    if (pre && preselect != null) { pre.checked = true; selectFolder(preselect); } else { folder = null; enable('step-name', false); $('root-warn').hidden = true; }
  }

  $('folders').addEventListener('change', (e) => { if (e.target.name === 'folder') selectFolder(e.target.value); });

  function selectFolder(path) {
    folder = path;
    $('root-warn').hidden = path !== '';
    $('title').value = `${repo.repo}${path ? ` / ${path}` : ''}`;
    $('created').hidden = true;
    enable('step-name', true);
  }

  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('create-error', '');
    $('create-btn').disabled = true;
    try {
      const share = await api('/api/admin/shares', {
        method: 'POST',
        body: JSON.stringify({ owner: repo.owner, repo: repo.repo, ref: $('branch').value, folder, title: $('title').value, password: $('password').value }),
      });
      $('created-note').textContent = share.has_password
        ? 'Link created. Viewers also need the password.'
        : 'Link created. Anyone who has it can open the map.';
      $('password').value = '';
      $('created-url').value = linkFor(share.id);
      $('created-open').href = linkFor(share.id);
      $('created').hidden = false;
      toast('Link created');
      loadLinks();
    } catch (err) {
      showError('create-error', err.message);
    } finally {
      $('create-btn').disabled = false;
    }
  });

  async function loadLinks() {
    const shares = await api('/api/admin/shares');
    $('links-empty').hidden = shares.length > 0;
    $('links').innerHTML = shares.map((s) => `
      <tr>
        <td>${esc(s.title)}</td>
        <td class="src">${esc(s.owner)}/${esc(s.repo)} · ${esc(s.folder || '/')} @ ${esc(s.ref)}</td>
        <td class="src">${s.has_password ? 'On' : 'None: open to anyone with the link'}</td>
        <td class="src">${esc(s.created_at.slice(0, 10))}</td>
        <td class="actions">
          <button class="btn small secondary" data-password="${esc(s.id)}" data-title="${esc(s.title)}" data-has="${s.has_password ? 1 : ''}">${s.has_password ? 'Change password' : 'Set password'}</button>
          <button class="btn small secondary" data-copy-link="${esc(s.id)}">Copy link</button>
          <a class="btn small secondary" href="/s/${esc(s.id)}" target="_blank" rel="noopener">Open</a>
          <button class="btn small danger" data-revoke="${esc(s.id)}" data-title="${esc(s.title)}">Turn off</button>
        </td>
      </tr>`).join('');
  }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.copy || t.dataset.copyLink) {
      await navigator.clipboard.writeText(t.dataset.copy ? $(t.dataset.copy).value : linkFor(t.dataset.copyLink));
      toast('Link copied');
    }
    if (t.id === 'gen-password') {
      $('password').value = generatePassword();
      $('password').select();
    }
    if (t.dataset.password) {
      const note = t.dataset.has ? ' Everyone signed in with the old one will need the new one. Leave empty to remove the password.' : '';
      const password = prompt(`New password for "${t.dataset.title}" (at least 8 characters).${note}`, generatePassword());
      if (password === null) return;
      if (!password && !confirm(`Remove the password? Anyone with the link will be able to open "${t.dataset.title}".`)) return;
      try {
        await api(`/api/admin/shares/${encodeURIComponent(t.dataset.password)}/password`, { method: 'PUT', body: JSON.stringify({ password }) });
        if (password) await navigator.clipboard.writeText(password).catch(() => {});
        toast(password ? 'Password set and copied' : 'Password removed');
        loadLinks();
      } catch (err) {
        toast(err.message);
      }
    }
    if (t.dataset.revoke) {
      if (!confirm(`Turn off "${t.dataset.title}"? Anyone who has this link loses access. This can't be undone.`)) return;
      try {
        await api(`/api/admin/shares/${encodeURIComponent(t.dataset.revoke)}`, { method: 'DELETE' });
        toast('Link turned off');
        loadLinks();
      } catch (err) {
        toast(err.message);
      }
    }
  });

  loadLinks().catch((err) => showError('repo-error', err.message));
})();
