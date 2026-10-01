/* global ForceGraph3D */
// The 3D map (3d-force-graph, which bundles three.js). Loaded only when someone switches to 3D.
// Implements the same view interface as view2d.js: update({ center }), paint(), fit(ids?), resize(), show(on).
window.createView3D = async (stage, ctx) => {
  const LIB = 'https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.0/dist/3d-force-graph.min.js';
  if (!window.ForceGraph3D) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the 3D view.'));
      document.head.appendChild(s);
    });
  }

  const { state, visibleIds, emphasis, colorOf, reduceMotion } = ctx;
  const BG = '#141416';
  const SIGNAL = '#7c84f6';
  const graphEl = stage.querySelector('.graph3d');
  const labelsEl = stage.querySelector('.labels3d');

  const nodes = new Map(state.nodes.map((n) => [n.id, { id: n.id, type: n.type, deg: state.degree[n.id] || 0 }]));
  const links = state.edges.map((e) => ({ source: e.source, target: e.target }));
  const idOf = (x) => (typeof x === 'object' ? x.id : x);
  let visible = new Set();
  let dataKey = '';
  let fitted = false;
  let settling = true; // the layout is still finding its shape

  const mix = (a, b, t) => {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [x, y] = [p(a), p(b)];
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
  };
  // Recomputed on every repaint; the accessors below read from it.
  let emph = { lit: null, focus: null };
  let hovered = null; // the note under the mouse
  const isLit = (l) => {
    if (!emph.focus) return false;
    const [a, b] = [idOf(l.source), idOf(l.target)];
    return (a === emph.focus || b === emph.focus) && emph.lit.has(a) && emph.lit.has(b);
  };
  const nodeColor = (n) => {
    const c = colorOf(n.type);
    if (!emph.lit || emph.lit.has(n.id)) return c;
    return state.selected && state.hops > 0 ? mix(c, BG, 0.45) : mix(c, BG, 0.8);
  };

  const REL = 3;
  const ALPHA_DECAY = 0.0228; // d3's default; the wobble briefly raises it
  const baseVal = (n) => 1 + n.deg * 0.6;
  // How a note should look right now. The spheres ease toward it (see "Node looks").
  // Hovered: bigger and see-through in its own color, so it reads apart from the selected note.
  const lookOf = (n) => {
    if (n.id === state.selected) return { color: colorOf(n.type), opacity: 0.95, scale: Math.cbrt(1.6) };
    if (n.id === hovered) return { color: colorOf(n.type), opacity: 0.6, scale: Math.cbrt(1.5) };
    return { color: nodeColor(n), opacity: 0.95, scale: 1 };
  };

  const g = ForceGraph3D({ controlType: 'orbit' })(graphEl)
    .backgroundColor('rgba(0,0,0,0)')
    .showNavInfo(false)
    // Clicks and hover are ours (see "Picking"): the library drops a click if the pointer moves at all.
    .enablePointerInteraction(false)
    // Its node drag ends every click with a fake pointerup that crashes OrbitControls ("reading 'x'").
    .enableNodeDrag(false)
    // Fixed inputs, so the library never redraws the spheres; their looks are eased by us.
    .nodeRelSize(REL)
    .nodeVal(baseVal)
    .nodeColor((n) => colorOf(n.type))
    .nodeOpacity(0.95)
    .nodeResolution(20)
    .linkColor((l) => (isLit(l) ? SIGNAL : emph.lit ? '#26262b' : '#55565d'))
    .linkOpacity(0.5)
    // Lit links are a thin tube in the accent color, no moving particles: they read without the noise.
    .linkWidth((l) => (isLit(l) ? 0.35 : 0))
    .warmupTicks(80)
    .cooldownTime(5000)
    .onEngineStop(() => {
      settling = false;
      if (!fitted && !state.selected) g.zoomToFit(reduceMotion ? 0 : 800, 40);
      fitted = true;
    });
  // Capped repulsion: notes with no visible links stay near the rest instead of drifting off.
  g.d3Force('charge').strength(-110).distanceMax(220);
  g.d3Force('link').distance(42);
  // Gentle pull toward the middle, so the constellation stays one cluster.
  let simNodes = [];
  const gravity = (alpha) => {
    for (const n of simNodes) {
      n.vx -= n.x * 0.03 * alpha;
      n.vy -= n.y * 0.03 * alpha;
      n.vz -= n.z * 0.03 * alpha;
    }
  };
  gravity.initialize = (ns) => { simNodes = ns; };
  g.d3Force('gravity', gravity);

  // Drift slowly until someone grabs the map.
  const controls = g.controls();
  controls.autoRotate = !reduceMotion;
  controls.autoRotateSpeed = 0.45;
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  function repaint() {
    emph = emphasis();
    g.linkColor(g.linkColor()).linkWidth(g.linkWidth());
  }

  // ---- Labels: HTML over the canvas, so they stay crisp. Nearer notes read bigger. ----
  const labelEls = new Map();
  for (const n of state.nodes) {
    const el = document.createElement('div');
    el.className = 'l3';
    el.textContent = n.label;
    labelsEl.appendChild(el);
    labelEls.set(n.id, el);
  }

  // Visible notes in front of the camera: distance, depth along the view, and spot on screen.
  function onScreen() {
    const cam = g.camera().position;
    const tgt = controls.target;
    const dir = [tgt.x - cam.x, tgt.y - cam.y, tgt.z - cam.z];
    const dirLen = Math.hypot(...dir) || 1;
    const out = [];
    for (const id of visible) {
      const n = nodes.get(id);
      if (n.x === undefined) continue;
      const v = [n.x - cam.x, n.y - cam.y, n.z - cam.z];
      const depth = (v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) / dirLen;
      if (depth < 5) continue; // behind the camera
      out.push({ id, n, depth, d: Math.hypot(...v), p: g.graph2ScreenCoords(n.x, n.y, n.z) });
    }
    return out;
  }

  // ---- Every frame: ease the spheres, move any wobble along, place the labels. ----
  const EASE_MS = 110; // time constant: a change is ~95% done after three of these
  let raf = null;
  let lastFrame = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const k = reduceMotion || !lastFrame ? 1 : 1 - Math.exp(-Math.min(now - lastFrame, 100) / EASE_MS);
    lastFrame = now;
    shake(now);
    easeNodes(k);
    drawLabels(k);
  }

  // ---- Node looks. Each sphere gets its own material, so color, opacity and size can fade
  // per note instead of snapping. ----
  const mats = new Map(); // id -> { mat, to }
  function easeNodes(k) {
    for (const id of visible) {
      const n = nodes.get(id);
      const obj = n.__threeObj;
      if (!obj || !obj.material) continue;
      let m = mats.get(id);
      if (!m) {
        const mat = obj.material.clone();
        m = { mat, to: mat.color.clone() };
        mats.set(id, m);
      }
      if (obj.material !== m.mat) obj.material = m.mat; // the library swaps its own back in on data changes
      const look = lookOf(n);
      m.mat.color.lerp(m.to.set(look.color), k);
      m.mat.opacity += (look.opacity - m.mat.opacity) * k;
      obj.scale.setScalar(obj.scale.x + (look.scale - obj.scale.x) * k);
    }
  }

  // ---- Wobble: when the mouse lands on a note, it and its neighbors shiver a little, so the
  // links between them ripple. They're pinned (fx/fy/fz) on a fading swing and let go after. ----
  const WOBBLE_MS = 900;
  const wobbles = new Map(); // id -> { t0, base, dir, amp }
  const randomDir = () => {
    const v = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
    const len = Math.hypot(...v) || 1;
    return v.map((c) => c / len);
  };
  function wobble(id) {
    if (reduceMotion || settling) return; // speeding up the cooling mid-layout would freeze it half done
    const t0 = performance.now();
    const start = (nid, amp) => {
      const n = nodes.get(nid);
      if (!visible.has(nid) || n.x === undefined) return;
      const base = wobbles.get(nid)?.base || { x: n.x, y: n.y, z: n.z };
      wobbles.set(nid, { t0, base, dir: randomDir(), amp });
    };
    start(id, 1.4);
    for (const nb of state.adj.get(id) || []) start(nb, 0.7);
    // Links only redraw while the simulation runs. Restart it, but let it cool within a few
    // ticks so nothing else drifts.
    g.d3AlphaDecay(0.9).d3ReheatSimulation();
    setTimeout(() => g.d3AlphaDecay(ALPHA_DECAY), 150);
  }
  function shake(now) {
    for (const [id, w] of wobbles) {
      const n = nodes.get(id);
      const t = (now - w.t0) / 1000;
      if (t * 1000 >= WOBBLE_MS || !visible.has(id)) {
        wobbles.delete(id);
        delete n.fx; delete n.fy; delete n.fz;
        Object.assign(n, w.base, { vx: 0, vy: 0, vz: 0 });
        continue;
      }
      const a = w.amp * Math.sin(2 * Math.PI * 3 * t) * Math.exp(-t / 0.22); // ~3 swings, fading
      n.fx = w.base.x + w.dir[0] * a;
      n.fy = w.base.y + w.dir[1] * a;
      n.fz = w.base.z + w.dir[2] * a;
    }
  }

  const labelOpacity = new Map(); // id -> the eased opacity
  function drawLabels(k) {
    const lit = emph.lit;
    const items = onScreen();
    const shown = new Set(items.map((it) => it.id));
    for (const id of visible) {
      if (shown.has(id)) continue;
      labelEls.get(id).style.opacity = 0;
      labelOpacity.delete(id);
    }
    const dmin = Math.min(...items.map((it) => it.d));
    const dmax = Math.max(...items.map((it) => it.d));
    const mid = (dmin + dmax) / 2;
    for (const { id, d, p } of items) {
      const el = labelEls.get(id);
      // An open note is the only one named (plus whatever's under the mouse). Without one, a
      // hovered note or a search names what it lights up; an idle map stays unlabeled.
      const named = state.selected ? id === state.selected : lit && lit.has(id);
      let o = named || id === hovered ? 1 : 0;
      const prev = labelOpacity.get(id);
      if (prev !== undefined) o = prev + (o - prev) * k;
      labelOpacity.set(id, o);
      const scale = Math.min(1.3, Math.max(0.75, mid / d));
      el.style.opacity = o.toFixed(2);
      let x = p.x;
      if (id === hovered) { // its full title is shown, so keep it inside the map
        const half = (el.offsetWidth * scale) / 2 + 4;
        x = Math.min(Math.max(x, half), graphEl.clientWidth - half);
      }
      el.style.transform = `translate(${x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, ${(9 * scale).toFixed(1)}px) scale(${scale.toFixed(2)})`;
      el.style.zIndex = String(id === hovered ? 20000 : Math.round(10000 - d));
      el.classList.toggle('sel', id === state.selected);
      el.classList.toggle('hover', id === hovered);
    }
    // Re-checked every frame: the map keeps turning under a still pointer.
    if (pointer && !press) setHovered(nodeAt(pointer.x, pointer.y, items));
  }

  // ---- Picking. More forgiving than the library's: a press may wobble a few pixels, a note's
  // label counts as part of it, and a small or distant note has a few pixels of slack. ----
  const TAP = 6; // how far a press can move and still be a click, in px
  const SLACK = 6;
  let press = null; // { x, y, moved } while a button or finger is down
  let pointer = null; // mouse position over the map, for hover

  const local = (e) => {
    const b = graphEl.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  // The note under a point on the map: the nearest one hit (sphere or readable label), else the
  // closest sphere within SLACK px, else null.
  function nodeAt(x, y, items = onScreen()) {
    const cam = g.camera();
    const focal = graphEl.clientHeight / 2 / Math.tan((cam.fov * Math.PI) / 360);
    const box = graphEl.getBoundingClientRect();
    let hit = null;
    let near = null;
    let nearGap = SLACK;
    for (const it of items) {
      const r = (REL * Math.cbrt(baseVal(it.n)) * (it.n.__threeObj?.scale.x || 1) * focal) / it.depth;
      const gap = Math.hypot(it.p.x - x, it.p.y - y) - r;
      const el = labelEls.get(it.id);
      const onLabel = Number(el.style.opacity) >= 0.3 && inside(el.getBoundingClientRect(), x + box.left, y + box.top);
      if ((gap <= 0 || onLabel) && (!hit || it.d < hit.d)) hit = it;
      if (gap > 0 && gap < nearGap) { near = it; nearGap = gap; }
    }
    return (hit || near)?.id ?? null;
  }

  function setHovered(id) {
    if (id === hovered) return;
    hovered = id;
    graphEl.style.cursor = id ? 'pointer' : '';
    if (!state.selected) ctx.onHover(id); // with no note open, hovering also previews its links
    if (id) wobble(id);
  }

  graphEl.addEventListener('pointerdown', (e) => {
    if (press) { press.moved = true; return; } // a second finger: a pinch, not a tap
    press = { ...local(e), moved: false };
  });
  graphEl.addEventListener('pointermove', (e) => {
    const at = local(e);
    pointer = e.pointerType === 'mouse' ? at : null;
    if (press && Math.hypot(at.x - press.x, at.y - press.y) > TAP) press.moved = true;
  });
  graphEl.addEventListener('pointerleave', () => {
    pointer = null;
    if (!press) setHovered(null);
  });
  graphEl.addEventListener('pointercancel', () => { press = null; });
  graphEl.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    if (!p || p.moved || e.button !== 0) return;
    const id = nodeAt(p.x, p.y);
    if (id) ctx.onSelect(id);
    else ctx.onBackground();
  });

  function flyTo(id) {
    const n = nodes.get(id);
    if (!n || n.x === undefined) return;
    const k = 1 + 260 / (Math.hypot(n.x, n.y, n.z) || 1);
    g.cameraPosition({ x: n.x * k, y: n.y * k, z: n.z * k }, { x: n.x, y: n.y, z: n.z }, reduceMotion ? 0 : 1200);
  }

  function fit(ids) {
    const pick = ids && ids.size ? (n) => ids.has(n.id) && visible.has(n.id) : (n) => visible.has(n.id);
    g.zoomToFit(reduceMotion ? 0 : 700, 60, pick);
  }

  function update({ center } = {}) {
    visible = visibleIds();
    const key = [...visible].sort().join('\n');
    const changed = key !== dataKey;
    if (changed) {
      dataKey = key;
      g.d3AlphaDecay(ALPHA_DECAY); // a new layout needs the normal cooling, even mid-wobble
      settling = true;
      g.graphData({
        nodes: [...visible].map((id) => nodes.get(id)),
        links: links.filter((l) => visible.has(idOf(l.source)) && visible.has(idOf(l.target))),
      });
    }
    for (const [id, el] of labelEls) el.style.display = visible.has(id) ? '' : 'none';
    repaint();
    if (state.selected) controls.autoRotate = false;
    // After a data change the simulation moves things around; wait for it to settle a little.
    const later = (fn) => setTimeout(fn, changed ? 900 : 0);
    if (center && state.selected) later(() => flyTo(state.selected));
    else if (center && changed && fitted) later(fit);
  }

  function resize() { g.width(graphEl.clientWidth).height(graphEl.clientHeight); }

  return {
    update,
    paint: repaint,
    fit,
    resize,
    show(on) {
      stage.hidden = !on;
      if (on) {
        resize();
        g.resumeAnimation();
        if (!raf) frame(performance.now());
      } else {
        g.pauseAnimation();
        cancelAnimationFrame(raf);
        raf = null;
      }
    },
  };
};
