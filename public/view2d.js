/* global cytoscape, cytoscapeFcose */
// The flat map (Cytoscape). Implements the view interface used by viewer.js:
// update({ center }), paint(), fit(ids?), resize(), show(on).
window.createView2D = (container, ctx) => {
  const { state, visibleIds, litIds, emphasis, colorOf, reduceMotion } = ctx;
  const duration = reduceMotion ? 0 : 350;
  cytoscape.use(cytoscapeFcose);
  // Labels stay off except on the biggest hubs until you zoom in past this, so the whole map stays readable.
  const LABEL_ZOOM = 1.1;
  // Index-style pages ("Other pages") link to almost everything; their edges are drawn fainter.
  const isIndex = (id) => state.byId.get(id)?.type === 'note';

  const cy = cytoscape({
    container,
    elements: [
      ...state.nodes.map((n) => ({
        data: { id: n.id, label: n.label, color: colorOf(n.type), size: 9 + 3 * Math.sqrt(state.degree[n.id] || 0) },
      })),
      ...state.edges.map((e) => ({
        data: { id: `${e.source}→${e.target}`, source: e.source, target: e.target },
        classes: isIndex(e.source) || isIndex(e.target) ? 'weak' : '',
      })),
    ],
    minZoom: 0.15,
    maxZoom: 3,
    style: [
      {
        selector: 'node',
        style: {
          'background-color': 'data(color)',
          width: 'data(size)', height: 'data(size)',
          'border-width': 1.5, 'border-color': '#141416', // a thin gap where nodes overlap
          label: '',
          color: '#9d9ea5',
          'font-family': 'Inter, system-ui, sans-serif',
          'font-size': 11,
          'text-valign': 'bottom', 'text-margin-y': 4,
          'text-wrap': 'ellipsis', 'text-max-width': 170,
          'text-outline-color': '#141416', 'text-outline-width': 2.5,
          'min-zoomed-font-size': 7,
          'transition-property': 'opacity', 'transition-duration': reduceMotion ? 0 : 150,
        },
      },
      {
        selector: 'edge',
        style: {
          // Cytoscape ignores alpha in line-color, so transparency goes in line-opacity.
          width: 0.8, 'line-color': '#8a8b92', 'line-opacity': 0.3, 'curve-style': 'haystack', 'haystack-radius': 0,
          'transition-property': 'opacity', 'transition-duration': reduceMotion ? 0 : 150,
        },
      },
      { selector: 'edge.weak', style: { 'line-opacity': 0.1 } },
      // Who gets a label: hubs, zoomed-in views, and whatever is highlighted. With a note open, only it.
      { selector: 'node.hub, node.zoomed', style: { label: 'data(label)' } },
      { selector: 'node.hub', style: { 'font-size': 13, color: '#b4b5bb' } },
      { selector: 'node.lit', style: { label: 'data(label)', color: '#e8e8ea' } },
      { selector: 'node:selected', style: { label: 'data(label)', 'border-width': 3, 'border-color': '#7c84f6', color: '#e8e8ea', 'font-weight': 600, 'font-size': 13, 'z-index': 10 } },
      { selector: '.faded', style: { opacity: 0.12, 'text-opacity': 0 } },
      { selector: 'node.unnamed', style: { 'text-opacity': 0 } },
      { selector: 'node.ring2', style: { opacity: 0.55 } },
      { selector: 'edge.lit', style: { 'line-color': '#7c84f6', 'line-opacity': 0.85, width: 1.3, 'z-index': 5 } },
      { selector: 'node.lit', style: { 'z-index': 8 } },
    ],
    layout: { name: 'preset' },
  });

  let home = {}; // positions in the whole-map layout, restored when leaving focus mode

  function layout(eles, initial) {
    const l = eles.layout({
      name: 'fcose', quality: 'proof', randomize: initial, animate: false, fit: true, padding: 60,
      nodeRepulsion: 60000, idealEdgeLength: (e) => (e.hasClass('weak') ? 220 : 120), nodeSeparation: 110,
      edgeElasticity: (e) => (e.hasClass('weak') ? 0.1 : 0.4), gravity: 0.15, numIter: 3000,
    });
    const done = l.promiseOn('layoutstop').then(() => {
      // A handful of nodes would otherwise be blown up to fill the screen.
      if (cy.zoom() > 1.3) { cy.zoom(1.3); cy.center(eles); }
    });
    l.run();
    return done;
  }

  // The best-connected visible notes keep their label at any zoom.
  function markHubs() {
    const vis = cy.nodes(':visible').sort((a, b) => (state.degree[b.id()] || 0) - (state.degree[a.id()] || 0));
    const k = Math.max(6, Math.round(vis.length * 0.12));
    cy.nodes().removeClass('hub');
    vis.slice(0, k).addClass('hub');
  }

  let zoomed = null;
  function applyZoomLabels() {
    const on = cy.zoom() >= LABEL_ZOOM;
    if (on === zoomed) return;
    zoomed = on;
    cy.batch(() => cy.nodes().toggleClass('zoomed', on));
  }
  cy.on('zoom', applyZoomLabels);

  function paint() {
    cy.elements().removeClass('faded lit ring2 unnamed');
    // An open note is the only one named, so it's clear which note you're looking at.
    if (state.selected) cy.nodes().filter((n) => n.id() !== state.selected).addClass('unnamed');
    if (state.selected && state.hops > 0) {
      // Focus mode: everything on screen is relevant. Direct neighbors lit, the second ring dimmed.
      const lit = litIds(state.selected);
      cy.nodes(':visible').filter((n) => !lit.has(n.id())).addClass('ring2');
      cy.getElementById(state.selected).connectedEdges().filter((e) => lit.has(e.source().id()) && lit.has(e.target().id())).addClass('lit');
      return;
    }
    const { lit, focus } = emphasis();
    if (!lit) return;
    cy.elements().addClass('faded');
    cy.nodes().filter((n) => lit.has(n.id())).removeClass('faded').addClass('lit');
    if (focus) {
      cy.getElementById(focus).connectedEdges()
        .filter((e) => lit.has(e.source().id()) && lit.has(e.target().id()))
        .removeClass('faded').addClass('lit');
    }
  }

  function fit(ids) {
    let eles = cy.nodes(':visible');
    if (ids && ids.size) eles = eles.filter((n) => ids.has(n.id()));
    if (!eles.length) return;
    // Fit, but never blow a few nodes up to fill the screen.
    const box = eles.boundingBox();
    const w = cy.width() - 120;
    const h = cy.height() - 120;
    const zoom = Math.min(1.3, Math.max(cy.minZoom(), Math.min(w / Math.max(box.w, 1), h / Math.max(box.h, 1))));
    cy.animate({ zoom, center: { eles } }, { duration });
  }

  async function update({ center } = {}) {
    cy.$(':selected').unselect();
    if (state.selected) cy.getElementById(state.selected).select();
    const vis = visibleIds();
    cy.nodes().forEach((n) => { n.style('display', vis.has(n.id()) ? 'element' : 'none'); });
    const keep = cy.nodes(':visible');
    const sub = keep.union(keep.edgesWith(keep));
    // A note opened while its kind is hidden (a page) joins the map as a guest: it's placed among its
    // neighbors and doesn't reshape the map around it.
    const sel = state.selected && state.byId.get(state.selected);
    const guest = sel && state.hidden.has(sel.type) ? cy.getElementById(sel.id) : cy.collection();
    const core = keep.difference(guest);
    if (state.selected && state.hops > 0) {
      await layout(sub, false);
    } else {
      if (core.some((n) => !home[n.id()])) {
        // First draw, or notes shown for the first time (a type switched back on): lay out again.
        await layout(core.union(core.edgesWith(core)), Object.keys(home).length === 0);
        home = Object.fromEntries(core.map((n) => [n.id(), { ...n.position() }]));
      } else {
        core.forEach((n) => { n.position(home[n.id()]); });
      }
      if (guest.length) {
        const box = guest.neighborhood('node').intersection(core).boundingBox();
        guest.position(Number.isFinite(box.x1) ? { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 } : { x: 0, y: 0 });
      }
    }
    markHubs();
    applyZoomLabels();
    paint();
    if (center && state.selected && state.hops === 0) {
      cy.animate({ center: { eles: cy.getElementById(state.selected) }, zoom: Math.max(cy.zoom(), 0.9) }, { duration });
    }
  }

  cy.on('tap', 'node', (e) => ctx.onSelect(e.target.id()));
  cy.on('tap', (e) => { if (e.target === cy) ctx.onBackground(); });
  cy.on('mouseover', 'node', (e) => { container.style.cursor = 'pointer'; if (!state.selected) ctx.onHover(e.target.id()); });
  cy.on('mouseout', 'node', () => { container.style.cursor = ''; if (!state.selected) ctx.onHover(null); });

  return {
    update,
    paint,
    fit,
    resize: () => cy.resize(),
    show(on) { container.hidden = !on; if (on) cy.resize(); },
  };
};
