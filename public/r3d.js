// DUBG 3D view: draws the match with three.js from a tilted camera. The game state, rules and
// networking stay in the main client; this module only turns that state into a 3D scene each frame.
// World units match the 2D game: x -> X, y -> Z, height is Y.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const H = { wall: 68, pwall: 78, block: 64, fence: 30, door: 68, aim: 25 };
const BODY = 0.72;   // characters are built at a big size and shrunk to fit the city
const PITCH = THREE.MathUtils.degToRad(60), FOV = 34;
const coarse = matchMedia('(pointer: coarse)').matches;
const LIGHTS = coarse ? 6 : 10;

let renderer = null, scene, camera, world = null, fogCv, fogCtx;
const players = new Map();   // id -> view of one player
const itemViews = new Map(); // item id -> mesh
const dummy = new THREE.Object3D(), tmpC = new THREE.Color(), tmpV = new THREE.Vector3(), tmpM = new THREE.Matrix4();
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

// ---------- cars: low-poly sedans built from a side profile, with wheels and lights ----------
const CAR_L = 58, CAR_W = 22;
function carGeos() {
  const L = CAR_L, h = L / 2;
  // side profile, nose at +x: bumper, hood, windscreen, roof, rear window, trunk
  const body = new THREE.Shape([[-h, 5], [-h, 15], [-h * 0.62, 16.5], [-h * 0.38, 25], [h * 0.18, 25.5], [h * 0.45, 17], [h, 15], [h, 5]].map(([x, y]) => new THREE.Vector2(x, y)));
  const glass = new THREE.Shape([[-h * 0.56, 17.5], [-h * 0.36, 24], [h * 0.16, 24.4], [h * 0.4, 17.6]].map(([x, y]) => new THREE.Vector2(x, y)));
  const bodyG = new THREE.ExtrudeGeometry(body, { depth: CAR_W - 2, bevelEnabled: true, bevelThickness: 1, bevelSize: 1, bevelSegments: 1 }).translate(0, 0, -(CAR_W - 2) / 2);
  const glassG = new THREE.ExtrudeGeometry(glass, { depth: CAR_W + 0.6, bevelEnabled: false }).translate(0, 0, -(CAR_W + 0.6) / 2);
  // windscreen and rear window: the cabin outline pushed out a little, narrower than the body
  const screen = new THREE.Shape([[-h * 0.68, 16], [-h * 0.395, 27], [h * 0.19, 27.5], [h * 0.5, 16.5]].map(([x, y]) => new THREE.Vector2(x, y)));
  const screenG = new THREE.ExtrudeGeometry(screen, { depth: CAR_W - 5, bevelEnabled: false }).translate(0, 0, -(CAR_W - 5) / 2);
  const roofG = new THREE.BoxGeometry(h * 0.44, 1.2, CAR_W - 3).translate(-h * 0.1, 27.8, 0);
  const wheelG = new THREE.CylinderGeometry(5.2, 5.2, 4, 12).rotateX(Math.PI / 2);
  return { bodyG, glassG, screenG, roofG, wheelG, lightG: new THREE.BoxGeometry(1.5, 3, 5) };
}
function addCars(g, cars) {
  const G = carGeos(), n = Math.max(1, cars.length);
  const body = new THREE.InstancedMesh(G.bodyG, solid({ color: '#ffffff' }), n);
  const glass = new THREE.InstancedMesh(G.glassG, solid({ color: '#0d1116' }), n);
  const screen = new THREE.InstancedMesh(G.screenG, solid({ color: '#1a2633' }), n);
  const roof = new THREE.InstancedMesh(G.roofG, solid({ color: '#ffffff' }), n);
  const wheels = new THREE.InstancedMesh(G.wheelG, lambert({ color: '#141414' }), n * 4);
  const lights = new THREE.InstancedMesh(G.lightG, new THREE.MeshBasicMaterial({ color: '#ffffff' }), n * 4);
  for (const m of [body, glass, screen, roof, wheels, lights]) { m.frustumCulled = false; m.count = 0; }
  const car = new THREE.Object3D(), part = new THREE.Object3D();
  cars.forEach((c, i) => {
    const hz = c.w > c.h, len = hz ? c.w : c.h, wid = hz ? c.h : c.w;
    // which way it faces is fixed per car so it doesn't change between clients
    const flip = (Math.floor(c.x * 7 + c.y * 13) & 1) ? Math.PI : 0;
    car.position.set(c.x + c.w / 2, 0, c.y + c.h / 2); car.rotation.set(0, (hz ? 0 : -Math.PI / 2) + flip, c.burned ? 0.04 : 0); car.scale.set(len / CAR_L, (c.burned ? 0.9 : 1) * len / CAR_L * 0.85, wid / CAR_W);
    car.updateMatrix();
    body.setMatrixAt(i, car.matrix); body.setColorAt(i, tmpC.set(c.burned ? '#2a2522' : c.color));
    glass.setMatrixAt(i, car.matrix); glass.setColorAt(i, tmpC.set(c.burned ? '#050505' : '#ffffff'));
    screen.setMatrixAt(i, car.matrix); screen.setColorAt(i, tmpC.set(c.burned ? '#050505' : '#ffffff'));
    roof.setMatrixAt(i, car.matrix); roof.setColorAt(i, tmpC.set(c.burned ? '#231f1c' : c.color).multiplyScalar(1.12));
    let k = 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      part.position.set(sx * CAR_L * 0.31, 5.2, sz * (CAR_W / 2 - 1)); part.rotation.set(0, 0, 0); part.scale.set(1, 1, 1); part.updateMatrix();
      wheels.setMatrixAt(i * 4 + k, tmpM.multiplyMatrices(car.matrix, part.matrix));
      // headlights at the nose, tail lights at the back; burned cars have none
      part.position.set(sx * (CAR_L / 2 + 0.6), 12, sz * (CAR_W / 2 - 4)); part.updateMatrix();
      lights.setMatrixAt(i * 4 + k, tmpM.multiplyMatrices(car.matrix, part.matrix));
      lights.setColorAt(i * 4 + k, tmpC.set(c.burned ? '#120d0a' : sx > 0 ? '#fff2c4' : '#ff3324'));
      k++;
    }
  });
  body.count = glass.count = screen.count = roof.count = cars.length; wheels.count = lights.count = cars.length * 4;
  g.add(body, glass, screen, roof, wheels, lights);
}

function disposeWorld() {
  if (!world) return;
  scene.remove(world.group);
  for (const g of itemViews.values()) world.group.remove(g); // their parts are shared, keep them
  world.group.traverse(o => { if (o.isMesh || o.isSprite || o.isLine) { if (o.geometry && o.geometry !== boxGeo) o.geometry.dispose(); const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { if (m.map && m.map !== flameTex) m.map.dispose(); m.dispose(); } } });
  for (const v of players.values()) scene.remove(v.holder);
  for (const v of zombieViews.values()) scene.remove(v.holder);
  players.clear(); itemViews.clear(); zombieViews.clear();
  world = null;
}

// W: the arrays from DUBG.buildWorld plus WORLD/SHOPS; ground: a canvas of the baked 2D ground; scale: its px per unit
function setWorld(W, ground, scale) {
  if (!renderer) return;
  disposeWorld();
  const g = new THREE.Group();
  world = { group: g, W, roofs: [], bwalls: [], doors: [], flames: [], lights: [], bars: [] };
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
  for (const w of W.walls) if (w.kind === 'wall') { const b = W.buildings.find(b => !b.mall && inB(w, b)); if (b) byB.get(b).push(w); else loose.push(w); }
  for (const [b, ws] of byB) {
    if (b.mall) {
      const roofMat = solid({ color: b.roof, transparent: true }), spare = new THREE.MeshBasicMaterial();
      const roof = new THREE.Mesh(boxGeo, roofMat); roof.position.set(b.x + b.w / 2, H.wall, b.y + b.h / 2); roof.scale.set(b.w + 8, 3, b.h + 8);
      g.add(roof); world.roofs.push({ b, mats: [spare, spare, roofMat], roof, a: 1 });
      continue;
    }
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
  addCars(g, W.cars);
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
  // the mall: food court counters, the dry fountain, planters, and plank barricades in the doorways
  const counters = W.walls.filter(w => w.kind === 'counter');
  g.add(boxes(counters, solid({ color: '#5a4634' }), rectBox(24)), boxes(counters, solid({ color: '#7a6248' }), rectBox(3, 24, 1)));
  for (const w of W.walls.filter(w => w.kind === 'fountain')) {
    const f = new THREE.Mesh(new THREE.CylinderGeometry(w.w / 2 + 6, w.w / 2 + 8, 14, 28).translate(0, 7, 0), solid({ color: '#6a6e70' }));
    const pool = new THREE.Mesh(new THREE.CylinderGeometry(w.w / 2 - 4, w.w / 2 - 4, 2, 28).translate(0, 14, 0), lambert({ color: '#26302c' }));
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(6, 9, 30, 12).translate(0, 15, 0), solid({ color: '#7d8183' }));
    for (const m of [f, pool, spout]) { m.position.set(w.x + w.w / 2, 0, w.y + w.h / 2); g.add(m); }
  }
  const planters = W.walls.filter(w => w.kind === 'planter');
  g.add(boxes(planters, solid({ color: '#4a4038' }), rectBox(16)), boxes(planters, solid({ color: '#5a4a2c' }), (w, o) => { o.position.set(w.x + w.w / 2, 16, w.y + w.h / 2); o.rotation.set(0.3, 0.7, 0.2); o.scale.set(3, 22, 3); }));
  for (const b of W.barricades || []) {
    const hz = b.w > b.h, len = (hz ? b.w : b.h) + 10, grp = new THREE.Group(), planks = [];
    grp.position.set(b.x + b.w / 2, 0, b.y + b.h / 2); if (!hz) grp.rotation.y = Math.PI / 2;
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(boxGeo, solid({ color: i % 2 ? '#7a5a36' : '#8e6a40' }));
      m.position.set(0, 8 + i * 10, (i % 2 ? 2 : -2)); m.rotation.set(0, 0, (i % 2 ? 1 : -1) * (0.1 + i * 0.03)); m.scale.set(len, 7, 4);
      grp.add(m); planks.push(m);
    }
    g.add(grp); world.bars.push({ b, planks });
  }
  for (const st of W.stores || []) world.lights.push({ x: st.x + st.w / 2, y: st.y + st.h / 2, h: 60, r: 260, color: W.ZSIGN[st.kind], base: 0.9 });
  // neon signs light up the street in their colour
  for (const b of W.buildings) {
    if (b.mall) continue;
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
  world.zone = { zw, zo, zn, off: W.mode === 'zombie' };
  scene.add(g);
}

// ---------- players ----------
// Block characters, built from boxes so every outfit from the 2D game carries over.
// Sizes in world units; the figure is about 58 tall and faces +Z. Limbs hang from their joints.
const PANTS = ['#1f2a3a', '#232323', '#3b3326', '#1d2b26', '#2e2a33'];
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const limbBox = new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0); // pivot at the top
const matCache = new Map();
function mat(c) { if (!matCache.has(c)) matCache.set(c, fogify(new THREE.MeshLambertMaterial({ color: c }))); return matCache.get(c); }
function box(parent, geo, c, w, h, d, x, y, z) {
  const m = new THREE.Mesh(geo, mat(c)); m.scale.set(w, h, d); m.position.set(x, y, z); m.frustumCulled = false; parent.add(m); return m;
}
const hex = c => '#' + tmpC.set(c).getHexString();
const shade = (c, k) => hex(tmpC.set(c).multiplyScalar(k));
function addHat(head, L, crew) {
  const hat = L.hat, top = 13;
  if (hat === 'cap' || hat === 'capBack') {
    box(head, unitBox, crew, 14, 4, 14, 0, top - 1, 0);
    box(head, unitBox, shade(crew, 0.6), 12, 1.5, 7, 0, top - 2.5, hat === 'cap' ? 9 : -9);
  } else if (hat === 'beanie') {
    box(head, unitBox, L.beanie, 14, 6, 14, 0, top, 0);
    box(head, unitBox, shade(L.beanie, 0.75), 14.4, 2, 14.4, 0, top - 3, 0);
  } else if (hat === 'durag') {
    box(head, unitBox, crew, 14, 3.5, 14, 0, top - 1, 0);
    box(head, unitBox, crew, 4, 2, 9, 0, top - 4, -10);
  } else if (hat === 'dreads') {
    box(head, unitBox, '#1a120c', 14, 3, 14, 0, top - 1, 0);
    for (let i = 0; i < 7; i++) { const a = Math.PI * (0.15 + i * 0.12); box(head, unitBox, '#1a120c', 2.6, 10, 2.6, Math.cos(a) * 7, top - 7, -Math.sin(a) * 6.5); }
  } else if (hat === 'buzz') {
    box(head, unitBox, '#1a120c', 13.4, 1.5, 13.4, 0, top - 0.6, 0);
  } else if (hat === 'bandana') {
    box(head, unitBox, '#1a120c', 13.6, 2, 13.6, 0, top - 0.5, 0);
    box(head, unitBox, crew, 14, 3, 14, 0, top - 3, 0);
    box(head, unitBox, crew, 3, 2, 6, 3, top - 4, -9);
  }
}
function makePlayer(P, isMe) {
  const L = P.look, crew = P.crew.c, hoodie = L.hoodie, skin = L.skin;
  const pants = PANTS[P.id % PANTS.length], shoe = P.id % 3 === 0 ? crew : '#e9e6df';
  const holder = new THREE.Group(), rig = new THREE.Group(); holder.add(rig); holder.scale.setScalar(BODY);
  // legs swing from the hips; the hips turn toward where you walk while the chest faces your aim
  const hips = new THREE.Group(); hips.position.y = 22; rig.add(hips);
  const legs = [-1, 1].map(s => {
    const leg = new THREE.Group(); leg.position.x = s * 4.2; hips.add(leg);
    box(leg, limbBox, pants, 7.5, 18, 8, 0, 0, 0);
    box(leg, unitBox, shoe, 8, 4.5, 11, 0, -19.5, 1.5);
    box(leg, unitBox, shade(shoe, 0.8), 8.2, 1.2, 11.2, 0, -21.4, 1.5);
    return leg;
  });
  const chest = new THREE.Group(); chest.position.y = 22; rig.add(chest);
  box(chest, unitBox, hoodie, 18, 19, 10, 0, 9.5, 0);
  box(chest, unitBox, shade(hoodie, 0.8), 10, 5, 1, 0, 5, 5.2);                 // pouch pocket
  box(chest, unitBox, shade(hoodie, 0.7), 14, 6, 4, 0, 17.5, -6);               // hood resting on the back
  box(chest, unitBox, crew, 18.4, 2.5, 10.4, 0, 1.2, 0);                        // crew colour at the waistband
  const vest = box(chest, unitBox, '#2c3340', 19, 14, 11, 0, 10, 0); vest.visible = false;
  const arms = [-1, 1].map(s => {
    const arm = new THREE.Group(); arm.position.set(s * 11.5, 18, 0); chest.add(arm);
    box(arm, limbBox, hoodie, 6, 15, 7, 0, 0, 0);
    box(arm, unitBox, skin, 5.5, 4.5, 5.5, 0, -17, 0);
    return arm;
  });
  const head = new THREE.Group(); head.position.y = 19; chest.add(head);
  box(head, unitBox, skin, 13, 13, 13, 0, 6.5, 0);
  box(head, unitBox, '#141414', 2.4, 2.4, 1, -3, 7.5, 6.6);
  box(head, unitBox, '#141414', 2.4, 2.4, 1, 3, 7.5, 6.6);
  box(head, unitBox, shade(skin, 0.75), 5, 1.2, 1, 0, 3, 6.6);
  addHat(head, L, crew);
  // the gun sits in the right hand; it points along the arm, and the arm points where you aim
  const gun = new THREE.Group(); gun.position.set(0, -18, 0); gun.rotation.x = Math.PI / 2; gun.scale.setScalar(1.2); arms[0].add(gun);
  // crew ring under the feet (white for you)
  const ring = new THREE.Mesh(new THREE.RingGeometry(15, 19, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: isMe ? '#ffffff' : crew, transparent: true, opacity: isMe ? 0.8 : 0.65, depthWrite: false }));
  ring.position.y = 0.8; holder.add(ring);
  const mats = [];
  rig.traverse(o => { if (o.isMesh) o.userData.base = o.material; });
  scene.add(holder);
  return { holder, rig, hips, legs, chest, arms, head, vest, gun, ring, mats, lx: P.x, ly: P.y, mvx: 0, mvy: 0, speed: 0, phase: 0, punch: 0, fall: 0, gunType: null, hurt: false };
}
const TWO_HANDED = { smg: true, shotgun: true, rifle: true, rpg: true };
// Block guns: barrel along +Z, up is +Y, the grip at the origin where the hand holds it.
const METAL = '#1c1e21', STEEL = '#3a3f46', WOOD = '#6b4426', BRASS = '#c9a24a';
function tilt(m, rx) { m.rotation.x = rx; return m; }
const GUN_BUILD = {
  pistol(g) {
    box(g, unitBox, STEEL, 3, 3.4, 13, 0, 4.2, 4.5);             // slide
    box(g, unitBox, METAL, 2.8, 2, 10, 0, 1.8, 4);               // frame
    tilt(box(g, unitBox, METAL, 2.6, 7, 3.6, 0, -1.5, -0.6), 0.28); // grip
    box(g, unitBox, METAL, 1, 1, 1, 0, 6.2, 10.5);               // front sight
  },
  smg(g) {
    box(g, unitBox, METAL, 3.6, 5, 13, 0, 3.2, 4);               // body
    box(g, unitBox, STEEL, 1.8, 1.8, 6, 0, 4, 13);               // barrel
    tilt(box(g, unitBox, METAL, 2.4, 9, 3, 0, -2.5, 7), 0.12);   // long magazine
    tilt(box(g, unitBox, METAL, 2.6, 6, 3, 0, -1, -0.5), 0.25);  // grip
    box(g, unitBox, STEEL, 1.2, 1.2, 8, 0, 4.2, -6);             // folding stock
    box(g, unitBox, STEEL, 1.6, 5, 1.4, 0, 2.6, -10);
  },
  shotgun(g) {
    box(g, unitBox, METAL, 2.2, 2.2, 22, 0, 4.8, 12);            // barrel
    box(g, unitBox, STEEL, 2, 2, 15, 0, 2.6, 11);                // magazine tube
    box(g, unitBox, WOOD, 3.2, 3.2, 7, 0, 2.6, 13);              // pump
    box(g, unitBox, METAL, 3.2, 5, 8, 0, 3.4, 0.5);              // receiver
    tilt(box(g, unitBox, METAL, 2.6, 5.5, 3, 0, -0.5, -1.5), 0.3);
    tilt(box(g, unitBox, WOOD, 3, 5, 11, 0, 1.8, -8.5), -0.12);  // stock
  },
  rifle(g) {
    box(g, unitBox, METAL, 3.2, 5, 13, 0, 3.4, 3);               // receiver
    box(g, unitBox, STEEL, 3, 3.6, 9, 0, 3.8, 13);               // handguard
    box(g, unitBox, METAL, 1.5, 1.5, 7, 0, 4.2, 20.5);           // barrel
    tilt(box(g, unitBox, METAL, 2.6, 9, 3.4, 0, -2, 6.5), 0.32); // curved magazine
    tilt(box(g, unitBox, METAL, 2.6, 6, 3, 0, -1, -0.8), 0.28);  // grip
    box(g, unitBox, METAL, 3, 5.5, 9, 0, 3, -8);                 // stock
    box(g, unitBox, STEEL, 2.2, 2.2, 8, 0, 7.4, 3);              // scope
    box(g, unitBox, '#7fb6ff', 1.6, 1.6, 0.4, 0, 7.4, 7.1);      // lens
    box(g, unitBox, METAL, 1, 1.6, 1, 0, 5.8, 0.5); box(g, unitBox, METAL, 1, 1.6, 1, 0, 5.8, 5.5);
  },
  rpg(g) {
    const tube = cyl(g, '#4b5a2e', 2.6, 34, 0, 5, 6); tube.rotation.x = Math.PI / 2;      // launch tube
    const bell = cyl(g, '#2a3119', 3.2, 4, 0, 5, -11); bell.rotation.x = Math.PI / 2;     // back blast cone
    const head = cyl(g, '#9fd356', 3.6, 7, 0, 5, 25); head.rotation.x = Math.PI / 2;      // warhead sticking out the front
    box(g, unitBox, '#9fd356', 2, 2, 4, 0, 5, 30);
    tilt(box(g, unitBox, METAL, 2.4, 6, 3, 0, 0, 0), 0.25);                               // grip
    tilt(box(g, unitBox, METAL, 2.4, 5, 3, 0, 0.5, 10), 0.1);                             // front grip
    box(g, unitBox, STEEL, 1.6, 3, 4, 1.8, 9, 6);                                         // sight
  },
};
const gunProto = {};
function gunModel(type) {
  if (!GUN_BUILD[type]) return new THREE.Group();
  if (!gunProto[type]) { const g = new THREE.Group(); GUN_BUILD[type](g); gunProto[type] = g; }
  return gunProto[type].clone();
}
function updatePlayer(P, v, dt, visible) {
  const x = P.x, y = P.y, k = Math.min(1, dt * 10);
  v.mvx += ((x - v.lx) / Math.max(dt, 1e-3) - v.mvx) * k; v.mvy += ((y - v.ly) / Math.max(dt, 1e-3) - v.mvy) * k;
  v.speed = Math.min(400, Math.hypot(v.mvx, v.mvy));
  v.lx = x; v.ly = y;
  v.holder.position.set(x, 0, y);
  v.holder.rotation.y = Math.PI / 2 - P.ang;
  v.holder.visible = visible;
  v.vest.visible = P.armor > 0;
  // swap the gun model when they change weapons
  if (v.gunType !== P.gun) {
    v.gunType = P.gun; v.gun.clear(); v.tip = null;
    if (P.gun) {
      // a marker at the end of the barrel, so shots can start from the gun instead of the body
      const gm = gunModel(P.gun), box = new THREE.Box3().setFromObject(gm);
      v.tip = new THREE.Object3D(); v.tip.position.set(0, (box.min.y + box.max.y) / 2, box.max.z); gm.add(v.tip);
      v.gun.add(gm);
    }
  }
  v.gun.visible = !!P.gun && P.alive;
  if (!P.alive) {
    // fall flat on the back
    v.fall = Math.min(1, v.fall + dt * 3.5);
    const e = 1 - Math.pow(1 - v.fall, 3);
    v.rig.rotation.x = -Math.PI / 2 * e; v.rig.position.y = 4 * e; v.rig.position.z = -14 * e;
    v.arms[0].rotation.set(-2.6 * e, 0, 0.3 * e); v.arms[1].rotation.set(-2.6 * e, 0, -0.3 * e);
    v.ring.visible = false;
    return;
  }
  v.fall = 0; v.rig.rotation.x = 0; v.rig.position.set(0, 0, 0); v.ring.visible = true;
  // walk cycle: legs face the direction of travel, swing faster the quicker you go
  const moving = v.speed > 20;
  let legYaw = 0, dir = 1;
  if (moving) {
    const rel = Math.atan2(v.mvy, v.mvx) - P.ang;
    let r = Math.atan2(Math.sin(rel), Math.cos(rel));
    if (Math.abs(r) > Math.PI / 2) { r = Math.atan2(Math.sin(r + Math.PI), Math.cos(r + Math.PI)); dir = -1; } // backpedal
    legYaw = -r;
    v.phase += dt * v.speed * 0.055 * dir;
  }
  const amt = moving ? Math.min(1, v.speed / 180) : 0;
  v.hips.rotation.y += (legYaw - v.hips.rotation.y) * k;
  const sw = Math.sin(v.phase) * 0.85 * amt;
  v.legs[0].rotation.x = sw; v.legs[1].rotation.x = -sw;
  v.rig.position.y = moving ? Math.abs(Math.cos(v.phase)) * 2 * amt : Math.sin(performance.now() / 600 + P.id) * 0.4;
  v.chest.rotation.y = -v.hips.rotation.y * 0.25;
  // arms: aim the gun, punch, or swing
  if (P.punch > 0 || (P.flags & 4)) v.punch = 0.22;
  v.punch -= dt;
  const [R, Lf] = v.arms;
  if (P.gun) {
    const kick = P.flash > 0 ? 0.12 : 0;
    R.rotation.set(-Math.PI / 2 + kick, 0, 0);
    if (TWO_HANDED[P.gun]) Lf.rotation.set(-Math.PI / 2 + 0.15 + kick, 0, -0.55); else Lf.rotation.set(sw * 0.6 - 0.1, 0, 0.08);
  } else if (v.punch > 0) {
    R.rotation.set(-Math.PI / 2, 0, 0.15); Lf.rotation.set(-0.9, 0, -0.2);
  } else {
    R.rotation.set(-sw * 0.9 - 0.25, 0, 0.06); Lf.rotation.set(sw * 0.9 - 0.25, 0, -0.06);
  }
  // hit flash
  const hurt = P.hurt > 0;
  // guns are swapped in after the player is built, so their parts pick up a base material here
  if (hurt !== v.hurt) {
    v.hurt = hurt;
    v.rig.traverse(o => {
      if (!o.isMesh) return;
      if (!o.userData.base) o.userData.base = o.material;
      o.material = hurt ? hurtMat : o.userData.base;
    });
  }
}
const hurtMat = fogify(new THREE.MeshLambertMaterial({ color: '#ff5a4a', emissive: '#a01810' }));
// muzzle position of a player's gun, for the muzzle flash light
function muzzle(P) { return P.muzzle || { x: P.x + Math.cos(P.ang) * 22, y: P.y + Math.sin(P.ang) * 22, h: H.aim }; }

// ---------- zombies: the same block figures, rotten, arms out; the boss towers over the walls ----------
// (3x here, not the 5x of the top-down view: at 5x the tilted camera sees nothing but boss)
const BOSS_K = 3;
const zombieViews = new Map();
const ZSKIN = ['#7d9a5a', '#8aa06a', '#6e8a58', '#93a37a'], ZCLOTH = ['#3b3a33', '#4a3a2e', '#2f3a40', '#5a4a3a', '#3a4030', '#5e1d1d'];
function makeZombie(Z) {
  const skin = Z.boss ? '#6f8a4a' : ZSKIN[Z.id % 4], cloth = Z.boss ? '#3a3226' : ZCLOTH[Z.id % 6], pants = PANTS[Z.id % PANTS.length], blood = '#6b1a14';
  const holder = new THREE.Group(), rig = new THREE.Group(); holder.add(rig); holder.scale.setScalar(BODY * (Z.boss ? BOSS_K : 1));
  const hips = new THREE.Group(); hips.position.y = 22; rig.add(hips);
  const legs = [-1, 1].map(s => {
    const leg = new THREE.Group(); leg.position.x = s * 4.2; hips.add(leg);
    box(leg, limbBox, pants, 7.5, 18, 8, 0, 0, 0);
    box(leg, unitBox, '#2a241e', 8, 4.5, 11, 0, -19.5, 1.5);
    return leg;
  });
  const chest = new THREE.Group(); chest.position.y = 22; chest.rotation.x = 0.25; rig.add(chest);   // hunched forward
  box(chest, unitBox, cloth, Z.boss ? 24 : 18, 19, Z.boss ? 16 : 10, 0, 9.5, 0);
  box(chest, unitBox, blood, 7, 6, 1, -3, 7, Z.boss ? 8.2 : 5.2);       // bloodstain
  box(chest, unitBox, skin, 5, 5, 1, 5, 13, Z.boss ? 8.2 : 5.2);        // skin through a tear
  const arms = [-1, 1].map(s => {
    const arm = new THREE.Group(); arm.position.set(s * (Z.boss ? 14 : 11.5), 18, 0); chest.add(arm);
    box(arm, limbBox, s < 0 ? cloth : skin, 6, 15, 7, 0, 0, 0);
    box(arm, unitBox, skin, 5.5, 4.5, 5.5, 0, -17, 0);
    return arm;
  });
  const head = new THREE.Group(); head.position.y = 19; head.rotation.x = -0.2; chest.add(head);
  box(head, unitBox, skin, 13, 13, 13, 0, 6.5, 1);
  const eye = Z.boss ? '#ff3a2a' : '#e8e26a';
  box(head, unitBox, eye, 2.4, 2.4, 1, -3, 7.5, 7.6); box(head, unitBox, eye, 2.4, 2.4, 1, 3, 7.5, 7.6);
  box(head, unitBox, blood, 6, 2, 1, 0, 2.8, 7.6);                        // the mouth
  box(head, unitBox, shade(skin, 0.6), 5, 3, 1, -3, 11, 7.6);             // rot
  rig.traverse(o => { if (o.isMesh) o.userData.base = o.material; });
  scene.add(holder);
  return { holder, rig, hips, legs, chest, arms, lx: Z.x, ly: Z.y, mvx: 0, mvy: 0, speed: 0, phase: Z.id, hurt: false, dead: false };
}
function updateZombie(Z, v, dt, visible) {
  const k = Math.min(1, dt * 10);
  v.mvx += ((Z.x - v.lx) / Math.max(dt, 1e-3) - v.mvx) * k; v.mvy += ((Z.y - v.ly) / Math.max(dt, 1e-3) - v.mvy) * k;
  v.speed = Math.min(300, Math.hypot(v.mvx, v.mvy)); v.lx = Z.x; v.ly = Z.y;
  v.holder.position.set(Z.x, 0, Z.y); v.holder.rotation.y = Math.PI / 2 - Z.ang; v.holder.visible = visible;
  // a dragging shamble: slow, uneven steps
  v.phase += dt * v.speed * 0.05;
  const sw = Math.sin(v.phase) * 0.6 * Math.min(1, v.speed / 80);
  v.legs[0].rotation.x = sw; v.legs[1].rotation.x = -sw * 0.6;
  v.rig.rotation.z = Math.sin(v.phase * 0.5) * 0.06;
  // arms reach forward; a bite snaps them down and in
  const bite = Z.atk > 0, t = performance.now() / 1000;
  v.arms[0].rotation.set(-Math.PI / 2 + (bite ? 0.5 : Math.sin(t * 3 + Z.id) * 0.1), 0, bite ? 0.35 : 0);
  v.arms[1].rotation.set(-Math.PI / 2 + (bite ? 0.5 : Math.sin(t * 3.4 + Z.id) * 0.1), 0, bite ? -0.35 : 0);
  const hurt = Z.hurt > 0;
  if (hurt !== v.hurt) { v.hurt = hurt; v.rig.traverse(o => { if (o.isMesh) o.material = hurt ? hurtMat : o.userData.base; }); }
}

// ---------- items: 3D pickups that float and turn above a glowing ring ----------
const ringGeo = new THREE.RingGeometry(8, 10.5, 24).rotateX(-Math.PI / 2);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
function cyl(parent, c, r, h, x, y, z) { const m = new THREE.Mesh(cylGeo, mat(c)); m.scale.set(r, h, r); m.position.set(x, y, z); parent.add(m); return m; }
const ITEM_BUILD = {
  med(g) {
    box(g, unitBox, '#f1ede4', 14, 9, 10, 0, 0, 0);
    box(g, unitBox, '#d9d3c6', 14.2, 1.2, 10.2, 0, 1.5, 0);          // lid seam
    box(g, unitBox, '#e23a2e', 6.5, 0.6, 2, 0, 4.8, 0); box(g, unitBox, '#e23a2e', 2, 0.6, 6.5, 0, 4.8, 0); // cross on the lid
    box(g, unitBox, '#e23a2e', 5, 1.6, 0.6, 0, -0.5, 5.1); box(g, unitBox, '#e23a2e', 1.6, 5, 0.6, 0, -0.5, 5.1); // and the front
    box(g, unitBox, '#5a5a5a', 6, 1.2, 1.4, 0, 5.4, 0);              // handle
  },
  band(g) {
    const roll = cyl(g, '#f1ede4', 4.2, 7, 0, 0, 0); roll.rotation.z = Math.PI / 2;
    const core = cyl(g, '#c9c0ad', 1.6, 7.2, 0, 0, 0); core.rotation.z = Math.PI / 2;
    tilt(box(g, unitBox, '#e8e3d8', 5.5, 0.5, 9, 0, -3.8, 5), 0.25);   // loose end
  },
  ammo(g) {
    box(g, unitBox, '#4f5a32', 13, 7, 8, 0, 0, 0);
    box(g, unitBox, '#3d4626', 13.2, 1.4, 8.2, 0, 3, 0);             // lid
    box(g, unitBox, '#d8c27c', 5, 2.4, 0.4, 0, 0, 4.1);              // label
    for (let i = -1; i <= 1; i++) { cyl(g, BRASS, 1.1, 5, i * 3.2, 6, 0); cyl(g, '#8a5a2a', 0.8, 1.6, i * 3.2, 9.2, 0); }
  },
  gren(g) {
    const body = new THREE.Mesh(new THREE.SphereGeometry(4.2, 12, 10), mat('#5f7438')); body.scale.y = 1.2; g.add(body);
    cyl(g, '#b9b3a3', 1.6, 2.4, 0, 5.6, 0);                          // fuse top
    tilt(box(g, unitBox, '#b9b3a3', 1, 6, 1.6, 2.4, 3, 0), -0.3);    // lever
  },
  rocket(g) {
    for (const x of [-3.4, 3.4]) { cyl(g, '#9fd356', 2.4, 12, x, 0, 0); const tip = new THREE.Mesh(new THREE.ConeGeometry(2.4, 5, 10), mat('#9fd356')); tip.position.set(x, 8.5, 0); g.add(tip); }
  },
  crate(g) {
    box(g, unitBox, '#3f4a2c', 26, 22, 26, 0, 11, 0);
    for (const [w, d] of [[27, 6], [6, 27]]) box(g, unitBox, '#ff4b3a', w, 22.4, d, 0, 11, 0);
    box(g, unitBox, '#2c3420', 27, 2, 27, 0, 22, 0);
    // a red beacon so people can find it from a distance
    const beam = new THREE.Mesh(cylGeo, fogify(new THREE.MeshBasicMaterial({ color: '#ff4b3a', transparent: true, opacity: 0.22, depthWrite: false })));
    beam.scale.set(4, 360, 4); beam.position.y = 180; g.add(beam);
  },
  vest1(g) { vest(g, '#5aa7ff', 1); },
  vest2(g) { vest(g, '#2f5fbf', 1.15); },
};
function vest(g, c, k) {
  box(g, unitBox, c, 13 * k, 15 * k, 4, 0, 0, 1.5);                  // front plate
  box(g, unitBox, shade(c, 0.75), 13 * k, 15 * k, 3, 0, 0, -2.5);     // back plate
  box(g, unitBox, shade(c, 0.6), 3, 4, 7, -4.5 * k, 8 * k, -0.5); box(g, unitBox, shade(c, 0.6), 3, 4, 7, 4.5 * k, 8 * k, -0.5); // shoulder straps
  if (k > 1) for (const x of [-4, 0, 4]) box(g, unitBox, shade(c, 0.55), 3.4, 4.5, 2, x, -3, 4.2); // pouches on the heavy one
}
const itemProto = {};
function itemModel(type, d) {
  if (!itemProto[type]) {
    const g = new THREE.Group();
    if (d.kind === 'gun') { const gm = gunModel(type); gm.rotation.y = Math.PI / 2; gm.scale.setScalar(1.25); g.add(gm); }
    else if (ITEM_BUILD[type]) ITEM_BUILD[type](g);
    else box(g, unitBox, d.color, 10, 8, 10, 0, 0, 0);
    itemProto[type] = g;
  }
  return itemProto[type].clone();
}
const ringMats = new Map();
function ringMat(c) { if (!ringMats.has(c)) ringMats.set(c, fogify(new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthWrite: false }))); return ringMats.get(c); }
function makeItem(it, ITEMS) {
  const d = ITEMS[it.type], g = new THREE.Group();
  const ring = new THREE.Mesh(ringGeo, ringMat(d.color));
  ring.position.y = 0.9; g.add(ring);
  const still = d.kind === 'crate';   // the airdrop crate sits on the ground instead of floating
  const icon = new THREE.Group(); icon.position.y = still ? 0 : 10; icon.scale.setScalar(still ? 0.85 : 0.8); icon.add(itemModel(it.type, d)); g.add(icon);
  if (still) ring.scale.setScalar(2);
  g.position.set(it.x, 0, it.y);
  g.userData = { ring, icon, still };
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
  for (const r of world.bars) r.planks.forEach((m, i) => { m.visible = i < r.b.hp; });
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
  Z.zw.position.set(z.cur.x, 0, z.cur.y); Z.zw.scale.set(zr, 260, zr); Z.zw.visible = F.fogOn && !Z.off;
  Z.zo.position.set(z.cur.x, 1.2, z.cur.y); Z.zo.scale.set(zr, 1, zr); Z.zo.visible = F.fogOn && !Z.off;
  Z.zn.visible = F.fogOn && !!z.next && !Z.off; if (z.next) { Z.zn.position.set(z.next.x, 2, z.next.y); Z.zn.scale.set(Math.max(1, z.next.r), 1, Math.max(1, z.next.r)); }
  // items: only the ones in sight are drawn
  const seenItem = it => !F.fogOn || F.canSeePt(it.x, it.y);
  for (const [id, g] of itemViews) if (!M.items.has(id)) { world.group.remove(g); itemViews.delete(id); }
  for (const it of M.items.values()) {
    if (Math.abs(it.x - cx) > 1300 || Math.abs(it.y - cy) > 1100) { const g = itemViews.get(it.id); if (g) g.visible = false; continue; }
    let g = itemViews.get(it.id); if (!g) { g = makeItem(it, F.ITEMS); itemViews.set(it.id, g); }
    g.visible = g.userData.still || seenItem(it);
    if (g.visible && !g.userData.still) { g.userData.icon.rotation.y = t * 1.2 + it.x; g.userData.icon.position.y = 10 + Math.sin(t * 3 + it.x * 0.1) * 2; }
  }
  // players
  let flash = null;
  for (const P of M.list) {
    if (!P.init) continue;
    let v = players.get(P.id); if (!v) { v = makePlayer(P, P.id === M.me); players.set(P.id, v); }
    const visible = P.alive ? !!P.seen : (!F.fogOn || F.canSeePt(P.x, P.y));
    updatePlayer(P, v, dt, visible);
    // where this player's barrel ends right now (x, y on the map, h above the ground)
    if (v.tip && P.alive) { v.tip.getWorldPosition(tmpV); P.muzzle = { x: tmpV.x, y: tmpV.z, h: tmpV.y }; } else P.muzzle = null;
    if (P.seen && P.flash > 0 && P.gun && (!flash || P === vw)) flash = P;
  }
  // zombies: dead ones topple and stay down a moment before they go
  for (const [id, v] of zombieViews) if (!M.zombies.has(id) && !v.dead) { v.dead = true; v.fall = 0; }
  for (const Zm of M.zombies.values()) {
    let v = zombieViews.get(Zm.id); if (!v) { v = makeZombie(Zm); zombieViews.set(Zm.id, v); }
    updateZombie(Zm, v, dt, !F.fogOn || F.canSeePt(Zm.x, Zm.y));
  }
  for (const [id, v] of zombieViews) {
    if (!v.dead) continue;
    v.fall = Math.min(1, v.fall + dt * 3); v.gone = (v.gone || 0) + dt;
    const e = 1 - Math.pow(1 - v.fall, 3);
    v.rig.rotation.x = Math.PI / 2 * e; v.rig.position.y = 4 * e; v.rig.position.z = 14 * e;
    if (v.gone > 2.5) { scene.remove(v.holder); zombieViews.delete(id); }
  }
  if (flash) { const mz = muzzle(flash); api.flashL.position.set(mz.x, mz.h, mz.y); api.flashL.intensity = 2.2; } else api.flashL.intensity = Math.max(0, api.flashL.intensity - dt * 30);
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

const api = { zoomMul: 1, BOSS_K, init, resize, setWorld, frame, project, toWorld, pxScale, get ok() { return !!renderer; }, get hasWorld() { return !!world; }, AIM_H: H.aim };
window.R3D = api;
window.dispatchEvent(new Event('r3d-ready'));
