// Implicit-body preview (GPU ray marching of the same field as worker.js makeField)
// and simple black mannequin parts that show where each piece is worn.
// All coordinates are the piece's own: millimetres, Z up, front = +Y.
import * as THREE from 'three';

const FRAG_HEAD = `
precision highp float;
uniform mat4 uInvModel, uModel, uProj; uniform vec3 uLo, uHi, uColor;
uniform int uCat, uMode, uN; uniform bool uClosed;
uniform float uNorm, uIso, uThick, uRim, uNU, uNV, uTwist, uRin, uT, uW, uRound, uTanT, uSpan, uCu, uCw, uD, uElong, uMetal;
uniform float uTop[33];
uniform int uGx, uNA; uniform float uL, uWn; uniform float uGo[96]; uniform vec4 uAtt[8];
uniform int uShape; uniform bool uTwo; uniform vec3 uBodyCol; // earring shape 0 ellipsoid 1 box (top face) 2 box (corner); two-material view
float gEnv; // envelope distance of the last field() call
varying vec3 vLocal;
const float PI = 3.14159265359, TAU = 6.28318530718;
float pw(float a, float b) { return (b == floor(b) && mod(b, 2.0) == 0.0) ? pow(abs(a), b) : sign(a) * pow(abs(a), b); }
`;
const FRAG_BODY = `
float tpd(float u, float v, float w, float cm) {
  float f = tp(TAU * u, TAU * v, TAU * w) * uNorm;
  return uMode == 1 ? (f - uIso) * cm / TAU : abs(f - uIso) * cm / TAU - uThick * 0.5;
}
float gT(int k) { int n = uN; k = uClosed ? ((k % n) + n) % n : clamp(k, 0, n - 1); return uTop[k]; }
// pattern-map warp, same as worker.js makeWarp: returns (s, v, stretch)
void cw4(float f, out vec4 w, out vec4 dw) {
  float f2 = f * f, f3 = f2 * f;
  w = 0.5 * vec4(-f + 2.0 * f2 - f3, 2.0 - 5.0 * f2 + 3.0 * f3, f + 4.0 * f2 - 3.0 * f3, -f2 + f3);
  dw = 0.5 * vec4(-1.0 + 4.0 * f - 3.0 * f2, -10.0 * f + 9.0 * f2, 1.0 + 8.0 * f - 9.0 * f2, -2.0 * f + 3.0 * f2);
}
vec3 warp(float s, float v) {
  float a = 1.0, b = 0.0, c = 0.0, d = 1.0, s1 = s, v1 = v;
  if (uGx > 0) {
    int gx = uGx; float ns = uClosed ? float(gx) : float(gx - 1);
    float ts = uClosed ? fract(s) * ns : clamp(s, 0.0, 1.0) * ns;
    int i = int(floor(ts)); if (!uClosed) i = min(i, gx - 2);
    float tv = clamp(v, 0.0, 1.0) * 2.0; int j = min(int(floor(tv)), 1);
    vec4 ws, dws, wv, dwv; cw4(ts - float(i), ws, dws); cw4(tv - float(j), wv, dwv);
    float gs = 0.0, gv = 0.0, gss = 0.0, gsv = 0.0, gvs = 0.0, gvv = 0.0;
    for (int q = 0; q < 4; q++) {
      int ii = i - 1 + q;
      ii = uClosed ? (ii < 0 ? ii + gx : (ii >= gx ? ii - gx : ii)) : clamp(ii, 0, gx - 1);
      for (int r = 0; r < 4; r++) {
        int jj = clamp(j - 1 + r, 0, 2), k = 2 * (jj * gx + ii);
        float ou = uGo[k], ov = uGo[k + 1], w = ws[q] * wv[r], wS = dws[q] * wv[r], wV = ws[q] * dwv[r];
        gs += w * ou; gv += w * ov; gss += wS * ou; gsv += wV * ou; gvs += wS * ov; gvv += wV * ov;
      }
    }
    gss *= ns; gvs *= ns; gsv *= 2.0; gvv *= 2.0;
    s1 = s - gs; v1 = v - gv;
    a = 1.0 - gss; b = -gsv * uL / uWn; c = -gvs * uWn / uL; d = 1.0 - gvv;
  }
  float X = s1 * uL, Y = v1 * uWn, dX = 0.0, dY = 0.0, jxx = 0.0, jxy = 0.0, jyy = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= uNA) break;
    vec4 t = uAtt[k];
    float dx = X - t.x * uL; if (uClosed) dx -= uL * floor(dx / uL + 0.5);
    float dy = Y - t.y * uWn, r2 = t.z * t.z, q = (dx * dx + dy * dy) / r2;
    if (q > 9.0) continue;
    float g = t.w * exp(-q);
    dX += g * dx; dY += g * dy;
    jxx += g * (1.0 - 2.0 * dx * dx / r2); jxy -= g * 2.0 * dx * dy / r2; jyy += g * (1.0 - 2.0 * dy * dy / r2);
  }
  float A = 1.0 + jxx, D = 1.0 + jyy;
  float m00 = A * a + jxy * c, m01 = A * b + jxy * d, m10 = jxy * a + D * c, m11 = jxy * b + D * d;
  float e = m00 * m00 + m01 * m01 + m10 * m10 + m11 * m11, dt = m00 * m11 - m01 * m10;
  return vec3((X + dX) / uL, (Y + dY) / uWn, max(sqrt((e + sqrt(max(e * e - 4.0 * dt * dt, 0.0))) * 0.5), 0.05));
}
float prof(float s) {
  float n = float(uN), t; int i;
  if (uClosed) { t = fract(s) * n; i = int(floor(t)); }
  else { t = clamp(s, 0.0, 1.0) * (n - 1.0); i = min(int(floor(t)), uN - 2); }
  float f = t - float(i), p0 = gT(i - 1), p1 = gT(i), p2 = gT(i + 1), p3 = gT(i + 2);
  return 0.5 * (2.0 * p1 + (-p0 + p2) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f * f + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * f * f * f);
}
float field(vec3 p) {
  if (uCat == 3) {
    float a = uD * 0.5, c = a * uElong, cell = uD / max(uNU, 1.0), Rl = 1.6, wr = 0.9, zl = Rl + wr * 0.2;
    // body frame, same as worker.js: l = point relative to the body centre, local z up
    vec3 l = vec3(p.x, p.y, p.z + c);
    float rr = uShape > 0 ? min(0.6, 0.15 * min(a, c)) : 0.0;
    if (uShape == 2) { // hang from a corner: body diagonal (a, a, c) points straight up
      float n = length(vec3(a, a, c)), r2 = sqrt(2.0);
      vec3 e1 = vec3(1.0 / r2, -1.0 / r2, 0.0), e2 = vec3(c, c, -2.0 * a) / (n * r2), e3 = vec3(a, a, c) / n;
      float nz = dot(e3, vec3(a - rr, a - rr, c - rr)) + rr;
      l = p.x * e1 + p.y * e2 + (p.z + nz) * e3;
    }
    float d;
    if (uShape > 0) { vec3 qb = abs(l) - vec3(a, a, c) + rr; d = length(max(qb, 0.0)) + min(max(qb.x, max(qb.y, qb.z)), 0.0) - rr; }
    else {
      vec3 q = vec3(l.x / a, l.y / a, l.z / c);
      float k0 = length(q), k1 = max(length(vec3(q.x / a, q.y / a, q.z / c)), 1e-9);
      d = k0 * (k0 - 1.0) / k1;
    }
    gEnv = d;
    float X = l.x, Z = l.z - c, cme = cell; // pattern map on the front view, same as worker.js
    if (uGx > 0 || uNA > 0) { vec3 w3 = warp((l.x + a) / (2.0 * a), (l.z + c) / (2.0 * c)); X = w3.x * 2.0 * a - a; Z = w3.y * 2.0 * c - 2.0 * c; cme = cell / w3.z; }
    float s = max(d, tpd(X / cell, l.y / cell, Z / cell, cme));
    if (uRim > 0.0) s = min(s, max(d, -(d + uRim)));
    s = min(s, max(d, length(p) - max(1.3, 0.25 * cell))); // solid bail: the pattern always reaches the hook
    float lp = length(vec2(length(vec2(p.y, p.z - zl)) - Rl, p.x)) - wr * 0.5;
    float zs = zl + Rl - 0.2, z0 = zl + Rl + 9.0, Rh = 3.0; // ear hook, same as worker.js
    float d1 = length(vec2(p.y, p.z - clamp(p.z, zs, z0)));
    float d3 = length(vec2(p.y + 2.0 * Rh, p.z - clamp(p.z, z0 - 6.0, z0)));
    float da = p.z > z0 ? abs(length(vec2(p.y + Rh, p.z - z0)) - Rh) : 1e3;
    float hk = length(vec2(min(min(d1, d3), da), p.x)) - 0.4;
    return min(min(s, lp), hk);
  }
  float r = length(p.xy), Rmid = uRin + uT * 0.5;
  float th = atan(p.y, p.x) - PI * 0.5;
  if (th <= -PI) th += TAU; if (th > PI) th -= TAU;
  float s = uClosed ? (th + PI) / TAU : th / uSpan + 0.5;
  float w = r - Rmid, zz = p.z - w * uTanT;
  float top = uW * 0.5 + prof(s), bot = -uW * 0.5;
  float h = max((top - bot) * 0.5, 0.05), zc = (top + bot) * 0.5;
  float rr = uRound * min(uT * 0.5, h) * 0.98;
  float qx = abs(w) - uT * 0.5 + rr, qz = abs(zz - zc) - h + rr;
  float d = length(max(vec2(qx, qz), 0.0)) + min(max(qx, qz), 0.0) - rr;
  if (!uClosed) d = max(d, (abs(th) - uSpan * 0.5) * max(r, 1.0));
  gEnv = d;
  float cm = min(min(uCu * r / Rmid, 2.0 * h / uNV), uCw);
  float su = s, vq = (zz - zc) / (2.0 * h) + 0.5;
  if (uGx > 0 || uNA > 0) { vec3 q = warp(s, vq); su = q.x; vq = q.y; cm /= q.z; }
  float U = su * uNU, V = (vq - 0.5) * uNV + uTwist * su, W = w / uCw;
  float tt = tpd(U, V, W, cm);
  if (uClosed) { // seamless closed band, same blend as worker.js
    float bw = min(0.5, 1.0 / max(uNU, 1.0)), k = (s - (1.0 - bw)) / bw;
    if (k > 0.0) { float b = smoothstep(0.0, 1.0, k); tt = mix(tt, tpd(U - uNU, V - uTwist, W, cm), b); }
  }
  float o = max(d, tt);
  if (uRim > 0.0) o = min(o, max(d, min(zz - bot, top - zz) - uRim));
  return o;
}
vec3 envc(vec3 r) { // soft studio: bright top, dark floor, two light strips
  float y = r.z;
  vec3 c = mix(vec3(0.06), vec3(0.95), smoothstep(-0.35, 0.9, y));
  c += vec3(1.4) * smoothstep(0.86, 0.97, abs(normalize(r.xy + 1e-5).x)) * smoothstep(-0.2, 0.4, y);
  return c;
}
void main() {
  vec3 ro = (uInvModel * vec4(cameraPosition, 1.0)).xyz, rd = normalize(vLocal - ro);
  vec3 t0 = (uLo - ro) / rd, t1 = (uHi - ro) / rd, tn = min(t0, t1), tf = max(t0, t1);
  float tN = max(max(max(tn.x, tn.y), tn.z), 0.0), tF = min(min(tf.x, tf.y), tf.z);
  if (tN >= tF) discard;
  float t = tN, d = 1.0; bool hit = false;
  for (int i = 0; i < 384; i++) {
    d = field(ro + rd * t);
    float eps = max(0.004, 0.0006 * t);
    if (d < eps) { hit = true; break; }
    t += max(d * 0.7, eps * 0.5);
    if (t > tF) break;
  }
  // two-material view: clear resin envelope around the coloured pattern (front surface only)
  float tg = tN; bool gHit = false;
  if (uTwo) {
    float tl = hit ? t : tF;
    for (int i = 0; i < 160; i++) {
      field(ro + rd * tg); float de = gEnv, eps = max(0.004, 0.0006 * tg);
      if (de < eps) { gHit = true; break; }
      tg += max(de * 0.8, eps * 0.5);
      if (tg > tl) break;
    }
  }
  if (!hit && !gHit) discard;
  vec3 col = vec3(0.0); vec3 p = ro + rd * t;
  vec3 v = -rd, L = normalize(vec3(0.5, 0.6, 0.8));
  const vec2 k = vec2(1.0, -1.0); float e = 0.01;
  if (hit) {
    vec3 n = normalize(k.xyy * field(p + k.xyy * e) + k.yyx * field(p + k.yyx * e) + k.yxy * field(p + k.yxy * e) + k.xxx * field(p + k.xxx * e));
    float ao = clamp(0.35 + field(p + n * 0.25) / 0.25 * 0.65, 0.25, 1.0);
    vec3 rf = reflect(rd, n);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
    vec3 F0 = mix(vec3(0.04), uColor, uMetal);
    vec3 spec = (F0 + (1.0 - F0) * fres) * envc(rf);
    float nl = max(dot(n, L), 0.0), sp = pow(max(dot(reflect(-L, n), v), 0.0), 60.0);
    col = spec * ao + (1.0 - uMetal) * uColor * (0.25 + 0.75 * nl) * ao + vec3(sp) * mix(0.3, 1.0, uMetal);
    col = col / (1.0 + col); // simple tone map
    col = pow(col, vec3(1.0 / 2.2));
  }
  float alpha = 1.0;
  if (gHit && (!hit || tg < t)) { // glass layer in front of the pattern (or of the background)
    vec3 pg = ro + rd * tg;
    field(pg + k.xyy * e); float a1 = gEnv; field(pg + k.yyx * e); float a2 = gEnv;
    field(pg + k.yxy * e); float a3 = gEnv; field(pg + k.xxx * e); float a4 = gEnv;
    vec3 ng = normalize(k.xyy * a1 + k.yyx * a2 + k.yxy * a3 + k.xxx * a4);
    float fr = 0.04 + 0.96 * pow(1.0 - max(dot(ng, v), 0.0), 5.0);
    vec3 refl = envc(reflect(rd, ng)); refl = pow(refl / (1.0 + refl), vec3(1.0 / 2.2));
    float sp = pow(max(dot(reflect(-L, ng), v), 0.0), 80.0);
    float ga = clamp(0.14 + 0.7 * fr, 0.0, 0.85); // haze of the resin + fresnel at grazing angles
    vec3 tint = uBodyCol;
    if (hit) { col = mix(col * mix(vec3(1.0), tint, 0.25), mix(tint, refl, fr), ga) + vec3(sp); }
    else { col = mix(tint, refl, fr) + vec3(sp); alpha = ga + sp; }
    if (!hit) p = pg;
  }
  gl_FragColor = vec4(min(col, vec3(1.0)), clamp(alpha, 0.0, 1.0));
  vec4 cp = uProj * viewMatrix * uModel * vec4(p, 1.0);
  gl_FragDepth = clamp(cp.z / cp.w * 0.5 + 0.5, 0.0, 1.0);
}`;
const VERT = `varying vec3 vLocal; void main() { vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export function makeImplicitView() {
  const U = {};
  for (const k of ['uNorm', 'uIso', 'uThick', 'uRim', 'uNU', 'uNV', 'uTwist', 'uRin', 'uT', 'uW', 'uRound', 'uTanT', 'uSpan', 'uCu', 'uCw', 'uD', 'uElong', 'uMetal']) U[k] = { value: 0 };
  Object.assign(U, { uInvModel: { value: new THREE.Matrix4() }, uModel: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() }, uLo: { value: new THREE.Vector3() }, uHi: { value: new THREE.Vector3() },
    uColor: { value: new THREE.Color() }, uCat: { value: 0 }, uMode: { value: 0 }, uN: { value: 32 }, uClosed: { value: true }, uTop: { value: new Array(33).fill(0) },
    uGx: { value: 0 }, uNA: { value: 0 }, uL: { value: 1 }, uWn: { value: 1 }, uGo: { value: new Array(96).fill(0) },
    uShape: { value: 0 }, uTwo: { value: false }, uBodyCol: { value: new THREE.Color(0xe8eef2) },
    uAtt: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) } });
  // placeholder material until the first update() compiles the shader
  // (a null material crashes three.js's render loop on `material.visible`)
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }));
  box.frustumCulled = false; box.visible = false;
  let glslKey = null;
  box.onBeforeRender = (renderer, scene, camera) => {
    U.uModel.value.copy(box.matrixWorld); U.uInvModel.value.copy(box.matrixWorld).invert();
    U.uProj.value.copy(camera.projectionMatrix);
  };
  function update(P, field, norm, glsl, colorHex, metallic, two) {
    if (glsl !== glslKey) {
      glslKey = glsl;
      if (box.material) box.material.dispose();
      box.material = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, side: THREE.BackSide, transparent: true,
        fragmentShader: FRAG_HEAD + `float tp(float x, float y, float z) { return ${glsl}; }\n` + FRAG_BODY });
    }
    // two = null or { color } of the clear body (two-material mode)
    U.uTwo.value = !!two; if (two) U.uBodyCol.value.setHex(two.color);
    U.uShape.value = P.cat === 'earring' && P.shape === 'box' ? (P.hang === 'corner' ? 2 : 1) : 0;
    const { lo, hi } = field.bb;
    // box geometry = bounding box (BoxGeometry is centred, so rebuild positions)
    const g = new THREE.BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    g.translate((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    box.geometry.dispose(); box.geometry = g;
    U.uLo.value.set(...lo); U.uHi.value.set(...hi);
    U.uCat.value = { ring: 0, bangle: 1, tiara: 2, earring: 3, choker: 2 }[P.cat];
    U.uMode.value = P.mode === 'strut' ? 1 : 0;
    U.uNorm.value = norm; U.uIso.value = P.iso; U.uThick.value = P.thick; U.uRim.value = P.rim;
    U.uNU.value = P.nU; U.uNV.value = P.nV; U.uTwist.value = P.twist;
    U.uColor.value.setHex(colorHex); U.uMetal.value = metallic ? 1 : 0;
    const setMap = (L, Wn) => { // pattern map (frame grid + attractors), see worker.js makeWarp
      U.uL.value = L; U.uWn.value = Wn;
      const G = P.goff, gx = P.gx || 0, hasG = !!(G && gx && G.some((x) => x !== 0));
      U.uGx.value = hasG ? gx : 0;
      for (let i = 0; i < 96; i++) U.uGo.value[i] = (hasG && G[i]) || 0;
      const att = (P.att || []).slice(0, 8); U.uNA.value = att.length;
      att.forEach((t, i) => U.uAtt.value[i].set(t.u, t.v, t.r, t.s));
    };
    if (P.cat === 'earring') { U.uD.value = P.D; U.uElong.value = P.elong; U.uClosed.value = false; setMap(P.D, P.D * P.elong); return; }
    const closed = P.cat !== 'tiara' && P.cat !== 'choker', span = closed ? 2 * Math.PI : P.span * Math.PI / 180, Rmid = P.rin + P.T / 2;
    U.uClosed.value = closed; U.uSpan.value = span; U.uRin.value = P.rin; U.uT.value = P.T; U.uW.value = P.W;
    U.uRound.value = P.round; U.uTanT.value = Math.tan(P.tilt * Math.PI / 180);
    U.uCu.value = span * Rmid / P.nU; U.uCw.value = (span * Rmid / P.nU + P.W / P.nV) / 2 / (P.nW || 1);
    U.uN.value = P.top.length; for (let i = 0; i < 33; i++) U.uTop.value[i] = P.top[i] || 0;
    setMap(span * Rmid, P.W);
  }
  return { object: box, update };
}

// ---------------- mannequin ----------------
const ell = (mat, sx, sy, sz, x, y, z) => { const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat); m.scale.set(sx, sy, sz); m.position.set(x, y, z); return m; };
const capZ = (mat, r, z0, z1, x = 0, y = 0) => { // capsule along Z from z0 to z1
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(z1 - z0 - 2 * r, 0.01), 12, 32), mat);
  m.rotation.x = Math.PI / 2; m.position.set(x, y, (z0 + z1) / 2); return m;
};
function bust(mat, cx, cy, cz) { // egg head + neck + shoulders, head centre at (cx, cy, cz)
  const g = new THREE.Group();
  g.add(ell(mat, 74, 92, 114, cx, cy, cz));
  g.add(ell(mat, 10, 14, 22, cx, cy + 90, cz - 15)); // nose
  g.add(ell(mat, 52, 58, 40, cx, cy + 22, cz - 72)); // jaw / chin
  g.add(capZ(mat, 50, cz - 230, cz - 60, cx, cy - 8));
  const pts = [[0, 0], [70, 5], [150, 25], [205, 60], [215, 110], [190, 260], [0, 270]].map(([r, h]) => new THREE.Vector2(r, -h));
  const sh = new THREE.Mesh(new THREE.LatheGeometry(pts, 64), mat);
  sh.rotation.x = Math.PI / 2; sh.scale.set(1, 1, 0.55); sh.position.set(cx, cy - 8, cz - 175);
  g.add(sh);
  return g;
}
// ---------------- scanned reference bodies ----------------
// Hand: "Hand and Forearm - Full.stl" (mm, fingers along +Z).
// Head: "young_woman_age_20-25_bald_head.glb" by nektarios81 (Sketchfab), CC-BY-4.0.
// Placements were fitted offline against the piece frame (mm, Z up, front +Y). The simple
// primitive mannequin is shown until the file has loaded, and stays if loading fails.
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const REF = './reference model/';
const HAND = 'Hand and Forearm - Full.stl', HEAD = 'young_woman_age_20-25_bald_head.glb';
const refCache = {};
// Earrings come in pairs: the head's mid-plane is at x = -71.3 + 3 = -68.3 in the earring frame
// (default ear offset included), so the mirrored copy for the right ear is the piece reflected
// in x and moved to x = 2 * -68.3.
export const EAR_PAIR_X = -136.6;
function loadRef(name) { // -> Promise<BufferGeometry[]>, loaded once and shared
  if (!refCache[name]) refCache[name] = new Promise((res, rej) => {
    const url = encodeURI(REF + name);
    if (name.endsWith('.stl')) new STLLoader().load(url, (geo) => res([geo]), undefined, rej);
    else new GLTFLoader().load(url, (gl) => {
      const out = []; gl.scene.updateMatrixWorld(true);
      gl.scene.traverse((o) => { if (o.isMesh) { const geo = o.geometry.clone(); geo.applyMatrix4(o.matrixWorld); out.push(geo); } });
      res(out);
    }, undefined, rej);
  });
  return refCache[name];
}
// hand: piece = k * (p - c), c = ring-finger base / wrist centre, scaled so the finger/wrist fits rin.
// head: raw (gx, gy, gz) -> piece (-gx, gz, gy) * k + t (face to +Y).
// ring finger in the scan is tilted ~38 deg from Z. Axis + base of the finger from a circle fit
// of the scan; finger radius there is ~8.8 mm (refit on circle centres, z = -5..25 mm past the base)
const RING_C = new THREE.Vector3(-15.5, 4.2, 590), RING_A = (() => { const tilt = -30 * Math.PI / 180, az = 20 * Math.PI / 180;
  return new THREE.Vector3(Math.sin(tilt) * Math.cos(az), Math.sin(tilt) * Math.sin(az), Math.cos(tilt)); })();
// Other fingers: the ring-finger placement above carried onto each finger's own axis (axes from
// centre-line fits of the scan). s = finger radius there relative to the ring finger.
const FINGERS = {
  ring: { c: RING_C, a: RING_A, s: 1 },
  thumb: { c: new THREE.Vector3(35, 63, 565), a: (() => { const t = -38*Math.PI/180, z = -36*Math.PI/180; return new THREE.Vector3(Math.sin(t)*Math.cos(z), Math.sin(t)*Math.sin(z), Math.cos(t)); })(), s: 1.05 },
  index: { c: new THREE.Vector3(-9.7, 46, 590), a: (() => { const t = -35*Math.PI/180, z = -20*Math.PI/180; return new THREE.Vector3(Math.sin(t)*Math.cos(z), Math.sin(t)*Math.sin(z), Math.cos(t)); })(), s: 1.05 },
  middle: { c: new THREE.Vector3(-12.8, 24.5, 592.57), a: (() => { const t = -30*Math.PI/180, z = -5*Math.PI/180; return new THREE.Vector3(Math.sin(t)*Math.cos(z), Math.sin(t)*Math.sin(z), Math.cos(t)); })(), s: 1.09 },
  pinky: { c: new THREE.Vector3(-11, -16.8, 580), a: (() => { const t = -33*Math.PI/180, z = 20*Math.PI/180; return new THREE.Vector3(Math.sin(t)*Math.cos(z), Math.sin(t)*Math.sin(z), Math.cos(t)); })(), s: 0.9 },
};
const fingerOf = (P) => FINGERS[P.finger] || FINGERS.ring;
// On the body the arm stands upright (same pose as for the bangle) and the ring is tilted onto
// the finger instead: app.js applies this rotation to the piece + mannequin when "Show on body" is on.
export function wearRotation(P) {
  return P.cat === 'ring' ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fingerOf(P).a) : new THREE.Quaternion();
}
function refPlacement(P) {
  const m = new THREE.Matrix4();
  if (P.cat === 'ring') { // rotate the finger axis onto Z; wearRotation() turns the whole set back upright
    const { c, a, s } = fingerOf(P);
    const k = P.rin / (10.1 * s), q = new THREE.Quaternion().setFromUnitVectors(a, new THREE.Vector3(0, 0, 1));
    m.compose(new THREE.Vector3(), q, new THREE.Vector3(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    return [HAND, m];
  }
  if (P.cat === 'bangle') {
    const c = [22.6, 2.6, 462], r0 = 27 / 0.92;
    const k = P.rin / r0;
    m.set(k, 0, 0, -k * c[0], 0, k, 0, -k * c[1], 0, 0, k, -k * c[2], 0, 0, 0, 1);
    return [HAND, m];
  }
  let k, t;
  if (P.cat === 'choker') { // neck axis from circle fits of the scan: leans ~17.5 deg forward
    // raw centre (gx, gy, gz) = (0, -0.30, -0.204); neck radius there is 0.18 mean / 0.20 max raw units,
    // scaled on the max so the band clears the throat
    const k = P.rin / 0.2, th = 0.306;
    const m0 = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1); // raw -> (-gx, gz, gy)
    m.makeScale(k, k, k).multiply(new THREE.Matrix4().makeRotationX(th))
      .multiply(new THREE.Matrix4().makeTranslation(0, 0.204, 0.30)).multiply(m0);
    return [HEAD, m];
  }
  if (P.cat === 'tiara') { const s = P.rin / 70; k = 259.2 * s; t = [0, -22.9 * s, -205.6 * s]; } // crown circle = rin
  // left ear lobe pierced by the top of the hook; the trailing (+3, -1, +4.5) mm is the hand-tuned
  // default spot (the page's ear sliders start at 0 and move relative to it)
  else { k = 220; t = [-0.324 * k + 3, 0.045 * k - 3 - 1, 1.78 - 0.215 * k + 8.6 + 4.5]; }
  m.set(-k, 0, 0, t[0], 0, 0, k, t[1], 0, k, 0, t[2], 0, 0, 0, 1);
  return [HEAD, m];
}
export function makeMannequin(P, mat) {
  const g = makePrimitive(P, mat);
  const [name, m] = refPlacement(P);
  loadRef(name).then((geos) => {
    for (const c of [...g.children]) { g.remove(c); c.traverse((o) => o.geometry && o.geometry.dispose()); }
    for (const geo of geos) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(m); mesh.userData.shared = true;
      g.add(mesh);
    }
  }).catch((e) => console.warn('Reference body unavailable, using simple mannequin:', e));
  return g;
}
function makePrimitive(P, mat) {
  const g = new THREE.Group();
  if (P.cat === 'ring') { // hand, ring finger along Z through the ring
    const rf = P.rin * 0.96;
    g.add(capZ(mat, rf, -30, 52));
    for (const [dx, len] of [[-2.1, 48], [2.1, 56], [4.2, 44]]) g.add(capZ(mat, rf * 0.98, -30, len - 4, dx * rf));
    g.add(ell(mat, 46, 15, 55, rf * 1.6, 0, -70));
    g.add(capZ(mat, rf * 1.15, -95, -40, -rf * 4.2, 0)).rotation.y = -0.5;
    g.add(capZ(mat, 30, -260, -110, rf * 1.4, 0));
  } else if (P.cat === 'bangle') { // forearm along Z, hand above
    const rw = P.rin * 0.78;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(rw, rw * 1.45, 240, 48), mat);
    arm.rotation.x = Math.PI / 2; arm.scale.set(1, 1, 0.78); arm.position.z = -100; g.add(arm);
    g.add(ell(mat, rw * 1.25, rw * 0.6, 60, 0, 0, 55));
  } else if (P.cat === 'tiara') {
    g.add(bust(mat, 0, -20, -40));
  } else if (P.cat === 'choker') { // neck through the choker
    g.add(bust(mat, 0, 8, 145));
  } else { // earring: lobe at the hook, head to the -X side
    const zl = 1.6 + 0.18;
    g.add(ell(mat, 3.5, 14, 30, -1, -2, zl + 24));
    g.add(ell(mat, 4.5, 7, 6, -1.5, 0, zl + 1));
    g.add(bust(mat, -70, -12, 40));
  }
  return g;
}
