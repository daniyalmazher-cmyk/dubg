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
const WORLD = { w: XN + 160, h: PRISON.y + PRISON.h + 100 };   // resized by buildWorld for the zombie map
const BR_WORLD = { ...WORLD };
const SCALE = (COLS * ROWS) / 30;
const GATE_L = PRISON.x - 35, GATE_R = PRISON.x + PRISON.w + 35;
const MAX_PLAYERS = 30, LOCKDOWN = 8, SPEED = 205;

const WEAPONS = {
  fists:   { name: 'Fists',   dmg: 14, rate: 0.45, melee: true, range: 34, tier: 0 },
  pistol:  { name: 'Pistol',  dmg: 17, rate: 0.26, spread: 0.05, mag: 12, speed: 1300, range: 650, reload: 1.2, auto: false, tier: 1, len: 15 },
  smg:     { name: 'SMG',     dmg: 11, rate: 0.085, spread: 0.11, mag: 30, speed: 1300, range: 560, reload: 1.8, auto: true, tier: 2, len: 20 },
  shotgun: { name: 'Shotgun', dmg: 10, pellets: 8, rate: 0.85, spread: 0.22, mag: 5, speed: 1100, range: 380, reload: 2.2, auto: false, tier: 2, len: 24 },
  rifle:   { name: 'Rifle',   dmg: 23, rate: 0.13, spread: 0.045, mag: 30, speed: 1600, range: 900, reload: 2.0, auto: true, tier: 3, len: 28 },
  // airdrop only: fires one rocket that blows up on whatever it hits, and uses rockets instead of ammo
  rpg:     { name: 'RPG',     dmg: 0, rate: 1.0, spread: 0.01, mag: 1, speed: 760, range: 850, reload: 2.4, auto: false, tier: 4, len: 30, proj: 'r', blast: 125 },
};
const GRENADE = { name: 'Grenade', fuse: 2.2, blast: 115, minD: 50, maxD: 420, drag: 2.6, max: 5 };
const BLAST_CORE = 0.6, BLAST_RIM = 50;   // explosions: inner 60% of the radius kills, the rest takes 50 hp
const ITEMS = {
  pistol:  { label: 'Pistol', kind: 'gun', color: '#d8c27c' },
  smg:     { label: 'SMG', kind: 'gun', color: '#e59a4b' },
  shotgun: { label: 'Shotgun', kind: 'gun', color: '#d46a4a' },
  rifle:   { label: 'Rifle', kind: 'gun', color: '#f2c230' },
  rpg:     { label: 'RPG', kind: 'gun', color: '#9fd356' },
  gren:    { label: 'Grenade', kind: 'gren', color: '#7f9a4a' },
  rocket:  { label: 'Rockets', kind: 'rocket', color: '#c9d84a' },
  crate:   { label: 'Airdrop', kind: 'crate', color: '#ff4b3a' },
  ammo:    { label: 'Ammo box', kind: 'ammo', color: '#b9a35a' },
  band:    { label: 'Bandage', kind: 'heal', color: '#f1ede4' },
  med:     { label: 'Medkit', kind: 'heal', color: '#ff5a4e' },
  vest1:   { label: 'Light vest', kind: 'armor', val: 50, color: '#5aa7ff' },
  vest2:   { label: 'Heavy vest', kind: 'armor', val: 100, color: '#3a78ea' },
};
const LOOT_TABLE = [['pistol', 14], ['smg', 9], ['shotgun', 7], ['rifle', 5], ['ammo', 25], ['band', 20], ['med', 7], ['vest1', 8], ['vest2', 4], ['gren', 5]];
const PHASES = [
  { wait: 50, shrink: 35, r: 1500, dps: 1 },
  { wait: 40, shrink: 30, r: 950, dps: 2 },
  { wait: 32, shrink: 24, r: 560, dps: 4 },
  { wait: 25, shrink: 18, r: 300, dps: 7 },
  { wait: 18, shrink: 14, r: 130, dps: 11 },
  { wait: 12, shrink: 14, r: 0, dps: 18 },
];
// airdrops: when they're announced (seconds after the doors open), how long they take to fall, and what's inside
const DROPS = [55, 135, 205], DROP_FALL = 14;
const DROP_LOOT = [['rpg'], ['rocket', 3], ['gren', 3], ['vest2'], ['med', 2]];

// zombie mode: up to 6 players hold a dead mall while waves come in from the four corners
const ZW = { w: 2600, h: 2600 };
const MALL = { x: 850, y: 900, w: 900, h: 800 };
const ZMAX = 6;
const ZOMBIE = {
  hp: 200, hpWave: 20,                    // every zombie in wave n has 200 + 20(n-1) hp
  boss: 1000, bossStep: 500, bossEvery: 5, // a boss every 5 waves: 1000 hp, then 1500, 2000...
  dmg: 20, bossDmg: 60, rate: 1, reach: 10,
  barHp: 5, buildRate: 0.5,               // a barricade takes 5 hits; holding build adds a plank every half second
  prep: 25, rest: 15, cap: 28,            // seconds before wave 1, between waves, most zombies alive at once
};
const ZSPAWNS = [{ x: 150, y: 150 }, { x: ZW.w - 150, y: 150 }, { x: 150, y: ZW.h - 150 }, { x: ZW.w - 150, y: ZW.h - 150 }];
const STORE_LOOT = {
  gun: [['pistol', 3], ['smg', 3], ['shotgun', 2], ['rifle', 2], ['ammo', 5]],
  pharmacy: [['band', 5], ['med', 2], ['ammo', 2]],
  sports: [['vest1', 3], ['vest2', 1], ['gren', 3], ['ammo', 3]],
  grocery: [['ammo', 6], ['band', 3], ['gren', 1]],
};
const ZTAGS = ['HELP', "THEY'RE INSIDE", 'NO HOPE', 'EVAC GONE', 'RUN', 'DONT GO IN', 'MALL = SAFE?', 'GOD HELP US', 'BITTEN', 'SHOOT THE HEAD'];
const NAMES = ['BigTone', 'LilSmoke', 'Ghostface', 'Kingpin', 'Rico', 'Dre', 'Tiny', 'Scrap', 'Blaze', 'Cash', 'Junebug', 'Nitro', 'Spider', 'Saint', 'Lefty', 'Bones', 'Dutch', 'Mook', 'Shadow', 'Ace', 'Vandal', 'Rocco', 'Diesel', 'Smokey', 'Knuckles', 'Slim', 'Capo', 'Truck', 'Ox'];
const CREWS = [
  { n: 'Dawgz', c: '#ff7a1a' }, { n: 'Vipers', c: '#3ddc84' }, { n: 'Kings', c: '#f2c230' },
  { n: 'Wolves', c: '#a67bff' }, { n: 'Reapers', c: '#e6e2da' }, { n: 'Ghosts', c: '#36d6e7' },
];
const SKINS = ['#8d5524', '#c68642', '#e0ac69', '#5c3a1e', '#f1c27d', '#3d2314', '#a86b3c'];
const HOODIES = ['#1c1c1e', '#2b2f36', '#3a3a3a', '#4b3b2a', '#1f2a3a', '#55524c', '#5e1d1d', '#2f3d2a', '#d9d6cf', '#6b5a3e'];
const BEANIES = ['#1b1b1b', '#5a2a2a', '#2a3a4a', '#d8d2c4', '#3d4a2a'];
const SHOPS = {
  gun:      { sign: 'GUN SHOP', color: '#ff3b3b', floor: '#3a3230', extra: 1, loot: [['pistol', 20], ['smg', 16], ['shotgun', 14], ['rifle', 12], ['ammo', 28], ['vest1', 6], ['vest2', 4], ['gren', 9]] },
  pawn:     { sign: 'PAWN', color: '#f2c230', floor: '#463c2c', extra: 0, loot: [['pistol', 12], ['smg', 6], ['shotgun', 6], ['rifle', 3], ['ammo', 20], ['band', 10], ['vest1', 14], ['vest2', 8], ['gren', 6]] },
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
let stores, barricades, blood, roads, pits, MODE = 'br';
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
function buildWorld(seed, mode) {
  walls = []; buildings = []; boarded = []; trees = []; blocks = []; doors = []; cars = []; cells = []; specks = [];
  lights = []; cracks = []; potholes = []; puddles = []; patches = []; manholes = []; trash = []; tags = []; tires = [];
  stores = []; barricades = []; blood = []; roads = []; pits = [];
  MODE = mode === 'zombie' ? 'zombie' : 'br';
  Object.assign(WORLD, MODE === 'zombie' ? ZW : BR_WORLD);
  const saved = R; R = mulberry32(seed);
  if (MODE === 'zombie') buildZombieWorld();
  else buildCity();
  R = saved;
  grid = Array.from({ length: GW * GH }, () => []);
  for (const w of walls) {
    for (let gx = Math.floor(w.x / GS); gx <= Math.floor((w.x + w.w) / GS); gx++)
      for (let gy = Math.floor(w.y / GS); gy <= Math.floor((w.y + w.h) / GS); gy++)
        if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) grid[gy * GW + gx].push(w);
  }
  return { walls, buildings, boarded, trees, blocks, doors, cars, cells, specks, lights, cracks, potholes, puddles, patches, manholes, trash, tags, tires, stores, barricades, blood, roads, pits };
}
function buildCity() {
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
  const doorNear = (lane, v, pos) => buildings.some(b => b.outPt.lane === lane && b.outPt[lane === 'h' ? 'y' : 'x'] === v && Math.abs(b.outPt[lane === 'h' ? 'x' : 'y'] - pos) < 75);
  for (let tries = 0, n = 0; tries < 300 * SCALE && n < 26 * SCALE; tries++) {
    const horiz = R() < 0.55, s = R() < 0.5 ? 1 : -1, color = pick(CAR_COLORS.map(c => [c, 1]));
    if (horiz) {
      const j = Math.floor(R() * (ROWS + 1)), cx = rnd(XL[0] + 70, XN - 70);
      if (XL.some(x => Math.abs(x - cx) < 85) || doorNear('h', YL[j], cx)) continue;
      if (j === ROWS && (Math.abs(cx - GATE_L) < 90 || Math.abs(cx - GATE_R) < 90)) continue;
      const y = s > 0 ? YL[j] + 16 : YL[j] - 38;
      if (cars.some(c => Math.abs(c.x + c.w / 2 - cx) < 90 && Math.abs(c.y - y) < 40)) continue;
      const w = addWall(cx - 29, y, 58, 22, 'car'); w.color = color; w.burned = R() < 0.4; w.rust = [0, 1, 2].map(() => [rnd(6, 52), rnd(4, 18), rnd(3, 7)]); cars.push(w); n++;
    } else {
      const i = Math.floor(R() * (COLS + 1)), cy = rnd(YL[0] + 70, YN - 70);
      if (YL.some(y => Math.abs(y - cy) < 85) || doorNear('v', XL[i], cy)) continue;
      const x = s > 0 ? XL[i] + 16 : XL[i] - 38;
      if (cars.some(c => Math.abs(c.y + c.h / 2 - cy) < 90 && Math.abs(c.x - x) < 40)) continue;
      const w = addWall(x, cy - 29, 22, 58, 'car'); w.color = color; w.burned = R() < 0.4; w.rust = [0, 1, 2].map(() => [rnd(4, 18), rnd(6, 52), rnd(3, 7)]); cars.push(w); n++;
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
}

// the zombie map: a dead mall in the middle of an overgrown lot, wrecks and ruins around it,
// and a breach in each corner where the horde comes from
function buildZombieWorld() {
  const M = MALL, T = 16, GAP = 80, X1 = M.x + M.w, Y1 = M.y + M.h, cx = M.x + M.w / 2, cy = M.y + M.h / 2;
  for (let i = 0; i < 220; i++) specks.push({ x: rnd(0, ZW.w), y: rnd(0, ZW.h), r: rnd(2, 7) });
  // outer walls; every doorway has a barricade spot that starts broken
  const bar = (x, y, w, h) => { const b = addWall(x, y, w, h, 'barricade'); b.hp = 0; b.open = true; barricades.push(b); };
  const hDoors = [M.x + 290, X1 - 290];
  for (const y of [M.y, Y1 - T]) {
    let x = M.x;
    for (const dx of hDoors) { addWall(x, y, dx - GAP / 2 - x, T); bar(dx - GAP / 2, y, GAP, T); x = dx + GAP / 2; }
    addWall(x, y, X1 - x, T);
  }
  for (const x of [M.x, X1 - T]) { addWall(x, M.y, T, cy - GAP / 2 - M.y); bar(x, cy - GAP / 2, T, GAP); addWall(x, cy + GAP / 2, T, Y1 - cy - GAP / 2); }
  buildings.push({ x: M.x, y: M.y, w: M.w, h: M.h, roofA: 1, roof: '#2b2e31', mall: true, decor: [] });
  // a store in each corner, open toward the atrium
  const SW = 220, SH = 210, FG = 90;
  const defs = [['GUNZ', 'gun', 0, 0], ['PHARMACY', 'pharmacy', 1, 0], ['SPORTS', 'sports', 0, 1], ['GROCERY', 'grocery', 1, 1]];
  for (const [name, kind, right, bottom] of defs) {
    const s = { name, kind, x: right ? X1 - T - SW : M.x + T, y: bottom ? Y1 - T - SH : M.y + T, w: SW, h: SH, front: bottom ? 'top' : 'bottom' };
    addWall(right ? s.x : s.x + SW - 10, s.y, 10, SH);
    const fy = bottom ? s.y : s.y + SH - 10, fx = s.x + (SW - FG) / 2;
    addWall(s.x, fy, fx - s.x, 10); addWall(fx + FG, fy, s.x + SW - fx - FG, 10);
    s.door = { x: fx, y: fy, w: FG, h: 10 };
    stores.push(s);
  }
  // food court counters, the dry fountain and planters in the atrium
  addWall(cx - 100, M.y + 80, 200, 18, 'counter'); addWall(cx - 100, Y1 - 98, 200, 18, 'counter');
  addWall(cx - 40, cy - 40, 80, 80, 'fountain');
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) addWall(cx + sx * 170 - 15, cy + sy * 120 - 15, 30, 30, 'planter');
  lights.push({ x: cx, y: cy - 150, kind: 'lamp', r: 260, ph: 1, flick: true }, { x: cx, y: cy + 150, kind: 'lamp', r: 260, ph: 3, flick: false });
  for (const s of stores) lights.push({ x: s.x + s.w / 2, y: s.y + s.h / 2, kind: 'lamp', r: 170, ph: rnd(0, 10), flick: R() < 0.6 });
  // cracked roads from the corners into the parking lot
  roads.push([0, cy, ZW.w, cy], [cx, 0, cx, ZW.h]);
  for (const s of ZSPAWNS) roads.push([s.x, s.y, s.x + (cx - s.x) * 0.55, s.y + (cy - s.y) * 0.55]);
  // the breaches: a torn-open fence and fires where the horde comes through
  for (const s of ZSPAWNS) {
    pits.push({ x: s.x, y: s.y, r: 70, a: rnd(0, TAU) });
    for (let k = 0; k < 2; k++) { const a = rnd(0, TAU), x = s.x + Math.cos(a) * 120, y = s.y + Math.sin(a) * 120; addWall(x - 9, y - 9, 18, 18, 'barrel'); lights.push({ x, y, kind: 'fire', r: 190, ph: rnd(0, 10) }); }
  }
  const LOT = { x: M.x - 230, y: M.y - 230, w: M.w + 460, h: M.h + 460 };
  const free = (x, y, pad) => !inRect(LOT, x, y, pad) && !ZSPAWNS.some(s => Math.hypot(s.x - x, s.y - y) < 230 + pad)
    && x > 60 + pad && y > 60 + pad && x < ZW.w - 60 - pad && y < ZW.h - 60 - pad
    && Math.abs(x - cx) > 70 + pad && Math.abs(y - cy) > 70 + pad;
  // ruined houses, boarded shut
  const homes = [];
  for (let t = 0; t < 400 && homes.length < 9; t++) {
    const w = rnd(120, 200), h = rnd(100, 160), x = rnd(80, ZW.w - 80 - w), y = rnd(80, ZW.h - 80 - h);
    if (!free(x, y, 0) || !free(x + w, y + h, 0) || !free(x + w, y, 0) || !free(x, y + h, 0)) continue;
    if (homes.some(o => x < o.x + o.w + 140 && x + w + 140 > o.x && y < o.y + o.h + 140 && y + h + 140 > o.y)) continue;
    const b = { x, y, w, h, roof: pick(ROOFS.map(c => [c, 1])), roofA: 1, planks: R() < 0.6 };
    if (R() < 0.7) b.tag = { text: pick(ZTAGS.map(t => [t, 1])), c: pick([['#b8261f', 3], ['#e8e2d4', 1], ['#7fae3a', 1]]), size: Math.min(30, w / 5), a: rnd(-0.3, 0.3) };
    homes.push(b); boarded.push(b); addWall(x, y, w, h, 'block');
  }
  // wrecks: burned out in the lot and along the roads
  const car = (x, y, horiz) => {
    const L = 58, W = 22, w = addWall(horiz ? x - L / 2 : x - W / 2, horiz ? y - W / 2 : y - L / 2, horiz ? L : W, horiz ? W : L, 'car');
    w.color = pick(CAR_COLORS.map(c => [c, 1])); w.burned = R() < 0.75;
    w.rust = [0, 1, 2].map(() => horiz ? [rnd(6, L - 6), rnd(4, W - 4), rnd(3, 7)] : [rnd(4, W - 4), rnd(6, L - 6), rnd(3, 7)]);
    cars.push(w);
  };
  for (let t = 0, n = 0; t < 200 && n < 10; t++) {
    const side = Math.floor(R() * 4), horiz = side < 2;
    const x = horiz ? rnd(LOT.x + 60, LOT.x + LOT.w - 60) : side === 2 ? LOT.x + rnd(40, 150) : LOT.x + LOT.w - rnd(40, 150);
    const y = horiz ? (side === 0 ? LOT.y + rnd(40, 150) : LOT.y + LOT.h - rnd(40, 150)) : rnd(LOT.y + 60, LOT.y + LOT.h - 60);
    if (Math.abs(x - cx) < 120 || Math.abs(y - cy) < 120 || hDoors.some(d => Math.abs(x - d) < 110)) continue;
    if (cars.some(c => Math.hypot(c.x + c.w / 2 - x, c.y + c.h / 2 - y) < 90)) continue;
    car(x, y, horiz ? R() < 0.7 : R() < 0.3); n++;
  }
  for (let t = 0, n = 0; t < 300 && n < 12; t++) {
    const x = rnd(120, ZW.w - 120), y = rnd(120, ZW.h - 120);
    if (!free(x, y, 40) || homes.some(o => inRect(o, x, y, 70)) || cars.some(c => Math.hypot(c.x + c.w / 2 - x, c.y + c.h / 2 - y) < 120)) continue;
    car(x, y, R() < 0.5); n++;
  }
  // dead trees and broken fence runs
  for (let t = 0, n = 0; t < 400 && n < 34; t++) {
    const x = rnd(90, ZW.w - 90), y = rnd(90, ZW.h - 90);
    if (!free(x, y, 20) || homes.some(o => inRect(o, x, y, 50)) || trees.some(o => Math.hypot(o.x - x, o.y - y) < 90)) continue;
    trees.push({ x, y, r: rnd(24, 36), a: rnd(0, TAU) }); addWall(x - 9, y - 9, 18, 18, 'tree'); n++;
  }
  for (let t = 0, n = 0; t < 200 && n < 10; t++) {
    const horiz = R() < 0.5, len = rnd(90, 220), x = rnd(100, ZW.w - 100 - len), y = rnd(100, ZW.h - 100 - len);
    const x2 = horiz ? x + len : x, y2 = horiz ? y : y + len;
    if (!free(x, y, 30) || !free(x2, y2, 30) || homes.some(o => inRect(o, x, y, 60) || inRect(o, x2, y2, 60))) continue;
    addWall(x, y, horiz ? len : 4, horiz ? 4 : len, 'fence'); n++;
  }
  // grime
  for (let i = 0; i < 110; i++) { const [x0, y0, x1, y1] = roads[Math.floor(R() * roads.length)], k = R(); const x = x0 + (x1 - x0) * k + rnd(-40, 40), y = y0 + (y1 - y0) * k + rnd(-40, 40); const pts = [x, y]; let a = rnd(0, TAU), px = x, py = y; for (let j = 0; j < 4; j++) { a += rnd(-0.9, 0.9); const l = rnd(10, 28); px += Math.cos(a) * l; py += Math.sin(a) * l; pts.push(px, py); } cracks.push({ x, y, pts }); }
  for (let i = 0; i < 40; i++) { const [x0, y0, x1, y1] = roads[Math.floor(R() * roads.length)], k = R(); potholes.push({ x: x0 + (x1 - x0) * k + rnd(-35, 35), y: y0 + (y1 - y0) * k + rnd(-35, 35), rx: rnd(5, 13), ry: rnd(4, 9), a: rnd(0, 3) }); }
  for (let i = 0; i < 70; i++) blood.push({ x: rnd(80, ZW.w - 80), y: rnd(80, ZW.h - 80), rx: rnd(8, 26), ry: rnd(5, 14), a: rnd(0, 3) });
  for (let i = 0; i < 14; i++) blood.push({ x: rnd(M.x + 30, X1 - 30), y: rnd(M.y + 30, Y1 - 30), rx: rnd(8, 22), ry: rnd(5, 12), a: rnd(0, 3) });
  for (let i = 0; i < 520; i++) trash.push({ x: rnd(70, ZW.w - 70), y: rnd(70, ZW.h - 70), w: rnd(2, 7), h: rnd(2, 5), c: pick([['#8a8170', 3], ['#5d6a74', 2], ['#7a3d2c', 2], ['#c9c3b5', 1], ['#3f5c3a', 2]]), a: rnd(0, 3) });
  for (let i = 0; i < 16; i++) { const x = rnd(120, ZW.w - 120), y = rnd(120, ZW.h - 120); if (inRect(M, x, y, 30)) continue; tags.push({ x, y, text: pick(ZTAGS.map(t => [t, 1])), c: pick([['#b8261f', 3], ['#e8e2d4', 1], ['#7fae3a', 1]]), size: rnd(22, 36), a: rnd(-0.5, 0.5) }); }
  for (let i = 0; i < 6; i++) { const x = rnd(LOT.x + 40, LOT.x + LOT.w - 40), y = rnd(LOT.y + 40, LOT.y + LOT.h - 40); if (inRect(M, x, y, 60)) continue; lights.push({ x, y, kind: 'lamp', r: 210, ph: rnd(0, 10), flick: R() < 0.5 }); }
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
    id, name, isBot, crew: crewIdx, look, x: cell.x, y: cell.y, r: 12, ang: cell.top ? Math.PI / 2 : -Math.PI / 2,
    hp: 100, armor: 0, alive: true, slots: [null, null], cur: -1, ammo: 0, rockets: 0, gren: 0, band: 0, med: 0, kills: 0,
    cd: 0, reload: 0, heal: null, punch: 0, place: 0, diedAt: 0, throwCd: 0, build: 0, gone: false,
    input: null, lastClicks: 0, pendingFire: 0,
    ai: isBot ? { path: [], think: 0, enemy: null, provoked: null, react: 0, lostT: 0, strafe: 1, strafeT: 0, aimErr: rnd(0.22, 0.45), visited: new Set(), stuckT: 0, stuck: 0, grenT: rnd(3, 8), lx: cell.x, ly: cell.y, sight: rnd(320, 400) } : null,
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
  if (opts && opts.mode === 'zombie') return createZombieMatch(humans, seed);
  const bots = !opts || opts.bots !== false;
  buildWorld(seed);
  G = {
    mode: 'br',
    state: 'lockdown', t: LOCKDOWN, time: 0, liveTime: 0, players: [], items: [], nextItem: 1, bullets: [], events: [],
    projs: [], nextProj: 1, drops: [], dropsDone: 0,
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
    const inReach = q => dist(p, q) < W.range + q.r && Math.abs(angDiff(Math.atan2(q.y - p.y, q.x - p.x), p.ang)) < 0.8;
    if (G.mode === 'zombie') { for (const z of G.zombies) if (z.alive && inReach(z)) hurtZombie(z, W.dmg, p); }
    else for (const q of G.players) if (q !== p && q.alive && inReach(q)) damage(q, W.dmg, p, 'Fists');
    return true;
  }
  if (g.mag <= 0) { startReload(p); return false; }
  g.mag--; p.cd = W.rate;
  const mx = p.x + Math.cos(p.ang) * (W.len + 6), my = p.y + Math.sin(p.ang) * (W.len + 6);
  if (W.proj) {
    const a = p.ang + (R() - 0.5) * 2 * W.spread + (p.isBot ? (R() - 0.5) * p.ai.aimErr * 0.5 : 0);
    const sx = solidAt(mx, my) ? p.x : mx, sy = solidAt(mx, my) ? p.y : my;
    addProj(p, 'r', sx, sy, Math.cos(a) * W.speed, Math.sin(a) * W.speed, { left: W.range });
    return true;
  }
  const angs = [];
  for (let i = 0; i < (W.pellets || 1); i++) {
    const a = p.ang + (R() - 0.5) * 2 * W.spread + (p.isBot ? (R() - 0.5) * p.ai.aimErr : 0);
    angs.push(+a.toFixed(3));
    G.bullets.push({ x: mx, y: my, vx: Math.cos(a) * W.speed, vy: Math.sin(a) * W.speed, dmg: W.dmg, owner: p, left: W.range, wname: W.name });
  }
  G.events.push(['shot', p.id, Math.round(mx), Math.round(my), angs, g.type]);
  return true;
}
// rockets are their own ammo; every other gun shares the ammo pool
const ammoKey = type => type === 'rpg' ? 'rockets' : 'ammo';
function startReload(p) {
  const g = curGun(p); if (!g || p.reload > 0) return;
  const W = WEAPONS[g.type]; if (g.mag >= W.mag || p[ammoKey(g.type)] <= 0) return;
  p.reload = W.reload; p.heal = null;
}
function finishReload(p) {
  const g = curGun(p); if (!g) return;
  const k = ammoKey(g.type), take = Math.min(WEAPONS[g.type].mag - g.mag, p[k]); g.mag += take; p[k] -= take;
}

// ---------- explosives ----------
// k: 'g' grenade (bounces, slows down, blows up when the fuse runs out) or 'r' rocket (flies straight until it hits something)
function addProj(p, k, x, y, vx, vy, extra) {
  const o = { id: G.nextProj++, k, x, y, vx, vy, owner: p, t: 0, ...extra };
  G.projs.push(o);
  G.events.push(['proj', o.id, k, +x.toFixed(1), +y.toFixed(1), +vx.toFixed(1), +vy.toFixed(1), p.id]);
  return o;
}
// shared by the server and the client so a thrown grenade lands in the same place on both.
// Returns true when a rocket hits a wall or runs out of range; hit(o) can stop it early (players, server only).
function stepProj(o, dt, hit) {
  o.t += dt;
  const sp = Math.hypot(o.vx, o.vy), n = Math.max(1, Math.ceil(sp * dt / 6));
  for (let i = 0; i < n; i++) {
    const nx = o.x + o.vx * dt / n, ny = o.y + o.vy * dt / n;
    if (o.k === 'g') {
      if (solidAt(nx, o.y)) o.vx *= -0.45; else o.x = nx;
      if (solidAt(o.x, ny)) o.vy *= -0.45; else o.y = ny;
    } else {
      const w = solidAt(nx, ny);
      if (w && w.kind !== 'barricade') return true;
      o.x = nx; o.y = ny;
      if ((o.left -= sp * dt / n) <= 0 || (hit && hit(o))) return true;
    }
  }
  if (o.k === 'g') { const f = Math.exp(-GRENADE.drag * dt); o.vx *= f; o.vy *= f; }
  return false;
}
function throwGrenade(p, a, d) {
  if (p.gren <= 0 || p.throwCd > 0 || !Number.isFinite(a)) return false;
  d = clamp(Number.isFinite(d) ? d : 260, GRENADE.minD, GRENADE.maxD);
  p.gren--; p.throwCd = 0.9; p.heal = null; p.ang = a;
  const sx = p.x + Math.cos(a) * (p.r + 6), sy = p.y + Math.sin(a) * (p.r + 6), ok = !solidAt(sx, sy);
  // with this drag a grenade slides d before stopping
  addProj(p, 'g', ok ? sx : p.x, ok ? sy : p.y, Math.cos(a) * d * GRENADE.drag, Math.sin(a) * d * GRENADE.drag, { fuse: GRENADE.fuse });
  G.events.push(['throw', p.id]);
  return true;
}
// damage falls off from the centre; walls between you and the blast protect you
// inside the kill core you die whatever armor you wear; out on the rim you lose half your health
function explode(o, R, wname) {
  G.events.push(['boom', o.id, Math.round(o.x), Math.round(o.y), R]);
  for (const q of G.players) {
    if (!q.alive || (G.mode === 'zombie' && q !== o.owner)) continue;   // no friendly fire against the horde
    const d = Math.hypot(q.x - o.x, q.y - o.y);
    if (d < R + q.r && los(o, q)) damage(q, d < R * BLAST_CORE ? 999 : BLAST_RIM, o.owner, wname, true);
  }
  // zombies: the core kills, the rim takes half; a boss only loses a quarter or a tenth of its health
  if (G.mode === 'zombie') for (const z of G.zombies) {
    if (!z.alive) continue;
    const d = Math.hypot(z.x - o.x, z.y - o.y), core = d < R * BLAST_CORE;
    if (d < R + z.r && los(o, z)) hurtZombie(z, z.boss ? z.max * (core ? 0.25 : 0.1) : core ? z.hp : z.max * 0.5, o.owner);
  }
}
function updateProjs(dt) {
  for (let i = G.projs.length - 1; i >= 0; i--) {
    const o = G.projs[i];
    if (o.k === 'g') {
      stepProj(o, dt);
      if ((o.fuse -= dt) <= 0) { G.projs.splice(i, 1); explode(o, GRENADE.blast, GRENADE.name); }
    } else {
      const hitP = G.mode === 'zombie'
        ? r => G.zombies.some(z => z.alive && Math.hypot(z.x - r.x, z.y - r.y) < z.r + 4)
        : r => G.players.some(q => q.alive && q !== r.owner && Math.hypot(q.x - r.x, q.y - r.y) < q.r + 4);
      if (stepProj(o, dt, hitP)) { G.projs.splice(i, 1); explode(o, WEAPONS.rpg.blast, WEAPONS.rpg.name); }
    }
  }
}

// ---------- airdrops ----------
function dropSpot() {
  const z = G.zone, c = z.next || z.cur, r = Math.min(c.r * 0.75, 1400);
  for (let i = 0; i < 80; i++) {
    const a = R() * TAU, d = Math.sqrt(R()) * r, x = c.x + Math.cos(a) * d, y = c.y + Math.sin(a) * d;
    if (!inRect(CITY, x, y) || buildingAt(x, y)) continue;
    let clear = true;
    for (let k = 0; k < 8 && clear; k++) if (solidAt(x + Math.cos(k * TAU / 8) * 28, y + Math.sin(k * TAU / 8) * 28)) clear = false;
    if (clear) return { x, y };
  }
  return { x: c.x, y: c.y };
}
function updateDrops(dt) {
  if (G.dropsDone < DROPS.length && G.liveTime >= DROPS[G.dropsDone]) {
    G.dropsDone++;
    const s = dropSpot(), d = { id: G.dropsDone, x: Math.round(s.x), y: Math.round(s.y), t: DROP_FALL };
    G.drops.push(d);
    G.events.push(['drop', d.id, d.x, d.y]);
  }
  for (let i = G.drops.length - 1; i >= 0; i--) {
    const d = G.drops[i];
    if ((d.t -= dt) > 0) continue;
    G.drops.splice(i, 1);
    const it = addItem('crate', d.x, d.y);
    G.events.push(['iadd', it.id, it.type, it.x, it.y]);
  }
}
function openCrate(it) {
  removeItem(it);
  DROP_LOOT.forEach(([type, n], i) => {
    const a = i / DROP_LOOT.length * TAU + 0.4;
    let x = it.x + Math.cos(a) * 30, y = it.y + Math.sin(a) * 30;
    if (solidAt(x, y)) { x = it.x; y = it.y; }
    const o = addItem(type, x, y, n);
    G.events.push(['iadd', o.id, o.type, Math.round(o.x), Math.round(o.y)]);
  });
  G.events.push(['crate', Math.round(it.x), Math.round(it.y)]);
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
function damage(q, dmg, src, wname, pierce) {
  if (!q.alive) return;
  if (q.armor > 0 && src && !pierce) { const ab = Math.min(q.armor, dmg * 0.55); q.armor -= ab; dmg -= ab; }
  q.hp -= dmg;
  if (q.isBot && src && src !== q && src.alive) {
    q.ai.provoked = src;
    if (q.ai.enemy !== src && dist(q, src) < 700) { q.ai.enemy = src; q.ai.react = 0.2; q.ai.lostT = 0; }
  }
  if (q.hp <= 0) kill(q, src, wname);
}
function kill(q, src, wname) {
  q.alive = false; q.hp = 0; q.place = G.alive; q.diedAt = G.liveTime;
  G.alive--;
  const drop = (type, n) => { const it = addItem(type, q.x + rnd(-18, 18), q.y + rnd(-18, 18), n); G.events.push(['iadd', it.id, it.type, Math.round(it.x), Math.round(it.y)]); };
  for (const g of q.slots) if (g) drop(g.type);
  if (q.ammo > 0) drop('ammo', q.ammo);
  if (q.rockets > 0) drop('rocket', q.rockets);
  if (q.gren > 0) drop('gren', q.gren);
  if (q.band > 0) drop('band', q.band);
  if (q.med > 0) drop('med', q.med);
  q.slots = [null, null]; q.ammo = 0; q.rockets = 0; q.gren = 0; q.band = 0; q.med = 0;
  if (src && src !== q) src.kills++;
  G.events.push(['kill', src ? src.id : -1, q.id, wname, q.place, Math.round(q.x), Math.round(q.y)]);
  if (G.mode === 'zombie') { if (G.alive <= 0 && G.state !== 'over') G.state = 'over'; return; }
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
  if (d.kind === 'crate') { openCrate(it); return true; }
  if (d.kind === 'gren' && p.gren >= GRENADE.max) return false;
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
    if (it.type === 'rpg') p.rockets += 1; else p.ammo += Math.round(WEAPONS[it.type].mag * 0.6);
    if (!p.isBot) { p.cur = slot; p.reload = 0; }
  } else if (d.kind === 'ammo') p.ammo += it.n || 40;
  else if (d.kind === 'rocket') p.rockets += it.n || 2;
  else if (d.kind === 'gren') p.gren = Math.min(GRENADE.max, p.gren + (it.n || 1));
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
  p.input = { x, y, a, f: !!inp.f, c, b: !!inp.b };
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
  // holding fire repeats at the weapon's own rate, fists and pistols included
  if (inp.f || p.pendingFire > 0) { if (tryFire(p)) p.pendingFire = 0; }
  p.pendingFire -= dt;
  const g = curGun(p); if (g && g.mag === 0 && p[ammoKey(g.type)] > 0 && p.reload <= 0) startReload(p);
  if (G.mode === 'zombie') buildBarricade(p, inp.b ? dt : 0);
  for (let i = G.items.length - 1; i >= 0; i--) {
    const it = G.items[i]; if (!it) continue;
    const k = ITEMS[it.type].kind;
    if ((k === 'ammo' || k === 'heal' || k === 'rocket' || k === 'gren' || k === 'crate' || (k === 'armor' && ITEMS[it.type].val > p.armor)) && Math.hypot(it.x - p.x, it.y - p.y) < p.r + (k === 'crate' ? 22 : 12)) pickup(p, it);
  }
}
function humanAction(p, a, v) {
  if (!p || !p.alive) return;
  if (a === 'pickup') { const it = nearestItem(p, 48); if (it) pickup(p, it); }
  else if (a === 'reload') startReload(p);
  else if (a === 'heal') startHeal(p, v);
  else if (a === 'throw' && Array.isArray(v)) throwGrenade(p, +v[0], +v[1]);
  else if (a === 'slot') { const i = v | 0; if (i >= -1 && i <= 1) setSlot(p, i); }
  else if (a === 'cycle') cycleSlot(p);
}
function humanLeft(p) { if (!p) return; p.gone = true; if (p.alive) kill(p, null, 'left'); }

// ---------- bots ----------
// close: an enemy is near, so don't pick the rocket launcher (it would blow the bot up too) if there's anything else
function usableGunSlot(b, close) {
  let best = -1, bt = 0;
  b.slots.forEach((g, i) => { const t = WEAPONS[g ? g.type : 'fists'].tier - (close && g && g.type === 'rpg' ? 4 : 0); if (g && (g.mag > 0 || b[ammoKey(g.type)] > 0) && t > bt) { bt = t; best = i; } });
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
  const s = usableGunSlot(b, ai.enemy && dist(b, ai.enemy) < 190); if (s !== b.cur) { b.cur = s; b.reload = 0; }
  const g = curGun(b);
  if (g && g.mag === 0) startReload(b);
  const fighting = ai.enemy && (b.cur >= 0 || ai.provoked === ai.enemy);
  if (!fighting) {
    if (g && g.mag < WEAPONS[g.type].mag * 0.5) startReload(b);
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
  if (e && e.alive && (armed || (ai.provoked === e && dist(b, e) < 130))) {
    const d = dist(b, e), a = Math.atan2(e.y - b.y, e.x - b.x), W = wdef(b);
    b.ang = lerpAngle(b.ang, a, dt * 9);
    if (ai.react > 0) ai.react -= dt;
    else if (b.gren > 0 && ai.grenT <= 0 && d > 150 && d < 380 && los(b, e)) { ai.grenT = rnd(7, 12); throwGrenade(b, a + (R() - 0.5) * 0.25, d + rnd(-40, 30)); }
    else if (Math.abs(angDiff(b.ang, a)) < 0.3 && (armed ? d < W.range * 0.9 && !(W.proj && d < 150) : d < 48)) tryFire(b);
    ai.grenT -= dt;
    const fx = Math.cos(a), fy = Math.sin(a);
    if (armed) {
      const want = W.range < 450 ? 140 : 240;
      if (d > want + 70) { mvx += fx; mvy += fy; } else if (d < want - 70) { mvx -= fx; mvy -= fy; }
      ai.strafeT -= dt; if (ai.strafeT <= 0) { ai.strafe = R() < 0.5 ? -1 : 1; ai.strafeT = rnd(0.5, 1.4); }
      mvx += -fy * ai.strafe * 0.8; mvy += fx * ai.strafe * 0.8;
    } else { mvx += fx; mvy += fy; }
  } else if (ai.path.length) {
    const t = ai.path[0], dx = t.x - b.x, dy = t.y - b.y, d = Math.hypot(dx, dy);
    if (d < 9) ai.path.shift();
    else { mvx = dx / d; mvy = dy / d; b.ang = lerpAngle(b.ang, Math.atan2(dy, dx), dt * 7); }
  }
  const m = Math.hypot(mvx, mvy);
  if (m > 0) { const sp = 185 * (b.heal ? 0.5 : 1); b.x += mvx / m * sp * dt; b.y += mvy / m * sp * dt; }
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
  for (let i = G.items.length - 1; i >= 0; i--) { const it = G.items[i]; if (it && Math.abs(it.x - b.x) < 22 && Math.abs(it.y - b.y) < 22) pickup(b, it); }
}


// ---------- zombie mode ----------
const ZSRC = { id: -2, name: 'Zombie', kills: 0 };   // what a zombie bite counts as when it kills you
function createZombieMatch(humans, seed) {
  buildWorld(seed, 'zombie');
  G = {
    mode: 'zombie', state: 'live', t: 0, time: 0, liveTime: 0, players: [], items: [], nextItem: 1, bullets: [], events: [],
    projs: [], nextProj: 1, drops: [], dropsDone: 0, alive: 0, winner: null,
    zone: { cur: { x: ZW.w / 2, y: ZW.h / 2, r: 99999 }, next: null, phase: 0, mode: 'final', t: 0, from: null, dps: 0 },
    zombies: [], nextZ: 1, flow: null, flowT: 0,
    zw: { wave: 0, phase: 'break', t: ZOMBIE.prep, toSpawn: 0, spawnT: 0, bossT: -1 },
  };
  buildFlowGrid();
  for (const s of stores) for (let i = 0; i < 4; i++) storeItem(s);
  humans.slice(0, ZMAX).forEach((h, i) => {
    const p = makePlayer(i, h.name, false, mallSpot(i));
    arm(p); G.players.push(p);
  });
  G.alive = G.players.length;
  return G;
}
// around the fountain, clear of it
function mallSpot(i) {
  const cx = MALL.x + MALL.w / 2, cy = MALL.y + MALL.h / 2, a = i / ZMAX * TAU + 0.4;
  return { x: cx + Math.cos(a) * 95, y: cy + Math.sin(a) * 95, top: false };
}
function arm(p) { p.slots = [{ type: 'pistol', mag: WEAPONS.pistol.mag }, null]; p.cur = 0; p.ammo = 48; p.band = 1; }
function storeItem(s) {
  const it = addItem(pick(STORE_LOOT[s.kind]), rnd(s.x + 30, s.x + s.w - 30), rnd(s.y + 30, s.y + s.h - 30));
  G.events.push(['iadd', it.id, it.type, Math.round(it.x), Math.round(it.y)]);
}
// between waves the shelves fill back up a little
function restock() { for (const s of stores) { const n = G.items.filter(it => inRect(s, it.x, it.y)).length; for (let i = n; i < 4; i++) storeItem(s); } }
function revive(p) {
  const s = mallSpot(p.id);
  Object.assign(p, { alive: true, hp: 100, armor: 0, x: s.x, y: s.y, reload: 0, heal: null, cd: 0, build: 0 });
  arm(p); G.alive++;
  G.events.push(['revive', p.id]);
}

// Pathfinding: a flow field over a 20px grid, rebuilt twice a second from every living player.
// Boarded doorways cost extra, so zombies go for an open door if there is one nearby.
const FS = 20;
let FW = 0, FH = 0, fBlock = null, fBar = null;
function buildFlowGrid() {
  FW = Math.ceil(ZW.w / FS); FH = Math.ceil(ZW.h / FS);
  fBlock = new Uint8Array(FW * FH); fBar = new Int8Array(FW * FH).fill(-1);
  for (let j = 0; j < FH; j++) for (let i = 0; i < FW; i++) {
    const x = i * FS + FS / 2, y = j * FS + FS / 2, k = j * FW + i;
    for (const [ox, oy] of [[0, 0], [-8, -8], [8, -8], [-8, 8], [8, 8]]) {
      for (const w of cellWalls(x + ox, y + oy)) {
        if (!inRect(w, x + ox, y + oy)) continue;
        if (w.kind === 'barricade') fBar[k] = barricades.indexOf(w); else fBlock[k] = 1;
      }
    }
  }
}
const fIdx = (x, y) => clamp(Math.floor(y / FS), 0, FH - 1) * FW + clamp(Math.floor(x / FS), 0, FW - 1);
function heapPush(h, d, i) { h.push(d, i); let k = h.length / 2 - 1; while (k > 0) { const p = (k - 1) >> 1; if (h[p * 2] <= h[k * 2]) break; for (const o of [0, 1]) { const t = h[p * 2 + o]; h[p * 2 + o] = h[k * 2 + o]; h[k * 2 + o] = t; } k = p; } }
function heapPop(h) {
  const d = h[0], i = h[1], li = h.pop(), ld = h.pop();
  if (h.length) {
    h[0] = ld; h[1] = li; let k = 0; const n = h.length / 2;
    for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < n && h[l * 2] < h[m * 2]) m = l; if (r < n && h[r * 2] < h[m * 2]) m = r; if (m === k) break; for (const o of [0, 1]) { const t = h[m * 2 + o]; h[m * 2 + o] = h[k * 2 + o]; h[k * 2 + o] = t; } k = m; }
  }
  return [d, i];
}
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
function updateFlow() {
  const f = G.flow || (G.flow = new Float64Array(FW * FH)), h = [];   // not Float32: rounding makes equal-cost routes look shorter and they snowball
  f.fill(1e9);
  for (const p of G.players) if (p.alive) { const k = fIdx(p.x, p.y); f[k] = 0; heapPush(h, 0, k); }
  while (h.length) {
    const [d, k] = heapPop(h);
    if (d > f[k]) continue;
    const i = k % FW, j = (k - i) / FW;
    for (const [di, dj, c] of NB) {
      const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= FW || nj >= FH) continue;
      const n = nj * FW + ni; if (fBlock[n]) continue;
      if (di && dj && (fBlock[j * FW + ni] || fBlock[nj * FW + i])) continue;   // no cutting corners
      const b = fBar[n], nd = d + c + (b >= 0 && !barricades[b].open ? 14 : 0);
      if (nd < f[n]) { f[n] = nd; heapPush(h, nd, n); }
    }
  }
}

function spawnZombie(boss) {
  const s = ZSPAWNS[Math.floor(R() * ZSPAWNS.length)], w = G.zw.wave;
  const hp = boss ? ZOMBIE.boss + ZOMBIE.bossStep * (w / ZOMBIE.bossEvery - 1) : ZOMBIE.hp + ZOMBIE.hpWave * (w - 1);
  const z = { id: G.nextZ++, x: s.x + rnd(-45, 45), y: s.y + rnd(-45, 45), r: boss ? 36 : 12, ang: rnd(0, TAU), boss, hp, max: hp, cd: 0, atk: 0, alive: true, stuckT: 0, lx: 0, ly: 0, side: null, born: G.liveTime,
    sp: SPEED * (boss ? 0.42 : Math.min(0.8, 0.55 + w * 0.02) * rnd(0.88, 1.12)) };
  G.zombies.push(z);
  if (boss) G.events.push(['boss', z.id]);
}
function startWave() {
  const zw = G.zw, n = G.players.filter(p => !p.gone).length;
  zw.wave++; zw.phase = 'fight';
  zw.toSpawn = 6 + (zw.wave - 1) * 4 + Math.max(0, n - 1) * 3; zw.spawnT = 0.5;
  zw.bossT = zw.wave % ZOMBIE.bossEvery === 0 ? 6 : -1;
  for (const p of G.players) if (!p.alive && !p.gone) revive(p);   // everyone who went down gets back up
  G.events.push(['wave', zw.wave, zw.bossT > 0 ? 1 : 0]);
}
function updateWaves(dt) {
  const zw = G.zw;
  if (zw.phase === 'break') { if ((zw.t -= dt) <= 0) startWave(); return; }
  if (zw.bossT > 0 && (zw.bossT -= dt) <= 0) { zw.bossT = -1; spawnZombie(true); }
  if (zw.toSpawn > 0 && (zw.spawnT -= dt) <= 0 && G.zombies.length < ZOMBIE.cap) {
    // they come in bunches from one corner at a time
    const k = Math.min(zw.toSpawn, 1 + Math.floor(R() * 3));
    for (let i = 0; i < k; i++) spawnZombie(false);
    zw.toSpawn -= k; zw.spawnT = Math.max(0.8, 2.6 - zw.wave * 0.12);
  }
  if (zw.toSpawn <= 0 && zw.bossT < 0 && !G.zombies.length) {
    zw.phase = 'break'; zw.t = ZOMBIE.rest;
    restock();
    G.events.push(['clear', zw.wave]);
  }
}
// closest point of a wall to a circle's centre
const rectDist = (w, p) => Math.hypot(clamp(p.x, w.x, w.x + w.w) - p.x, clamp(p.y, w.y, w.y + w.h) - p.y);
function updateZombie(z, dt) {
  z.cd -= dt; z.atk -= dt;
  let tgt = null, td = 1e9;
  for (const p of G.players) if (p.alive) { const d = dist(z, p); if (d < td) { td = d; tgt = p; } }
  if (!tgt) return;
  let mx, my;
  if (td < 170 && los(z, tgt)) { mx = tgt.x - z.x; my = tgt.y - z.y; }
  else {
    // walk downhill on the flow field
    const f = G.flow, k = fIdx(z.x, z.y), i = k % FW, j = (k - i) / FW;
    let best = -1, bd = f ? f[k] : 1e9;
    if (f) for (const [di, dj] of NB) {
      const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= FW || nj >= FH) continue;
      const n = nj * FW + ni; if (f[n] < bd) { bd = f[n]; best = n; }
    }
    if (best >= 0) { mx = (best % FW) * FS + FS / 2 - z.x; my = Math.floor(best / FW) * FS + FS / 2 - z.y; }
    else { mx = tgt.x - z.x; my = tgt.y - z.y; }
  }
  let m = Math.hypot(mx, my) || 1; mx /= m; my /= m;
  // wedged on something for a second: shuffle sideways for a bit
  if ((z.stuckT += dt) > 1) {
    if (Math.hypot(z.x - z.lx, z.y - z.ly) < 8 && z.atk <= 0) { const s = R() < 0.5 ? 1 : -1; z.side = { x: -my * s, y: mx * s, t: 0.6 }; }
    z.stuckT = 0; z.lx = z.x; z.ly = z.y;
  }
  if (z.side && (z.side.t -= dt) > 0) { mx += z.side.x * 2; my += z.side.y * 2; }
  m = Math.hypot(mx, my);
  if (m > 0.5 && z.atk <= 0) { z.x += mx / m * z.sp * dt; z.y += my / m * z.sp * dt; z.ang = lerpAngle(z.ang, Math.atan2(my, mx), dt * 8); }
  if (z.cd > 0) return;
  if (td < z.r + tgt.r + ZOMBIE.reach) {
    z.cd = ZOMBIE.rate; z.atk = 0.35; z.ang = Math.atan2(tgt.y - z.y, tgt.x - z.x);
    G.events.push(['zatk', z.id]);
    damage(tgt, z.boss ? ZOMBIE.bossDmg : ZOMBIE.dmg, ZSRC, z.boss ? 'Boss' : 'Zombie');
    return;
  }
  // outside and up against a boarded doorway: tear at it
  if (inRect(MALL, z.x, z.y, -4)) return;
  for (let i = 0; i < barricades.length; i++) {
    const b = barricades[i];
    if (b.open || rectDist(b, z) > z.r + 6) continue;
    z.cd = ZOMBIE.rate; z.atk = 0.35; z.ang = Math.atan2(b.y + b.h / 2 - z.y, b.x + b.w / 2 - z.x);
    b.hp = Math.max(0, b.hp - (z.boss ? ZOMBIE.barHp : 1));
    if (!b.hp) b.open = true;
    G.events.push(['bar', i, b.hp, -1]);
    return;
  }
}
// zombies keep out of each other and out of the players
function separate() {
  const Z = G.zombies;
  for (let a = 0; a < Z.length; a++) {
    const p = Z[a];
    for (let b = a + 1; b < Z.length; b++) {
      const q = Z[b], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy), min = p.r + q.r - 4;
      if (d >= min || d < 0.01) continue;
      const o = (min - d) / d, wp = p.boss ? 0.1 : q.boss ? 0.9 : 0.5;
      p.x -= dx * o * wp; p.y -= dy * o * wp; q.x += dx * o * (1 - wp); q.y += dy * o * (1 - wp);
    }
    for (const h of G.players) {
      if (!h.alive) continue;
      const dx = p.x - h.x, dy = p.y - h.y, d = Math.hypot(dx, dy), min = p.r + h.r;
      if (d < min && d > 0.01) { p.x += dx / d * (min - d); p.y += dy / d * (min - d); }
    }
    pushOut(p);
  }
}
function hurtZombie(z, dmg, src) {
  if (!z.alive) return;
  z.hp -= dmg;
  if (z.hp > 0) return;
  z.alive = false;
  if (src && src !== ZSRC && G.players.includes(src)) src.kills++;
  G.events.push(['zdie', z.id, Math.round(z.x), Math.round(z.y), src && src.id != null ? src.id : -1, z.boss ? 1 : 0]);
  const drop = (type, n, spread) => { const it = addItem(type, z.x + rnd(-spread, spread), z.y + rnd(-spread, spread), n); G.events.push(['iadd', it.id, it.type, Math.round(it.x), Math.round(it.y)]); };
  if (z.boss) { drop('crate', 0, 4); drop('ammo', 120, 30); drop('med', 1, 30); return; }   // the boss carries an airdrop crate
  const r = R();
  if (r < 0.16) drop('ammo', 24, 8); else if (r < 0.21) drop('band', 1, 8); else if (r < 0.23) drop('gren', 1, 8);
}
// hold build next to a doorway to nail planks back up, one every half second
function nearBarricade(p, maxD) { let best = -1, bd = maxD; barricades.forEach((b, i) => { const d = rectDist(b, p); if (d < bd) { bd = d; best = i; } }); return best; }
function buildBarricade(p, dt) {
  if (!dt) { p.build = 0; return; }
  const i = nearBarricade(p, 60), b = barricades[i];
  if (!b || b.hp >= ZOMBIE.barHp) { p.build = 0; return; }
  if ((p.build += dt) < ZOMBIE.buildRate) return;
  p.build = 0; b.hp++; b.open = false;
  G.events.push(['bar', i, b.hp, p.id]);
}
function stepZombies(dt) {
  G.liveTime += dt;
  updateWaves(dt);
  if ((G.flowT -= dt) <= 0) { G.flowT = 0.5; updateFlow(); }
  for (const z of G.zombies) if (z.alive) updateZombie(z, dt);
  separate();
  G.zombies = G.zombies.filter(z => z.alive);
}

// ---------- tick ----------
function step(dt) {
  G.time += dt;
  if (G.state === 'lockdown') { G.t -= dt; if (G.t <= 0) release(); }
  if (G.mode === 'zombie') { if (G.state === 'live') stepZombies(dt); }
  else if (G.state === 'live') { G.liveTime += dt; updateZone(dt); updateDrops(dt); }
  for (const p of G.players) {
    if (!p.alive) continue;
    if (!p.isBot) humanUpdate(p, dt);
    else if (G.state === 'lockdown') p.ang += Math.sin(G.time * 1.3 + p.id) * dt;
    else updateBot(p, dt);
  }
  for (const p of G.players) {
    if (!p.alive) continue;
    p.cd -= dt; p.punch -= dt; p.throwCd -= dt;
    if (p.reload > 0) { p.reload -= dt; if (p.reload <= 0) { p.reload = 0; finishReload(p); } }
    if (p.heal) {
      p.heal.t += dt;
      if (p.heal.t >= p.heal.dur) {
        if (p.heal.type === 'med' && p.med > 0) { p.med--; p.hp = 100; }
        else if (p.heal.type === 'band' && p.band > 0) { p.band--; p.hp = Math.min(75, p.hp + 25); }
        p.heal = null;
      }
    }
    if (G.state === 'live' && G.mode !== 'zombie') {
      const z = G.zone.cur;
      if (Math.hypot(p.x - z.x, p.y - z.y) > z.r) damage(p, G.zone.dps * dt, null, 'Zone');
    }
  }
  updateProjs(dt);
  for (let i = G.bullets.length - 1; i >= 0; i--) {
    const bl = G.bullets[i], sp = Math.hypot(bl.vx, bl.vy), steps = Math.max(1, Math.ceil(sp * dt / 10)), sl = sp * dt / steps;
    let dead = false;
    for (let s = 0; s < steps && !dead; s++) {
      bl.x += bl.vx * dt / steps; bl.y += bl.vy * dt / steps; bl.left -= sl;
      const w = bl.left > 0 && solidAt(bl.x, bl.y);
      if (bl.left <= 0 || (w && w.kind !== 'barricade')) { dead = true; break; }
      if (G.mode === 'zombie') {
        for (const z of G.zombies) {
          const dx = z.x - bl.x, dy = z.y - bl.y;
          if (z.alive && dx * dx + dy * dy < z.r * z.r) { G.events.push(['zhit', z.id, Math.round(bl.x), Math.round(bl.y)]); hurtZombie(z, bl.dmg, bl.owner); dead = true; break; }
        }
        continue;
      }
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
    dr: G.drops.map(d => [d.id, d.x, d.y, +d.t.toFixed(1)]),
    ev,
    ...(G.mode === 'zombie' ? {
      zb: G.zombies.map(z => [z.id, Math.round(z.x), Math.round(z.y), +z.ang.toFixed(2), Math.ceil(z.hp / z.max * 100), z.boss ? 1 : 0, z.atk > 0 ? 1 : 0]),
      zw: [G.zw.wave, G.zw.phase === 'fight' ? 1 : 0, +Math.max(0, G.zw.t).toFixed(1), G.zw.toSpawn + G.zombies.length + (G.zw.bossT > 0 ? 1 : 0)],
      bc: barricades.map(b => b.hp),
    } : {}),
  };
}
function snapMe(p) {
  return {
    x: +p.x.toFixed(1), y: +p.y.toFixed(1), s: p.slots.map(s => s ? [s.type, s.mag] : null), c: p.cur, am: p.ammo, rk: p.rockets, gr: p.gren, b: p.band, m: p.med, k: p.kills,
    h: p.heal ? [p.heal.type, +p.heal.t.toFixed(2), p.heal.dur] : null, r: +p.reload.toFixed(2), pl: p.place, dt: +p.diedAt.toFixed(1), bd: +p.build.toFixed(2),
  };
}
function match() { return G; }

return {
  TAU, COLS, ROWS, XL, YL, XN, YN, CITY, CX, CY, PRISON, PX, PY, CORR_Y, WORLD, GATE_L, GATE_R, MAX_PLAYERS, LOCKDOWN, SPEED,
  WEAPONS, ITEMS, CREWS, SHOPS, PHASES, GRENADE, BLAST_CORE, DROPS, DROP_FALL, ZW, MALL, ZMAX, ZOMBIE, ZSPAWNS,
  clamp, dist, angDiff, lerpAngle, darken, inRect,
  buildWorld, setDoors, cellWalls, solidAt, blocksSight, pushOut,
  stepProj, createMatch, step, setInput, humanAction, humanLeft, roster, itemList, snapCommon, snapMe, match,
};
});
