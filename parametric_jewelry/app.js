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
  earring: { D: 16, elong: 1.3, nU: 4, thick: 0.45, rim: 0 },
  choker:  { rin: 52, gap: 12, T: 2, W: 16, round: 0.5, tilt: 0, rise: 6, spread: 0.2, nU: 60, nV: 3, nW: 1, twist: 0, thick: 0.6, rim: 0.6 },
};
const isOpen = (c) => c === 'tiara' || c === 'choker';
const PAT = { kind: 'gyroid', expr: TPMS.gyroid, mode: 'sheet', iso: 0 };
const fresh = (c) => ({ ...PAT, ...DEF[c] });
const S = { cat: 'ring', byCat: {}, res: 0.1, simp: 0.01, metal: 'ag925', fmt: 'stl', xu: 'mm', wire: false };
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
    o.set(v); c.refresh(); changed();
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
  g.innerHTML = ''; p.innerHTML = '';
  const c = S.cat;
  if (c === 'earring') {
    slider(g, { id: 'D', label: 'Width', help: 'D', unit: 'mm', min: 6, max: 40, step: 0.5, ...P_('D') });
    slider(g, { id: 'elong', label: 'Drop length', help: 'elong', hint: () => 'x half-width', min: 0.5, max: 3, step: 0.05, ...P_('elong') });
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
    slider(p, { id: 'twist', label: 'Twist', help: 'twist', int: !isOpen(c), min: -6, max: 6, step: isOpen(c) ? 0.1 : 1, unit: 'cells', ...P_('twist') });
  }
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
document.querySelectorAll('.side > section').forEach((s) => s.querySelectorAll(':scope > .tabline, :scope > .row').forEach(wireHelp));
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
function updateMannequin(P) {
  if (manObj) { root.remove(manObj); manObj.traverse((o) => o.geometry && !o.userData.shared && o.geometry.dispose()); manObj = null; }
  // on the body the ring is tilted onto the finger so the arm stands upright (like the bangle)
  const wear = PV && PV.wearRotation && $('man').checked ? PV.wearRotation(P) : new THREE.Quaternion();
  root.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2).multiply(wear);
  if (!PV || !$('man').checked) return;
  manObj = PV.makeMannequin(P, matBody); root.add(manObj);
}
$('man').addEventListener('change', () => updateMannequin(params()));
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1); camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement); resize();
(function loop() { orbit.update(); syncPair(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
function fitView() {
  const bb = lastBB || makeField(params()).bb;
  const c = bb.lo.map((v, i) => (v + bb.hi[i]) / 2), R = Math.hypot(...bb.lo.map((v, i) => bb.hi[i] - v)) / 2;
  const dist = R / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
  const tgt = new THREE.Vector3(c[0], c[1], c[2]).applyQuaternion(root.quaternion); // piece frame -> world
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
  if (c === 'earring') return Object.assign(P, { D: p.D, elong: p.elong });
  // choker: open arc centred at the front, the back opening (mm along the band) sets the span
  const span = c === 'choker' ? Math.max(180, 360 * (1 - p.gap / (2 * Math.PI * (p.rin + p.T / 2)))) : p.span || 360;
  Object.assign(P, { rin: p.rin, T: p.T, W: p.W, round: p.round, tilt: p.tilt, span, top: [], bot: [] });
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
  updateImplicit(P0); updateMannequin(P0);
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

// ---------------- go ----------------
buildFields();
changed(true);
})();
