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
varying vec3 vLocal;
const float PI = 3.14159265359, TAU = 6.28318530718;
float pw(float a, float b) { return (b == floor(b) && mod(b, 2.0) == 0.0) ? pow(abs(a), b) : sign(a) * pow(abs(a), b); }
`;
const FRAG_BODY = `
float tpd(float u, float v, float w, float cm) {
  float f = tp(TAU * u, TAU * v, TAU * w) * uNorm;
  return uMode == 1 ? (f - uIso) * cm / TAU : abs(f) * cm / TAU - uThick * 0.5;
}
float gT(int k) { int n = uN; k = uClosed ? ((k % n) + n) % n : clamp(k, 0, n - 1); return uTop[k]; }
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
    vec3 q = vec3(p.x / a, p.y / a, (p.z + c) / c);
    float k0 = length(q), k1 = max(length(vec3(q.x / a, q.y / a, q.z / c)), 1e-9);
    float d = k0 * (k0 - 1.0) / k1;
    float s = max(d, tpd(p.x / cell, p.y / cell, p.z / cell, cell));
    if (uRim > 0.0) s = min(s, max(d, -(d + uRim)));
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
  float cm = min(min(uCu * r / Rmid, 2.0 * h / uNV), uCw);
  float U = s * uNU, V = (zz - zc) / (2.0 * h) * uNV + uTwist * s, W = w / uCw;
  float o = max(d, tpd(U, V, W, cm));
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
  if (!hit) discard;
  vec3 p = ro + rd * t;
  const vec2 k = vec2(1.0, -1.0); float e = 0.01;
  vec3 n = normalize(k.xyy * field(p + k.xyy * e) + k.yyx * field(p + k.yyx * e) + k.yxy * field(p + k.yxy * e) + k.xxx * field(p + k.xxx * e));
  float ao = clamp(0.35 + field(p + n * 0.25) / 0.25 * 0.65, 0.25, 1.0);
  vec3 v = -rd, rf = reflect(rd, n), L = normalize(vec3(0.5, 0.6, 0.8));
  float fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 F0 = mix(vec3(0.04), uColor, uMetal);
  vec3 spec = (F0 + (1.0 - F0) * fres) * envc(rf);
  float nl = max(dot(n, L), 0.0), sp = pow(max(dot(reflect(-L, n), v), 0.0), 60.0);
  vec3 col = spec * ao + (1.0 - uMetal) * uColor * (0.25 + 0.75 * nl) * ao + vec3(sp) * mix(0.3, 1.0, uMetal);
  col = col / (1.0 + col); // simple tone map
  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
  vec4 cp = uProj * viewMatrix * uModel * vec4(p, 1.0);
  gl_FragDepth = clamp(cp.z / cp.w * 0.5 + 0.5, 0.0, 1.0);
}`;
const VERT = `varying vec3 vLocal; void main() { vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export function makeImplicitView() {
  const U = {};
  for (const k of ['uNorm', 'uIso', 'uThick', 'uRim', 'uNU', 'uNV', 'uTwist', 'uRin', 'uT', 'uW', 'uRound', 'uTanT', 'uSpan', 'uCu', 'uCw', 'uD', 'uElong', 'uMetal']) U[k] = { value: 0 };
  Object.assign(U, { uInvModel: { value: new THREE.Matrix4() }, uModel: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() }, uLo: { value: new THREE.Vector3() }, uHi: { value: new THREE.Vector3() },
    uColor: { value: new THREE.Color() }, uCat: { value: 0 }, uMode: { value: 0 }, uN: { value: 32 }, uClosed: { value: true }, uTop: { value: new Array(33).fill(0) } });
  // placeholder material until the first update() compiles the shader
  // (a null material crashes three.js's render loop on `material.visible`)
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }));
  box.frustumCulled = false; box.visible = false;
  let glslKey = null;
  box.onBeforeRender = (renderer, scene, camera) => {
    U.uModel.value.copy(box.matrixWorld); U.uInvModel.value.copy(box.matrixWorld).invert();
    U.uProj.value.copy(camera.projectionMatrix);
  };
  function update(P, field, norm, glsl, colorHex, metallic) {
    if (glsl !== glslKey) {
      glslKey = glsl;
      if (box.material) box.material.dispose();
      box.material = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, side: THREE.BackSide,
        fragmentShader: FRAG_HEAD + `float tp(float x, float y, float z) { return ${glsl}; }\n` + FRAG_BODY });
    }
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
    if (P.cat === 'earring') { U.uD.value = P.D; U.uElong.value = P.elong; return; }
    const closed = P.cat !== 'tiara' && P.cat !== 'choker', span = closed ? 2 * Math.PI : P.span * Math.PI / 180, Rmid = P.rin + P.T / 2;
    U.uClosed.value = closed; U.uSpan.value = span; U.uRin.value = P.rin; U.uT.value = P.T; U.uW.value = P.W;
    U.uRound.value = P.round; U.uTanT.value = Math.tan(P.tilt * Math.PI / 180);
    U.uCu.value = span * Rmid / P.nU; U.uCw.value = (span * Rmid / P.nU + P.W / P.nV) / 2 / (P.nW || 1);
    U.uN.value = P.top.length; for (let i = 0; i < 33; i++) U.uTop.value[i] = P.top[i] || 0;
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
// Earrings come in pairs: the head's mid-plane is at x = -71.3 in the earring frame, so the
// mirrored copy for the right ear is the piece reflected in x and moved to x = 2 * -71.3.
export const EAR_PAIR_X = -142.6;
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
function refPlacement(P) {
  const m = new THREE.Matrix4();
  if (P.cat === 'ring') { // ring finger in the scan is tilted ~38 deg from Z: rotate its axis onto Z
    // axis + base of the finger from a circle fit of the scan; finger radius there is ~8.8 mm
    // (refit iteratively on circle centres along the finger, z = -5..25 mm past the base)
    const c = new THREE.Vector3(-7.74, 3.18, 619.46), a = new THREE.Vector3(0.5959, 0.0626, 0.8006).normalize();
    const k = P.rin / 8.8, q = new THREE.Quaternion().setFromUnitVectors(a, new THREE.Vector3(0, 0, 1));
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
  else { k = 220; t = [-0.324 * k, 0.045 * k - 3, 1.78 - 0.215 * k + 8.6]; } // left ear lobe pierced by the top of the hook
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
