// TPMS jewelry mesher worker. MC tables + QEM simplifier adapted from Voronoi_Lattice_Generator.
const MC = (function buildTables() {
  const C = [];
  for (let i = 0; i < 8; i++) C.push([i & 1, (i >> 1) & 1, (i >> 2) & 1]);
  const EDGES = [];
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
    const d = a ^ b;
    if (d === 1 || d === 2 || d === 4) EDGES.push([a, b]);
  }
  const edgeOf = (a, b) => EDGES.findIndex(([p, q]) => (p === a && q === b) || (p === b && q === a));
  const FACES = [];
  for (let ax = 0; ax < 3; ax++) for (let s = 0; s < 2; s++) {
    const u = (ax + 1) % 3, v = (ax + 2) % 3;
    const cyc = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([pu, pv]) => {
      const c = [0, 0, 0]; c[ax] = s; c[u] = pu; c[v] = pv;
      return c[0] | (c[1] << 1) | (c[2] << 2);
    });
    const n = [0, 0, 0]; n[ax] = s ? 1 : -1;
    FACES.push({ cyc, n });
  }
  const mid = (e) => { const [a, b] = EDGES[e]; return [0, 1, 2].map((i) => (C[a][i] + C[b][i]) / 2); };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const TRI = [], bad = [];
  for (let m = 0; m < 256; m++) {
    const ins = (i) => (m >> i) & 1;
    const next = new Int32Array(12).fill(-1);
    for (const { cyc, n } of FACES) {
      const fe = [0, 1, 2, 3].map((k) => edgeOf(cyc[k], cyc[(k + 1) % 4]));
      const crossing = fe.filter((e) => ins(EDGES[e][0]) !== ins(EDGES[e][1]));
      const segs = [];
      if (crossing.length === 2) {
        const corner = cyc.find((c) => ins(c));
        segs.push([crossing[0], crossing[1], corner]);
      } else if (crossing.length === 4) {
        for (let k = 0; k < 4; k++) if (ins(cyc[k])) segs.push([fe[(k + 3) % 4], fe[k], cyc[k]]);
      }
      for (let [ea, eb, corner] of segs) {
        const P = mid(ea), Q = mid(eb);
        if (dot(cross(sub(Q, P), sub(C[corner], P)), n) < 0) [ea, eb] = [eb, ea];
        next[ea] = eb;
      }
    }
    const tris = [], seen = new Uint8Array(12);
    for (let e = 0; e < 12; e++) {
      if (next[e] < 0 || seen[e]) continue;
      const loop = [];
      let cur = e;
      while (!seen[cur]) { seen[cur] = 1; loop.push(cur); cur = next[cur]; }
      // fan from a start vertex chosen so no triangle lies flat in one cube face
      // (a flat one would be duplicated by the neighbouring cube)
      const faceSet = (e) => FACES.map((f, fi) => (f.cyc.includes(EDGES[e][0]) && f.cyc.includes(EDGES[e][1]) ? fi : -1)).filter((x) => x >= 0);
      const flat = (a, b, c) => faceSet(a).some((f) => faceSet(b).includes(f) && faceSet(c).includes(f));
      let start = -1;
      for (let s0 = 0; s0 < loop.length && start < 0; s0++) {
        let ok = true;
        for (let i = 1; i + 1 < loop.length; i++) {
          if (flat(loop[s0], loop[(s0 + i) % loop.length], loop[(s0 + i + 1) % loop.length])) { ok = false; break; }
        }
        if (ok) start = s0;
      }
      if (start < 0) { bad.push([m, loop]); start = 0; }
      // inside-on-left loops => reverse for outward normals
      for (let i = 1; i + 1 < loop.length; i++) {
        tris.push(loop[start], loop[(start + i + 1) % loop.length], loop[(start + i) % loop.length]);
      }
    }
    TRI.push(tris);
  }
  return { EDGES, TRI, bad };
})();

// Mesh simplification: quadric error metric edge collapse (Garland & Heckbert).
// Collapses edges while the accumulated squared plane distance stays below tol^2,
// so flat-ish regions (strut sides) lose most triangles and curved nodes keep detail.
// Keeps the mesh closed and manifold (link condition) and rejects collapses that
// flip or squash triangles.
// ---------------------------------------------------------------------------
function simplifyMesh(positions, indices, tol, onProgress) {
  const nV = positions.length / 3, nF = indices.length / 3;
  const P = new Float64Array(positions);
  const F = new Int32Array(indices);
  const fAlive = new Uint8Array(nF).fill(1);
  const vAlive = new Uint8Array(nV).fill(1);
  const ver = new Int32Array(nV);
  const Q = new Float64Array(nV * 10);
  // vertex -> faces
  const vfCount = new Int32Array(nV);
  for (let i = 0; i < F.length; i++) vfCount[F[i]]++;
  const VF = new Array(nV);
  for (let v = 0; v < nV; v++) VF[v] = [];
  for (let f = 0; f < nF; f++) for (let k = 0; k < 3; k++) VF[F[3 * f + k]].push(f);

  const fn = (f, out) => {
    const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    return a;
  };
  const n = [0, 0, 0];
  for (let f = 0; f < nF; f++) {
    const a = fn(f, n);
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-20) continue;
    const nx = n[0] / l, ny = n[1] / l, nz = n[2] / l, d = -(nx * P[a] + ny * P[a + 1] + nz * P[a + 2]);
    for (let k = 0; k < 3; k++) {
      const q = 10 * F[3 * f + k];
      Q[q] += nx * nx; Q[q + 1] += nx * ny; Q[q + 2] += nx * nz; Q[q + 3] += nx * d;
      Q[q + 4] += ny * ny; Q[q + 5] += ny * nz; Q[q + 6] += ny * d;
      Q[q + 7] += nz * nz; Q[q + 8] += nz * d; Q[q + 9] += d * d;
    }
  }
  const qe = (q, x, y, z) =>
    q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x +
    q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];

  // ---- binary min-heap of candidate collapses ----
  let cap = 1 << 20, hn = 0;
  let hc = new Float64Array(cap), hu = new Int32Array(cap), hv = new Int32Array(cap), hvu = new Int32Array(cap), hvv = new Int32Array(cap);
  let hx = new Float64Array(cap), hy = new Float64Array(cap), hz = new Float64Array(cap);
  const swap = (i, j) => {
    let t;
    t = hc[i]; hc[i] = hc[j]; hc[j] = t; t = hu[i]; hu[i] = hu[j]; hu[j] = t; t = hv[i]; hv[i] = hv[j]; hv[j] = t;
    t = hvu[i]; hvu[i] = hvu[j]; hvu[j] = t; t = hvv[i]; hvv[i] = hvv[j]; hvv[j] = t;
    t = hx[i]; hx[i] = hx[j]; hx[j] = t; t = hy[i]; hy[i] = hy[j]; hy[j] = t; t = hz[i]; hz[i] = hz[j]; hz[j] = t;
  };
  const grow = () => {
    const c2 = cap * 2;
    const g = (a, T) => { const b = new T(c2); b.set(a); return b; };
    hc = g(hc, Float64Array); hu = g(hu, Int32Array); hv = g(hv, Int32Array); hvu = g(hvu, Int32Array); hvv = g(hvv, Int32Array);
    hx = g(hx, Float64Array); hy = g(hy, Float64Array); hz = g(hz, Float64Array); cap = c2;
  };
  const qs = new Float64Array(10);
  const limit = tol * tol;
  function pushEdge(u, v) {
    const a = 10 * u, b = 10 * v;
    for (let i = 0; i < 10; i++) qs[i] = Q[a + i] + Q[b + i];
    // optimal point: solve A x = -b
    const A00 = qs[0], A01 = qs[1], A02 = qs[2], A11 = qs[4], A12 = qs[5], A22 = qs[7];
    const c00 = A11 * A22 - A12 * A12, c01 = A02 * A12 - A01 * A22, c02 = A01 * A12 - A02 * A11;
    const det = A00 * c00 + A01 * c01 + A02 * c02;
    const pu = 3 * u, pv = 3 * v;
    let x, y, z, cost;
    const sc = A00 + A11 + A22;
    if (Math.abs(det) > 1e-9 * sc * sc * sc) {
      const b0 = -qs[3], b1 = -qs[6], b2 = -qs[8];
      const c11 = A00 * A22 - A02 * A02, c12 = A01 * A02 - A00 * A12, c22 = A00 * A11 - A01 * A01;
      x = (c00 * b0 + c01 * b1 + c02 * b2) / det;
      y = (c01 * b0 + c11 * b1 + c12 * b2) / det;
      z = (c02 * b0 + c12 * b1 + c22 * b2) / det;
      // stay near the edge (avoid far-off solutions in near-singular cases)
      const mx = (P[pu] + P[pv]) / 2, my = (P[pu + 1] + P[pv + 1]) / 2, mz = (P[pu + 2] + P[pv + 2]) / 2;
      const L = Math.hypot(P[pu] - P[pv], P[pu + 1] - P[pv + 1], P[pu + 2] - P[pv + 2]);
      if (Math.hypot(x - mx, y - my, z - mz) > 2 * L) { x = NaN; }
      else cost = qe(qs, x, y, z);
    } else x = NaN;
    if (Number.isNaN(x)) {
      const cand = [[P[pu], P[pu + 1], P[pu + 2]], [P[pv], P[pv + 1], P[pv + 2]],
        [(P[pu] + P[pv]) / 2, (P[pu + 1] + P[pv + 1]) / 2, (P[pu + 2] + P[pv + 2]) / 2]];
      cost = Infinity;
      for (const c of cand) { const e = qe(qs, c[0], c[1], c[2]); if (e < cost) { cost = e; x = c[0]; y = c[1]; z = c[2]; } }
    }
    if (!(cost <= limit)) return;
    if (hn >= cap) grow();
    let i = hn++;
    hc[i] = cost; hu[i] = u; hv[i] = v; hvu[i] = ver[u]; hvv[i] = ver[v]; hx[i] = x; hy[i] = y; hz[i] = z;
    while (i > 0) { const p = (i - 1) >> 1; if (hc[p] <= hc[i]) break; swap(i, p); i = p; }
  }
  function pop() {
    hn--; swap(0, hn);
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < hn && hc[l] < hc[m]) m = l;
      if (r < hn && hc[r] < hc[m]) m = r;
      if (m === i) break; swap(i, m); i = m;
    }
    return hn;
  }
  for (let f = 0; f < nF; f++) for (let k = 0; k < 3; k++) {
    const a = F[3 * f + k], b = F[3 * f + (k + 1) % 3];
    if (a < b) pushEdge(a, b);
  }

  const mark = new Int32Array(nV), mark2 = new Int32Array(nV);
  let stamp = 0;
  const n0 = [0, 0, 0], n1 = [0, 0, 0];
  let removed = 0, iter = 0;
  const total0 = hn;
  while (hn > 0) {
    const e = pop();
    const u = hu[e], v = hv[e];
    if (!vAlive[u] || !vAlive[v] || hvu[e] !== ver[u] || hvv[e] !== ver[v]) continue;
    if ((++iter & 32767) === 0 && onProgress) onProgress(Math.min(1, iter / total0));
    const tx = hx[e], ty = hy[e], tz = hz[e];
    // link condition: common neighbours must be exactly the 2 opposite vertices
    stamp++;
    for (const f of VF[u]) for (let k = 0; k < 3; k++) mark[F[3 * f + k]] = stamp;
    let shared = 0, common = 0;
    stamp++;
    for (const f of VF[v]) {
      let hasU = false;
      for (let k = 0; k < 3; k++) if (F[3 * f + k] === u) hasU = true;
      if (hasU) shared++;
      for (let k = 0; k < 3; k++) {
        const w = F[3 * f + k];
        if (w !== u && w !== v && mark[w] === stamp - 1 && mark2[w] !== stamp) { mark2[w] = stamp; common++; }
      }
    }
    if (shared !== 2 || common !== 2) continue;
    // geometry check: no flipped or degenerate triangles around u and v
    let ok = true;
    for (const vv of [u, v]) {
      for (const f of VF[vv]) {
        let hasU = false, hasV = false;
        for (let k = 0; k < 3; k++) { if (F[3 * f + k] === u) hasU = true; if (F[3 * f + k] === v) hasV = true; }
        if (hasU && hasV) continue;
        fn(f, n0);
        const p = 3 * vv, ox = P[p], oy = P[p + 1], oz = P[p + 2];
        P[p] = tx; P[p + 1] = ty; P[p + 2] = tz;
        fn(f, n1);
        P[p] = ox; P[p + 1] = oy; P[p + 2] = oz;
        const l0 = Math.hypot(n0[0], n0[1], n0[2]), l1 = Math.hypot(n1[0], n1[1], n1[2]);
        if (l1 < 1e-14 || (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) < 0.3 * l0 * l1) { ok = false; break; }
        // reject slivers: area vs longest edge squared
        const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
        const get = (i) => (i === p ? [tx, ty, tz] : [P[i], P[i + 1], P[i + 2]]);
        const A = get(a), B = get(b), C = get(c);
        const e2 = Math.max((A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2,
          (B[0] - C[0]) ** 2 + (B[1] - C[1]) ** 2 + (B[2] - C[2]) ** 2, (C[0] - A[0]) ** 2 + (C[1] - A[1]) ** 2 + (C[2] - A[2]) ** 2);
        if (l1 < 0.05 * e2) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    // collapse v into u
    const keep = [];
    for (const f of VF[u]) {
      let hasV = false;
      for (let k = 0; k < 3; k++) if (F[3 * f + k] === v) hasV = true;
      if (hasV) { fAlive[f] = 0; removed++; } else keep.push(f);
    }
    for (const f of VF[v]) {
      if (!fAlive[f]) continue;
      let hasU = false;
      for (let k = 0; k < 3; k++) if (F[3 * f + k] === u) hasU = true;
      if (hasU) { fAlive[f] = 0; continue; }
      for (let k = 0; k < 3; k++) if (F[3 * f + k] === v) F[3 * f + k] = u;
      keep.push(f);
    }
    // remove dead faces from the opposite vertices' lists
    VF[u] = keep; VF[v] = [];
    vAlive[v] = 0;
    P[3 * u] = tx; P[3 * u + 1] = ty; P[3 * u + 2] = tz;
    for (let i = 0; i < 10; i++) Q[10 * u + i] += Q[10 * v + i];
    ver[u]++;
    stamp++;
    for (const f of keep) for (let k = 0; k < 3; k++) {
      const w = F[3 * f + k];
      if (w === u || mark[w] === stamp) continue;
      mark[w] = stamp;
      VF[w] = VF[w].filter((g) => fAlive[g]);
      pushEdge(u, w);
    }
  }
  // compact
  const remap = new Int32Array(nV).fill(-1);
  let nv2 = 0, nf2 = 0;
  for (let f = 0; f < nF; f++) if (fAlive[f]) nf2++;
  const outI = new Uint32Array(nf2 * 3);
  const outP = [];
  let o = 0;
  for (let f = 0; f < nF; f++) {
    if (!fAlive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = F[3 * f + k];
      if (remap[v] < 0) { remap[v] = nv2++; outP.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); }
      outI[o++] = remap[v];
    }
  }
  if (onProgress) onProgress(1);
  return { positions: new Float32Array(outP), indices: outI };
}


// ===================== TPMS library =====================
const TPMS = {
  gyroid:  'sin(x)*cos(y) + sin(y)*cos(z) + sin(z)*cos(x)',
  diamond: 'sin(x)*sin(y)*sin(z) + sin(x)*cos(y)*cos(z) + cos(x)*sin(y)*cos(z) + cos(x)*cos(y)*sin(z)',
  neovius: '3*(cos(x) + cos(y) + cos(z)) + 4*cos(x)*cos(y)*cos(z)',
  schwarzp:'cos(x) + cos(y) + cos(z)',
  lidinoid:'0.5*(sin(2*x)*cos(y)*sin(z) + sin(2*y)*cos(z)*sin(x) + sin(2*z)*cos(x)*sin(y)) - 0.5*(cos(2*x)*cos(2*y) + cos(2*y)*cos(2*z) + cos(2*z)*cos(2*x)) + 0.15',
  fischerkoch:'cos(2*x)*sin(y)*cos(z) + cos(x)*cos(2*y)*sin(z) + sin(x)*cos(y)*cos(2*z)',
  iwp:     '2*(cos(x)*cos(y) + cos(y)*cos(z) + cos(z)*cos(x)) - (cos(2*x) + cos(2*y) + cos(2*z))',
};
const ALLOWED = new Set(['x','y','z','sin','cos','tan','abs','sqrt','exp','log','pow','min','max','pi','PI','floor','sign','atan','asin','acos','sinh','cosh','tanh']);
function compileExpr(src) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('Formula is empty.');
  if (src.length > 600) throw new Error('Formula is too long.');
  if (/[^0-9a-zA-Z_+\-*/^().,\s]/.test(src)) throw new Error('Only numbers, x y z, + - * / ^ ( ) and math functions are allowed.');
  const ids = src.match(/[a-zA-Z_]\w*/g) || [];
  for (const id of ids) if (!ALLOWED.has(id)) throw new Error(`Unknown name "${id}".`);
  const body = src.replace(/\^/g, '**').replace(/(^|[(,+\-*/]\s*)-\s*([a-zA-Z_]\w*|\d*\.?\d+)\s*\*\*/g, '$1-1*$2**');
  let fn;
  try {
    fn = new Function('x', 'y', 'z', `const {sin,cos,tan,abs,sqrt,exp,log,pow,min,max,floor,sign,atan,asin,acos,sinh,cosh,tanh}=Math;const pi=Math.PI,PI=Math.PI;return (${body});`);
  } catch (e) { throw new Error('Syntax error in formula.'); }
  // sample: must be finite and must change sign (otherwise there is no surface)
  let neg = 0, pos = 0, s = 12345;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 * Math.PI;
  for (let i = 0; i < 400; i++) {
    const v = fn(rnd(), rnd(), rnd());
    if (typeof v !== 'number' || !isFinite(v)) throw new Error('Formula gives non-numeric or infinite values.');
    if (v < 0) neg++; else pos++;
  }
  if (!neg || !pos) throw new Error('Formula never crosses zero, so it has no surface.');
  // normalize so |grad| ~ 1 near the surface (field value then ~ distance in radians)
  let gs = 0, gn = 0; const h = 1e-3;
  for (let i = 0; i < 3000 && gn < 300; i++) {
    const x = rnd(), y = rnd(), z = rnd(), v = fn(x, y, z);
    const gx = (fn(x + h, y, z) - v) / h, gy = (fn(x, y + h, z) - v) / h, gz = (fn(x, y, z + h) - v) / h;
    const g = Math.hypot(gx, gy, gz);
    if (isFinite(g) && g > 1e-6 && Math.abs(v) < 0.25 * g) { gs += g; gn++; }
  }
  const norm = gn ? gn / gs : 1;
  const out = (x, y, z) => fn(x, y, z) * norm;
  out.norm = norm;
  return out;
}

// Translate a whitelisted formula into a GLSL expression (for the ray-marched preview).
function exprGLSL(src) {
  compileExpr(src); // validates
  const toks = src.match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-zA-Z_]\w*|[-+*/^(),]/gi) || [];
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const num = (t) => (/[.e]/i.test(t) ? t : t + '.0');
  function primary() {
    const t = next();
    if (t === undefined) throw new Error('Syntax error in formula.');
    if (t === '(') { const e = add(); next(); return `(${e})`; }
    if (t === '-') return `(-${power()})`;
    if (t === '+') return power();
    if (/^[\d.]/.test(t)) return num(t);
    if (t === 'pi' || t === 'PI') return '3.14159265359';
    if (/^[xyz]$/.test(t)) return t;
    next(); // '('
    const args = [add()];
    while (peek() === ',') { next(); args.push(add()); }
    next(); // ')'
    return `${t === 'pow' ? 'pw' : t}(${args.join(',')})`;
  }
  function power() { const b = primary(); if (peek() === '^') { next(); return `pw(${b},${unary()})`; } return b; }
  function unary() { if (peek() === '-') { next(); return `(-${unary()})`; } return power(); }
  function mul() { let a = unary(); while (peek() === '*' || peek() === '/') { const o = next(); a = `(${a}${o}${unary()})`; } return a; }
  function add() { let a = mul(); while (peek() === '+' || peek() === '-') { const o = next(); a = `(${a}${o}${mul()})`; } return a; }
  return add();
}

// ===================== jewelry field (mm, Z up, front = +Y) =====================
function interp(A, s, closed) {
  const n = A.length;
  if (!n) return 0;
  let t, i;
  if (closed) { t = (((s % 1) + 1) % 1) * n; i = Math.floor(t); }
  else { t = Math.min(Math.max(s, 0), 1) * (n - 1); i = Math.min(Math.floor(t), n - 2); }
  const f = t - i;
  const g = (k) => closed ? A[((k % n) + n) % n] : A[Math.min(Math.max(k, 0), n - 1)];
  const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
  return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
}

// ===================== pattern warp (pattern map) =====================
// Map coords: s = 0..1 along the band (0.5 = front), v = 0..1 across it (1 = top edge).
// Two warps are applied to where the TPMS lattice is sampled:
//  1. frame grid: P.gx x 3 control nodes; node offsets (P.goff, in s / v units) are blended with
//     Catmull-Rom splines, and the lattice under a node moves with it (q = p - G(p));
//  2. attractors (P.att: {u, v, r mm, s}): radial warp q = p + s*(p - a)*exp(-|p - a|^2 / r^2),
//     so at the centre the cells are (1 + s) times smaller; s < 0 makes them bigger.
// sig = largest stretch of the whole map (mm per mm). Dividing the cell size by it keeps the
// distance field honest, so walls keep their thickness where the cells get denser.
const GRID_ROWS = 3;
function makeWarp(P, closed, L, Wn) {
  const att = (P.att || []).slice(0, 8), G = P.goff, gx = P.gx || 0, GY = GRID_ROWS;
  const hasG = !!(G && gx && G.some((x) => x !== 0));
  if (!att.length && !hasG) return null;
  const out = { s: 0, v: 0, sig: 1 };
  const ws = [0, 0, 0, 0], dws = [0, 0, 0, 0], wv = [0, 0, 0, 0], dwv = [0, 0, 0, 0];
  const cw = (f, w, dw) => {
    const f2 = f * f, f3 = f2 * f;
    w[0] = 0.5 * (-f + 2 * f2 - f3); w[1] = 0.5 * (2 - 5 * f2 + 3 * f3); w[2] = 0.5 * (f + 4 * f2 - 3 * f3); w[3] = 0.5 * (-f2 + f3);
    dw[0] = 0.5 * (-1 + 4 * f - 3 * f2); dw[1] = 0.5 * (-10 * f + 9 * f2); dw[2] = 0.5 * (1 + 8 * f - 9 * f2); dw[3] = 0.5 * (-2 * f + 3 * f2);
  };
  const ns = closed ? gx : gx - 1;
  return (s, v) => {
    let a = 1, b = 0, c = 0, d = 1, s1 = s, v1 = v;
    if (hasG) {
      const ts = closed ? (((s % 1) + 1) % 1) * ns : Math.min(Math.max(s, 0), 1) * ns;
      let i = Math.floor(ts); if (!closed) i = Math.min(i, gx - 2);
      const tv = Math.min(Math.max(v, 0), 1) * (GY - 1), j = Math.min(Math.floor(tv), GY - 2);
      cw(ts - i, ws, dws); cw(tv - j, wv, dwv);
      let gs = 0, gv = 0, gss = 0, gsv = 0, gvs = 0, gvv = 0;
      for (let q = 0; q < 4; q++) {
        let ii = i - 1 + q;
        ii = closed ? (ii < 0 ? ii + gx : ii >= gx ? ii - gx : ii) : Math.min(Math.max(ii, 0), gx - 1);
        for (let r = 0; r < 4; r++) {
          const jj = Math.min(Math.max(j - 1 + r, 0), GY - 1), k = 2 * (jj * gx + ii), ou = G[k], ov = G[k + 1];
          const w = ws[q] * wv[r], wS = dws[q] * wv[r], wV = ws[q] * dwv[r];
          gs += w * ou; gv += w * ov; gss += wS * ou; gsv += wV * ou; gvs += wS * ov; gvv += wV * ov;
        }
      }
      gss *= ns; gvs *= ns; gsv *= GY - 1; gvv *= GY - 1;
      s1 = s - gs; v1 = v - gv;
      a = 1 - gss; b = -gsv * L / Wn; c = -gvs * Wn / L; d = 1 - gvv;
    }
    const X = s1 * L, Y = v1 * Wn;
    let dX = 0, dY = 0, jxx = 0, jxy = 0, jyy = 0;
    for (const t of att) {
      let dx = X - t.u * L; if (closed) dx -= L * Math.round(dx / L);
      const dy = Y - t.v * Wn, r2 = t.r * t.r, q = (dx * dx + dy * dy) / r2;
      if (q > 9) continue;
      const g = t.s * Math.exp(-q);
      dX += g * dx; dY += g * dy;
      jxx += g * (1 - 2 * dx * dx / r2); jxy -= g * 2 * dx * dy / r2; jyy += g * (1 - 2 * dy * dy / r2);
    }
    const A = 1 + jxx, D = 1 + jyy;
    const m00 = A * a + jxy * c, m01 = A * b + jxy * d, m10 = jxy * a + D * c, m11 = jxy * b + D * d;
    const e = m00 * m00 + m01 * m01 + m10 * m10 + m11 * m11, det = m00 * m11 - m01 * m10;
    out.s = (X + dX) / L; out.v = (Y + dY) / Wn;
    out.sig = Math.max(Math.sqrt((e + Math.sqrt(Math.max(e * e - 4 * det * det, 0))) / 2), 0.05);
    return out;
  };
}

function makeField(P) {
  const F = compileExpr(P.kind === 'custom' ? P.expr : TPMS[P.kind] || TPMS.gyroid);
  const TAU = 2 * Math.PI;
  const tpmsDist = (u, v, w, cmin) => {
    const f = F(TAU * u, TAU * v, TAU * w);
    return P.mode === 'strut' ? (f - P.iso) * cmin / TAU : Math.abs(f) * cmin / TAU - P.thick / 2;
  };
  if (P.cat === 'earring') {
    const a = P.D / 2, c = a * P.elong, cell = P.D / Math.max(P.nU, 1);
    const Rl = 1.6, wire = 0.9, zl = Rl + wire * 0.2;
    // French ear hook (0.8 mm wire): stem up from the loop, arc over the top (this passes
    // through the lobe, front to back), then a 6 mm tail hanging behind
    const zs = zl + Rl - 0.2, z0 = zl + Rl + 9, Rh = 3, hw = 0.4;
    const bb = { lo: [-a - 1, Math.min(-a - 1, -2 * Rh - 1.5), -2 * c - 1], hi: [a + 1, a + 1, z0 + Rh + 1.5] };
    const f = (x, y, z) => {
      const px = x / a, py = y / a, pz = (z + c) / c;
      const k0 = Math.hypot(px, py, pz), k1 = Math.hypot(px / a, py / a, pz / c) || 1e-9;
      const d = k0 * (k0 - 1) / k1;
      let s = Math.max(d, tpmsDist(x / cell, y / cell, z / cell, cell));
      if (P.rim > 0) s = Math.min(s, Math.max(d, -(d + P.rim)));
      const loop = Math.hypot(Math.hypot(y, z - zl) - Rl, x) - wire / 2;
      const d1 = Math.hypot(y, z - Math.min(Math.max(z, zs), z0));
      const d3 = Math.hypot(y + 2 * Rh, z - Math.min(Math.max(z, z0 - 6), z0));
      const da = z > z0 ? Math.abs(Math.hypot(y + Rh, z - z0) - Rh) : 1e3;
      const hook = Math.hypot(Math.min(d1, d3, da), x) - hw;
      return Math.min(s, loop, hook);
    };
    return { f, bb };
  }
  const closed = P.cat !== 'tiara' && P.cat !== 'choker';
  const T = P.T, Rmid = P.rin + T / 2, span = closed ? TAU : P.span * Math.PI / 180;
  const tanT = Math.tan((P.tilt || 0) * Math.PI / 180);
  // cells are roughly cubic (depth = mean of around/across size, scaled by nW), so a thin band
  // slices through the lattice and stays see-through instead of packing a whole cell into T
  const cu = span * Rmid / P.nU, cw = (cu + P.W / P.nV) / 2 / (P.nW || 1);
  // z extents
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const s = i / 200;
    zmax = Math.max(zmax, P.W / 2 + interp(P.top, s, closed));
    zmin = Math.min(zmin, -P.W / 2 + interp(P.bot, s, closed));
  }
  const tz = Math.abs(tanT) * T / 2, Ro = P.rin + T + 1;
  // tiara: bound only the arc |th| <= span/2 (point = (-r sin th, r cos th))
  const hs = span / 2, xr = closed ? Ro : Ro * Math.sin(Math.min(hs, Math.PI / 2)) + 1;
  const ylo = closed ? -Ro : (Math.cos(hs) < 0 ? Ro * Math.cos(hs) : P.rin * Math.cos(hs)) - 1;
  const bb = { lo: [-xr, ylo, zmin - tz - 1], hi: [xr, Ro, zmax + tz + 1] };
  const warp = makeWarp(P, closed, span * Rmid, P.W);
  const f = (x, y, z) => {
    const r = Math.hypot(x, y);
    let th = Math.atan2(y, x) - Math.PI / 2; // 0 at front (+Y)
    if (th <= -Math.PI) th += TAU; if (th > Math.PI) th -= TAU;
    const s = closed ? (th + Math.PI) / TAU : th / span + 0.5;
    const w = r - Rmid;
    const zz = z - w * tanT;
    const top = P.W / 2 + interp(P.top, s, closed), bot = -P.W / 2 + interp(P.bot, s, closed);
    const h = Math.max((top - bot) / 2, 0.05), zc = (top + bot) / 2;
    const rr = (P.round || 0) * Math.min(T / 2, h) * 0.98;
    const qx = Math.abs(w) - T / 2 + rr, qz = Math.abs(zz - zc) - h + rr;
    let d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - rr;
    if (!closed) d = Math.max(d, (Math.abs(th) - span / 2) * Math.max(r, 1));
    const cv = 2 * h / P.nV;
    let cmin = Math.min(cu * r / Rmid, cv, cw), su = s, vq = (zz - zc) / (2 * h) + 0.5;
    if (warp) { const q = warp(s, vq); su = q.s; vq = q.v; cmin /= q.sig; }
    const U = su * P.nU, V = (vq - 0.5) * P.nV + (P.twist || 0) * su, W = w / cw;
    let t = tpmsDist(U, V, W, cmin);
    // seamless closed band: near the back seam (s -> 1) blend into the copy of the lattice that
    // continues past s = 0 (shifted by one full turn). For a 2*pi-periodic TPMS both are equal,
    // for any other formula / warp this forces the two sides of the seam to meet.
    if (closed) {
      const bw = Math.min(0.5, 1 / Math.max(P.nU, 1)), k = (s - (1 - bw)) / bw;
      if (k > 0) {
        const b = k * k * (3 - 2 * k);
        t = (1 - b) * t + b * tpmsDist(U - P.nU, V - (P.twist || 0), W, cmin);
      }
    }
    let out = Math.max(d, t);
    if (P.rim > 0) out = Math.min(out, Math.max(d, Math.min(zz - bot, top - zz) - P.rim));
    return out;
  };
  return { f, bb };
}

// ===================== marching cubes on the field =====================
function meshField(field, voxel, onProgress) {
  const { f, bb } = field;
  const lo = bb.lo.map((v) => v - voxel), hi = bb.hi.map((v) => v + voxel);
  const nx = Math.ceil((hi[0] - lo[0]) / voxel) + 1, ny = Math.ceil((hi[1] - lo[1]) / voxel) + 1, nz = Math.ceil((hi[2] - lo[2]) / voxel) + 1;
  if (nx * ny * nz > 1.2e8) throw new Error('Resolution too fine for this size. Pick a coarser mesh resolution.');
  const NP = nx * ny;
  const plane = (iz, out) => {
    const z = lo[2] + iz * voxel;
    for (let j = 0; j < ny; j++) {
      const y = lo[1] + j * voxel;
      for (let i = 0; i < nx; i++) {
        let v = (i === 0 || j === 0 || iz === 0 || i === nx - 1 || j === ny - 1 || iz === nz - 1) ? voxel : f(lo[0] + i * voxel, y, z);
        if (v === 0) v = 1e-7;
        out[j * nx + i] = v;
      }
    }
  };
  let pos = new Float32Array(1 << 18), np = 0, idx = new Uint32Array(1 << 19), ni = 0;
  const pushV = (x, y, z) => { if (np + 3 > pos.length) { const n = new Float32Array(pos.length * 2); n.set(pos); pos = n; } pos[np++] = x; pos[np++] = y; pos[np++] = z; return np / 3 - 1; };
  const pushT = (a, b, c) => { if (ni + 3 > idx.length) { const n = new Uint32Array(idx.length * 2); n.set(idx); idx = n; } idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; };
  let F0 = new Float32Array(NP), F1 = new Float32Array(NP);
  let EX0 = new Int32Array(NP).fill(-1), EY0 = new Int32Array(NP).fill(-1), EX1 = new Int32Array(NP).fill(-1), EY1 = new Int32Array(NP).fill(-1);
  const EZ = new Int32Array(NP);
  const { EDGES, TRI } = MC;
  const EINFO = EDGES.map(([a, b]) => ({ axis: (a ^ b) === 1 ? 0 : (a ^ b) === 2 ? 1 : 2, dx: a & 1, dy: (a >> 1) & 1, dz: (a >> 2) & 1, a, b }));
  const cv = new Float32Array(8), ev = new Int32Array(12).fill(-1);
  plane(0, F0);
  for (let iz = 0; iz < nz - 1; iz++) {
    plane(iz + 1, F1); EZ.fill(-1);
    const z0 = lo[2] + iz * voxel;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const b = j * nx + i;
      cv[0] = F0[b]; cv[1] = F0[b + 1]; cv[2] = F0[b + nx]; cv[3] = F0[b + nx + 1];
      cv[4] = F1[b]; cv[5] = F1[b + 1]; cv[6] = F1[b + nx]; cv[7] = F1[b + nx + 1];
      let m = 0; for (let c = 0; c < 8; c++) if (cv[c] < 0) m |= 1 << c;
      if (m === 0 || m === 255) continue;
      const tri = TRI[m];
      for (let q = 0; q < tri.length; q++) {
        const e = tri[q]; if (ev[e] !== -1) continue;
        const inf = EINFO[e], gi = b + inf.dx + inf.dy * nx, top = inf.dz === 1;
        const store = inf.axis === 0 ? (top ? EX1 : EX0) : inf.axis === 1 ? (top ? EY1 : EY0) : EZ;
        let id = store[gi];
        if (id < 0) {
          const fa = cv[inf.a], fb = cv[inf.b], t = fa / (fa - fb);
          const x = lo[0] + (i + inf.dx) * voxel, y = lo[1] + (j + inf.dy) * voxel, z = z0 + inf.dz * voxel;
          id = inf.axis === 0 ? pushV(x + t * voxel, y, z) : inf.axis === 1 ? pushV(x, y + t * voxel, z) : pushV(x, y, z + t * voxel);
          store[gi] = id;
        }
        ev[e] = id;
      }
      for (let q = 0; q < tri.length; q += 3) { const a = ev[tri[q]], bb2 = ev[tri[q + 1]], c = ev[tri[q + 2]]; if (a !== bb2 && bb2 !== c && a !== c) pushT(a, bb2, c); }
      for (let q = 0; q < tri.length; q++) ev[tri[q]] = -1;
    }
    let t = F0; F0 = F1; F1 = t;
    t = EX0; EX0 = EX1; EX1 = t; EX1.fill(-1);
    t = EY0; EY0 = EY1; EY1 = t; EY1.fill(-1);
    if (onProgress && (iz & 3) === 0) onProgress((iz + 1) / (nz - 1));
  }
  return { positions: pos.slice(0, np), indices: idx.slice(0, ni) };
}
function meshVolume(pos, idx) {
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t], b = 3 * idx[t + 1], c = 3 * idx[t + 2];
    vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return vol / 6;
}

// Drop small floating islands (cut-off cell fragments) that cannot be cast or printed.
// Keeps every connected component with at least `keepFrac` of the largest one's triangles.
function removeIslands(positions, indices, keepFrac = 0.05) {
  const nv = positions.length / 3, par = new Int32Array(nv);
  for (let i = 0; i < nv; i++) par[i] = i;
  const find = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]), b = find(indices[t + 1]), c = find(indices[t + 2]);
    par[a] = b; par[find(b)] = find(c);
  }
  const cnt = new Map();
  for (let t = 0; t < indices.length; t += 3) { const k = find(indices[t]); cnt.set(k, (cnt.get(k) || 0) + 1); }
  let big = 0; for (const v of cnt.values()) big = Math.max(big, v);
  const keep = (k) => cnt.get(k) >= keepFrac * big;
  let nt = 0; for (let t = 0; t < indices.length; t += 3) if (keep(find(indices[t]))) nt++;
  if (nt * 3 === indices.length) return { positions, indices, islands: 0 };
  const remap = new Int32Array(nv).fill(-1), outI = new Uint32Array(nt * 3), outP = [];
  let o = 0, n = 0;
  for (let t = 0; t < indices.length; t += 3) {
    if (!keep(find(indices[t]))) continue;
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k];
      if (remap[v] < 0) { remap[v] = n++; outP.push(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]); }
      outI[o++] = remap[v];
    }
  }
  let islands = 0; for (const k of cnt.keys()) if (!keep(k)) islands++;
  return { positions: new Float32Array(outP), indices: outI, islands };
}

if (typeof module !== 'undefined') module.exports = { TPMS, compileExpr, exprGLSL, makeField, makeWarp, GRID_ROWS, meshField, simplifyMesh, meshVolume, removeIslands, MC };
if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof module === 'undefined') {
  self.onmessage = (e) => {
    const m = e.data;
    try {
      if (m.type === 'check') { compileExpr(m.expr); self.postMessage({ type: 'check', id: m.id, ok: true }); return; }
      const field = makeField(m.params);
      const prog = (f, label) => self.postMessage({ type: 'progress', id: m.id, f, label });
      const simp = m.simplify > 0;
      let r = meshField(field, m.voxel, (f) => prog(f * (simp ? 0.7 : 1), 'Meshing...'));
      const isl = m.islands === false ? { islands: 0 } : (r = removeIslands(r.positions, r.indices));
      if (simp) r = simplifyMesh(r.positions, r.indices, m.simplify, (f) => prog(0.7 + 0.3 * f, 'Simplifying...'));
      const vol = meshVolume(r.positions, r.indices);
      self.postMessage({ type: 'mesh', id: m.id, final: m.final, positions: r.positions, indices: r.indices, volume: vol, islands: isl.islands }, [r.positions.buffer, r.indices.buffer]);
    } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err.message || err) }); }
  };
}
