// DUBG 3D view: draws the match with three.js from a tilted camera. The game state, rules and
// networking stay in the main client; this module only turns that state into a 3D scene each frame.
// World units match the 2D game: x -> X, y -> Z, height is Y.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Character: Quaternius casual hoodie guy (CC0). Clip names are the model's, minus the "CharacterArmature|" prefix.
const CHAR = {
  url: '/assets/hoodie.glb', height: 58, yaw: 0, hand: 'Wrist.R',
  clips: { idle: 'Idle', aim: 'Idle_Gun_Pointing', shoot: 'Idle_Gun_Shoot', walk: 'Walk', run: 'Run', runGun: 'Run_Shoot', back: 'Run_Back', left: 'Run_Left', right: 'Run_Right', punch: 'Punch_Right', death: 'Death' },
  // material name -> which colour of the player it takes
  paint: { White: 'hoodie', Skin: 'skin', Purple: 'crew' },
};
// Guns (Quaternius, CC0). len: length in world units; flip: turn round if the model's muzzle faces backwards.
const GUNS = { pistol: { len: 14, flip: true }, smg: { len: 21, flip: true }, shotgun: { len: 30, flip: true }, rifle: { len: 31, flip: true } };
const H = { wall: 68, pwall: 78, block: 64, fence: 30, door: 68, aim: 34 };
const PITCH = THREE.MathUtils.degToRad(60), FOV = 34;
const coarse = matchMedia('(pointer: coarse)').matches;
const LIGHTS = coarse ? 6 : 10;

let renderer = null, scene, camera, world = null, charSrc = null, fogCv, fogCtx;
const gunSrc = {};           // gun type -> model, barrel along +Z with the grip at the origin
const players = new Map();   // id -> view of one player
const itemViews = new Map(); // item id -> mesh
const dummy = new THREE.Object3D(), tmpC = new THREE.Color(), tmpV = new THREE.Vector3();
const ray = new THREE.Raycaster(), aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -H.aim);

// ---------- fog of war: every world material is darkened outside what the viewer can see ----------
const FOG_PX = coarse ? 256 : 512;
const fogU = { tex: { value: null }, rect: { value: new THREE.Vector4(0, 0, 1, 0) } };
// see-through hole: walls and roofs between the camera and your player are cut away around you
// (x, y: your screen position in drawing-buffer pixels, z: your distance from the camera, w: hole radius)
const cutU = { value: new THREE.Vector4(0, 0, 0, 0) }, cutZ = { value: 0 }; // cutZ: your world y; only things south of you are cut
function fogify(mat, cut) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.dubgFog = fogU.tex; sh.uniforms.dubgFogR = fogU.rect; sh.uniforms.dubgCut = cutU; sh.uniforms.dubgCutZ = cutZ;
    sh.vertexShader = 'varying vec2 vDubgW;\nvarying float vDubgD;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      vec4 dubgW = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        dubgW = instanceMatrix * dubgW;
      #endif
      vDubgW = (modelMatrix * dubgW).xz;
      vDubgD = -mvPosition.z;`);
    sh.fragmentShader = 'uniform sampler2D dubgFog;\nuniform vec4 dubgFogR;\nuniform vec4 dubgCut;\nuniform float dubgCutZ;\nvarying vec2 vDubgW;\nvarying float vDubgD;\n' + sh.fragmentShader.replace('#include <dithering_fragment>', `
      ${cut ? `if (dubgCut.w > 0.0 && vDubgD < dubgCut.z - 14.0 && vDubgW.y > dubgCutZ + 4.0) {
        float dubgR = distance(gl_FragCoord.xy, dubgCut.xy) / dubgCut.w;
        float dubgDot = fract(sin(dot(floor(gl_FragCoord.xy / 2.0), vec2(12.9898, 78.233))) * 43758.5453);
        if (dubgR < 1.0 && dubgDot > smoothstep(0.75, 1.0, dubgR) * 0.9) discard;
      }` : ''}
      vec2 dubgUv = (vDubgW - dubgFogR.xy) / dubgFogR.z;
      float dubgVis = texture2D(dubgFog, vec2(dubgUv.x, 1.0 - dubgUv.y)).r;
      gl_FragColor.rgb *= mix(1.0, mix(0.3, 1.0, dubgVis), dubgFogR.w);
      #include <dithering_fragment>`);
  };
  mat.customProgramCacheKey = () => cut ? 'dubgfog-cut' : 'dubgfog';
  return mat;
}
const lambert = (o) => fogify(new THREE.MeshLambertMaterial(o));
const solid = (o) => fogify(new THREE.MeshLambertMaterial(o), true); // tall things you can be hidden behind

// ---------- setup ----------
function init(canvas) {
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: !coarse, powerPreference: 'high-performance' }); }
  catch (e) { renderer = null; return false; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.25 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b0d12');
  camera = new THREE.PerspectiveCamera(FOV, 1, 20, 9000);
  scene.add(new THREE.AmbientLight('#b4bdd6', 2.1));
  scene.add(new THREE.HemisphereLight('#8c9cc8', '#3a2e22', 1.1));
  const moon = new THREE.DirectionalLight('#aab8e0', 0.9); moon.position.set(-0.4, 1, 0.6); scene.add(moon);
  api.lantern = new THREE.PointLight('#ffe3b8', 1.1, 420, 0); scene.add(api.lantern);
  api.flashL = new THREE.PointLight('#ffcc77', 0, 260, 0); scene.add(api.flashL);
  api.pool = Array.from({ length: LIGHTS }, () => { const l = new THREE.PointLight('#ffd28c', 0, 200, 0); scene.add(l); return l; });
  fogCv = document.createElement('canvas'); fogCv.width = fogCv.height = FOG_PX; fogCtx = fogCv.getContext('2d');
  fogU.tex.value = new THREE.CanvasTexture(fogCv);
  const loader = new GLTFLoader();
  loader.load(CHAR.url, g => { charSrc = g; }, undefined, e => console.warn('DUBG: character model failed to load', e));
  for (const t of Object.keys(GUNS)) loader.load(`/assets/${t}.glb`, g => { gunSrc[t] = normalizeGun(g.scene, GUNS[t]); }, undefined, e => console.warn('DUBG: gun model failed to load', t, e));
  return true;
}

function resize(w, h) {
  if (!renderer) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

// ---------- static world ----------
const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
function boxes(list, mat, place, color) {
  const m = new THREE.InstancedMesh(boxGeo, mat, Math.max(1, list.length));
  m.count = list.length; m.frustumCulled = false;
  list.forEach((w, i) => {
    place(w, dummy); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix);
    if (color) m.setColorAt(i, tmpC.set(color(w)));
  });
  return m;
}
const rectBox = (h, y0 = 0, pad = 0) => (w, o) => { o.position.set(w.x + w.w / 2, y0, w.y + w.h / 2); o.rotation.set(0, 0, 0); o.scale.set(w.w + pad * 2, h, w.h + pad * 2); };
function barsTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d');
  x.fillStyle = '#a9b3bb'; for (let i = 2; i < 64; i += 10) x.fillRect(i, 0, 4, 64);
  x.fillRect(0, 0, 64, 5); x.fillRect(0, 59, 64, 5); x.fillRect(0, 28, 64, 4);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function treeGeo() {
  const parts = [new THREE.CylinderGeometry(3, 6, 56, 6).translate(0, 28, 0)];
  for (let k = 0; k < 5; k++) {
    const b = new THREE.CylinderGeometry(1.2, 2.6, 30, 5).translate(0, 15, 0);
    b.rotateZ(0.9 + (k % 2) * 0.3); b.rotateY(k * Math.PI * 2 / 5); b.translate(0, 34 + (k % 3) * 6, 0);
    parts.push(b);
  }
  return mergeGeometries(parts);
}
const flameTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,230,150,1)'); g.addColorStop(0.35, 'rgba(255,140,40,.8)'); g.addColorStop(1, 'rgba(255,80,20,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();

function disposeWorld() {
  if (!world) return;
  scene.remove(world.group);
  world.group.traverse(o => { if (o.isMesh || o.isSprite || o.isLine) { if (o.geometry && o.geometry !== boxGeo) o.geometry.dispose(); const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { if (m.map && m.map !== flameTex) m.map.dispose(); m.dispose(); } } });
  for (const v of players.values()) scene.remove(v.holder);
  players.clear(); itemViews.clear();
  world = null;
}

// W: the arrays from DUBG.buildWorld plus WORLD/SHOPS; ground: a canvas of the baked 2D ground; scale: its px per unit
function setWorld(W, ground, scale) {
  if (!renderer) return;
  disposeWorld();
  const g = new THREE.Group();
  world = { group: g, W, roofs: [], bwalls: [], doors: [], flames: [], lights: [] };
  // ground
  const under = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000).rotateX(-Math.PI / 2), lambert({ color: '#1f1e1a' }));
  under.position.set(W.WORLD.w / 2, -0.5, W.WORLD.h / 2); g.add(under);
  const gt = new THREE.CanvasTexture(ground); gt.colorSpace = THREE.SRGBColorSpace; gt.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const gw = ground.width / scale, gh = ground.height / scale;
  const gm = new THREE.Mesh(new THREE.PlaneGeometry(gw, gh).rotateX(-Math.PI / 2), lambert({ map: gt }));
  gm.position.set(gw / 2, 0, gh / 2); g.add(gm);

  // walls: building walls are grouped per building so they can fade when you're inside
  const inB = (w, b) => w.x >= b.x - 1 && w.y >= b.y - 1 && w.x + w.w <= b.x + b.w + 1 && w.y + w.h <= b.y + b.h + 1;
  const wallMat = solid({ color: '#3a3d42' }), capMat = solid({ color: '#61666d' });
  const loose = [];
  const byB = new Map(W.buildings.map(b => [b, []]));
  for (const w of W.walls) if (w.kind === 'wall') { const b = W.buildings.find(b => inB(w, b)); if (b) byB.get(b).push(w); else loose.push(w); }
  for (const [b, ws] of byB) {
    const mat = solid({ color: '#3a3d42', transparent: true }), cap = solid({ color: '#61666d', transparent: true });
    const m = boxes(ws, mat, rectBox(H.wall)), c = boxes(ws, cap, rectBox(2, H.wall, 0.5));
    g.add(m, c);
    const roofMat = solid({ color: b.roof, transparent: true });
    const roof = new THREE.Mesh(boxGeo, roofMat); roof.position.set(b.x + b.w / 2, H.wall, b.y + b.h / 2); roof.scale.set(b.w + 8, 3, b.h + 8);
    g.add(roof);
    world.roofs.push({ b, mats: [mat, cap, roofMat], roof, a: 1 });
  }
  g.add(boxes(loose, wallMat, rectBox(H.wall)), boxes(loose, capMat, rectBox(2, H.wall, 0.5)));
  const pw = W.walls.filter(w => w.kind === 'pwall');
  g.add(boxes(pw, solid({ color: '#4c5053' }), rectBox(H.pwall)), boxes(pw, solid({ color: '#7a7f83' }), rectBox(3, H.pwall, 1)));
  // boarded-up buildings: solid blocks with a roof and planks
  g.add(boxes(W.boarded, solid({ color: '#2b2520' }), rectBox(H.block)));
  g.add(boxes(W.boarded, solid({ color: '#ffffff' }), rectBox(3, H.block, 3), b => b.roof));
  const planks = [];
  for (const b of W.boarded) if (b.planks) for (const s of [1, -1]) planks.push({ b, s });
  g.add(boxes(planks, solid({ color: '#5a4630' }), (p, o) => { const b = p.b; o.position.set(b.x + b.w / 2, H.block + 3, b.y + b.h / 2); o.rotation.set(0, p.s * 0.6, 0); o.scale.set(Math.hypot(b.w, b.h) * 0.75, 3, 10); }));
  // fences, barrels, cars, trees
  const fence = W.walls.filter(w => w.kind === 'fence');
  g.add(boxes(fence, lambert({ color: '#98a1a8', transparent: true, opacity: 0.32, depthWrite: false }), rectBox(H.fence)));
  g.add(boxes(fence, lambert({ color: '#7d848a' }), rectBox(2, H.fence)));
  const barrels = W.walls.filter(w => w.kind === 'barrel');
  const bm = new THREE.InstancedMesh(new THREE.CylinderGeometry(9, 9, 26, 12).translate(0, 13, 0), lambert({ color: '#4a2d1a' }), Math.max(1, barrels.length));
  bm.count = barrels.length; bm.frustumCulled = false;
  barrels.forEach((w, i) => { dummy.position.set(w.x + 9, 0, w.y + 9); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); bm.setMatrixAt(i, dummy.matrix); });
  g.add(bm);
  g.add(boxes(W.cars, lambert({ color: '#ffffff' }), rectBox(18), c => c.burned ? '#262321' : c.color));
  g.add(boxes(W.cars, lambert({ color: '#0f1317' }), (c, o) => { const hz = c.w > c.h; o.position.set(c.x + c.w / 2, 18, c.y + c.h / 2); o.rotation.set(0, 0, 0); o.scale.set(hz ? c.w * 0.5 : c.w - 6, 13, hz ? c.h - 6 : c.h * 0.5); }));
  const tg = treeGeo(), tm = new THREE.InstancedMesh(tg, solid({ color: '#46392d' }), Math.max(1, W.trees.length));
  tm.count = W.trees.length; tm.frustumCulled = false;
  W.trees.forEach((t, i) => { dummy.position.set(t.x, 0, t.y); dummy.rotation.set(0, t.a, 0); dummy.scale.setScalar(t.r / 26); dummy.updateMatrix(); tm.setMatrixAt(i, dummy.matrix); });
  g.add(tm);
  // doors (prison gates and cell bars): hidden once open
  const bars = barsTexture();
  for (const d of W.doors) {
    const t = bars.clone(); t.repeat.set(Math.max(d.w, d.h) / 30, 2); t.needsUpdate = true;
    const m = new THREE.Mesh(boxGeo, solid({ map: t, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide }));
    m.position.set(d.x + d.w / 2, 0, d.y + d.h / 2); m.scale.set(d.w, H.door, d.h);
    g.add(m); world.doors.push({ d, m });
  }
  // lamps and fire barrels
  const lamps = W.lights.filter(l => l.kind === 'lamp');
  g.add(boxes(lamps, lambert({ color: '#26282b' }), (l, o) => { o.position.set(l.x, 0, l.y); o.rotation.set(0, 0, 0); o.scale.set(4, 104, 4); }));
  g.add(boxes(lamps, new THREE.MeshBasicMaterial({ color: '#ffe6b0' }), (l, o) => { o.position.set(l.x, 100, l.y); o.rotation.set(0, 0, 0); o.scale.set(12, 5, 12); }));
  for (const l of W.lights) {
    world.lights.push({ x: l.x, y: l.y, h: l.kind === 'fire' ? 34 : 96, r: l.r * 1.5, color: l.kind === 'fire' ? '#ff8a3a' : '#ffd8a0', base: l.kind === 'fire' ? 1.5 : 1.15, src: l });
    if (l.kind === 'fire') {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.position.set(l.x, 34, l.y); s.scale.set(26, 34, 1); g.add(s); world.flames.push({ s, l });
    }
  }
  // neon signs light up the street in their colour
  for (const b of W.buildings) {
    const S = W.SHOPS[b.shop], d = b.door;
    let x = d.x + d.w / 2, y = d.y + d.h / 2;
    if (b.side === 'top') y = b.y - 30; else if (b.side === 'bottom') y = b.y + b.h + 30; else if (b.side === 'left') x = b.x - 30; else x = b.x + b.w + 30;
    world.lights.push({ x, y, h: 60, r: 190, color: S.color, base: 1.1, neon: b });
  }
  // zone
  const zw = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 160, 1, true).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: '#3c74ff', transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
  const zo = new THREE.Mesh(new THREE.RingGeometry(1, 60, 160).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#2858d2', transparent: true, opacity: 0.28, depthWrite: false }));
  zo.position.y = 1.2;
  const circle = []; for (let i = 0; i <= 160; i++) { const a = i / 160 * Math.PI * 2; circle.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
  const zn = new THREE.Line(new THREE.BufferGeometry().setFromPoints(circle), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 }));
  zn.position.y = 2;
  g.add(zw, zo, zn);
  world.zone = { zw, zo, zn };
  scene.add(g);
}

// ---------- players ----------
// turn a gun model so its barrel runs along +Z, scaled to `len`, grip at the origin
function normalizeGun(src, o) {
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src, true), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const inner = new THREE.Group(); inner.add(src); inner.position.copy(c).negate();
  const axis = new THREE.Group(); axis.add(inner);
  const long = Math.max(size.x, size.y, size.z);
  if (long === size.x) axis.rotation.y = -Math.PI / 2; else if (long === size.y) axis.rotation.x = Math.PI / 2;
  const out = new THREE.Group(); out.add(axis);
  axis.scale.setScalar(o.len / long);
  if (o.flip) out.rotation.y = Math.PI;
  const wrap = new THREE.Group(); wrap.add(out);
  out.position.z = o.len * 0.3; // grip sits a third of the way back
  wrap.traverse(m => { if (m.isMesh) { m.material = fogify(m.material.clone()); m.frustumCulled = false; } });
  return wrap;
}
const clipOf = name => charSrc.animations.find(a => a.name === name || a.name.endsWith('|' + name));
function makePlayer(P, isMe) {
  const holder = new THREE.Group();
  const model = cloneSkinned(charSrc.scene);
  if (!charSrc.height) { charSrc.scene.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(charSrc.scene, true); charSrc.height = box.max.y - box.min.y || 1.8; }
  model.scale.setScalar(CHAR.height / charSrc.height);
  model.rotation.y = CHAR.yaw;
  const colors = { hoodie: P.look.hoodie, skin: P.look.skin, crew: P.crew.c };
  const mats = [];
  model.traverse(o => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const out = list.map(m0 => {
      const m = m0.clone(), k = CHAR.paint[m0.name];
      if (k) m.color.set(colors[k]);
      if (m.emissive) m.emissive.setRGB(0, 0, 0);
      fogify(m); mats.push(m); return m;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
  holder.add(model);
  // crew ring under the feet (white for you)
  const ring = new THREE.Mesh(new THREE.RingGeometry(15, 19, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: isMe ? '#ffffff' : P.crew.c, transparent: true, opacity: isMe ? 0.8 : 0.65, depthWrite: false }));
  ring.position.y = 0.8; holder.add(ring);
  // the gun follows the right hand but always points where the player aims (local +Z)
  const gun = new THREE.Group(); holder.add(gun);
  const mixer = new THREE.AnimationMixer(model), actions = {};
  for (const [k, n] of Object.entries(CHAR.clips)) { const c = clipOf(n); if (c) actions[k] = mixer.clipAction(c); }
  if (actions.death) { actions.death.setLoop(THREE.LoopOnce, 1); actions.death.clampWhenFinished = true; }
  if (actions.idle) actions.idle.play();
  scene.add(holder);
  return { holder, model, mats, ring, gun, hand: model.getObjectByName(CHAR.hand) || model.getObjectByName(CHAR.hand.replace('.', '')), mixer, actions, cur: 'idle', lx: P.x, ly: P.y, speed: 0, mvx: 0, mvy: 0, gunType: null, dead: false };
}
function setAnim(v, name, scale) {
  const a = v.actions[name] || v.actions.idle; if (!a) return;
  a.timeScale = scale;
  if (v.cur === name) return;
  const prev = v.actions[v.cur];
  a.reset().play(); if (prev) a.crossFadeFrom(prev, name === 'death' ? 0.1 : 0.18, false);
  v.cur = name;
}
function updatePlayer(P, v, dt, visible) {
  const x = P.x, y = P.y;
  const k = Math.min(1, dt * 10);
  v.mvx += ((x - v.lx) / Math.max(dt, 1e-3) - v.mvx) * k; v.mvy += ((y - v.ly) / Math.max(dt, 1e-3) - v.mvy) * k;
  v.speed = Math.min(400, Math.hypot(v.mvx, v.mvy));
  v.lx = x; v.ly = y;
  v.holder.position.set(x, 0, y);
  v.holder.rotation.y = Math.PI / 2 - P.ang;
  v.holder.visible = visible;
  const armed = !!P.gun;
  if (!P.alive) {
    if (!v.dead) { v.dead = true; setAnim(v, 'death', 1); }
    v.ring.visible = false; v.gun.visible = false;
  } else {
    v.dead = false; v.ring.visible = true;
    if (P.punch > 0 || (P.flags & 4)) setAnim(v, 'punch', 1.6);
    else if (v.speed > 25) {
      // pick the run that matches the direction of travel relative to where they aim
      const fx = Math.cos(P.ang), fy = Math.sin(P.ang), fwd = (v.mvx * fx + v.mvy * fy) / v.speed, side = (v.mvx * -fy + v.mvy * fx) / v.speed;
      const rate = THREE.MathUtils.clamp(v.speed / 205, 0.6, 1.3);
      if (fwd > 0.55) setAnim(v, armed ? 'runGun' : 'run', rate);
      else if (fwd < -0.55) setAnim(v, 'back', rate);
      else setAnim(v, side > 0 ? 'right' : 'left', rate);
    } else if (armed) setAnim(v, P.flash > 0 ? 'shoot' : 'aim', 1);
    else setAnim(v, 'idle', 1);
  }
  v.mixer.update(dt);
  // swap the gun model when they change weapons
  if (v.gunType !== P.gun || (P.gun && !v.gun.children.length && gunSrc[P.gun])) {
    v.gunType = P.gun;
    v.gun.clear();
    if (P.gun && gunSrc[P.gun]) v.gun.add(gunSrc[P.gun].clone());
  }
  if (P.alive && armed) {
    v.gun.visible = true;
    if (v.hand) { v.holder.updateMatrixWorld(true); v.hand.getWorldPosition(tmpV); v.holder.worldToLocal(tmpV); v.gun.position.set(tmpV.x, Math.max(20, tmpV.y), Math.max(2, tmpV.z)); }
    else v.gun.position.set(-6, 30, 10);
  } else v.gun.visible = false;
  const hurt = Math.max(0, Math.min(0.8, P.hurt * 3));
  for (const m of v.mats) if (m.emissive) m.emissive.setRGB(hurt, hurt * 0.1, hurt * 0.1);
}
// muzzle position of a player's gun, for the muzzle flash light
function muzzle(P) { return { x: P.x + Math.cos(P.ang) * 30, y: P.y + Math.sin(P.ang) * 30 }; }

// ---------- items ----------
const itemGeo = {
  ring: new THREE.RingGeometry(10, 13, 24).rotateX(-Math.PI / 2),
  gun: new THREE.BoxGeometry(22, 5, 6), ammo: new THREE.CylinderGeometry(2, 2, 10, 6), heal: new THREE.BoxGeometry(12, 6, 10), armor: new THREE.BoxGeometry(14, 16, 6),
};
const itemMats = new Map();
function itemMat(c) { if (!itemMats.has(c)) itemMats.set(c, fogify(new THREE.MeshBasicMaterial({ color: c }))); return itemMats.get(c); }
function makeItem(it, ITEMS) {
  const d = ITEMS[it.type], g = new THREE.Group();
  const ring = new THREE.Mesh(itemGeo.ring, fogify(new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity: 0.8, depthWrite: false })));
  ring.position.y = 0.9; g.add(ring);
  const icon = new THREE.Group(); icon.position.y = 12; g.add(icon);
  if (d.kind === 'gun') { if (gunSrc[it.type]) { const m = gunSrc[it.type].clone(); m.rotation.z = Math.PI / 2; icon.add(m); } else icon.add(new THREE.Mesh(itemGeo.gun, itemMat(d.color))); }
  else if (d.kind === 'ammo') for (let i = -1; i <= 1; i++) { const m = new THREE.Mesh(itemGeo.ammo, itemMat(d.color)); m.position.x = i * 5; icon.add(m); }
  else if (d.kind === 'armor') icon.add(new THREE.Mesh(itemGeo.armor, itemMat(d.color)));
  else { icon.add(new THREE.Mesh(itemGeo.heal, itemMat(it.type === 'med' ? '#f1ede4' : d.color))); }
  g.position.set(it.x, 0, it.y);
  g.userData = { ring, icon };
  world.group.add(g);
  return g;
}

// ---------- per frame ----------
// F: { M, ITEMS, viewer, fogOn, vis: [x0,y0,x1,y1,...] visibility polygon, visOrigin, visR, zoom, dt, me }
function frame(F) {
  if (!renderer || !world) return;
  const { M, dt } = F, t = M.time;
  // camera: tilted, looking north, framing about as much ground as the 2D view
  const vh = renderer.domElement.clientHeight || innerHeight;
  const L = (vh / F.zoom) * 0.62 / api.zoomMul / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
  camera.position.set(M.cam.x, Math.sin(PITCH) * L, M.cam.y + Math.cos(PITCH) * L);
  camera.lookAt(M.cam.x, 0, M.cam.y);
  camera.updateMatrixWorld();
  // fog texture around the viewer
  const o = F.visOrigin, R = F.visR * 1.15, size = R * 2;
  fogU.rect.value.set(o.x - R, o.y - R, size, F.fogOn ? 1 : 0);
  if (F.fogOn) {
    const k = FOG_PX / size, c = fogCtx;
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#000'; c.fillRect(0, 0, FOG_PX, FOG_PX);
    c.setTransform(k, 0, 0, k, -(o.x - R) * k, -(o.y - R) * k);
    const gr = c.createRadialGradient(o.x, o.y, F.visR * 0.55, o.x, o.y, F.visR);
    gr.addColorStop(0, '#fff'); gr.addColorStop(1, '#000');
    c.fillStyle = gr; c.beginPath();
    const p = F.vis; c.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]); c.closePath(); c.fill();
    fogU.tex.value.needsUpdate = true;
  }
  const vw = F.viewer;
  if (F.fogOn) {
    tmpV.set(vw.x, 30, vw.y).project(camera);
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2()), dpr = renderer.getPixelRatio();
    const depth = tmpV.set(vw.x, 30, vw.y).applyMatrix4(camera.matrixWorldInverse).z;
    tmpV.set(vw.x, 30, vw.y).project(camera);
    cutU.value.set((tmpV.x + 1) / 2 * buf.x, (tmpV.y + 1) / 2 * buf.y, -depth, 75 * pxScale(vw.x, vw.y, 30) * dpr); cutZ.value = vw.y;
  } else cutU.value.w = 0;
  // roofs and walls fade when the viewer is inside that building
  for (const r of world.roofs) {
    const b = r.b, inside = vw.x > b.x && vw.x < b.x + b.w && vw.y > b.y && vw.y < b.y + b.h;
    r.a += ((inside ? 0 : 1) - r.a) * Math.min(1, dt * 10);
    r.mats[2].opacity = r.a; r.roof.visible = r.a > 0.02;
    const wa = 0.3 + 0.7 * r.a; r.mats[0].opacity = wa; r.mats[1].opacity = wa;
  }
  for (const d of world.doors) d.m.visible = !d.d.open;
  for (const f of world.flames) { const k = 0.85 + 0.15 * Math.sin(t * 13 + f.l.ph) * Math.sin(t * 7.3 + f.l.ph * 2); f.s.scale.set(24 * k, 34 * k, 1); }
  // nearest light sources get the pooled lights
  const cx = M.cam.x, cy = M.cam.y;
  const near = world.lights.filter(l => Math.abs(l.x - cx) < 1100 && Math.abs(l.y - cy) < 900).sort((a, b) => ((a.x - cx) ** 2 + (a.y - cy) ** 2) - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
  api.pool.forEach((pl, i) => {
    const l = near[i];
    if (!l) { pl.intensity = 0; return; }
    let k = 1;
    if (l.src && l.src.kind === 'fire') k = 0.85 + 0.15 * Math.sin(t * 13 + l.src.ph) * Math.sin(t * 7.3 + l.src.ph * 2);
    else if (l.src && l.src.flick && Math.sin(t * 6 + l.src.ph) + Math.sin(t * 17.3 + l.src.ph) < -1.1) k = 0.2;
    else if (l.neon && l.neon.flicker && Math.sin(t * 9 + l.neon.x) + Math.sin(t * 23 + l.neon.y) < -1.2) k = 0.2;
    pl.position.set(l.x, l.h, l.y); pl.color.set(l.color); pl.distance = l.r; pl.intensity = l.base * k;
  });
  api.lantern.position.set(vw.x, 70, vw.y); api.lantern.intensity = F.fogOn ? 1.1 : 0;
  // zone
  const z = M.zone, zr = Math.max(1, Math.min(z.cur.r, 20000)), Z = world.zone;
  Z.zw.position.set(z.cur.x, 0, z.cur.y); Z.zw.scale.set(zr, 260, zr); Z.zw.visible = F.fogOn;
  Z.zo.position.set(z.cur.x, 1.2, z.cur.y); Z.zo.scale.set(zr, 1, zr); Z.zo.visible = F.fogOn;
  Z.zn.visible = F.fogOn && !!z.next; if (z.next) { Z.zn.position.set(z.next.x, 2, z.next.y); Z.zn.scale.set(Math.max(1, z.next.r), 1, Math.max(1, z.next.r)); }
  // items: only the ones in sight are drawn
  const seenItem = it => !F.fogOn || F.canSeePt(it.x, it.y);
  for (const [id, g] of itemViews) if (!M.items.has(id)) { world.group.remove(g); g.userData.ring.material.dispose(); itemViews.delete(id); }
  for (const it of M.items.values()) {
    if (Math.abs(it.x - cx) > 1300 || Math.abs(it.y - cy) > 1100) { const g = itemViews.get(it.id); if (g) g.visible = false; continue; }
    let g = itemViews.get(it.id); if (!g) { g = makeItem(it, F.ITEMS); itemViews.set(it.id, g); }
    g.visible = seenItem(it);
    if (g.visible) { g.userData.icon.rotation.y = t * 1.2 + it.x; g.userData.icon.position.y = 12 + Math.sin(t * 3 + it.x * 0.1) * 2.5; }
  }
  // players
  let flash = null;
  if (charSrc) for (const P of M.list) {
    if (!P.init) continue;
    let v = players.get(P.id); if (!v) { v = makePlayer(P, P.id === M.me); players.set(P.id, v); }
    const visible = P.alive ? !!P.seen : (!F.fogOn || F.canSeePt(P.x, P.y));
    updatePlayer(P, v, dt, visible);
    if (P.seen && P.flash > 0 && P.gun && (!flash || P === vw)) flash = P;
  }
  if (flash) { const mz = muzzle(flash); api.flashL.position.set(mz.x, H.aim, mz.y); api.flashL.intensity = 2.2; } else api.flashL.intensity = Math.max(0, api.flashL.intensity - dt * 30);
  renderer.render(scene, camera);
}

// screen <-> world helpers for the 2D overlay and for aiming
function project(x, y, h) {
  tmpV.set(x, h || 0, y).project(camera);
  const el = renderer.domElement;
  return { x: (tmpV.x + 1) / 2 * el.clientWidth, y: (1 - tmpV.y) / 2 * el.clientHeight, z: tmpV.z };
}
function toWorld(sx, sy) {
  const el = renderer.domElement;
  ray.setFromCamera({ x: sx / el.clientWidth * 2 - 1, y: -(sy / el.clientHeight * 2 - 1) }, camera);
  const hit = ray.ray.intersectPlane(aimPlane, tmpV);
  return hit ? { x: hit.x, y: hit.z } : null;
}
// world units per screen pixel near a point, so overlay text can shrink with distance
function pxScale(x, y, h) { const a = project(x, y, h), b = project(x + 100, y, h); return Math.hypot(b.x - a.x, b.y - a.y) / 100; }

const api = { zoomMul: 1,  init, resize, setWorld, frame, project, toWorld, pxScale, get ok() { return !!renderer; }, get hasWorld() { return !!world; }, AIM_H: H.aim };
window.R3D = api;
window.dispatchEvent(new Event('r3d-ready'));
