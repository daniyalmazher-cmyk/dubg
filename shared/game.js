// DUBG shared game logic: map generation, collision and the authoritative match simulation.
// Loaded by the Node server (require) and by the browser (<script>, exposes window.DUBG).
(function (root, factory) {
  const api = factory();
  api.instance = factory;   // a fresh, independent copy (one per match on the server)
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DUBG = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const TAU = Math.PI * 2;

// ---------- helpers ----------
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let R = Math.random;
const rnd = (a, b) => a + R() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function pick(list) { let s = 0; for (const [, w] of list) s += w; let r = R() * s; for (const [v, w] of list) { if ((r -= w) < 0) return v; } return list[0][0]; }
function angDiff(a, b) { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
function lerpAngle(a, b, k) { return a - angDiff(a, b) * Math.min(1, k); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function darken(hex, k) { const n = parseInt(hex.slice(1), 16); return `rgb(${(n >> 16) * k | 0},${(n >> 8 & 255) * k | 0},${(n & 255) * k | 0})`; }

// ---------- data ----------
// city size in blocks; streets run between them every 350 units
const COLS = 10, ROWS = 8;
const XL = Array.from({ length: COLS + 1 }, (_, i) => 140 + i * 350);
const YL = Array.from({ length: ROWS + 1 }, (_, j) => 140 + j * 350);
const XN = XL[COLS], YN = YL[ROWS];
const CITY = { x: 100, y: 100, w: XN + 40 - 100, h: YN + 40 - 100 };
const CX = (XL[0] + XN) / 2, CY = (YL[0] + YN) / 2;
const PRISON = { x: CX - 400, y: YN + 90, w: 800, h: 360 };
const PX = PRISON.x - 800, PY = PRISON.y - 1980; // prison layout below was drawn at x 800, y 1980
const CORR_Y = PY + 2160;
const WORLD = { w: XN + 160, h: PRISON.y + PRISON.h + 100 };
const SCALE = (COLS * ROWS) / 30;
const GATE_L = PRISON.x - 35, GATE_R = PRISON.x + PRISON.w + 35;
// players are small next to the city (a car is about twice as long as a person is tall)
const MAX_PLAYERS = 30, LOCKDOWN = 8, SPEED = 160, BOT_SPEED = 145, BODY_R = 9;
const CAR_L = 80, CAR_W = 30;

const WEAPONS = {
  fists:   { name: 'Fists',   dmg: 14, rate: 0.45, melee: true, range: 26, tier: 0 },
  pistol:  { name: 'Pistol',  dmg: 17, rate: 0.26, spread: 0.05, mag: 12, speed: 1050, range: 520, reload: 1.2, auto: false, tier: 1, len: 11 },
  smg:     { name: 'SMG',     dmg: 11, rate: 0.085, spread: 0.11, mag: 30, speed: 1050, range: 450, reload: 1.8, auto: true, tier: 2, len: 15 },
  shotgun: { name: 'Shotgun', dmg: 10, pellets: 8, rate: 0.85, spread: 0.22, mag: 5, speed: 880, range: 300, reload: 2.2, auto: false, tier: 2, len: 18 },
  rifle:   { name: 'Rifle',   dmg: 23, rate: 0.13, spread: 0.045, mag: 30, speed: 1280, range: 720, reload: 2.0, auto: true, tier: 3, len: 21 },
};
const ITEMS = {
  pistol:  { label: 'Pistol', kind: 'gun', color: '#d8c27c' },
  smg:     { label: 'SMG', kind: 'gun', color: '#e59a4b' },
  shotgun: { label: 'Shotgun', kind: 'gun', color: '#d46a4a' },
  rifle:   { label: 'Rifle', kind: 'gun', color: '#f2c230' },
  ammo:    { label: 'Ammo box', kind: 'ammo', color: '#b9a35a' },
  band:    { label: 'Bandage', kind: 'heal', color: '#f1ede4' },
  med:     { label: 'Medkit', kind: 'heal', color: '#ff5a4e' },
  vest1:   { label: 'Light vest', kind: 'armor', val: 50, color: '#5aa7ff' },
  vest2:   { label: 'Heavy vest', kind: 'armor', val: 100, color: '#3a78ea' },
};
const LOOT_TABLE = [['pistol', 14], ['smg', 9], ['shotgun', 7], ['rifle', 5], ['ammo', 25], ['band', 20], ['med', 7], ['vest1', 8], ['vest2', 4]];
const PHASES = [
  { wait: 50, shrink: 35, r: 1500, dps: 1 },
  { wait: 40, shrink: 30, r: 950, dps: 2 },
  { wait: 32, shrink: 24, r: 560, dps: 4 },
  { wait: 25, shrink: 18, r: 300, dps: 7 },
  { wait: 18, shrink: 14, r: 130, dps: 11 },
  { wait: 12, shrink: 14, r: 0, dps: 18 },
];
const NAMES = ['BigTone', 'LilSmoke', 'Ghostface', 'Kingpin', 'Rico', 'Dre', 'Tiny', 'Scrap', 'Blaze', 'Cash', 'Junebug', 'Nitro', 'Spider', 'Saint', 'Lefty', 'Bones', 'Dutch', 'Mook', 'Shadow', 'Ace', 'Vandal', 'Rocco', 'Diesel', 'Smokey', 'Knuckles', 'Slim', 'Capo', 'Truck', 'Ox'];
const CREWS = [
  { n: 'Dawgz', c: '#ff7a1a' }, { n: 'Vipers', c: '#3ddc84' }, { n: 'Kings', c: '#f2c230' },
  { n: 'Wolves', c: '#a67bff' }, { n: 'Reapers', c: '#e6e2da' }, { n: 'Ghosts', c: '#36d6e7' },
];
const SKINS = ['#8d5524', '#c68642', '#e0ac69', '#5c3a1e', '#f1c27d', '#3d2314', '#a86b3c'];
const HOODIES = ['#1c1c1e', '#2b2f36', '#3a3a3a', '#4b3b2a', '#1f2a3a', '#55524c', '#5e1d1d', '#2f3d2a', '#d9d6cf', '#6b5a3e'];
const BEANIES = ['#1b1b1b', '#5a2a2a', '#2a3a4a', '#d8d2c4', '#3d4a2a'];
const SHOPS = {
  gun:      { sign: 'GUN SHOP', color: '#ff3b3b', floor: '#3a3230', extra: 1, loot: [['pistol', 20], ['smg', 16], ['shotgun', 14], ['rifle', 12], ['ammo', 28], ['vest1', 6], ['vest2', 4]] },
  pawn:     { sign: 'PAWN', color: '#f2c230', floor: '#463c2c', extra: 0, loot: [['pistol', 12], ['smg', 6], ['shotgun', 6], ['rifle', 3], ['ammo', 20], ['band', 10], ['vest1', 14], ['vest2', 8]] },
  pharmacy: { sign: 'PHARMACY', color: '#39e07a', floor: '#3e4644', extra: 0, loot: [['band', 40], ['med', 25], ['ammo', 10], ['pistol', 6]] },
  liquor:   { sign: 'LIQUOR', color: '#3fb8ff', floor: '#3b3646', extra: 0, loot: LOOT_TABLE },
  motel:    { sign: 'MOTEL', color: '#ff4fd8', floor: '#4a3a3e', extra: 0, loot: LOOT_TABLE },
  diner:    { sign: 'DINER', color: '#ffa53a', floor: '#4a3f33', extra: 0, loot: LOOT_TABLE },
  laundry:  { sign: '24H LAUNDRY', color: '#9d7bff', floor: '#3a4048', extra: 0, loot: LOOT_TABLE },
};
const SHOP_PICK = [['pawn', 3], ['pharmacy', 2], ['liquor', 3], ['motel', 2], ['diner', 2], ['laundry', 2]];
const TAG_WORDS = ['DAWGZ', 'VIPERS', 'KINGS', 'WOLVES', 'REAPERS', 'GHOSTS', 'EASTSIDE', 'WESTSIDE', '4 LIFE', 'NO COPS', 'RIP BIG T', 'OUR BLOCK', 'STAY OUT'];
const ROOFS = ['#4a2f26', '#363d44', '#46432f', '#2f3d37', '#45394a', '#553f29', '#3b322a', '#2c2c2e'];
const FLOORS = ['#5e4c3b', '#4f5655', '#5c5547', '#4d4a5a', '#584339'];
const DECOR = ['#3e3328', '#6e3b2e', '#2f4146', '#5a5236', '#3b3048', '#28362f'];
const CAR_COLORS = ['#6e2622', '#22394f', '#9a958a', '#2d2f31', '#4f4b22', '#173f35', '#5b3a1c'];

// ---------- world ----------
let walls, grid, buildings, boarded, trees, blocks, doors, cars, cells, specks;
let lights, cracks, potholes, puddles, patches, manholes, trash, tags, tires;
const GS = 100, GW = Math.ceil(WORLD.w / GS), GH = Math.ceil(WORLD.h / GS), EMPTY = [];
function addWall(x, y, w, h, kind = 'wall') { const o = { x, y, w, h, kind, open: false }; walls.push(o); return o; }

function addBuilding(x, y, w, h, side, lane) {
  if (R() < 0.42) {
    boarded.push({ x, y, w, h, roof: pick(ROOFS.map(c => [c, 1])), roofA: 1, planks: R() < 0.7 });
    addWall(x, y, w, h, 'block');
    return;
  }
  const T = 10, G = 48;
  const b = { x, y, w, h, side, roofA: 1, roof: pick(ROOFS.map(c => [c, 1])), floor: pick(FLOORS.map(c => [c, 1])), decor: [] };
  if (side === 'top' || side === 'bottom') {
    const dx = x + w / 2, wy = side === 'top' ? y : y + h - T;
    addWall(x, wy, w / 2 - G / 2, T); addWall(x + w / 2 + G / 2, wy, w / 2 - G / 2, T);
    addWall(x, side === 'top' ? y + h - T : y, w, T); addWall(x, y, T, h); addWall(x + w - T, y, T, h);
    b.outPt = { x: dx, y: lane, lane: 'h' }; b.inPt = { x: dx, y: side === 'top' ? y + 34 : y + h - 34 };
    b.door = { x: dx - G / 2, y: wy, w: G, h: T };
  } else {
    const dy = y + h / 2, wx = side === 'left' ? x : x + w - T;
    addWall(wx, y, T, h / 2 - G / 2); addWall(wx, y + h / 2 + G / 2, T, h / 2 - G / 2);
    addWall(side === 'left' ? x + w - T : x, y, T, h); addWall(x, y, w, T); addWall(x, y + h - T, w, T);
    b.outPt = { x: lane, y: dy, lane: 'v' }; b.inPt = { x: side === 'left' ? x + 34 : x + w - 34, y: dy };
    b.door = { x: wx, y: dy - G / 2, w: T, h: G };
  }
  const nd = 1 + Math.floor(R() * 3);
  for (let i = 0; i < nd; i++) {
    const dw = rnd(26, Math.min(70, w - 50)), dh = rnd(20, Math.min(60, h - 50));
    b.decor.push({ x: rnd(x + 20, x + w - 20 - dw), y: rnd(y + 20, y + h - 20 - dh), w: dw, h: dh, c: pick(DECOR.map(c => [c, 1])) });
  }
  buildings.push(b);
}

// Same seed gives the same city on the server and in every browser.
function buildWorld(seed) {
  walls = []; buildings = []; boarded = []; trees = []; blocks = []; doors = []; cars = []; cells = []; specks = [];
  lights = []; cracks = []; potholes = []; puddles = []; patches = []; manholes = []; trash = []; tags = []; tires = [];
  const saved = R; R = mulberry32(seed);
  for (let i = 0; i < 260 * SCALE; i++) specks.push({ x: rnd(0, WORLD.w), y: rnd(0, WORLD.h), r: rnd(2, 7) });
  // city blocks
  for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) {
    const bx = XL[i] + 40, by = YL[j] + 40, bw = XL[i + 1] - 40 - bx, bh = YL[j + 1] - 40 - by;
    const t = pick([['big', 33], ['two', 32], ['four', 16], ['park', 19]]);
    blocks.push({ x: bx, y: by, w: bw, h: bh, park: t === 'park', i, j });
    const m = 14;
    if (t === 'big') {
      const side = pick([['top', 1], ['bottom', 1], ['left', 1], ['right', 1]]);
      const lane = side === 'top' ? YL[j] : side === 'bottom' ? YL[j + 1] : side === 'left' ? XL[i] : XL[i + 1];
      addBuilding(bx + m, by + m, bw - 2 * m, bh - 2 * m, side, lane);
    } else if (t === 'two') {
      if (R() < 0.5) {
        const hh = (bh - 3 * m) / 2;
        addBuilding(bx + m, by + m, bw - 2 * m, hh, 'top', YL[j]);
        addBuilding(bx + m, by + 2 * m + hh, bw - 2 * m, hh, 'bottom', YL[j + 1]);
      } else {
        const hw = (bw - 3 * m) / 2;
        addBuilding(bx + m, by + m, hw, bh - 2 * m, 'left', XL[i]);
        addBuilding(bx + 2 * m + hw, by + m, hw, bh - 2 * m, 'right', XL[i + 1]);
      }
    } else if (t === 'four') {
      const hw = (bw - 3 * m) / 2, hh = (bh - 3 * m) / 2;
      addBuilding(bx + m, by + m, hw, hh, 'top', YL[j]);
      addBuilding(bx + 2 * m + hw, by + m, hw, hh, 'top', YL[j]);
      addBuilding(bx + m, by + 2 * m + hh, hw, hh, 'bottom', YL[j + 1]);
      addBuilding(bx + 2 * m + hw, by + 2 * m + hh, hw, hh, 'bottom', YL[j + 1]);
    } else {
      // vacant lot: chain-link fence with one opening, dead trees, burning barrels, junk
      const fx = bx + 8, fy = by + 8, fw = bw - 16, fh = bh - 16, gap = pick([['top', 1], ['bottom', 1], ['left', 1], ['right', 1]]), G2 = 70;
      const fence = (side, x, y, w, h) => {
        if (gap !== side) { addWall(x, y, w, h, 'fence'); return; }
        if (w > h) { addWall(x, y, w / 2 - G2 / 2, h, 'fence'); addWall(x + w / 2 + G2 / 2, y, w / 2 - G2 / 2, h, 'fence'); }
        else { addWall(x, y, w, h / 2 - G2 / 2, 'fence'); addWall(x, y + h / 2 + G2 / 2, w, h / 2 - G2 / 2, 'fence'); }
      };
      fence('top', fx, fy, fw, 4); fence('bottom', fx, fy + fh - 4, fw, 4); fence('left', fx, fy, 4, fh); fence('right', fx + fw - 4, fy, 4, fh);
      const used = [];
      const spot = () => { for (let k = 0; k < 40; k++) { const x = rnd(bx + 45, bx + bw - 45), y = rnd(by + 45, by + bh - 45); if (!used.some(u => Math.abs(u.x - x) < 60 && Math.abs(u.y - y) < 60)) { used.push({ x, y }); return { x, y }; } } return null; };
      for (let k = 0, n = 2 + Math.floor(R() * 3); k < n; k++) { const s2 = spot(); if (!s2) break; trees.push({ x: s2.x, y: s2.y, r: rnd(24, 34), a: rnd(0, TAU) }); addWall(s2.x - 9, s2.y - 9, 18, 18, 'tree'); }
      for (let k = 0, n = 1 + Math.floor(R() * 2); k < n; k++) { const s2 = spot(); if (!s2) break; addWall(s2.x - 9, s2.y - 9, 18, 18, 'barrel'); lights.push({ x: s2.x, y: s2.y, kind: 'fire', r: 170, ph: rnd(0, 10) }); }
      for (let k = 0; k < 4; k++) tires.push({ x: rnd(bx + 30, bx + bw - 30), y: rnd(by + 30, by + bh - 30) });
      for (let k = 0; k < 40; k++) trash.push({ x: rnd(bx + 14, bx + bw - 14), y: rnd(by + 14, by + bh - 14), w: rnd(2, 7), h: rnd(2, 5), c: pick([['#8a8170', 3], ['#5d6a74', 2], ['#7a3d2c', 1], ['#c9c3b5', 2]]), a: rnd(0, 3) });
      if (R() < 0.8) tags.push({ x: rnd(bx + 60, bx + bw - 60), y: rnd(by + 60, by + bh - 60), text: pick(TAG_WORDS.map(t => [t, 1])), c: pick(CREWS.map(c => [c.c, 1])), size: rnd(26, 40), a: rnd(-0.4, 0.4) });
    }
  }
  // prison
  const P = PRISON, T = 14;
  addWall(P.x, P.y, P.w, T, 'pwall'); addWall(P.x, P.y + P.h - T, P.w, T, 'pwall');
  for (const gx of [P.x, P.x + P.w - T]) {
    addWall(gx, P.y, T, CORR_Y - 30 - P.y, 'pwall');
    addWall(gx, CORR_Y + 30, T, P.y + P.h - (CORR_Y + 30), 'pwall');
    doors.push(addWall(gx, CORR_Y - 30, T, 60, 'gate'));
  }
  for (let k = 0; k <= 15; k++) { const x = PX + 825 + k * 50; addWall(x - 3, PY + 1994, 6, 80, 'pwall'); addWall(x - 3, PY + 2246, 6, 80, 'pwall'); }
  for (let k = 0; k < 15; k++) {
    const x = PX + 825 + k * 50;
    doors.push(addWall(x + 3, PY + 2068, 44, 6, 'bars'));
    doors.push(addWall(x + 3, PY + 2246, 44, 6, 'bars'));
    cells.push({ x: x + 25, y: PY + 2031, top: true }, { x: x + 25, y: PY + 2289, top: false });
  }
  // parked cars along the kerbs, away from doors, junctions and the prison exits
  const doorNear = (lane, v, pos) => buildings.some(b => b.outPt.lane === lane && b.outPt[lane === 'h' ? 'y' : 'x'] === v && Math.abs(b.outPt[lane === 'h' ? 'x' : 'y'] - pos) < 85);
  for (let tries = 0, n = 0; tries < 300 * SCALE && n < 26 * SCALE; tries++) {
    const horiz = R() < 0.55, s = R() < 0.5 ? 1 : -1, color = pick(CAR_COLORS.map(c => [c, 1]));
    if (horiz) {
      const j = Math.floor(R() * (ROWS + 1)), cx = rnd(XL[0] + 80, XN - 80);
      if (XL.some(x => Math.abs(x - cx) < 95) || doorNear('h', YL[j], cx)) continue;
      if (j === ROWS && (Math.abs(cx - GATE_L) < 100 || Math.abs(cx - GATE_R) < 100)) continue;
      const y = s > 0 ? YL[j] + 13 : YL[j] - 13 - CAR_W;
      if (cars.some(c => Math.abs(c.x + c.w / 2 - cx) < CAR_L + 30 && Math.abs(c.y - y) < 40)) continue;
      const w = addWall(cx - CAR_L / 2, y, CAR_L, CAR_W, 'car'); w.color = color; w.burned = R() < 0.4; w.rust = [0, 1, 2].map(() => [rnd(8, CAR_L - 8), rnd(5, CAR_W - 5), rnd(3, 8)]); cars.push(w); n++;
    } else {
      const i = Math.floor(R() * (COLS + 1)), cy = rnd(YL[0] + 80, YN - 80);
      if (YL.some(y => Math.abs(y - cy) < 95) || doorNear('v', XL[i], cy)) continue;
      const x = s > 0 ? XL[i] + 13 : XL[i] - 13 - CAR_W;
      if (cars.some(c => Math.abs(c.y + c.h / 2 - cy) < CAR_L + 30 && Math.abs(c.x - x) < 40)) continue;
      const w = addWall(x, cy - CAR_L / 2, CAR_W, CAR_L, 'car'); w.color = color; w.burned = R() < 0.4; w.rust = [0, 1, 2].map(() => [rnd(5, CAR_W - 5), rnd(8, CAR_L - 8), rnd(3, 8)]); cars.push(w); n++;
    }
  }
  // which shops are open: always five gun shops, the rest mixed
  shuffle(buildings.slice()).forEach((b, i) => { b.shop = i < 5 ? 'gun' : pick(SHOP_PICK); b.flicker = R() < 0.25; b.floor = SHOPS[b.shop].floor; });
  // a city nobody has fixed in years
  const onStreet = () => { if (R() < 0.5) return { x: rnd(110, XN + 30), y: YL[Math.floor(R() * (ROWS + 1))] + rnd(-32, 32) }; return { x: XL[Math.floor(R() * (COLS + 1))] + rnd(-32, 32), y: rnd(110, YN + 30) }; };
  for (let i = 0; i < 45 * SCALE; i++) { const q = onStreet(); potholes.push({ x: q.x, y: q.y, rx: rnd(5, 13), ry: rnd(4, 9), a: rnd(0, 3) }); }
  for (let i = 0; i < 24 * SCALE; i++) { const q = onStreet(); puddles.push({ x: q.x, y: q.y, rx: rnd(14, 36), ry: rnd(8, 18), a: rnd(0, 3) }); }
  for (let i = 0; i < 34 * SCALE; i++) { const q = onStreet(); patches.push({ x: q.x - 20, y: q.y - 14, w: rnd(24, 70), h: rnd(16, 40), c: R() < 0.5 ? '#222326' : '#18191b' }); }
  for (let i = 0; i < 16 * SCALE; i++) manholes.push(onStreet());
  for (let i = 0; i < 180 * SCALE; i++) {
    const q = onStreet(), pts = [q.x, q.y]; let a = rnd(0, TAU), x = q.x, y = q.y;
    for (let k = 0; k < 4; k++) { a += rnd(-0.9, 0.9); const l = rnd(10, 28); x += Math.cos(a) * l; y += Math.sin(a) * l; pts.push(x, y); }
    cracks.push({ x: q.x, y: q.y, pts });
  }
  for (let i = 0; i < 380 * SCALE; i++) trash.push({ x: rnd(105, XN + 35), y: rnd(105, YN + 35), w: rnd(2, 6), h: rnd(2, 5), c: pick([['#8a8170', 3], ['#5d6a74', 2], ['#7a3d2c', 1], ['#c9c3b5', 2], ['#3f5c3a', 1]]), a: rnd(0, 3) });
  for (let i = 0; i < 26 * SCALE; i++) { const q = onStreet(); tags.push({ x: q.x, y: q.y, text: pick(TAG_WORDS.map(t => [t, 1])), c: pick(CREWS.map(c => [c.c, 1])), size: rnd(20, 34), a: rnd(-0.5, 0.5) }); }
  for (const b of boarded) if (R() < 0.65) b.tag = { text: pick(TAG_WORDS.map(t => [t, 1])), c: pick(CREWS.map(c => [c.c, 1])), size: Math.min(34, b.w / 5), a: rnd(-0.3, 0.3) };
  for (const x of XL) for (const y of YL) if (R() < 0.42) {
    const sx = R() < 0.5 ? 1 : -1, sy = R() < 0.5 ? 1 : -1;
    lights.push({ x: x + sx * 47, y: y + sy * 47, kind: 'lamp', r: 200, ph: rnd(0, 10), flick: R() < 0.35 });
  }
  lights.push({ x: GATE_L, y: PRISON.y - 20, kind: 'lamp', r: 220, ph: 1, flick: false }, { x: GATE_R, y: PRISON.y - 20, kind: 'lamp', r: 220, ph: 2, flick: true });
  R = saved;
  grid = Array.from({ length: GW * GH }, () => []);
  for (const w of walls) {
    for (let gx = Math.floor(w.x / GS); gx <= Math.floor((w.x + w.w) / GS); gx++)
      for (let gy = Math.floor(w.y / GS); gy <= Math.floor((w.y + w.h) / GS); gy++)
        if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) grid[gy * GW + gx].push(w);
  }
  return { walls, buildings, boarded, trees, blocks, doors, cars, cells, specks, lights, cracks, potholes, puddles, patches, manholes, trash, tags, tires };
}
function setDoors(open) { for (const d of doors) d.open = open; }

function cellWalls(x, y) { const gx = Math.floor(x / GS), gy = Math.floor(y / GS); return gx < 0 || gy < 0 || gx >= GW || gy >= GH ? EMPTY : grid[gy * GW + gx]; }
function solidAt(x, y) { for (const w of cellWalls(x, y)) if (!w.open && w.kind !== 'fence' && x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w; return null; }
function blocksSight(x, y) { for (const w of cellWalls(x, y)) if ((w.kind === 'wall' || w.kind === 'pwall' || w.kind === 'block') && x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true; return false; }
function los(a, b) { const d = dist(a, b), n = Math.ceil(d / 12); for (let i = 1; i < n; i++) { const t = i / n; if (solidAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false; } return true; }
function pushOut(p) {
  const x0 = Math.floor((p.x - p.r) / GS), x1 = Math.floor((p.x + p.r) / GS), y0 = Math.floor((p.y - p.r) / GS), y1 = Math.floor((p.y + p.r) / GS);
  for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
    if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) continue;
    for (const w of grid[gy * GW + gx]) {
      if (w.open) continue;
      const cx = clamp(p.x, w.x, w.x + w.w), cy = clamp(p.y, w.y, w.y + w.h);
      const dx = p.x - cx, dy = p.y - cy, d2 = dx * dx + dy * dy;
      if (d2 >= p.r * p.r) continue;
      if (d2 > 1e-4) { const d = Math.sqrt(d2), k = (p.r - d) / d; p.x += dx * k; p.y += dy * k; }
      else {
        const l = p.x - w.x, r = w.x + w.w - p.x, t = p.y - w.y, b = w.y + w.h - p.y, m = Math.min(l, r, t, b);
        if (m === l) p.x = w.x - p.r; else if (m === r) p.x = w.x + w.w + p.r; else if (m === t) p.y = w.y - p.r; else p.y = w.y + w.h + p.r;
      }
    }
  }
  p.x = clamp(p.x, p.r, WORLD.w - p.r); p.y = clamp(p.y, p.r, WORLD.h - p.r);
}
const inRect = (r, x, y, pad = 0) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
function buildingAt(x, y) { for (const b of buildings) if (inRect(b, x, y)) return b; return null; }
const inPrison = p => inRect(PRISON, p.x, p.y);

// lane routing: every door's outside point sits on a street centre line
function nearestIdx(arr, v) { let bi = 0, bd = 1e9; arr.forEach((a, i) => { const d = Math.abs(a - v); if (d < bd) { bd = d; bi = i; } }); return bi; }
function laneNode(p, lane) { return lane === 'h' ? { x: XL[nearestIdx(XL, p.x)], y: p.y } : { x: p.x, y: YL[nearestIdx(YL, p.y)] }; }
function route(P, pl, Q, ql) { const a = laneNode(P, pl), b = laneNode(Q, ql); return [a, { x: b.x, y: a.y }, b, Q]; }
function snapLane(x, y) {
  const ix = nearestIdx(XL, x), iy = nearestIdx(YL, y);
  return Math.abs(XL[ix] - x) < Math.abs(YL[iy] - y)
    ? { x: XL[ix], y: clamp(y, YL[0], YN), lane: 'v' }
    : { x: clamp(x, XL[0], XN), y: YL[iy], lane: 'h' };
}

// ======================================================================
// Match simulation (runs on the server)
// ======================================================================
let G = null;

function makePlayer(id, name, isBot, cell) {
  const crewIdx = Math.floor(Math.random() * CREWS.length);
  const hoodie = pick(HOODIES.map(c => [c, 1]));
  const hat = pick([['cap', 3], ['capBack', 2], ['beanie', 2], ['durag', 2], ['dreads', 2], ['buzz', 2], ['bandana', 2]]);
  const look = { skin: pick(SKINS.map(c => [c, 1])), hoodie, hat, beanie: pick(BEANIES.map(c => [c, 1])) };
  return {
    id, name, isBot, crew: crewIdx, look, x: cell.x, y: cell.y, r: BODY_R, ang: cell.top ? Math.PI / 2 : -Math.PI / 2,
    hp: 100, armor: 0, alive: true, slots: [null, null], cur: -1, ammo: 0, band: 0, med: 0, kills: 0,
    cd: 0, reload: 0, heal: null, punch: 0, place: 0, diedAt: 0,
    input: null, lastClicks: 0, pendingFire: 0,
    ai: isBot ? { path: [], think: 0, enemy: null, provoked: null, react: 0, lostT: 0, strafe: 1, strafeT: 0, aimErr: rnd(0.22, 0.45), visited: new Set(), stuckT: 0, stuck: 0, lx: cell.x, ly: cell.y, sight: rnd(260, 320) } : null,
  };
}

function addItem(type, x, y, n) {
  const it = { id: G.nextItem++, type, x, y, n: n || 0 };
  G.items.push(it);
  return it;
}
function spawnLoot() {
  for (const b of buildings) {
    const S = SHOPS[b.shop], n = (b.w * b.h > 40000 ? 3 + (R() < 0.5 ? 1 : 0) : 2) + S.extra;
    for (let i = 0; i < n; i++) addItem(pick(S.loot), rnd(b.x + 28, b.x + b.w - 28), rnd(b.y + 28, b.y + b.h - 28));
  }
  for (const k of blocks) if (k.park) for (let i = 0; i < 2; i++) addItem(pick(LOOT_TABLE), rnd(k.x + 30, k.x + k.w - 30), rnd(k.y + 30, k.y + k.h - 30));
  for (let i = 0; i < 3; i++) addItem('band', rnd(PX + 880, PX + 1520), CORR_Y + rnd(-40, 40));
}

// humans: [{ name }]. Returns the match; humans get player ids 0..n-1, bots fill the rest
// unless opts.bots is false.
function createMatch(humans, seed, opts) {
  const bots = !opts || opts.bots !== false;
  buildWorld(seed);
  G = {
    state: 'lockdown', t: LOCKDOWN, time: 0, liveTime: 0, players: [], items: [], nextItem: 1, bullets: [], events: [],
    alive: 0, winner: null,
    zone: { cur: { x: WORLD.w / 2, y: WORLD.h / 2, r: Math.hypot(WORLD.w, WORLD.h) * 0.55 }, next: null, phase: 0, mode: 'wait', t: 0, from: null, dps: 0.5 },
  };
  spawnLoot();
  const cellOrder = shuffle(cells.slice());
  const taken = new Set(humans.map(h => h.name.toLowerCase()));
  const names = shuffle(NAMES.filter(n => !taken.has(n.toLowerCase())));
  humans.slice(0, MAX_PLAYERS).forEach((h, i) => G.players.push(makePlayer(i, h.name, false, cellOrder[i])));
  if (bots) for (let i = G.players.length, k = 0; i < MAX_PLAYERS; i++, k++) G.players.push(makePlayer(i, names[k % names.length], true, cellOrder[i]));
  G.alive = G.players.length;
  return G;
}

function release() {
  G.state = 'live';
  setDoors(true);
  zoneStartPhase();
  for (const b of G.players) if (b.isBot) b.ai.think = rnd(0.1, 0.9);
  G.events.push(['release']);
}

// ---------- zone ----------
function zoneStartPhase() {
  const z = G.zone, ph = PHASES[z.phase], c = z.cur, maxOff = Math.max(0, c.r - ph.r);
  let nx = CX, ny = CY;
  for (let i = 0; i < 40; i++) {
    const a = R() * TAU, d = Math.sqrt(R()) * maxOff, x = c.x + Math.cos(a) * d, y = c.y + Math.sin(a) * d;
    if (x > CITY.x + 230 && x < CITY.x + CITY.w - 230 && y > CITY.y + 230 && y < CITY.y + CITY.h - 230) { nx = x; ny = y; break; }
  }
  z.next = { x: nx, y: ny, r: ph.r }; z.mode = 'wait'; z.t = ph.wait;
}
function updateZone(dt) {
  const z = G.zone;
  if (z.mode === 'final') return;
  z.t -= dt;
  const ph = PHASES[z.phase];
  if (z.mode === 'wait' && z.t <= 0) { z.mode = 'shrink'; z.t = ph.shrink; z.from = { ...z.cur }; z.dps = ph.dps; }
  else if (z.mode === 'shrink') {
    const k = clamp(1 - z.t / ph.shrink, 0, 1);
    z.cur = { x: z.from.x + (z.next.x - z.from.x) * k, y: z.from.y + (z.next.y - z.from.y) * k, r: z.from.r + (z.next.r - z.from.r) * k };
    if (z.t <= 0) {
      z.cur = { ...z.next }; z.phase++;
      if (z.phase < PHASES.length) zoneStartPhase(); else { z.mode = 'final'; z.next = null; }
    }
  }
}

// ---------- combat ----------
const curGun = p => p.cur >= 0 ? p.slots[p.cur] : null;
const wdef = p => { const g = curGun(p); return g ? WEAPONS[g.type] : WEAPONS.fists; };

function tryFire(p) {
  if (p.cd > 0 || p.reload > 0) return false;
  const g = curGun(p), W = wdef(p);
  p.heal = null;
  if (!g) {
    p.cd = W.rate; p.punch = 0.15;
    G.events.push(['punch', p.id]);
    for (const q of G.players) {
      if (q === p || !q.alive) continue;
      if (dist(p, q) < W.range + q.r && Math.abs(angDiff(Math.atan2(q.y - p.y, q.x - p.x), p.ang)) < 0.8) damage(q, W.dmg, p, 'Fists');
    }
    return true;
  }
  if (g.mag <= 0) { startReload(p); return false; }
  g.mag--; p.cd = W.rate;
  const mx = p.x + Math.cos(p.ang) * (W.len + 6), my = p.y + Math.sin(p.ang) * (W.len + 6);
  const angs = [];
  for (let i = 0; i < (W.pellets || 1); i++) {
    const a = p.ang + (R() - 0.5) * 2 * W.spread + (p.isBot ? (R() - 0.5) * p.ai.aimErr : 0);
    angs.push(+a.toFixed(3));
    G.bullets.push({ x: mx, y: my, vx: Math.cos(a) * W.speed, vy: Math.sin(a) * W.speed, dmg: W.dmg, owner: p, left: W.range, wname: W.name });
  }
  G.events.push(['shot', p.id, Math.round(mx), Math.round(my), angs, g.type]);
  return true;
}
function startReload(p) {
  const g = curGun(p); if (!g || p.reload > 0) return;
  const W = WEAPONS[g.type]; if (g.mag >= W.mag || p.ammo <= 0) return;
  p.reload = W.reload; p.heal = null;
}
function finishReload(p) {
  const g = curGun(p); if (!g) return;
  const take = Math.min(WEAPONS[g.type].mag - g.mag, p.ammo); g.mag += take; p.ammo -= take;
}
// want: 'band' or 'med' when the player picked one, otherwise the best choice for their health
function startHeal(p, want) {
  if (p.heal || p.hp >= 100) return;
  if (want === 'med') { if (p.med > 0) p.heal = { type: 'med', t: 0, dur: 4 }; }
  else if (want === 'band') { if (p.band > 0 && p.hp < 75) p.heal = { type: 'band', t: 0, dur: 2 }; }
  else if (p.med > 0 && (p.hp < 60 || p.band === 0 || p.hp >= 75)) p.heal = { type: 'med', t: 0, dur: 4 };
  else if (p.band > 0 && p.hp < 75) p.heal = { type: 'band', t: 0, dur: 2 };
  if (p.heal) p.reload = 0;
}
function damage(q, dmg, src, wname) {
  if (!q.alive) return;
  if (q.armor > 0 && src) { const ab = Math.min(q.armor, dmg * 0.55); q.armor -= ab; dmg -= ab; }
  q.hp -= dmg;
  if (q.isBot && src && src !== q && src.alive) {
    q.ai.provoked = src;
    if (q.ai.enemy !== src && dist(q, src) < 560) { q.ai.enemy = src; q.ai.react = 0.2; q.ai.lostT = 0; }
  }
  if (q.hp <= 0) kill(q, src, wname);
}
function kill(q, src, wname) {
  q.alive = false; q.hp = 0; q.place = G.alive; q.diedAt = G.liveTime;
  G.alive--;
  const drop = (type, n) => { const it = addItem(type, q.x + rnd(-18, 18), q.y + rnd(-18, 18), n); G.events.push(['iadd', it.id, it.type, Math.round(it.x), Math.round(it.y)]); };
  for (const g of q.slots) if (g) drop(g.type);
  if (q.ammo > 0) drop('ammo', q.ammo);
  if (q.band > 0) drop('band', q.band);
  if (q.med > 0) drop('med', q.med);
  q.slots = [null, null]; q.ammo = 0; q.band = 0; q.med = 0;
  if (src && src !== q) src.kills++;
  G.events.push(['kill', src ? src.id : -1, q.id, wname, q.place, Math.round(q.x), Math.round(q.y)]);
  if (G.alive <= 1 && G.state !== 'over') {
    const w = G.players.find(p => p.alive) || q;
    G.winner = w; w.place = 1; G.state = 'over';
  }
}

function removeItem(it) {
  const i = G.items.indexOf(it);
  if (i >= 0) { G.items.splice(i, 1); G.events.push(['idel', it.id]); }
}
function pickup(p, it) {
  const d = ITEMS[it.type];
  if (d.kind === 'gun') {
    let slot = p.slots[0] == null ? 0 : p.slots[1] == null ? 1 : -1;
    if (p.isBot && p.slots.some(s => s && s.type === it.type)) return false;
    if (slot < 0) {
      if (p.isBot) {
        const worst = WEAPONS[p.slots[0].type].tier <= WEAPONS[p.slots[1].type].tier ? 0 : 1;
        if (WEAPONS[it.type].tier <= WEAPONS[p.slots[worst].type].tier) return false;
        slot = worst;
      } else slot = p.cur >= 0 ? p.cur : 0;
      const old = addItem(p.slots[slot].type, p.x + rnd(-16, 16), p.y + rnd(-16, 16));
      G.events.push(['iadd', old.id, old.type, Math.round(old.x), Math.round(old.y)]);
    }
    p.slots[slot] = { type: it.type, mag: WEAPONS[it.type].mag };
    p.ammo += Math.round(WEAPONS[it.type].mag * 0.6);
    if (!p.isBot) { p.cur = slot; p.reload = 0; }
  } else if (d.kind === 'ammo') p.ammo += it.n || 40;
  else if (d.kind === 'heal') p[it.type] += it.n || 1;
  else if (d.kind === 'armor') { if (d.val <= p.armor) return false; p.armor = d.val; }
  removeItem(it);
  if (!p.isBot) G.events.push(['got', p.id]);
  return true;
}
function nearestItem(p, maxD, filter) { let best = null, bd = maxD; for (const it of G.items) { const d = Math.hypot(it.x - p.x, it.y - p.y); if (d < bd && (!filter || filter(it))) { bd = d; best = it; } } return best; }
function setSlot(p, i) { if (i >= 0 && !p.slots[i]) return; if (p.cur !== i) { p.cur = i; p.reload = 0; } }
function cycleSlot(p) { const order = [0, 1, -1].filter(i => i < 0 || p.slots[i]); const k = order.indexOf(p.cur); setSlot(p, order[(k + 1) % order.length]); }

// ---------- human players ----------
// The client predicts its own movement and reports where it is; the server
// walks the player toward that point no faster than the legal speed.
function setInput(p, inp) {
  if (!p || !inp) return;
  const x = +inp.x, y = +inp.y, a = +inp.a, c = inp.c | 0;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(a)) return;
  p.input = { x, y, a, f: !!inp.f, c };
}
function humanUpdate(p, dt) {
  const inp = p.input; if (!inp) return;
  const max = SPEED * (p.heal ? 0.5 : 1) * dt * 1.35 + 0.5;
  const dx = inp.x - p.x, dy = inp.y - p.y, d = Math.hypot(dx, dy);
  if (d > 0) { const k = Math.min(1, max / d); p.x += dx * k; p.y += dy * k; }
  pushOut(p);
  p.ang = inp.a;
  if (inp.c !== p.lastClicks) { p.lastClicks = inp.c; p.pendingFire = 0.3; }
  const W = wdef(p);
  if ((W.auto && inp.f) || p.pendingFire > 0) { if (tryFire(p)) p.pendingFire = 0; }
  p.pendingFire -= dt;
  const g = curGun(p); if (g && g.mag === 0 && p.ammo > 0 && p.reload <= 0) startReload(p);
  for (let i = G.items.length - 1; i >= 0; i--) {
    const it = G.items[i]; if (!it) continue;
    const k = ITEMS[it.type].kind;
    if ((k === 'ammo' || k === 'heal' || (k === 'armor' && ITEMS[it.type].val > p.armor)) && Math.hypot(it.x - p.x, it.y - p.y) < p.r + 10) pickup(p, it);
  }
}
function humanAction(p, a, v) {
  if (!p || !p.alive) return;
  if (a === 'pickup') { const it = nearestItem(p, 40); if (it) pickup(p, it); }
  else if (a === 'reload') startReload(p);
  else if (a === 'heal') startHeal(p, v);
  else if (a === 'slot') { const i = v | 0; if (i >= -1 && i <= 1) setSlot(p, i); }
  else if (a === 'cycle') cycleSlot(p);
}
function humanLeft(p) { if (p && p.alive) kill(p, null, 'left'); }

// ---------- bots ----------
function usableGunSlot(b) {
  let best = -1, bt = 0;
  b.slots.forEach((g, i) => { if (g && (g.mag > 0 || b.ammo > 0) && WEAPONS[g.type].tier > bt) { bt = WEAPONS[g.type].tier; best = i; } });
  return best;
}
function chooseBuilding(b, zoneMode, inB) {
  const z = G.zone, c = z.next || z.cur, rr = (z.next ? z.next.r : z.cur.r) * (zoneMode ? 0.7 : 0.95);
  let cand = buildings.filter(x => x !== inB && !b.ai.visited.has(x) && Math.hypot(x.inPt.x - c.x, x.inPt.y - c.y) < rr);
  if (!cand.length && !zoneMode) { b.ai.visited.clear(); cand = buildings.filter(x => x !== inB && Math.hypot(x.inPt.x - c.x, x.inPt.y - c.y) < rr); }
  if (!cand.length) return null;
  cand.sort((u, v) => Math.hypot(u.inPt.x - b.x, u.inPt.y - b.y) - Math.hypot(v.inPt.x - b.x, v.inPt.y - b.y));
  return zoneMode ? cand[0] : cand[Math.floor(R() * Math.min(b.ai.visited.size === 0 ? 45 : 8, cand.length))];
}
function planPath(b, zoneMode) {
  const ai = b.ai, pts = [];
  let P;
  const inB = buildingAt(b.x, b.y);
  if (inPrison(b)) {
    const gx = b.x < CX ? GATE_L : GATE_R;
    pts.push({ x: clamp(b.x, PX + 830, PX + 1570), y: CORR_Y }, { x: gx, y: CORR_Y }, { x: gx, y: YN });
    P = { x: gx, y: YN, lane: 'h' };
  } else if (inB) { pts.push(inB.inPt, inB.outPt); P = inB.outPt; }
  else { P = snapLane(b.x, b.y); pts.push(P); }
  const tb = chooseBuilding(b, zoneMode, inB);
  if (tb) {
    pts.push(...route(P, P.lane, tb.outPt, tb.outPt.lane), tb.inPt);
    let cur = tb.inPt; const loot = G.items.filter(it => inRect(tb, it.x, it.y));
    while (loot.length) { loot.sort((u, v) => Math.hypot(u.x - cur.x, u.y - cur.y) - Math.hypot(v.x - cur.x, v.y - cur.y)); cur = loot.shift(); pts.push({ x: cur.x, y: cur.y }); }
    pts.push({ x: rnd(tb.x + 30, tb.x + tb.w - 30), y: rnd(tb.y + 30, tb.y + tb.h - 30) });
    ai.visited.add(tb);
  } else {
    const c = G.zone.next || G.zone.cur, s = snapLane(c.x, c.y);
    pts.push(...route(P, P.lane, s, s.lane));
  }
  ai.path = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 2);
}
function botThink(b) {
  const ai = b.ai;
  let best = null, bd = 1e9;
  for (const q of G.players) {
    if (q === b || !q.alive) continue;
    const d = dist(b, q);
    if (d < ai.sight && d < bd && los(b, q)) { best = q; bd = d; }
  }
  if (best) { if (ai.enemy !== best) ai.react = rnd(0.55, 1.0); ai.enemy = best; ai.lostT = 0; }
  else if (ai.enemy) { ai.lostT += 0.25; if (ai.lostT > 1.5 || !ai.enemy.alive) { ai.enemy = null; ai.path = []; } }
  if (ai.enemy && !ai.enemy.alive) { ai.enemy = null; ai.path = []; }
  const s = usableGunSlot(b); if (s !== b.cur) { b.cur = s; b.reload = 0; }
  const g = curGun(b);
  if (g && g.mag === 0 && b.ammo > 0) startReload(b);
  const fighting = ai.enemy && (b.cur >= 0 || ai.provoked === ai.enemy);
  if (!fighting) {
    if (g && g.mag < WEAPONS[g.type].mag * 0.5 && b.ammo > 0) startReload(b);
    if (b.hp < 65 && (b.band > 0 || b.med > 0)) startHeal(b);
    const z = G.zone;
    if (z.next) {
      const dn = Math.hypot(b.x - z.next.x, b.y - z.next.y);
      const tgt = ai.path.length ? ai.path[ai.path.length - 1] : null;
      const tgtOk = tgt && Math.hypot(tgt.x - z.next.x, tgt.y - z.next.y) < z.next.r * 0.85 + 30;
      if (dn > z.next.r * 0.8 && !tgtOk && !ai.zoneMode) { planPath(b, true); ai.zoneMode = true; }
      if (dn < z.next.r * 0.7) ai.zoneMode = false;
    }
    if (!ai.path.length) planPath(b, false);
  }
}
function updateBot(b, dt) {
  const ai = b.ai;
  ai.think -= dt;
  if (ai.think <= 0) { ai.think = 0.25; botThink(b); }
  let mvx = 0, mvy = 0;
  const e = ai.enemy, armed = b.cur >= 0;
  if (e && e.alive && (armed || (ai.provoked === e && dist(b, e) < 100))) {
    const d = dist(b, e), a = Math.atan2(e.y - b.y, e.x - b.x), W = wdef(b);
    b.ang = lerpAngle(b.ang, a, dt * 9);
    if (ai.react > 0) ai.react -= dt;
    else if (Math.abs(angDiff(b.ang, a)) < 0.3 && (armed ? d < W.range * 0.9 : d < 36)) tryFire(b);
    const fx = Math.cos(a), fy = Math.sin(a);
    if (armed) {
      const want = W.range < 400 ? 110 : 190;
      if (d > want + 55) { mvx += fx; mvy += fy; } else if (d < want - 55) { mvx -= fx; mvy -= fy; }
      ai.strafeT -= dt; if (ai.strafeT <= 0) { ai.strafe = R() < 0.5 ? -1 : 1; ai.strafeT = rnd(0.5, 1.4); }
      mvx += -fy * ai.strafe * 0.8; mvy += fx * ai.strafe * 0.8;
    } else { mvx += fx; mvy += fy; }
  } else if (ai.path.length) {
    const t = ai.path[0], dx = t.x - b.x, dy = t.y - b.y, d = Math.hypot(dx, dy);
    if (d < 9) ai.path.shift();
    else { mvx = dx / d; mvy = dy / d; b.ang = lerpAngle(b.ang, Math.atan2(dy, dx), dt * 7); }
  }
  const m = Math.hypot(mvx, mvy);
  if (m > 0) { const sp = BOT_SPEED * (b.heal ? 0.5 : 1); b.x += mvx / m * sp * dt; b.y += mvy / m * sp * dt; }
  pushOut(b);
  ai.stuckT += dt;
  if (ai.stuckT > 0.8) {
    const moved = Math.hypot(b.x - ai.lx, b.y - ai.ly);
    if (m > 0 && moved < 14 && !e) {
      ai.stuck++;
      if (ai.stuck > 2) { ai.path = []; ai.stuck = 0; } else ai.path.unshift({ x: b.x + rnd(-45, 45), y: b.y + rnd(-45, 45) });
    } else ai.stuck = 0;
    ai.stuckT = 0; ai.lx = b.x; ai.ly = b.y;
  }
  for (let i = G.items.length - 1; i >= 0; i--) { const it = G.items[i]; if (it && Math.abs(it.x - b.x) < 18 && Math.abs(it.y - b.y) < 18) pickup(b, it); }
}

// ---------- tick ----------
function step(dt) {
  G.time += dt;
  if (G.state === 'lockdown') { G.t -= dt; if (G.t <= 0) release(); }
  if (G.state === 'live') { G.liveTime += dt; updateZone(dt); }
  for (const p of G.players) {
    if (!p.alive) continue;
    if (!p.isBot) humanUpdate(p, dt);
    else if (G.state === 'lockdown') p.ang += Math.sin(G.time * 1.3 + p.id) * dt;
    else updateBot(p, dt);
  }
  for (const p of G.players) {
    if (!p.alive) continue;
    p.cd -= dt; p.punch -= dt;
    if (p.reload > 0) { p.reload -= dt; if (p.reload <= 0) { p.reload = 0; finishReload(p); } }
    if (p.heal) {
      p.heal.t += dt;
      if (p.heal.t >= p.heal.dur) {
        if (p.heal.type === 'med' && p.med > 0) { p.med--; p.hp = 100; }
        else if (p.heal.type === 'band' && p.band > 0) { p.band--; p.hp = Math.min(75, p.hp + 25); }
        p.heal = null;
      }
    }
    if (G.state === 'live') {
      const z = G.zone.cur;
      if (Math.hypot(p.x - z.x, p.y - z.y) > z.r) damage(p, G.zone.dps * dt, null, 'Zone');
    }
  }
  for (let i = G.bullets.length - 1; i >= 0; i--) {
    const bl = G.bullets[i], sp = Math.hypot(bl.vx, bl.vy), steps = Math.max(1, Math.ceil(sp * dt / 8)), sl = sp * dt / steps;
    let dead = false;
    for (let s = 0; s < steps && !dead; s++) {
      bl.x += bl.vx * dt / steps; bl.y += bl.vy * dt / steps; bl.left -= sl;
      if (bl.left <= 0 || solidAt(bl.x, bl.y)) { dead = true; break; }
      for (const q of G.players) {
        if (!q.alive || q === bl.owner) continue;
        const dx = q.x - bl.x, dy = q.y - bl.y;
        if (dx * dx + dy * dy < q.r * q.r) { G.events.push(['hit', q.id, Math.round(bl.x), Math.round(bl.y)]); damage(q, bl.dmg, bl.owner, bl.wname); dead = true; break; }
      }
    }
    if (dead) G.bullets.splice(i, 1);
  }
}

// ---------- network views ----------
function roster() { return G.players.map(p => ({ id: p.id, name: p.name, bot: p.isBot, crew: p.crew, look: p.look })); }
function itemList() { return G.items.map(i => [i.id, i.type, Math.round(i.x), Math.round(i.y)]); }
function snapCommon() {
  const z = G.zone, ev = G.events; G.events = [];
  return {
    t: 's', st: G.state, lk: +Math.max(0, G.t).toFixed(1), lt: +G.liveTime.toFixed(1), al: G.alive, w: G.winner ? G.winner.id : -1,
    z: [Math.round(z.cur.x), Math.round(z.cur.y), Math.round(z.cur.r), z.next ? Math.round(z.next.x) : 0, z.next ? Math.round(z.next.y) : 0, z.next ? Math.round(z.next.r) : -1, z.mode, +Math.max(0, z.t).toFixed(1)],
    p: G.players.map(p => [p.id, Math.round(p.x), Math.round(p.y), +p.ang.toFixed(2), Math.ceil(p.hp), Math.ceil(p.armor), p.alive ? 1 : 0, curGun(p) ? curGun(p).type : '', (p.heal ? 1 : 0) | (p.reload > 0 ? 2 : 0) | (p.punch > 0 ? 4 : 0)]),
    ev,
  };
}
function snapMe(p) {
  return {
    x: +p.x.toFixed(1), y: +p.y.toFixed(1), s: p.slots.map(s => s ? [s.type, s.mag] : null), c: p.cur, am: p.ammo, b: p.band, m: p.med, k: p.kills,
    h: p.heal ? [p.heal.type, +p.heal.t.toFixed(2), p.heal.dur] : null, r: +p.reload.toFixed(2), pl: p.place, dt: +p.diedAt.toFixed(1),
  };
}
function match() { return G; }

return {
  TAU, COLS, ROWS, XL, YL, XN, YN, CITY, CX, CY, PRISON, PX, PY, CORR_Y, WORLD, GATE_L, GATE_R, MAX_PLAYERS, LOCKDOWN, SPEED, BODY_R, CAR_L, CAR_W,
  WEAPONS, ITEMS, CREWS, SHOPS, PHASES,
  clamp, dist, angDiff, lerpAngle, darken, inRect,
  buildWorld, setDoors, cellWalls, solidAt, blocksSight, pushOut,
  createMatch, step, setInput, humanAction, humanLeft, roster, itemList, snapCommon, snapMe, match,
};
});
