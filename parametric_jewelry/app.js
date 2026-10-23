// Parametric TPMS jewelry: UI, three.js viewer, worker orchestration, export.
// Geometry lives in worker.js (also loaded on this page as a classic script, so
// makeField / compileExpr / TPMS are globals here too).
// Loaded as a classic script (not type="module") so the page also works when
// opened straight from disk (file://), where Chrome blocks local module scripts.
(async () => {
'use strict';
let THREE, OrbitControls, RoomEnvironment;
try {
  THREE = await import('three');
  ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
  ({ RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js'));
} catch (e) {
  const el = document.getElementById('err');
  el.textContent = 'Could not load three.js from the CDN (check your internet connection): ' + (e.message || e);
  el.hidden = false;
  return;
}
// Ray-marched implicit preview + mannequin. Optional: local module imports are
// blocked on file://, in which case the coarse mesh preview is used instead.
let PV = null;
try { PV = await import('./preview.js'); } catch (e) { console.warn('Implicit preview unavailable:', e); }

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 2) => (+v.toFixed(d)).toString();

// ---------------- state ----------------
const DEF = {
  ring:    { rin: 8.6, T: 1.8, W: 6, round: 0.5, tilt: 0, rise: 0, spread: 0.18, nU: 24, nV: 2, nW: 1, twist: 0, thick: 0.45, rim: 0.4 },
  bangle:  { rin: 30, T: 3, W: 14, round: 0.5, tilt: 0, rise: 0, spread: 0.18, nU: 40, nV: 3, nW: 1, twist: 0, thick: 0.6, rim: 0.6 },
  tiara:   { rin: 70, T: 2, W: 10, span: 150, round: 0.5, tilt: 10, rise: 25, spread: 0.16, nU: 40, nV: 3, nW: 1, twist: 0, thick: 0.6, rim: 0.6 },
  earring: { D: 16, elong: 1.3, nU: 1, thick: 0.45, rim: 0, earX: 0, earY: 0, earZ: 0 }, // ear sliders are offsets from the fitted spot in preview.js
  choker:  { rin: 52, gap: 12, T: 2, W: 16, round: 0.5, tilt: 0, rise: 6, spread: 0.2, nU: 60, nV: 3, nW: 1, twist: 0, thick: 0.6, rim: 0.6 },
};
const isOpen = (c) => c === 'tiara' || c === 'choker';
const PAT = { kind: 'gyroid', expr: TPMS.gyroid, mode: 'sheet', iso: 0 };
const fresh = (c) => ({ ...PAT, ...DEF[c], gx: 8, goff: null, att: [] }); // gx/goff/att: pattern map
const S = { cat: 'ring', finger: 'ring', byCat: {}, res: 0.1, simp: 0.01, metal: 'ag925', fmt: 'stl', xu: 'mm', wire: false };
for (const c of Object.keys(DEF)) S.byCat[c] = fresh(c);
const cur = () => S.byCat[S.cat];

const RES = [0.05, 0.08, 0.1, 0.15, 0.2, 0.3];
const SIMP = [[0, 'Off'], [0.005, 'Light'], [0.01, 'Medium'], [0.02, 'Strong']];
const METALS = [
  ['ag925', 'Sterling silver 925', 10.36, 0xd9d9de], ['au14', '14k yellow gold', 13.07, 0xe6c46a],
  ['au18', '18k yellow gold', 15.58, 0xe8bf55], ['au18w', '18k white gold', 14.7, 0xe2e1dc],
  ['pt950', 'Platinum 950', 20.7, 0xd4d4d6], ['brass', 'Brass', 8.5, 0xd8b45a],
  ['bronze', 'Bronze', 8.8, 0xc08850], ['ti', 'Titanium', 4.5, 0xa9a9ae],
  ['resin', 'Castable resin', 1.2, 0x5a8fd6], ['pla', 'PLA (print)', 1.24, 0xeeeeee],
];
const metal = () => METALS.find((m) => m[0] === S.metal) || METALS[0];
const usSize = (id) => (id - 11.63) / 0.8128;

// ---------------- sliders ----------------
let controls = [];
function slider(parent, o) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<div class="lbl"><label for="${o.id}">${o.label}${o.help ? `<button type="button" class="qi" data-help="${o.help}">?</button>` : ''}</label><span class="hint"></span></div>
    <div class="ctl"><input autocomplete="off" type="range" aria-label="${o.label}"><input autocomplete="off" type="number" id="${o.id}"><span class="u">${o.unit || ''}</span></div>`;
  parent.appendChild(row);
  const r = row.querySelector('input[type=range]'), n = row.querySelector('input[type=number]'), h = row.querySelector('.hint');
  for (const el of [r, n]) { el.min = o.min; el.max = o.max; el.step = o.step; }
  const c = { refresh() { const v = o.get(); r.value = v; n.value = fmt(v, 3); h.textContent = o.hint ? o.hint(v) : ''; } };
  const commit = (raw) => {
    let v = parseFloat(raw);
    if (!isFinite(v)) return;
    v = Math.min(Math.max(v, o.min), o.max);
    if (o.int) v = Math.round(v);
    o.set(v); c.refresh(); (o.onchange || changed)();
  };
  r.addEventListener('input', () => commit(r.value));
  n.addEventListener('change', () => commit(n.value));
  wireHelp(row);
  controls.push(c); c.refresh();
  return c;
}
const P_ = (k, scale = 1) => ({ get: () => cur()[k] * scale, set: (v) => (cur()[k] = v / scale) });

function buildFields() {
  controls = [];
  const g = $('geoFields'), p = $('patFields');
  g.innerHTML = ''; p.innerHTML = ''; $('viewFields').innerHTML = '';
  const c = S.cat;
  $('viewFields').hidden = c !== 'earring'; $('fingerPick').hidden = c !== 'ring';
  if (c === 'earring') {
    slider(g, { id: 'D', label: 'Width', help: 'D', unit: 'mm', min: 6, max: 40, step: 0.5, ...P_('D') });
    slider(g, { id: 'elong', label: 'Drop length', help: 'elong', hint: () => 'x half-width', min: 0.5, max: 3, step: 0.05, ...P_('elong') });
    // where the pair hangs on the head (preview only: the exported mesh is unchanged) -> viewport panel
    const wearUpd = () => updateMannequin(params()), v = $('viewFields');
    slider(v, { id: 'earX', label: 'On ear: out from head', help: 'earPos', unit: 'mm', min: -15, max: 15, step: 0.5, onchange: wearUpd, ...P_('earX') });
    slider(v, { id: 'earY', label: 'On ear: forward / back', help: 'earPos', unit: 'mm', min: -20, max: 20, step: 0.5, onchange: wearUpd, ...P_('earY') });
    slider(v, { id: 'earZ', label: 'On ear: up / down', help: 'earPos', unit: 'mm', min: -20, max: 20, step: 0.5, onchange: wearUpd, ...P_('earZ') });
  } else {
    if (c === 'tiara') {
      slider(g, { id: 'rin', label: 'Head radius', help: 'rinT', unit: 'mm', min: 50, max: 100, step: 0.5, ...P_('rin') });
      slider(g, { id: 'span', label: 'Arc span', help: 'span', unit: 'deg', min: 60, max: 240, step: 1, ...P_('span') });
    } else if (c === 'choker') {
      slider(g, { id: 'rin', label: 'Neck circumference', help: 'rinC', unit: 'mm', min: 260, max: 440, step: 1,
        hint: (v) => `inner \u00d8 ${fmt(v / Math.PI, 1)} mm`, ...P_('rin', 2 * Math.PI) });
      slider(g, { id: 'gap', label: 'Back opening', help: 'gap', hint: () => '0 = closed', unit: 'mm', min: 0, max: 60, step: 0.5, ...P_('gap') });
    } else {
      slider(g, { id: 'rin', label: 'Inner diameter', help: c === 'ring' ? 'rinR' : 'rinB', unit: 'mm', min: c === 'ring' ? 12 : 45, max: c === 'ring' ? 26 : 80, step: 0.1,
        hint: (v) => (c === 'ring' ? `US size ${fmt(usSize(v), 1)}` : ''), ...P_('rin', 2) });
    }
    slider(g, { id: 'T', label: 'Band thickness', help: 'T', hint: () => 'radial', unit: 'mm', min: 0.8, max: 8, step: 0.05, ...P_('T') });
    slider(g, { id: 'W', label: 'Band width', help: 'W', unit: 'mm', min: 2, max: 40, step: 0.1, ...P_('W') });
    slider(g, { id: 'rise', label: c === 'tiara' ? 'Peak height' : 'Front rise', help: 'rise', unit: 'mm', min: -4, max: c === 'tiara' ? 60 : 20, step: 0.1, ...P_('rise') });
    slider(g, { id: 'spread', label: 'Rise spread', help: 'spread', min: 0.05, max: 0.5, step: 0.01, ...P_('spread') });
    slider(g, { id: 'round', label: 'Edge rounding', help: 'round', min: 0, max: 1, step: 0.05, ...P_('round') });
    slider(g, { id: 'tilt', label: 'Tilt', help: 'tilt', unit: 'deg', min: -30, max: 30, step: 0.5, ...P_('tilt') });
  }
  slider(p, { id: 'nU', label: c === 'earring' ? 'Cells across' : 'Cells around', help: 'nU', int: true, min: 1, max: c === 'earring' ? 12 : 120, step: 1, ...P_('nU') });
  if (c !== 'earring') {
    slider(p, { id: 'nV', label: 'Cells across width', help: 'nV', int: true, min: 1, max: 12, step: 1, ...P_('nV') });
    slider(p, { id: 'nW', label: 'Cells through thickness', help: 'nW', int: true, min: 1, max: 4, step: 1, ...P_('nW') });
  } // twist (pattern rotation) lives next to the pattern map, see buildMap()
  const sheetRow = slider(p, { id: 'thick', label: 'Wall thickness', help: 'thick', unit: 'mm', min: 0.2, max: 3, step: 0.01, ...P_('thick') });
  const isoRow = slider(p, { id: 'iso', label: 'Network bias', help: 'iso', hint: () => '- thinner, + thicker', min: -1.2, max: 1.2, step: 0.01, ...P_('iso') });
  sheetRow.el = p.children[p.children.length - 2]; isoRow.el = p.lastElementChild;
  slider(p, { id: 'rim', label: c === 'earring' ? 'Outer shell' : 'Edge rails', help: 'rim', hint: () => '0 = off', unit: 'mm', min: 0, max: 3, step: 0.05, ...P_('rim') });
  syncPattern = () => {
    sheetRow.el.hidden = cur().mode !== 'sheet'; isoRow.el.hidden = cur().mode === 'sheet';
    $('kind').value = cur().kind; $('expr').value = cur().expr;
    document.querySelector(`input[name=mode][value=${cur().mode}]`).checked = true;
    $('exprNote').hidden = true;
  };
  syncPattern();
  buildMap();
}
let syncPattern = () => {};

// ---------------- help ----------------
const HELP = {
  piece: 'Choose what to make. Each piece keeps its own settings while you switch between them. Reset puts the current piece back to its defaults.',
  rinR: 'Inner diameter of the ring, which is the finger size. The US ring size is shown on the right. Add about 0.1 to 0.2 mm if the piece will be polished after casting.',
  rinB: 'Inner diameter of the bangle. Most adult hands need 60 to 70 mm to slide a closed bangle over the knuckles.',
  rinT: 'Radius of the circle the tiara follows, at the inside of the band. An adult head is roughly 70 to 80 mm in radius above the ears.',
  span: 'How far the tiara reaches around the head, in degrees. 180 covers the front half.',
  rinC: 'Inner circumference of the choker, measured where it sits on the neck. Adult necks are usually about 300 to 380 mm; add 10 to 20 mm for a comfortable fit.',
  gap: 'Opening at the back of the choker, measured along the band, for a clasp or to flex it on. 0 makes a closed collar (only for flexible prints).',
  T: 'Thickness of the band from inside to outside. The pattern fills this whole thickness.',
  W: 'Height of the band, measured along the finger, wrist or head.',
  rise: 'Makes the band taller at the front (or at the centre of a tiara), like a crown. Negative values make it lower there instead.',
  spread: 'How wide the rise is. Small values give a sharp peak, large values a gentle swell.',
  round: 'Rounds the corners of the band cross-section. 0 gives a square edge, 1 a fully round edge.',
  tilt: 'Leans the band cross-section, so the band becomes a cone. Useful for tiaras so they sit on the head.',
  D: 'Width of the earring drop.',
  earPos: 'Moves the earring pair on the head in the preview (both ears move symmetrically). This only changes how it is shown on the body, not the exported mesh.',
  elong: 'Length of the drop compared with its half width. 1 gives a sphere, larger values a longer teardrop-like ellipsoid. A small loop for the ear hook sits on top.',
  pattern: 'The lattice that fills the piece. It is a triply periodic minimal surface (TPMS), wrapped so the cells follow the curve of the band.',
  kind: 'Which surface to use. Gyroid and Schwarz D are smooth and very strong. Schwarz P gives round holes. Neovius, I-WP, Lidinoid and Fischer-Koch give more intricate patterns. Pick Custom to type your own.',
  expr: 'The surface is where this formula equals 0. Use x, y, z, numbers, + - * / ^ and functions like sin, cos, abs, sqrt, min, max. One cell is 2*pi in each direction. Editing the formula switches to Custom.',
  mode: 'Sheet thickens the surface into a thin wall, giving two interlocked channels. Network fills one side of the surface, giving a strut-like lattice.',
  nU: 'How many cells repeat around the band (or across the earring). On rings and bangles it is a whole number so the pattern joins seamlessly.',
  nV: 'How many cells fit across the band width.',
  nW: 'How many cells fit through the band thickness. 1 gives an open pattern you can see through.',
  twist: 'Shifts the pattern across the width as it goes around, so the cells spiral. Whole numbers keep a closed band seamless.',
  thick: 'Wall thickness of the sheet. For casting in silver or gold keep it at least 0.4 to 0.5 mm; for resin printing 0.3 mm can work.',
  iso: 'Moves the surface level for the network. Positive values give thicker struts and more material, negative values thinner struts. Too far either way and the network breaks apart or fills in.',
  rim: 'Solid rails along both edges of the band, this thick. They make the piece much stronger and more comfortable. On the earring it is a thin solid shell around the drop. 0 turns it off.',
  mesh: 'The preview is meshed on a coarser grid so it stays fast. Process mesh builds the mesh at the chosen resolution, which is needed before downloading.',
  res: 'Voxel size used to turn the implicit solid into triangles. Smaller is smoother and more accurate but slower and gives bigger files. Use about a quarter of the wall thickness or finer.',
  simp: 'Reduces the number of triangles after processing. Flat areas get large triangles, curved areas keep detail. The value is the largest allowed change in shape. The mesh stays closed and watertight.',
  export: 'Download the processed mesh for printing, casting or CAD.',
  metal: 'Used only to estimate the weight from the mesh volume, and to colour the preview.',
  map: 'The band unrolled flat: left to right goes around the piece (the front is in the middle), bottom to top goes across its width. On the earring it is the drop seen from the front, with the hook at the top. The grey pattern is a slice through the middle of the lattice. Drag the black grid points to pull the cells along with them (a warped frame grid). Yellow attractor points make the cells denser around them (positive strength) or larger and more open (negative strength). Walls keep their thickness everywhere, so denser areas are also stiffer and heavier.',
  gx: 'How many columns of control points the frame grid has around the band. Changing it resets the grid.',
  attS: 'Positive values pack more, smaller cells around the attractor (up to about 3 times denser at its centre). Negative values open the cells up.',
  attR: 'How far the attractor reaches, in mm along the band.',
};
function wireHelp(rootEl) {
  rootEl.querySelectorAll('.qi[data-help]').forEach((btn) => {
    const key = btn.dataset.help;
    btn.setAttribute('aria-label', 'Explain this setting'); btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const host = btn.closest('.row, .tabline');
      let p = host.nextElementSibling;
      if (p && p.classList.contains('explain') && p.dataset.for === key) { p.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
      p = document.createElement('p'); p.className = 'explain'; p.dataset.for = key; p.textContent = HELP[key] || '';
      host.after(p); btn.setAttribute('aria-expanded', 'true');
    });
  });
}
document.querySelectorAll('.side > section, #mapSec').forEach((s) => s.querySelectorAll(':scope > .tabline, :scope > .row').forEach(wireHelp));
$('helpBtn').addEventListener('click', () => { const h = $('help'); h.hidden = !h.hidden; $('helpBtn').setAttribute('aria-expanded', String(!h.hidden)); });
$('contactBtn').addEventListener('click', () => { const m = $('contactMsg'); m.hidden = !m.hidden; $('contactBtn').setAttribute('aria-expanded', String(!m.hidden)); });

// ---------------- other inputs ----------------
const radios = (name, fn) => document.querySelectorAll(`input[name=${name}]`).forEach((el) => el.addEventListener('change', () => el.checked && fn(el.value)));
radios('cat', (v) => { S.cat = v; buildFields(); changed(true); });
$('resetCat').addEventListener('click', () => { S.byCat[S.cat] = fresh(S.cat); buildFields(); changed(true); });
radios('mode', (v) => { cur().mode = v; syncPattern(); changed(); });
$('kind').addEventListener('change', (e) => {
  const k = e.target.value; cur().kind = k;
  if (k !== 'custom') cur().expr = TPMS[k];
  syncPattern(); changed();
});
let tExpr = null;
$('expr').addEventListener('input', (e) => {
  clearTimeout(tExpr);
  tExpr = setTimeout(() => {
    const src = e.target.value, note = $('exprNote');
    try { compileExpr(src); } catch (err) { note.textContent = err.message; note.hidden = false; return; }
    note.hidden = true; cur().expr = src; cur().kind = 'custom'; $('kind').value = 'custom'; changed();
  }, 400);
});
$('res').innerHTML = RES.map((r) => `<option value="${r}" ${r === S.res ? 'selected' : ''}>${r} mm${r === 0.05 ? '  (finest)' : ''}</option>`).join('');
$('simp').innerHTML = SIMP.map(([t, n]) => `<option value="${t}" ${t === S.simp ? 'selected' : ''}>${t ? `${n}  (\u2264 ${t} mm)` : n}</option>`).join('');
$('metal').innerHTML = METALS.map((m) => `<option value="${m[0]}">${m[1]}  (${m[2]} g/cm\u00b3)</option>`).join('');
$('res').addEventListener('change', (e) => { S.res = +e.target.value; dropFinal(); updateExport(); });
$('simp').addEventListener('change', (e) => { S.simp = +e.target.value; dropFinal(); updateExport(); });
$('metal').addEventListener('change', (e) => { S.metal = e.target.value; matMesh.color.setHex(metal()[3]); styleMat(); updateStats(); if (iv && iv.object.visible) updateImplicit(params()); });
$('wire').addEventListener('change', (e) => {
  matMesh.wireframe = e.target.checked;
  if (e.target.checked && iv) { iv.object.visible = false; if (meshObj) meshObj.visible = true; } // wireframe needs the mesh
});
radios('fmt', (v) => (S.fmt = v));
radios('xu', (v) => (S.xu = v));

// ---------------- viewer ----------------
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 5000);
const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(3, 5, 4); camera.add(key); scene.add(camera);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true; orbit.dampingFactor = 0.09;
const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root); // piece Z is up
const matMesh = new THREE.MeshStandardMaterial({ color: metal()[3] });
function styleMat() {
  const plastic = S.metal === 'resin' || S.metal === 'pla';
  matMesh.metalness = plastic ? 0 : 1; matMesh.roughness = plastic ? 0.55 : 0.28;
}
styleMat();
let meshObj = null, lastBB = null;
// implicit body (shown while editing) and the wearer mannequin
const iv = PV ? PV.makeImplicitView() : null;
if (iv) root.add(iv.object);
const matBody = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6, metalness: 0 });
let manObj = null;
// earring pair: on the body a mirrored copy hangs from the other ear
const pair = new THREE.Group(); pair.scale.x = -1; pair.position.x = PV ? PV.EAR_PAIR_X : 0; pair.visible = false; root.add(pair);
const ivR = PV ? PV.makeImplicitView() : null;
if (ivR) pair.add(ivR.object);
const meshR = new THREE.Mesh(new THREE.BufferGeometry(), matMesh); pair.add(meshR);
function syncPair() { // called every frame: copy the left piece's state to the mirrored one
  pair.visible = S.cat === 'earring' && !!PV && $('man').checked;
  if (!pair.visible) return;
  if (ivR) ivR.object.visible = !!(iv && iv.object.visible);
  meshR.visible = !!(meshObj && meshObj.visible);
  if (meshObj && meshR.geometry !== meshObj.geometry) meshR.geometry = meshObj.geometry;
}
function updateImplicit(P) {
  if (!iv) return;
  try {
    const src = P.kind === 'custom' ? P.expr : TPMS[P.kind] || TPMS.gyroid;
    const plastic = S.metal === 'resin' || S.metal === 'pla';
    iv.update(P, makeField(P), compileExpr(src).norm, exprGLSL(src), metal()[3], !plastic);
    if (ivR && P.cat === 'earring') ivR.update(P, makeField(P), compileExpr(src).norm, exprGLSL(src), metal()[3], !plastic);
    iv.object.visible = true;
    if (meshObj) meshObj.visible = false;
  } catch (e) { iv.object.visible = false; if (meshObj) meshObj.visible = true; }
}
function updateMannequin(P0) {
  const P = { ...P0, finger: S.finger }; // which finger is preview-only, so it stays out of the mesh key
  if (manObj) { root.remove(manObj); manObj.traverse((o) => o.geometry && !o.userData.shared && o.geometry.dispose()); manObj = null; }
  // on the body the ring is tilted onto the finger so the arm stands upright (like the bangle)
  const wear = PV && PV.wearRotation && $('man').checked ? PV.wearRotation(P) : new THREE.Quaternion();
  root.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2).multiply(wear);
  if (PV && $('man').checked) {
    manObj = PV.makeMannequin(P, matBody); root.add(manObj);
    if (P.cat === 'earring') { // ear offsets: move the head the other way, so the piece (and its export) stay put
      const e = cur(), dx = e.earX || 0;
      manObj.position.set(-dx, -(e.earY || 0), -(e.earZ || 0));
      pair.position.x = PV.EAR_PAIR_X - 2 * dx; // keep the pair mirrored about the head's mid-plane
    }
  }
  retarget(P0);
}
// orbit pivot = centre of the jewelry (for an earring pair on the body: midway between the two ears).
// Moving the pivot also moves the camera by the same amount, so the view does not jump.
function pivotOf(P) {
  const { lo, hi } = makeField(P).bb, c = lo.map((v, i) => (v + hi[i]) / 2);
  let R = Math.hypot(...lo.map((v, i) => hi[i] - v)) / 2;
  if (P.cat === 'earring' && PV && $('man').checked) { const mx = pair.position.x / 2; R += Math.abs(mx - c[0]); c[0] = mx; }
  return { c: new THREE.Vector3(...c).applyQuaternion(root.quaternion), R };
}
function retarget(P) {
  const { c } = pivotOf(P), d = c.clone().sub(orbit.target);
  if (d.lengthSq() < 1e-8) return;
  orbit.target.add(d); camera.position.add(d);
}
$('man').addEventListener('change', () => updateMannequin(params()));
// hand diagram: click a finger to move the ring there (only the mannequin changes, the camera stays put)
const fingerEls = document.querySelectorAll('#fingerPick [data-finger]');
const pickFinger = (el) => {
  S.finger = el.dataset.finger;
  fingerEls.forEach((f) => f.classList.toggle('on', f === el));
  updateMannequin(params());
};
fingerEls.forEach((el) => {
  el.addEventListener('click', () => pickFinger(el));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFinger(el); } });
});
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1); camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement); resize();
(function loop() { orbit.update(); syncPair(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
function fitView() {
  const { c: tgt, R } = pivotOf(params());
  const dist = R / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
  orbit.target.copy(tgt);
  camera.position.copy(tgt).add(new THREE.Vector3(0.45, 0.5, 0.75).normalize().multiplyScalar(dist));
  camera.near = dist / 100; camera.far = dist * 20; camera.updateProjectionMatrix();
}
$('fit').addEventListener('click', fitView);
function show(pos, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals(); g.computeBoundingBox();
  if (meshObj) { root.remove(meshObj); meshObj.geometry.dispose(); }
  meshObj = new THREE.Mesh(g, matMesh); root.add(meshObj);
  meshObj.visible = !(iv && iv.object.visible);
  const b = g.boundingBox;
  lastBB = { lo: b.min.toArray(), hi: b.max.toArray() };
  $('dims').textContent = `${fmt(b.max.x - b.min.x, 1)} \u00d7 ${fmt(b.max.y - b.min.y, 1)} \u00d7 ${fmt(b.max.z - b.min.z, 1)} mm`;
}

// ---------------- jobs ----------------
function params() {
  const c = S.cat, p = cur();
  const P = { cat: c, kind: p.kind, expr: p.expr, mode: p.mode, thick: p.thick, iso: p.iso, rim: p.rim, nU: p.nU, nV: p.nV || 1, nW: p.nW || 1, twist: p.twist || 0 };
  if (c === 'earring') return Object.assign(P, { D: p.D, elong: p.elong, gx: p.gx, goff: [...gridOf(p)], att: p.att.map((a) => ({ ...a })) });
  // closed bands: whole cells around + whole twist, so the lattice joins at the seam
  if (!isOpen(c)) { P.nU = Math.max(1, Math.round(P.nU)); P.twist = Math.round(P.twist); }
  // choker: open arc centred at the front, the back opening (mm along the band) sets the span
  const span = c === 'choker' ? Math.max(180, 360 * (1 - p.gap / (2 * Math.PI * (p.rin + p.T / 2)))) : p.span || 360;
  Object.assign(P, { rin: p.rin, T: p.T, W: p.W, round: p.round, tilt: p.tilt, span, top: [], bot: [],
    gx: p.gx, goff: [...gridOf(p)], att: p.att.map((a) => ({ ...a })) });
  const closed = !isOpen(c), N = closed ? 32 : 33;
  for (let i = 0; i < N; i++) {
    const s = closed ? i / N : i / (N - 1);
    const g = Math.exp(-(((s - 0.5) / p.spread) ** 2));
    // tiara: tall centre peak with smaller scalloped peaks stepping down to the sides
    const sc = c === 'tiara' ? 0.72 + 0.28 * Math.cos(2 * Math.PI * 6 * (s - 0.5)) : 1;
    P.top.push(p.rise * g * sc); P.bot.push(0);
  }
  return P;
}
const PREVIEW_CELLS = 1.5e6;
function previewVoxel(P) {
  const { lo, hi } = makeField(P).bb;
  const vol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
  return Math.max(S.res, Math.cbrt(vol / PREVIEW_CELLS));
}
let worker = null, useMain = false, busy = false, pending = null, jobId = 0, running = null;
let finalMesh = null; // {key, positions, indices, volume}
const keyOf = () => JSON.stringify([params(), S.res, S.simp]);
function makeWorker() {
  if (useMain) return null;
  try {
    const w = new Worker('worker.js');
    w.onmessage = (e) => onMsg(e.data);
    w.onerror = (e) => { e.preventDefault(); useMain = true; worker = null; busy = false; if (running) start(running); };
    return w;
  } catch (e) { useMain = true; return null; }
}
function start(job) {
  running = job; busy = true;
  job.id = ++jobId;
  if (!worker && !useMain) worker = makeWorker();
  if (worker) { worker.postMessage(job); return; }
  // main-thread fallback (sandboxed pages may block workers)
  setTimeout(() => {
    try {
      const f = makeField(job.params);
      let r = meshField(f, job.voxel);
      const isl = r = removeIslands(r.positions, r.indices);
      if (job.simplify > 0) r = simplifyMesh(r.positions, r.indices, job.simplify);
      onMsg({ type: 'mesh', id: job.id, final: job.final, positions: r.positions, indices: r.indices, volume: meshVolume(r.positions, r.indices), islands: isl.islands });
    } catch (err) { onMsg({ type: 'error', id: job.id, message: String(err.message || err) }); }
  }, 30);
}
function submit(job) {
  if (busy && running && running.final && !job.final && worker) { worker.terminate(); worker = null; busy = false; }
  if (busy && job.final && worker) { worker.terminate(); worker = null; busy = false; }
  if (busy) { pending = job; return; }
  start(job);
}
function onMsg(m) {
  if (!running || m.id !== running.id) return;
  if (m.type === 'progress') { $('bar').style.width = `${(m.f * 100).toFixed(1)}%`; $('busy').textContent = `${m.label} ${Math.round(m.f * 100)}%`; return; }
  const job = running;
  busy = false; running = null; $('bar').style.width = '0';
  if (m.type === 'error') { $('err').textContent = m.message; $('err').hidden = false; }
  else if (m.type === 'mesh') {
    $('err').hidden = true;
    if (job.final && iv) iv.object.visible = false; // processed mesh replaces the implicit view
    show(m.positions, m.indices);
    if (job.final && job.key === keyOf()) finalMesh = { key: job.key, positions: m.positions, indices: m.indices, volume: m.volume };
    $('status').innerHTML = `<b>${job.final ? 'Processed mesh' : 'Preview'}</b> \u00b7 voxel ${fmt(job.voxel, 3)} mm \u00b7 ${(m.indices.length / 3).toLocaleString()} triangles${m.islands ? ` \u00b7 ${m.islands} loose fragments removed` : ''}`;
    if (!job.final) previewVol = m.volume;
    if (job.fit) fitView();
  }
  updateExport(); updateStats();
  if (pending) { const p = pending; pending = null; start(p); }
  else $('busy').hidden = true;
}
let previewVol = 0, tChange = null;
function dropFinal() { finalMesh = null; }
function changed(fit = false) {
  dropFinal(); updateExport();
  clearTimeout(tChange);
  $('busy').hidden = false; $('busy').textContent = 'Updating\u2026';
  const P0 = params();
  updateImplicit(P0); updateMannequin(P0); queueMap();
  tChange = setTimeout(() => {
    const P = params();
    submit({ type: 'mesh', params: P, voxel: previewVoxel(P), simplify: 0, final: false, fit, key: keyOf() });
  }, 200);
}
$('process').addEventListener('click', () => {
  const P = params();
  $('busy').hidden = false; $('busy').textContent = 'Meshing\u2026';
  submit({ type: 'mesh', params: P, voxel: S.res, simplify: S.simp, final: true, key: keyOf() });
});

// ---------------- stats + export ----------------
function updateStats() {
  const vol = finalMesh ? finalMesh.volume : previewVol;
  if (!vol) { $('stats').innerHTML = ''; return; }
  const m = metal(), g = (vol / 1000) * m[2];
  const rows = [[finalMesh ? 'Volume' : 'Volume (preview)', `${fmt(vol / 1000, 3)} cm\u00b3`], ['Est. weight', `${fmt(g, 2)} g`]];
  if (S.cat === 'earring') rows.push(['Pair weight', `${fmt(2 * g, 2)} g`]);
  if (finalMesh) rows.push(['Triangles', (finalMesh.indices.length / 3).toLocaleString()]);
  $('stats').innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
}
function updateExport() {
  const ok = !!finalMesh && finalMesh.key === keyOf();
  $('download').disabled = !ok;
  $('dlHint').textContent = ok ? `Ready: ${S.cat === 'earring' ? 'earring pair (left + mirrored right)' : S.cat} at ${S.res} mm.` : 'Process the mesh first.';
}
function earringPair(pos, idx) { // left piece + mirrored right piece, side by side 4 mm apart
  const n = pos.length, nv = n / 3, P2 = new Float32Array(2 * n), I2 = new Uint32Array(2 * idx.length);
  let hx = -Infinity;
  for (let i = 0; i < n; i += 3) hx = Math.max(hx, pos[i]);
  const m2 = 2 * (hx + 2);
  P2.set(pos); I2.set(idx);
  for (let i = 0; i < n; i += 3) { P2[n + i] = m2 - pos[i]; P2[n + i + 1] = pos[i + 1]; P2[n + i + 2] = pos[i + 2]; }
  for (let t = 0; t < idx.length; t += 3) { // mirroring flips orientation, so swap two corners
    const o = idx.length + t;
    I2[o] = idx[t] + nv; I2[o + 1] = idx[t + 2] + nv; I2[o + 2] = idx[t + 1] + nv;
  }
  return { pos: P2, idx: I2 };
}
function toSTL(pos, idx, sc) {
  const n = idx.length / 3, buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t], b = 3 * idx[t + 1], c = 3 * idx[t + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz]) { dv.setFloat32(o, v, true); o += 4; }
    for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, pos[p + k] * sc, true); o += 4; }
    o += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}
function toOBJ(pos, idx, sc) {
  const out = [`# TPMS jewelry (${S.cat}), units ${S.xu}`];
  for (let i = 0; i < pos.length; i += 3) out.push(`v ${(pos[i] * sc).toFixed(5)} ${(pos[i + 1] * sc).toFixed(5)} ${(pos[i + 2] * sc).toFixed(5)}`);
  for (let t = 0; t < idx.length; t += 3) out.push(`f ${idx[t] + 1} ${idx[t + 1] + 1} ${idx[t + 2] + 1}`);
  return new Blob([out.join('\n') + '\n'], { type: 'text/plain' });
}
$('download').addEventListener('click', () => {
  if (!finalMesh) return;
  const sc = S.xu === 'in' ? 1 / 25.4 : 1;
  let pos = finalMesh.positions, idx = finalMesh.indices;
  if (S.cat === 'earring') ({ pos, idx } = earringPair(pos, idx));
  const blob = S.fmt === 'stl' ? toSTL(pos, idx, sc) : toOBJ(pos, idx, sc);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tpms_${S.cat}${S.cat === 'earring' ? '_pair' : ''}_${cur().kind}_${S.res}mm.${S.fmt}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

// ---------------- pattern map (unrolled band: frame grid + attractors) ----------------
// Same data the field uses (worker.js makeWarp): goff = GRID_ROWS x gx node offsets in (s, v),
// att = [{u, v, r (mm), s}]. The grey picture is the lattice sliced at mid-thickness.
const mapCv = $('map'), mapCtx = mapCv.getContext('2d'), mapOff = document.createElement('canvas');
let selAtt = -1, drag = null, mapQueued = false;
function gridOf(p) {
  const n = 2 * GRID_ROWS * (p.gx || 8);
  if (!p.goff || p.goff.length !== n) p.goff = new Array(n).fill(0);
  return p.goff;
}
// earring: the map is the front view of the drop (width D across, drop length D * elong up)
const mapClosed = () => !isOpen(S.cat) && S.cat !== 'earring';
const mapGeo = () => {
  const P = params(), closed = mapClosed();
  if (S.cat === 'earring') return { P, closed, L: P.D, Wn: P.D * P.elong };
  const Rmid = P.rin + P.T / 2;
  return { P, closed, L: (closed ? 2 * Math.PI : P.span * Math.PI / 180) * Rmid, Wn: P.W };
};
const PAD = 7;
function mapSize() {
  const r = mapCv.getBoundingClientRect();
  return { w: Math.max(r.width, 50), h: Math.max(r.height, 40) };
}
const toPx = (s, v, w, h) => [PAD + s * (w - 2 * PAD), PAD + (1 - v) * (h - 2 * PAD)];
const fromPx = (x, y, w, h) => [(x - PAD) / (w - 2 * PAD), 1 - (y - PAD) / (h - 2 * PAD)];
function nodeRest(i, j, gx, closed) { return [closed ? i / gx : i / (gx - 1), j / (GRID_ROWS - 1)]; }
function drawMap() {
  mapQueued = false;
  const ear = S.cat === 'earring';
  // earring: the drawing area has the drop's own proportions (D wide, D * elong tall), like the model
  let mw = '', mh = '';
  if (ear) {
    const pw = Math.max(mapCv.parentElement.clientWidth - 12, 120), e = cur().elong;
    const iw0 = Math.min(pw - 2 * PAD, (300 - 2 * PAD) / e);
    mw = `${Math.round(iw0 + 2 * PAD)}px`; mh = `${Math.round(iw0 * e + 2 * PAD)}px`;
  }
  if (mapCv.style.height !== mh) mapCv.style.height = mh;
  if (mapCv.style.width !== mw) mapCv.style.width = mw;
  const { w, h } = mapSize(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (mapCv.width !== Math.round(w * dpr) || mapCv.height !== Math.round(h * dpr)) { mapCv.width = Math.round(w * dpr); mapCv.height = Math.round(h * dpr); }
  const { P, closed, L, Wn } = mapGeo(), p = cur();
  // lattice slice (half-res offscreen image)
  const iw = Math.round((w - 2 * PAD) / 1.5), ih = Math.round((h - 2 * PAD) / 1.5);
  mapOff.width = iw; mapOff.height = ih;
  const octx = mapOff.getContext('2d'), img = octx.createImageData(iw, ih);
  let F; try { F = compileExpr(P.kind === 'custom' ? P.expr : TPMS[P.kind] || TPMS.gyroid); } catch (e) { return; }
  const warp = makeWarp(P, closed, L, Wn), TAU = 2 * Math.PI;
  const cu = L / P.nU, cw = (cu + Wn / P.nV) / 2 / (P.nW || 1), cm0 = Math.min(cu, Wn / P.nV, cw);
  const pxmm = Math.max(L / iw, Wn / ih), ecell = ear ? P.D / Math.max(P.nU, 1) : 1;
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const s = (x + 0.5) / iw, v = 1 - (y + 0.5) / ih;
    let su = s, vq = v, cm = ear ? ecell : cm0;
    if (warp) { const q = warp(s, v); su = q.s; vq = q.v; cm /= q.sig; }
    let d;
    if (ear) { // slice through the drop at y = 0 (same field as worker.js), outside the outline stays white
      const X = su * L - L / 2, Z = vq * Wn - Wn, f = F(TAU * X / ecell, 0, TAU * Z / ecell);
      const ed = (Math.hypot((s - 0.5) * 2, (v - 0.5) * 2) - 1) * Math.min(L, Wn) / 2; // ~distance to the outline
      d = P.mode === 'strut' ? (f - P.iso) * cm / TAU : Math.abs(f) * cm / TAU - P.thick / 2;
      if (P.rim > 0) d = Math.min(d, -ed - P.rim);
      d = Math.max(d, ed);
    } else {
      const f = F(TAU * su * P.nU, TAU * ((vq - 0.5) * P.nV + P.twist * su), 0);
      d = P.mode === 'strut' ? (f - P.iso) * cm / TAU : Math.abs(f) * cm / TAU - P.thick / 2;
      if (P.rim > 0) d = Math.min(d, Math.min(v, 1 - v) * Wn - P.rim);
    }
    const a = Math.min(Math.max(0.5 - d / pxmm, 0), 1), o = 4 * (y * iw + x);
    const c = 255 - a * 150, out = ear && Math.hypot((s - 0.5) * 2, (v - 0.5) * 2) > 1.02; // soft, no hard box behind it
    img.data[o] = c; img.data[o + 1] = c; img.data[o + 2] = c + a * 6; img.data[o + 3] = out ? 0 : 150 + a * 105;
  }
  octx.putImageData(img, 0, 0);
  const g = mapCtx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  g.imageSmoothingEnabled = true; g.drawImage(mapOff, PAD, PAD, w - 2 * PAD, h - 2 * PAD);
  // no frame, no labels: the band gets a thin top/bottom edge, the earring its outline; a small tick marks the front
  g.strokeStyle = '#141416'; g.lineWidth = 1;
  const [fx] = toPx(0.5, 0, w, h);
  if (ear) { g.strokeStyle = '#6c6c73'; g.beginPath(); g.ellipse(fx, h / 2, (w - 2 * PAD) / 2, (h - 2 * PAD) / 2, 0, 0, 2 * Math.PI); g.stroke(); }
  else {
    g.beginPath(); g.moveTo(PAD, PAD - 0.5); g.lineTo(w - PAD, PAD - 0.5); g.moveTo(PAD, h - PAD + 0.5); g.lineTo(w - PAD, h - PAD + 0.5); g.stroke();
    g.fillStyle = '#141416'; g.beginPath(); g.moveTo(fx, h - PAD + 1); g.lineTo(fx - 4, h); g.lineTo(fx + 4, h); g.fill();
  }
  g.font = '9px "IBM Plex Mono", monospace'; g.textAlign = 'center';
  // frame grid
  const G = gridOf(p), gx = p.gx, pt = (i, j) => { const [s, v] = nodeRest(i, j, gx, closed), k = 2 * (j * gx + i); return toPx(s + G[k], v + G[k + 1], w, h); };
  g.strokeStyle = 'rgba(20,20,22,0.55)'; g.beginPath();
  for (let j = 0; j < GRID_ROWS; j++) for (let i = 0; i < (closed ? gx : gx - 1); i++) {
    const a = pt(i, j);
    if (closed && i === gx - 1) { const b = pt(0, j); g.moveTo(...a); g.lineTo(b[0] + (w - 2 * PAD), b[1]); }
    else { const b = pt(i + 1, j); g.moveTo(...a); g.lineTo(...b); }
  }
  for (let i = 0; i < gx; i++) for (let j = 0; j < GRID_ROWS - 1; j++) { g.moveTo(...pt(i, j)); g.lineTo(...pt(i, j + 1)); }
  g.stroke();
  for (let j = 0; j < GRID_ROWS; j++) for (let i = 0; i < gx; i++) {
    const [x, y] = pt(i, j), on = drag && drag.kind === 'node' && drag.i === i && drag.j === j;
    g.fillStyle = on ? '#f3e500' : '#141416'; g.fillRect(x - 3, y - 3, 6, 6);
  }
  // attractors: dashed ellipse = radius, filled dot = centre (+ dense, - open)
  p.att.forEach((t, k) => {
    const [x, y] = toPx(t.u, t.v, w, h), rx = t.r / L * (w - 2 * PAD), ry = t.r / Wn * (h - 2 * PAD);
    g.setLineDash([3, 3]); g.strokeStyle = '#141416'; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI); g.stroke(); g.setLineDash([]);
    g.beginPath(); g.arc(x, y, k === selAtt ? 7 : 5.5, 0, 2 * Math.PI);
    g.fillStyle = t.s >= 0 ? '#f3e500' : '#ffffff'; g.fill(); g.lineWidth = k === selAtt ? 2 : 1; g.stroke(); g.lineWidth = 1;
    g.fillStyle = '#141416'; g.fillText(t.s >= 0 ? '+' : '\u2212', x, y + 3);
  });
}
function queueMap() { if (!mapQueued) { mapQueued = true; requestAnimationFrame(drawMap); } }
new ResizeObserver(queueMap).observe(mapCv);
function hitMap(e) {
  const r = mapCv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, { w, h } = mapSize(), p = cur();
  for (let k = p.att.length - 1; k >= 0; k--) { const [ax, ay] = toPx(p.att[k].u, p.att[k].v, w, h); if (Math.hypot(ax - x, ay - y) < 9) return { kind: 'att', k, x, y }; }
  const closed = mapClosed(), G = gridOf(p);
  let best = null, bd = 9;
  for (let j = 0; j < GRID_ROWS; j++) for (let i = 0; i < p.gx; i++) {
    const [s, v] = nodeRest(i, j, p.gx, closed), kk = 2 * (j * p.gx + i), [nx, ny] = toPx(s + G[kk], v + G[kk + 1], w, h);
    const d = Math.hypot(nx - x, ny - y); if (d < bd) { bd = d; best = { kind: 'node', i, j, x, y }; }
  }
  return best || { kind: 'none', x, y };
}
function selectAtt(k) { selAtt = k; buildAttFields(); queueMap(); }
mapCv.addEventListener('pointerdown', (e) => {
  const hit = hitMap(e);
  if (hit.kind === 'none') { if (selAtt >= 0) selectAtt(-1); return; }
  drag = hit; mapCv.setPointerCapture(e.pointerId);
  if (hit.kind === 'att') selectAtt(hit.k);
  e.preventDefault();
});
mapCv.addEventListener('pointermove', (e) => {
  if (!drag) { mapCv.style.cursor = hitMap(e).kind === 'none' ? 'crosshair' : 'grab'; return; }
  const r = mapCv.getBoundingClientRect(), { w, h } = mapSize(), p = cur();
  let [s, v] = fromPx(e.clientX - r.left, e.clientY - r.top, w, h);
  if (drag.kind === 'att') {
    const t = p.att[drag.k]; t.u = !mapClosed() ? Math.min(Math.max(s, 0), 1) : ((s % 1) + 1) % 1; t.v = Math.min(Math.max(v, 0), 1);
  } else {
    const closed = mapClosed(), [s0, v0] = nodeRest(drag.i, drag.j, p.gx, closed), G = gridOf(p), k = 2 * (drag.j * p.gx + drag.i);
    const ms = 0.42 / (closed ? p.gx : p.gx - 1), mv = 0.42 / (GRID_ROWS - 1); // keep the grid from folding over
    G[k] = Math.min(Math.max(s - s0, -ms), ms); G[k + 1] = Math.min(Math.max(v - v0, -mv), mv);
  }
  changed();
});
const endDrag = () => { if (drag) { drag = null; queueMap(); } };
mapCv.addEventListener('pointerup', endDrag); mapCv.addEventListener('pointercancel', endDrag);
mapCv.addEventListener('dblclick', (e) => {
  const hit = hitMap(e), p = cur();
  if (hit.kind === 'att') { p.att.splice(hit.k, 1); selectAtt(-1); changed(); return; }
  if (hit.kind === 'node') { const k = 2 * (hit.j * p.gx + hit.i); gridOf(p)[k] = 0; gridOf(p)[k + 1] = 0; changed(); return; }
  const { w, h } = mapSize(), [s, v] = fromPx(hit.x, hit.y, w, h);
  addAtt(Math.min(Math.max(s, 0), 1), Math.min(Math.max(v, 0), 1));
});
mapCv.addEventListener('wheel', (e) => {
  const hit = hitMap(e); if (hit.kind !== 'att') return;
  e.preventDefault();
  const t = cur().att[hit.k], { L } = mapGeo();
  t.r = Math.min(Math.max(t.r * Math.pow(1.1, e.deltaY > 0 ? -1 : 1), 0.5), L / 2);
  selectAtt(hit.k); changed();
}, { passive: false });
function addAtt(u, v) {
  const p = cur(); if (p.att.length >= 8) return;
  const { L, Wn } = mapGeo();
  p.att.push({ u, v, r: +Math.max(Math.min(L / 6, 3 * Wn), 1).toFixed(1), s: 1 });
  selectAtt(p.att.length - 1); changed();
}
$('mapAdd').addEventListener('click', () => addAtt(0.5, 0.5));
$('mapReset').addEventListener('click', () => { const p = cur(); p.goff = null; p.att = []; selectAtt(-1); changed(); });
function buildAttFields() {
  const f = $('mapFields'); f.innerHTML = '';
  const t = cur().att[selAtt]; if (!t) return;
  const A = (k) => ({ get: () => cur().att[selAtt][k], set: (v) => (cur().att[selAtt][k] = v) });
  slider(f, { id: 'attS', label: `Attractor ${selAtt + 1} strength`, help: 'attS', hint: () => '+ denser, \u2212 open', min: -0.8, max: 2, step: 0.05, ...A('s') });
  slider(f, { id: 'attR', label: 'Attractor radius', help: 'attR', unit: 'mm', min: 0.5, max: +(mapGeo().L / 2).toFixed(1), step: 0.1, ...A('r') });
}
function buildMap() {
  $('mapSec').hidden = false;
  $('mapGrid').innerHTML = ''; selAtt = -1; $('mapFields').innerHTML = '';
  // pattern rotation (twist) sits here, next to the map it turns
  if (S.cat !== 'earring') slider($('mapGrid'), { id: 'twist', label: 'Twist', int: !isOpen(S.cat), min: -6, max: 6, step: isOpen(S.cat) ? 0.1 : 1, unit: 'cells', ...P_('twist') });
  slider($('mapGrid'), { id: 'gx', label: 'Grid', int: true, min: 4, max: 16, step: 1,
    get: () => cur().gx, set: (v) => { if (v !== cur().gx) { cur().gx = v; cur().goff = null; } } });
  queueMap();
}
// one click: a random but well-behaved pattern (surface, solid type, cell counts, twist, warped grid, attractors)
const rnd = (a, b) => a + Math.random() * (b - a), rint = (a, b) => Math.floor(rnd(a, b + 1)), pick = (a) => a[Math.floor(Math.random() * a.length)];
$('mapRand').addEventListener('click', () => {
  const p = cur(), c = S.cat, ear = c === 'earring', closed = mapClosed(), kinds = Object.keys(TPMS);
  if (Math.random() < 0.3) { // blend of two surfaces
    const a = pick(kinds), b = pick(kinds.filter((k) => k !== a)), w = +rnd(0.3, 0.7).toFixed(2);
    p.kind = 'custom'; p.expr = `${w}*(${TPMS[a]}) + ${+(1 - w).toFixed(2)}*(${TPMS[b]})`;
  } else { p.kind = pick(kinds); p.expr = TPMS[p.kind]; }
  p.mode = Math.random() < 0.6 ? 'sheet' : 'strut';
  p.iso = +rnd(-0.4, 0.4).toFixed(2);
  if (ear) p.nU = rint(1, 4);
  else {
    const base = DEF[c].nU; p.nU = Math.max(4, Math.round(base * rnd(0.5, 1.6)));
    p.nV = rint(1, Math.max(2, DEF[c].nV + 1)); p.nW = 1;
    p.twist = Math.random() < 0.5 ? 0 : (closed ? rint(-2, 2) : +rnd(-2, 2).toFixed(1));
  }
  p.gx = rint(5, 10); p.goff = null;
  const G = gridOf(p), ms = 0.42 / (closed ? p.gx : p.gx - 1), mv = 0.42 / (GRID_ROWS - 1);
  const ph = rnd(0, 2 * Math.PI), fr = rint(1, 3), amp = rnd(0.3, 1);
  for (let j = 0; j < GRID_ROWS; j++) for (let i = 0; i < p.gx; i++) { // smooth wave, not noise
    const k = 2 * (j * p.gx + i), t = i / p.gx * 2 * Math.PI * fr + ph;
    G[k] = amp * ms * Math.sin(t + j); G[k + 1] = (j === 1 ? 1 : 0.3) * amp * mv * Math.cos(t);
  }
  const { L, Wn } = mapGeo();
  p.att = Array.from({ length: rint(0, 3) }, () => ({ u: +rnd(0.1, 0.9).toFixed(3), v: +rnd(0.2, 0.8).toFixed(3),
    r: +Math.max(rnd(0.12, 0.3) * Math.min(L, ear ? L : 4 * Wn), 1).toFixed(1), s: +(Math.random() < 0.7 ? rnd(0.5, 1.6) : rnd(-0.6, -0.2)).toFixed(2) }));
  buildFields(); changed();
});
// the map floats over the viewport without a frame; drag the grip to move it
(() => {
  const sec = $('mapSec'), grip = $('mapGrip'); let d = null;
  grip.addEventListener('pointerdown', (e) => {
    const r = sec.getBoundingClientRect(), v = sec.parentElement.getBoundingClientRect();
    d = { dx: e.clientX - r.left, dy: e.clientY - r.top, v }; grip.setPointerCapture(e.pointerId); e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!d) return;
    const { v } = d, w = sec.offsetWidth, h = sec.offsetHeight;
    sec.style.left = `${Math.min(Math.max(e.clientX - v.left - d.dx, 0), v.width - w)}px`;
    sec.style.top = `${Math.min(Math.max(e.clientY - v.top - d.dy, 0), Math.max(v.height - h, 0))}px`;
    sec.style.right = 'auto'; sec.style.transform = 'none';
  });
  const up = () => (d = null); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
})();

// ---------------- go ----------------
buildFields();
changed(true);
})();
