/* global marked, DOMPurify */
// Shared viewer state and UI: the notes tree (browse by type, filter, show/hide), focus, the note
// sheet, and the 2D / 3D switch.
// The map itself is drawn by a view (view2d.js or view3d.js) that reads `state` and redraws on update().
(() => {
  const shareId = location.pathname.split('/').filter(Boolean).pop();
  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const TYPE_COLORS = {
    job: '#6fd6c8', pain: '#ff8f7e', solution: '#a5e07f', department: '#b6a4ff',
    person: '#f7a8d8', system: '#86c3ff', note: '#c3cfdb',
  };
  const SPARE = ['#ffd48a', '#9ee6f0', '#e3b3ff', '#ffb98a', '#d4e88a', '#f0a3a3'];
  const colorOf = (() => {
    const assigned = {};
    let i = 0;
    return (t) => TYPE_COLORS[t] || (assigned[t] ||= SPARE[i++ % SPARE.length]);
  })();
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  const state = {
    nodes: [], edges: [], byId: new Map(), adj: new Map(), degree: {},
    selected: null, hops: 0, hidden: new Set(),
    activeType: null, // the open group in the tree: its notes are highlighted on the map
    hover: null, // a note being pointed at, in the tree or on the map
    matches: null, // notes matching the tree filter, while typing
    linkTypes: null, // which types of connected notes to show around a note (null = all); sticky across notes
    quote: null, // the quote just clicked, so its transcript can highlight it: { text, who, from }
    recordings: false, // whether meeting videos play here (the server has Fathom access)
    // Untyped pages, sorted out in classifyPages() when most notes have a type:
    structured: false,
    home: null, // the root README / INDEX
    overview: {}, // type -> the index page of that type's folder (jobs.md, people/README.md)
    sectionOf: {}, // index page -> its type
    pages: [], // top-level pages for the tree, Home first
    sections: null, // the brain's own grouping of types for the tree: [{ name, types }], or null
  };
  const isPage = (id) => state.structured && state.byId.get(id)?.type === 'note';

  // A note's neighbors, narrowed to the chosen connection types.
  const neighborsOf = (id) => [...(state.adj.get(id) || [])]
    .filter((m) => !state.linkTypes || state.linkTypes.has(state.byId.get(m).type));

  // Notes on screen: everything not filtered out, or in focus mode only what's within `hops` of the selection.
  function visibleIds() {
    const base = new Set(state.nodes.filter((n) => !state.hidden.has(n.type)).map((n) => n.id));
    if (state.selected) base.add(state.selected); // an opened page shows on the map even though pages are hidden
    if (!state.selected || state.hops === 0) return base;
    let keep = new Set([state.selected]);
    for (let i = 0; i < state.hops; i++) {
      const next = new Set(keep);
      for (const id of keep) for (const m of neighborsOf(id)) if (base.has(m)) next.add(m);
      keep = next;
    }
    return keep;
  }
  const litIds = (id) => new Set([id, ...neighborsOf(id)]);

  // What the map should emphasize. Pointing at a note previews it; otherwise the selected note and
  // its neighbors; otherwise every note of the open type. `focus` is the note whose links light up.
  function emphasis() {
    const focus = state.hover || state.selected;
    if (focus) return { lit: litIds(focus), focus };
    if (state.matches) return { lit: state.matches, focus: null };
    if (state.activeType) return { lit: new Set(state.nodes.filter((n) => n.type === state.activeType).map((n) => n.id)), focus: null };
    return { lit: null, focus: null };
  }
  const typeIds = (type) => new Set(state.nodes.filter((n) => n.type === type).map((n) => n.id));

  const ctx = {
    state, visibleIds, litIds, emphasis, colorOf, reduceMotion,
    onSelect: (id) => setHash(id),
    onBackground: () => closeNote(),
    onHover: (id) => setHover(id),
  };
  const views = {};
  let mode = '3d';
  let view = null;

  // "#n=<note>" or "#n=<note>&f=<fragment>" (a spot inside the note, like "t=17:08" in a transcript).
  function readHash() {
    const m = location.hash.match(/^#n=([^&]+)(?:&f=(.*))?$/);
    if (!m) return { id: null, frag: null };
    try { return { id: decodeURIComponent(m[1]), frag: m[2] ? decodeURIComponent(m[2]) : null }; } catch { return { id: null, frag: null }; }
  }
  const hashFor = (id, frag) => `#n=${encodeURIComponent(id)}${frag ? `&f=${encodeURIComponent(frag)}` : ''}`;

  function showStatus(text) {
    $('status').hidden = !text;
    $('status').textContent = text || '';
  }

  async function load() {
    let data;
    try {
      const res = await fetch(`/api/s/${encodeURIComponent(shareId)}/graph`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The map could not be loaded.');
    } catch (e) {
      $('title').textContent = 'Map unavailable';
      showStatus(e.message);
      return;
    }

    document.title = data.title;
    $('title').textContent = data.title;
    $('meta').textContent = `${plural(data.nodes.length, 'note')} · ${plural(data.edges.length, 'link')} · version ${data.sha}`;

    state.nodes = data.nodes;
    state.recordings = Boolean(data.recordings);
    state.sections = data.sections || null;
    state.edges = data.edges;
    state.byId = new Map(data.nodes.map((n) => [n.id, n]));
    for (const n of data.nodes) state.adj.set(n.id, new Set());
    for (const e of data.edges) {
      state.adj.get(e.source).add(e.target);
      state.adj.get(e.target).add(e.source);
      state.degree[e.source] = (state.degree[e.source] || 0) + 1;
      state.degree[e.target] = (state.degree[e.target] || 0) + 1;
    }

    // When most notes declare a type, the untyped ones are usually index pages that link to
    // everything; start with them hidden so the real structure shows, and list them as pages.
    const typed = data.nodes.filter((n) => n.type !== 'note').length;
    if (typed > 0 && typed >= data.nodes.length / 2 && typed < data.nodes.length) {
      state.hidden.add('note');
      classifyPages();
    }

    buildTree();
    showStatus('');
    const { id, frag } = readHash();
    if (id && state.byId.has(id)) select(id, frag);
    else if (state.home) select(state.home); // a fresh link opens on the home page
    // 3D unless this browser picked 2D. (A new key: the old one saved 2D for everyone, chosen or not.)
    await setMode(store.get('brain-graph:view-choice') === '2d' ? '2d' : '3d');
  }

  // An untyped page beside or inside a type's folder (jobs.md next to jobs/, people/README.md) is
  // that type's overview; the root README / INDEX is Home; the rest are top-level pages.
  function classifyPages() {
    state.structured = true;
    const indexName = /^(readme|index)$/i;
    for (const n of state.nodes) {
      if (n.type !== 'note') continue;
      const parts = n.id.replace(/\.md$/i, '').split('/');
      const base = parts.pop();
      const dir = parts.join('/');
      const folder = indexName.test(base) ? dir : [dir, base].filter(Boolean).join('/');
      if (!folder) { if (!state.home) state.home = n.id; continue; }
      const counts = {};
      for (const x of state.nodes) if (x.type !== 'note' && x.id.startsWith(`${folder}/`)) counts[x.type] = (counts[x.type] || 0) + 1;
      const [type] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
      if (type && !state.overview[type]) { state.overview[type] = n.id; state.sectionOf[n.id] = type; }
    }
    state.pages = state.nodes
      .filter((n) => n.type === 'note' && !state.sectionOf[n.id] && n.id !== state.home)
      .sort((a, b) => collator.compare(a.label, b.label))
      .map((n) => n.id);
    if (state.home) state.pages.unshift(state.home);
  }

  // ---- 2D / 3D ----

  async function setMode(next) {
    for (const b of $('view').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === next));
    if (!views[next]) {
      try {
        if (next === '3d') {
          showStatus('Loading 3D…');
          views['3d'] = await window.createView3D($('stage3d'), ctx);
        } else {
          views['2d'] = window.createView2D($('map'), ctx);
        }
      } catch (e) {
        showStatus('');
        console.error(e);
        alertOnce(next === '3d' ? '3D isn\'t available in this browser. Showing the flat map.' : e.message);
        if (next === '3d') return setMode('2d');
        return undefined;
      }
      showStatus('');
    }
    if (view) view.show(false);
    mode = next;
    view = views[next];
    view.show(true);
    await view.update({ center: true });
    return undefined;
  }
  function alertOnce(msg) { showStatus(msg); setTimeout(() => showStatus(''), 3500); }

  $('view').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.view === mode) return;
    store.set('brain-graph:view-choice', b.dataset.view); // only a click is remembered
    setMode(b.dataset.view);
  });

  // ---- Selection and focus ----

  function setHash(id, frag) {
    const h = hashFor(id, frag);
    if (location.hash === h) openFromHash(); else location.hash = h;
  }

  function select(id, frag) {
    const n = state.byId.get(id);
    if (state.hidden.has(n.type) && !isPage(id)) setTypeHidden(n.type, false);
    state.selected = id;
    state.hover = null;
    const group = state.sectionOf[id] || (isPage(id) ? null : n.type);
    if (group) openGroup(group); else closeGroup();
    markSelected();
    setNavOpen(false);
    setFocusEnabled(true);
    renderNote(n, frag); // opens the sheet first, so the map has its final size before the view centers
  }

  function openFromHash() {
    const { id, frag } = readHash();
    if (!id || !state.byId.has(id)) { closeNote(true); return; }
    select(id, frag);
    if (view) view.update({ center: true });
  }

  function closeNote(fromHash) {
    closeRecording();
    setSheetOpen(false);
    const wasFocused = state.hops !== 0;
    state.selected = null;
    markSelected();
    setHops(0);
    setFocusEnabled(false);
    if (view) view.update({ center: wasFocused });
    if (!fromHash && location.hash) history.pushState(null, '', location.pathname);
  }

  function setSheetOpen(open) {
    if (!$('sheet').hidden === open) return;
    $('sheet').hidden = !open;
    document.body.classList.toggle('sheet-open', open);
    if (view) view.resize();
  }

  function setHops(h) {
    state.hops = h;
    for (const b of $('focus').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.hops) === h));
  }
  function setFocusEnabled(on) {
    for (const b of $('focus').querySelectorAll('button:not([data-hops="0"])')) b.disabled = !on;
  }

  $('focus').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !view) return;
    setHops(Number(b.dataset.hops));
    await view.update({ center: true });
    if (state.hops === 0) view.fit();
  });
  $('fit').addEventListener('click', () => view && view.fit(state.activeType && !state.selected ? typeIds(state.activeType) : null));
  $('close').addEventListener('click', () => closeNote());
  window.addEventListener('hashchange', openFromHash);
  window.addEventListener('resize', () => view && view.resize());

  // ---- The notes tree: one group per type, drill down to its notes ----

  const ICON_CARET = '<svg class="caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const ICON_HOME = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 7L8 2.5 13.5 7v6.5h-3.5v-4h-4v4H2.5z"/></svg>';
  const ICON_PAGE = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4 1.5h5.5L12.5 4.5v10H4z"/><path d="M6.5 8h4M6.5 10.5h4"/></svg>';
  const ICON_EYE = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path class="slash" d="M2.5 13.5l11-11"/></svg>';
  const typeName = (t) => {
    const special = { person: 'People', note: state.structured ? 'Pages' : 'Other pages' };
    if (special[t]) return special[t];
    const p = /(s|x|ch|sh)$/.test(t) ? `${t}es` : /[^aeiou]y$/.test(t) ? `${t.slice(0, -1)}ies` : `${t}s`;
    return p.charAt(0).toUpperCase() + p.slice(1);
  };
  // Show a note's ref only when it's an ID (PAIN-001), not a filename that repeats the title.
  const showRef = (n) => /\d/.test(n.ref) && n.ref !== n.label;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  // The sections the brain declares, keeping only types that have notes, in the order given.
  // Types no section lists go under "Other" at the end. Null when the brain declares none.
  let treeSections = null;
  function sectionsFor(types) {
    const listed = (state.sections || [])
      .map((s) => ({ name: s.name, types: s.types.filter((t) => types.includes(t)) }))
      .filter((s) => s.types.length);
    if (!listed.length) return null;
    const rest = types.filter((t) => !listed.some((s) => s.types.includes(t)));
    return rest.length ? [...listed, { name: 'Other', types: rest }] : listed;
  }

  function buildTree() {
    const groups = {};
    for (const n of state.nodes) (groups[n.type] ||= []).push(n);
    const order = Object.keys(groups)
      .filter((t) => !(state.structured && t === 'note')) // pages are listed on their own, above the groups
      .sort((a, b) => (a === 'note') - (b === 'note') || collator.compare(typeName(a), typeName(b)));
    const pages = state.pages.map((id) => {
      const n = state.byId.get(id);
      const home = id === state.home;
      return `<li><button class="item page" role="treeitem" data-id="${esc(id)}" data-hay="${esc(fold(`${home ? 'home ' : ''}${n.label} ${n.ref}`))}">
        ${home ? ICON_HOME : ICON_PAGE}<span class="t">${esc(home ? 'Home' : n.label)}</span></button></li>`;
    }).join('');
    const overview = (t) => {
      const id = state.overview[t];
      return id ? `<li><button class="item overview" role="treeitem" data-id="${esc(id)}" data-hay="${esc(fold(`overview ${state.byId.get(id).label}`))}">
        <span class="t">Overview</span></button></li>` : '';
    };
    const group = (t) => {
      const notes = groups[t].sort((a, b) => collator.compare(a.ref, b.ref));
      return `
      <div class="group" data-type="${esc(t)}" style="--c:${colorOf(t)}">
        <div class="group-row">
          <button class="group-head" aria-expanded="false" role="treeitem">
            ${ICON_CARET}<span class="dot"></span><span class="name">${esc(typeName(t))}</span><span class="n">${notes.length}</span>
          </button>
          <button class="eye" aria-pressed="${!state.hidden.has(t)}" title="Show or hide ${esc(typeName(t)).toLowerCase()} on the map" aria-label="Show ${esc(typeName(t))} on the map">${ICON_EYE}</button>
        </div>
        <ul class="items" role="group">
          ${overview(t)}${notes.map((n) => `<li><button class="item" role="treeitem" data-id="${esc(n.id)}" data-hay="${esc(fold(`${n.label} ${n.ref}`))}">
            <span class="t">${esc(n.label)}</span>${showRef(n) ? `<span class="ref">${esc(n.ref)}</span>` : ''}
          </button></li>`).join('')}
        </ul>
      </div>`;
    };
    treeSections = sectionsFor(order);
    const body = treeSections ? treeSections.map((s, i) => `
      <div class="section" role="group" aria-label="${esc(s.name)}" data-section="${i}">
        <div class="section-row">
          <span class="section-name">${esc(s.name)}</span>
          <button class="eye" aria-pressed="true" title="Show or hide ${esc(s.name).toLowerCase()} on the map" aria-label="Show ${esc(s.name)} on the map">${ICON_EYE}</button>
        </div>
        ${s.types.map(group).join('')}
      </div>`).join('') : order.map(group).join('');
    $('tree').innerHTML = (pages ? `<ul class="pages" role="group" aria-label="Pages">${pages}</ul>` : '') + body;
    for (const t of state.hidden) setTypeHidden(t, true);

    $('tree').addEventListener('click', (e) => {
      const eye = e.target.closest('.eye');
      const head = e.target.closest('.group-head');
      const item = e.target.closest('.item');
      if (eye) {
        // A section's eye shows or hides all of its types: hides them unless they're all hidden already.
        const section = eye.parentElement.classList.contains('section-row') && eye.closest('.section');
        const types = section ? treeSections[section.dataset.section].types : [eye.closest('.group').dataset.type];
        const hide = !types.every((t) => state.hidden.has(t));
        for (const t of types) setTypeHidden(t, hide);
        if (state.selected && !isPage(state.selected) && state.hidden.has(state.byId.get(state.selected).type)) closeNote();
        else if (view) view.update({ center: false });
      } else if (head) {
        const t = head.closest('.group').dataset.type;
        if (state.activeType === t) { closeGroup(); return; }
        // Opening a type is a new drill-down: drop the current note and frame that type on the map.
        if (state.selected) closeNote();
        if (state.hidden.has(t)) setTypeHidden(t, false);
        openGroup(t);
        if (view) Promise.resolve(view.update({ center: false })).then(() => view.fit(typeIds(t)));
      } else if (item) {
        setHash(item.dataset.id);
      }
    });
    $('tree').addEventListener('mouseover', (e) => {
      const item = e.target.closest('.item');
      setHover(item ? item.dataset.id : null);
    });
    $('tree').addEventListener('mouseleave', () => setHover(null));
    $('tree').addEventListener('focusin', (e) => {
      const item = e.target.closest('.item');
      if (item) setHover(item.dataset.id);
    });
    $('tree').addEventListener('focusout', () => setHover(null));

    setupFilter();
    $('nav-toggle').addEventListener('click', () => setNavOpen(!document.body.classList.contains('nav-open')));
    // On phones the tree is a drawer: tapping anywhere else closes it.
    document.addEventListener('pointerdown', (e) => {
      if (document.body.classList.contains('nav-open') && !e.target.closest('#nav, #nav-toggle')) setNavOpen(false);
    });
  }

  function openGroup(type) {
    state.activeType = type;
    for (const g of $('tree').querySelectorAll('.group')) {
      const open = g.dataset.type === type;
      g.classList.toggle('open', open || g.classList.contains('match'));
      g.querySelector('.group-head').setAttribute('aria-expanded', String(open));
    }
    if (view && !state.selected) view.paint();
  }

  function closeGroup() {
    state.activeType = null;
    for (const g of $('tree').querySelectorAll('.group')) {
      if (!g.classList.contains('match')) g.classList.remove('open');
      g.querySelector('.group-head').setAttribute('aria-expanded', 'false');
    }
    if (view) view.paint();
  }

  function markSelected() {
    let current = null;
    for (const b of $('tree').querySelectorAll('.item')) {
      const on = b.dataset.id === state.selected;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', String(on));
      if (on) current = b;
    }
    if (current) current.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function setHover(id) {
    if (state.hover === id) return;
    state.hover = id;
    if (view) view.paint();
  }

  function setTypeHidden(type, hide) {
    if (hide) state.hidden.add(type); else state.hidden.delete(type);
    const g = $('tree').querySelector(`.group[data-type="${CSS.escape(type)}"]`);
    if (!g) return;
    g.classList.toggle('off', hide);
    g.querySelector('.eye').setAttribute('aria-pressed', String(!hide));
    const s = g.closest('.section');
    if (!s) return;
    const off = !s.querySelector('.group:not(.off)');
    s.classList.toggle('off', off);
    s.querySelector('.section-row .eye').setAttribute('aria-pressed', String(!off));
  }

  function setNavOpen(open) {
    document.body.classList.toggle('nav-open', open);
    $('nav-toggle').setAttribute('aria-expanded', String(open));
  }

  // Typing filters the tree: matching notes stay, their groups open, everything else hides.
  function setupFilter() {
    const q = $('q');
    const apply = () => {
      const terms = fold(q.value.trim()).split(/\s+/).filter(Boolean);
      $('tree').classList.toggle('filtering', terms.length > 0);
      const matches = new Set();
      const test = (b) => {
        const hit = terms.length > 0 && terms.every((t) => b.dataset.hay.includes(t));
        b.parentElement.classList.toggle('hit', hit);
        if (hit) matches.add(b.dataset.id);
        return hit;
      };
      for (const b of $('tree').querySelectorAll('.pages .item')) test(b);
      for (const g of $('tree').querySelectorAll('.group')) {
        let hits = 0;
        let count = 0;
        for (const b of g.querySelectorAll('.item')) {
          const hit = test(b);
          if (b.classList.contains('overview')) continue; // not counted as a note of the group
          count++;
          if (hit) hits++;
        }
        const any = g.querySelector('li.hit') !== null;
        g.classList.toggle('match', any);
        g.classList.toggle('open', any || g.dataset.type === state.activeType);
        g.querySelector('.n').textContent = terms.length ? `${hits}/${count}` : String(count);
      }
      // Matches light up on the map too, so filtering doubles as "where is this on the map?"
      state.matches = terms.length ? matches : null;
      if (view) view.paint();
    };
    q.addEventListener('input', apply);
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = $('tree').querySelector('li.hit .item');
        if (first) { setHash(first.dataset.id); q.blur(); }
      }
      if (e.key === 'Escape') { q.value = ''; apply(); q.blur(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); setNavOpen(true); q.focus(); }
      if (e.key !== 'Escape' || e.target === q) return; // Escape in the filter only clears it
      if (!$('player').hidden) closeRecording();
      else if (!$('sheet').hidden) closeNote();
    });
  }

  // ---- The note sheet ----

  function renderNote(n, frag) {
    const body = n.body.replace(/^\s*#\s+.+\n/, ''); // the sheet heading replaces the note's own H1
    const html = DOMPurify.sanitize(marked.parse(body, { gfm: true }));

    // Only the properties a note actually has; a page's kind is its place in the tree, not a type.
    const prop = (label, value, { dot, mono } = {}) => (value ? `<dt>${label}</dt><dd${mono ? ' class="mono"' : ''}>${dot ? `<span class="dot" style="--c:${dot}"></span>` : ''}${esc(value)}</dd>` : '');
    const section = state.sectionOf[n.id];
    const kind = section ? prop('Type', `${typeName(section)} overview`, { dot: colorOf(section) })
      : isPage(n.id) ? '' : prop('Type', n.type, { dot: colorOf(n.type) });
    const video = n.video ? `<dt>Recording</dt><dd>${watchLink(n.video, null, 'Watch')}</dd>` : '';
    const props = `${showRef(n) ? prop('Ref', n.ref, { mono: true }) : ''}${kind}${prop('Status', n.status)}${prop('Updated', n.updated)}${video}`;
    $('sheet-scroll').innerHTML = `
      <h2 class="note-title" id="note-title">${esc(n.label)}</h2>
      ${props ? `<dl class="props">${props}</dl>` : ''}
      <div class="conn-filter" id="conn-filter"></div>
      <div class="prose">${html}</div>
      ${n.transcript ? renderTranscript(n) : ''}
      <section class="connections" id="conn-list"></section>`;
    renderConnections(n);
    closeRecording();

    for (const a of $('sheet-scroll').querySelectorAll('.prose a')) {
      const href = a.getAttribute('href') || '';
      if (href === '#outside' || href === '#missing') {
        const span = document.createElement('span');
        span.className = href.slice(1);
        span.textContent = a.textContent;
        span.title = href === '#outside' ? 'This note lives outside the shared folder' : 'No note with this name';
        a.replaceWith(span);
      } else if (!href.startsWith('#')) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        if (/^https:\/\/fathom\.video\//.test(href)) a.classList.add('watch'); // a quote's "▶ Watch"
      }
    }
    setSheetOpen(true);
    $('sheet-scroll').scrollTop = 0;
    const quote = state.quote;
    state.quote = null;
    const at = frag && frag.match(/^t=(\d{1,2}:\d{2}(?::\d{2})?)$/);
    if (n.transcript && at) jumpTo(n, at[1], quote && quote.src === n.id ? quote : null);
  }

  // ---- Connection filter: which kinds of connected notes to show around the open note ----

  function renderConnections(n) {
    const all = [...(state.adj.get(n.id) || [])].map((id) => state.byId.get(id));
    const counts = {};
    for (const x of all) counts[x.type] = (counts[x.type] || 0) + 1;
    const types = Object.keys(counts).sort((a, b) => (a === 'note') - (b === 'note') || collator.compare(typeName(a), typeName(b)));
    const on = (t) => !state.linkTypes || state.linkTypes.has(t);
    const shown = all.filter((x) => on(x.type))
      .sort((a, b) => collator.compare(typeName(a.type), typeName(b.type)) || collator.compare(a.ref, b.ref));

    $('conn-filter').innerHTML = all.length ? `
      <div class="label">Connected to ${plural(all.length, 'note')} · show on map</div>
      <div class="conn-chips" role="group" aria-label="Kinds of connected notes to show">
        ${types.map((t) => `<button class="conn-chip" data-type="${esc(t)}" aria-pressed="${Boolean(state.linkTypes && state.linkTypes.has(t))}" style="--c:${colorOf(t)}">
          <span class="dot"></span>${esc(typeName(t))}<span class="n">${counts[t]}</span></button>`).join('')}
        ${state.linkTypes ? '<button class="conn-all" data-all>Show all</button>' : ''}
      </div>` : '';

    $('conn-list').innerHTML = shown.length ? `
      <h3 class="label">${state.linkTypes ? `Showing ${shown.length} of ${plural(all.length, 'connected note')}` : `Connected to ${plural(all.length, 'note')}`}</h3>
      <ul>${shown.map((x) => `<li><span class="dot" style="--c:${colorOf(x.type)}"></span><a href="#n=${encodeURIComponent(x.id)}">${esc(x.label)}</a></li>`).join('')}</ul>` : '';
  }

  // First click on a kind shows only that kind; further clicks add or remove kinds.
  function toggleLinkType(type) {
    const set = new Set(state.linkTypes || []);
    if (set.has(type)) set.delete(type); else set.add(type);
    state.linkTypes = set.size ? set : null;
    if (state.linkTypes && state.hidden.has(type) && set.has(type)) setTypeHidden(type, false);
    applyLinkTypes();
  }
  function applyLinkTypes() {
    if (state.selected) renderConnections(state.byId.get(state.selected));
    if (!view) return;
    if (state.selected && state.hops > 0) view.update({ center: false }); else view.paint();
  }

  $('sheet').addEventListener('click', (e) => {
    // "▶ Watch": play the meeting here, beside its transcript, rather than on Fathom.
    const watch = e.target.closest('a.watch');
    if (watch && state.recordings && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const bq = watch.closest('blockquote');
      const at = watch.href.match(/[?&]timestamp=(\d+)/);
      openRecording(watch.href, at ? Number(at[1]) : null, bq ? readQuote(bq) : null);
      return;
    }
    // A link out of a quote: remember what was quoted, so the transcript can highlight those words.
    const a = e.target.closest('.prose blockquote a[href^="#n="]');
    if (a) {
      const q = readQuote(a.closest('blockquote'));
      const target = a.getAttribute('href').match(/^#n=([^&]+)/);
      state.quote = q && target ? { ...q, src: decodeURIComponent(target[1]), from: state.selected } : null;
    }
    const chip = e.target.closest('.conn-chip');
    if (chip) toggleLinkType(chip.dataset.type);
    if (e.target.closest('[data-all]')) { state.linkTypes = null; applyLinkTypes(); }
  });


  // ---- Transcripts: who said what, when; a quote's link jumps to the moment and highlights it ----

  const SPEAKER_COLORS = ['#86c3ff', '#f7a8d8', '#6fd6c8', '#ffd48a', '#b6a4ff', '#ffb98a', '#a5e07f', '#f0a3a3'];
  const seconds = (ts) => ts.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  const nameWords = (s) => fold(s).match(/[a-z]{3,}/g) || [];

  function speakerColors(turns) {
    const color = {};
    let k = 0;
    for (const t of turns) color[t.speaker] ||= SPEAKER_COLORS[k++ % SPEAKER_COLORS.length];
    return color;
  }

  function renderTranscript(n) {
    const color = speakerColors(n.transcript);
    const people = Object.keys(color);
    return `
      <section class="transcript" aria-label="Transcript">
        <h3 class="label">Transcript · ${plural(n.transcript.length, 'turn')} · ${esc(people.join(', '))}</h3>
        <ol>${n.transcript.map((t, i) => `
          <li class="turn" data-i="${i}" style="--c:${color[t.speaker]}">
            <div class="turn-head"><span class="dot"></span><span class="who">${esc(t.speaker)}</span>
              <a class="ts" href="${esc(hashFor(n.id, `t=${t.ts}`))}" title="Link to this moment">${esc(t.ts)}</a>
              ${n.video ? watchLink(n.video, t.t, '▶') : ''}</div>
            <p class="said">${esc(t.text)}</p>
          </li>`).join('')}
        </ol>
      </section>`;
  }

  // The meeting's video, playing from `secs` when the player understands it (Fathom's ?timestamp=).
  function atMoment(url, secs) {
    if (secs == null || !/^https:\/\/fathom\.video\//.test(url)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}timestamp=${secs}`;
  }
  function watchLink(url, secs, label) {
    const title = secs == null ? 'Watch the recording' : 'Watch from this moment';
    return `<a class="watch" href="${esc(atMoment(url, secs))}" target="_blank" rel="noopener noreferrer" title="${title}">${esc(label)}</a>`;
  }

  // The quote in a blockquote written as: "said" / *translation* / — Speaker, context (17:08) [SRC](...)
  function readQuote(bq) {
    const paras = [...bq.querySelectorAll(':scope > p')];
    const attrib = paras.find((p) => p.textContent.trim().startsWith('—'));
    if (!attrib) return null;
    const said = [];
    for (const p of paras) {
      const t = p.textContent.trim();
      if (p === attrib || (p.firstElementChild && p.firstElementChild.tagName === 'EM' && p.textContent.trim() === p.firstElementChild.textContent.trim())) break;
      said.push(t.replace(/^["“”«»]+|["“”«»]+$/g, ''));
    }
    // the speaker: everything before the first comma outside parentheses, without the parenthetical
    let depth = 0;
    let who = '';
    for (const ch of attrib.textContent.trim().slice(1)) {
      if (ch === ',' && depth === 0) break;
      depth += (ch === '(') - (ch === ')');
      if (depth === 0 && ch !== ')') who += ch;
    }
    return { text: said.join(' '), who: who.trim() };
  }

  // Words with their place in the text, compared ignoring case and accents, like the brain's quote check.
  const WORD = /[\p{L}\p{N}]+/gu;
  const wordsOf = (text) => [...text.matchAll(WORD)].map((m) => ({ w: fold(m[0]), from: m.index, to: m.index + m[0].length }));

  // Where the quoted words are, as [{ turn, from, to }] character ranges, or null if not word for word.
  // A quote may skip words ("...") and can run on into the next turn or two.
  function findQuote(turns, start, text) {
    const frags = text.split(/\.\.\.|…|\[…\]|\[\.\.\.\]/).map((f) => wordsOf(f).map((x) => x.w)).filter((f) => f.length);
    if (!frags.length) return null;
    for (const first of [start, start - 1, start + 1]) {
      if (first < 0 || first >= turns.length) continue;
      const stream = [];
      turns.slice(first, first + 3).forEach((t, k) => { for (const x of wordsOf(t.text)) stream.push({ ...x, turn: first + k }); });
      const firstLen = wordsOf(turns[first].text).length;
      const ranges = [];
      let pos = 0;
      let ok = true;
      for (const [fi, f] of frags.entries()) {
        let hit = -1;
        for (let i = pos; i + f.length <= stream.length; i++) {
          if (fi === 0 && i >= firstLen) break; // the quote has to start in this turn
          if (f.every((w, j) => stream[i + j].w === w)) { hit = i; break; }
        }
        if (hit < 0) { ok = false; break; }
        for (let i = hit; i < hit + f.length; i++) {
          const x = stream[i];
          const last = ranges[ranges.length - 1];
          if (last && last.turn === x.turn && i > hit) last.to = x.to;
          else ranges.push({ turn: x.turn, from: x.from, to: x.to });
        }
        pos = hit + f.length;
      }
      if (ok) return ranges;
    }
    return null;
  }

  function markText(text, ranges) {
    let html = '';
    let last = 0;
    for (const r of ranges.sort((a, b) => a.from - b.from)) {
      html += esc(text.slice(last, r.from)) + `<mark>${esc(text.slice(r.from, r.to))}</mark>`;
      last = r.to;
    }
    return html + esc(text.slice(last));
  }

  function jumpTo(n, ts, quote) {
    const turns = n.transcript;
    const want = seconds(ts);
    let i = turns.findIndex((t) => t.ts === ts);
    if (i < 0) i = Math.max(0, turns.findLastIndex((t) => t.t <= want));
    const ranges = quote ? findQuote(turns, i, quote.text) : null;
    if (ranges) i = ranges[0].turn;
    const list = $('sheet-scroll').querySelector('.transcript ol');
    const els = list.children;
    const byTurn = {};
    for (const r of ranges || []) (byTurn[r.turn] ||= []).push(r);
    for (const [k, rs] of Object.entries(byTurn)) {
      els[k].classList.add('quoted');
      els[k].querySelector('.said').innerHTML = markText(turns[k].text, rs);
    }
    els[i].classList.add('hit');

    // Say who said it. When the note and the transcript disagree on the speaker, show both.
    const t = turns[i];
    const who = quote && quote.who ? quote.who : t.speaker;
    const differs = quote && quote.who && !nameWords(t.speaker).some((w) => nameWords(quote.who).includes(w));
    const from = quote && quote.from && state.byId.get(quote.from);
    const bar = document.createElement('div');
    bar.className = 'quote-bar';
    bar.innerHTML = `
      <div class="qb-main"><span class="dot" style="--c:${els[i].style.getPropertyValue('--c')}"></span>
        <b>${esc(who)}</b><span class="qb-at">at ${esc(t.ts)}</span>
        ${n.video ? watchLink(n.video, t.t, '▶ Watch this moment') : ''}
        ${from ? `<a class="qb-back" href="${esc(hashFor(from.id))}">← ${esc(showRef(from) ? from.ref : from.label)}</a>` : ''}</div>
      ${differs ? `<div class="qb-note">The transcript labels this speaker ${esc(t.speaker)}.</div>` : ''}
      ${quote && !ranges ? '<div class="qb-note">The exact words weren\'t found here, so the whole turn is highlighted.</div>' : ''}`;
    $('sheet-scroll').append(bar); // sticky at the bottom of the sheet while you read around the moment
    // center the highlighted words; a long monologue would otherwise push them off screen
    const spot = els[i].querySelector('mark') || els[i];
    requestAnimationFrame(() => spot.scrollIntoView({ block: 'center', behavior: 'auto' }));
  }

  // ---- Recordings: the meeting's video on top, its transcript below, opened over the note ----
  // The server fetches both from Fathom; the video streams through it, starting at the quoted moment.

  const player = { token: null, poll: null, turns: [], now: -1, quoteAt: 0, start: 0, heldUntil: 0 };
  const recordingApi = (url, path = '') => `/api/s/${encodeURIComponent(shareId)}/recording${path}?url=${encodeURIComponent(url)}`;
  const videoEl = $('player-video');

  function setPlayerOpen(open) {
    $('player').hidden = !open;
    document.body.classList.toggle('player-open', open);
  }
  function setWait(html) {
    $('player-wait').hidden = !html;
    $('player-wait').innerHTML = html || '';
  }

  async function openRecording(url, secs, quote) {
    closeRecording();
    const token = player.token = {};
    $('player-out').href = url;
    $('player-title').textContent = 'Recording';
    $('player-sub').textContent = '';
    $('player-scroll').innerHTML = '<p class="player-note">Loading the transcript…</p>';
    setWait('Getting the video…');
    setPlayerOpen(true);
    $('player-back').focus({ preventScroll: true });

    let data;
    try {
      const res = await fetch(recordingApi(url));
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The recording could not be loaded.');
    } catch (e) {
      if (token !== player.token) return;
      setWait(`${esc(e.message)}<a class="watch" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Watch it on Fathom ↗</a>`);
      $('player-scroll').innerHTML = '';
      return;
    }
    if (token !== player.token) return;
    $('player-title').textContent = data.title || 'Recording';
    renderRecordingTranscript(data.transcript, secs, quote);
    const start = player.start = secs ?? player.quoteAt;
    $('player-sub').innerHTML = [esc(data.date), secs != null ? `<button class="player-again" id="player-again" title="Play the quoted moment again">↺ ${esc(clock(start))}</button>` : '']
      .filter(Boolean).join(' · ');
    if (data.video === 'ready') playFrom(url, start);
    else waitForVideo(url, start, token, data.video);
  }

  const clock = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor(secs / 60) % 60;
    const s = String(Math.floor(secs % 60)).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };

  // Rarely seen: the server has Fathom make each linked video when the map opens. Only a click in the
  // first minute, or on a meeting nobody's opened in a day, waits for it.
  function waitForVideo(url, start, token, status, tries = 0) {
    if (token !== player.token) return;
    if (status === 'ready') { playFrom(url, start); return; }
    if (status === 'failed' || tries > 60) {
      setWait(`The video isn't ready. Try again in a few minutes.<a class="watch" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Watch it on Fathom ↗</a>`);
      return;
    }
    setWait('Fathom is preparing the video.<span>This takes about a minute.</span>');
    player.poll = setTimeout(async () => {
      const next = await fetch(recordingApi(url)).then((r) => r.json()).catch(() => ({}));
      waitForVideo(url, start, token, next.video || 'pending', tries + 1);
    }, 4000);
  }

  function playFrom(url, start) {
    setWait('Loading the video…');
    videoEl.src = `${recordingApi(url, '/video')}#t=${Math.max(0, start)}`;
    videoEl.play().catch(() => { /* the browser wants a click first; the controls are there */ });
  }

  function renderRecordingTranscript(turns, secs, quote) {
    player.turns = turns;
    player.now = -1;
    if (!turns.length) { $('player-scroll').innerHTML = '<p class="player-note">This recording has no transcript.</p>'; return; }
    const color = speakerColors(turns);
    $('player-scroll').innerHTML = `
      <section class="transcript" aria-label="Transcript">
        <ol>${turns.map((t, i) => `
          <li class="turn" data-i="${i}" style="--c:${color[t.speaker]}">
            <div class="turn-head"><span class="dot"></span><span class="who">${esc(t.speaker)}</span>
              <button class="ts" title="Play from here">${esc(t.ts)}</button></div>
            <p class="said">${esc(t.text)}</p>
          </li>`).join('')}
        </ol>
      </section>`;
    if (secs == null && !quote) return;

    // The quoted words, found the same way as in a transcript note
    let i = Math.max(0, turns.findLastIndex((t) => t.t <= (secs ?? 0)));
    const ranges = quote ? findQuote(turns, i, quote.text) : null;
    if (ranges) i = ranges[0].turn;
    player.quoteAt = turns[i].t;
    const els = $('player-scroll').querySelectorAll('.turn');
    const byTurn = {};
    for (const r of ranges || []) (byTurn[r.turn] ||= []).push(r);
    for (const [k, rs] of Object.entries(byTurn)) {
      els[k].classList.add('quoted');
      els[k].querySelector('.said').innerHTML = markText(turns[k].text, rs);
    }
    els[i].classList.add('hit');
    const spot = els[i].querySelector('mark') || els[i];
    requestAnimationFrame(() => spot.scrollIntoView({ block: 'center', behavior: 'auto' }));
  }

  function closeRecording() {
    if (!player.token) return;
    player.token = null;
    clearTimeout(player.poll);
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load(); // stops the download
    setWait('');
    setPlayerOpen(false);
  }

  // While it plays, the turn being said lights up and stays in view, unless you're scrolling around.
  videoEl.addEventListener('timeupdate', () => {
    const turns = player.turns;
    const i = turns.findLastIndex((t) => t.t <= videoEl.currentTime + 0.5);
    if (i === player.now) return;
    const els = $('player-scroll').querySelectorAll('.turn');
    els[player.now]?.classList.remove('now');
    els[i]?.classList.add('now');
    player.now = i;
    if (els[i] && !videoEl.paused && Date.now() > player.heldUntil) els[i].scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  });
  videoEl.addEventListener('loadeddata', () => setWait(''));
  videoEl.addEventListener('error', () => {
    if (!player.token || !videoEl.getAttribute('src')) return;
    setWait(`The video couldn't be played.<a class="watch" href="${esc($('player-out').href)}" target="_blank" rel="noopener noreferrer">Watch it on Fathom ↗</a>`);
  });
  for (const ev of ['wheel', 'touchmove']) $('player-scroll').addEventListener(ev, () => { player.heldUntil = Date.now() + 5000; }, { passive: true });

  $('player').addEventListener('click', (e) => {
    const ts = e.target.closest('.turn .ts');
    const again = e.target.closest('#player-again');
    if (!ts && !again) return;
    if (!videoEl.getAttribute('src')) return;
    videoEl.currentTime = again ? player.start : player.turns[Number(ts.closest('.turn').dataset.i)].t;
    player.heldUntil = 0;
    videoEl.play().catch(() => {});
  });
  $('player-back').addEventListener('click', () => closeRecording());

  load();
})();
