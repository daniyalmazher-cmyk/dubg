// DUBG server: serves the game page, runs public matchmaking and private rooms, and simulates
// any number of matches at once over WebSockets.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const D = require('./shared/game.js');

const PORT = process.env.PORT || 3000;
const TICK = 1 / 30;                                         // simulation step
const SEND_EVERY = 2;                                        // snapshots at 15 per second
const END_DELAY = 12000;                                     // results screen before players are sent back
const QUEUE_SIZE = +process.env.QUEUE_SIZE || 10;            // real players per public match
const QUEUE_WAIT = (+process.env.QUEUE_WAIT || 20) * 1000;   // start with whoever is queued after this long
const MAX_MATCHES = +process.env.MAX_MATCHES || 12;          // keep a small server from being overloaded
const MODES = { br: { size: QUEUE_SIZE, max: D.MAX_PLAYERS }, zombie: { size: D.ZMAX, max: D.ZMAX } };
const modeOf = m => m === 'zombie' ? 'zombie' : 'br';

// ---------- static files ----------
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/shared/game.js': ['shared/game.js', 'text/javascript; charset=utf-8'],
  '/r3d.js': ['public/r3d.js', 'text/javascript; charset=utf-8'],
};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  // sound effects: plain names only, so nothing outside public/sounds can be asked for
  const snd = /^\/sounds\/[a-z0-9_]+\.m4a$/.test(url);
  const f = snd ? ['public' + url, 'audio/mp4'] : FILES[url];
  if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, f[0]), (err, data) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); res.end(); return; }
    res.writeHead(200, { 'content-type': f[1], 'cache-control': snd ? 'public, max-age=86400' : 'no-cache' });
    res.end(data);
  });
});

// ---------- state ----------
// client: { cid, ws, name, queued, room, match, pid }
// room:   { code, owner, members: [client], match, bots, mode }
// match:  { id, E, seed, tick, endAt, room, mode }
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const clients = new Map();   // ws -> client
// clients waiting for a public match, oldest first; one queue per mode
const queues = { br: { list: [], deadline: 0 }, zombie: { list: [], deadline: 0 } };
const rooms = new Map();     // code -> room
const matches = new Set();
let nextCid = 1, nextMatch = 1;

const send = (c, obj) => { if (c.ws.readyState === 1) c.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
function cleanName(s) {
  const n = String(s || '').replace(/[^\w .\-]/g, '').trim().slice(0, 14);
  return n || 'Dawg' + Math.floor(Math.random() * 900 + 100);
}
// names only need to be unique inside one match
function uniqueNames(list) {
  const used = new Set();
  return list.map(c => {
    let out = c.name, k = 2;
    while (used.has(out.toLowerCase())) out = `${c.name.slice(0, 12)}${k++}`;
    used.add(out.toLowerCase());
    return { name: out };
  });
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let code;
  do { code = ''; for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; } while (rooms.has(code));
  return code;
}

// ---------- matches ----------
function startMatch(humans, room, mode) {
  const m = { id: nextMatch++, E: D.instance(), seed: Math.floor(Math.random() * 1e9), tick: 0, endAt: 0, room, mode };
  m.E.createMatch(uniqueNames(humans), m.seed, { bots: room ? room.bots : true, mode });
  matches.add(m);
  const roster = m.E.roster(), items = m.E.itemList(), st = m.E.match().state;
  humans.forEach((c, pid) => {
    c.match = m; c.pid = pid;
    send(c, { t: 'match', seed: m.seed, mode, you: pid, roster, items, st, room: room ? room.code : null });
  });
  if (room) { room.match = m; roomUpdate(room); }
  console.log(`match ${m.id} started (${mode}, ${room ? 'room ' + room.code : 'public'}): ${humans.length} players, ${m.E.match().players.length - humans.length} bots`);
}
const inMatch = m => [...clients.values()].filter(c => c.match === m);
function leaveMatch(c) {
  const m = c.match; if (!m) return;
  const p = m.E.match().players[c.pid];
  if (p && p.alive) m.E.humanLeft(p);
  c.match = null; c.pid = null;
  send(c, { t: 'ended' });
  if (m.room) roomUpdate(m.room);
}
function endMatch(m) {
  matches.delete(m);
  for (const c of inMatch(m)) { c.match = null; c.pid = null; send(c, { t: 'ended' }); }
  if (m.room && m.room.match === m) { m.room.match = null; roomUpdate(m.room); }
  console.log(`match ${m.id} ended`);
}

// ---------- public queue ----------
function queueUpdate() {
  for (const [mode, q] of Object.entries(queues)) {
    const left = q.list.length ? Math.max(0, Math.ceil((q.deadline - Date.now()) / 1000)) : 0;
    for (const c of q.list) send(c, { t: 'queue', mode, n: q.list.length, max: MODES[mode].size, left, full: matches.size >= MAX_MATCHES });
  }
}
function unqueue(c) {
  for (const q of Object.values(queues)) {
    const i = q.list.indexOf(c); if (i < 0) continue;
    q.list.splice(i, 1); c.queued = false;
    if (!q.list.length) q.deadline = 0;
  }
  queueUpdate();
}
function pumpQueue() {
  for (const [mode, q] of Object.entries(queues)) {
    const size = MODES[mode].size;
    while (q.list.length && matches.size < MAX_MATCHES && (q.list.length >= size || Date.now() >= q.deadline)) {
      const group = q.list.splice(0, size);
      for (const c of group) c.queued = false;
      q.deadline = q.list.length ? Date.now() + QUEUE_WAIT : 0;
      startMatch(group, null, mode);
    }
  }
  queueUpdate();
}

// ---------- private rooms ----------
function roomUpdate(r) {
  const msg = {
    t: 'room', code: r.code, owner: r.owner.cid, max: MODES[r.mode].max, live: !!r.match, bots: r.bots, mode: r.mode,
    players: r.members.map(c => ({ cid: c.cid, name: c.name, playing: !!r.match && c.match === r.match })),
  };
  for (const c of r.members) send(c, msg);
}
function leaveRoom(c) {
  const r = c.room; if (!r) return;
  leaveMatch(c);
  r.members = r.members.filter(x => x !== c);
  c.room = null;
  send(c, { t: 'home' });
  if (!r.members.length) { rooms.delete(r.code); console.log(`room ${r.code} closed`); return; }
  if (r.owner === c) r.owner = r.members[0];
  roomUpdate(r);
}

// ---------- connections ----------
wss.on('connection', ws => {
  const c = { cid: nextCid++, ws, name: null, queued: false, room: null, match: null, pid: null };
  clients.set(ws, c);
  send(c, { t: 'hello', cid: c.cid });
  send(c, stats());
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const me = c.match ? c.match.E.match().players[c.pid] : null;
    const free = !c.queued && !c.room && !c.match;
    switch (m.t) {
      case 'queue': {
        if (!free) return;
        const q = queues[modeOf(m.mode)];
        c.name = cleanName(m.name);
        c.queued = true; q.list.push(c);
        if (!q.deadline) q.deadline = Date.now() + QUEUE_WAIT;
        pumpQueue();
        break;
      }
      case 'unqueue':
        unqueue(c);
        send(c, { t: 'home' });
        break;
      case 'create': {
        if (!free) return;
        c.name = cleanName(m.name);
        const r = { code: newCode(), owner: c, members: [c], match: null, bots: true, mode: modeOf(m.mode) };
        rooms.set(r.code, r); c.room = r;
        console.log(`room ${r.code} opened`);
        roomUpdate(r);
        break;
      }
      case 'join': {
        if (!free) return;
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) { send(c, { t: 'err', msg: 'No room with that code. Check it and try again.' }); return; }
        if (r.members.length >= MODES[r.mode].max) { send(c, { t: 'err', msg: 'That room is full.' }); return; }
        c.name = cleanName(m.name);
        r.members.push(c); c.room = r;
        roomUpdate(r);
        break;
      }
      case 'roomBots':
        if (c.room && c.room.owner === c && !c.room.match) { c.room.bots = !!m.on; roomUpdate(c.room); }
        break;
      case 'roomMode': {
        const r = c.room, mode = modeOf(m.mode);
        if (!r || r.owner !== c || r.match) return;
        if (r.members.length > MODES[mode].max) { send(c, { t: 'err', msg: `Zombie mode takes ${D.ZMAX} players at most. This room has ${r.members.length}.` }); roomUpdate(r); return; }
        r.mode = mode; roomUpdate(r);
        break;
      }
      case 'leaveRoom':
        leaveRoom(c);
        break;
      case 'start': {
        const r = c.room;
        if (!r || r.owner !== c || r.match) return;
        if (matches.size >= MAX_MATCHES) { send(c, { t: 'err', msg: 'The server is busy right now. Try again in a minute.' }); return; }
        if (r.mode === 'br' && !r.bots && r.members.length < 2) { send(c, { t: 'err', msg: 'With bots off you need at least 2 players. Turn bots on to play solo.' }); return; }
        startMatch(r.members.slice(), r, r.mode);
        break;
      }
      case 'leave':
        leaveMatch(c);
        break;
      case 'in':
        if (me) c.match.E.setInput(me, m);
        break;
      case 'act':
        if (me) c.match.E.humanAction(me, String(m.a), m.v);
        break;
      case 'ping':
        send(c, { t: 'pong', c: m.c });
        break;
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    unqueue(c);
    if (c.room) leaveRoom(c); else leaveMatch(c);
  });
});

function stats() { return { t: 'stats', online: clients.size, live: matches.size, queued: queues.br.list.length + queues.zombie.list.length }; }
setInterval(() => { const s = JSON.stringify(stats()); for (const c of clients.values()) if (!c.match) send(c, s); }, 2000);
setInterval(pumpQueue, 1000);

// ---------- game loop ----------
let last = Date.now(), acc = 0;
setInterval(() => {
  const now = Date.now();
  acc += Math.min(0.25, (now - last) / 1000); last = now;
  if (!matches.size) { acc = 0; return; }
  const steps = Math.floor(acc / TICK); acc -= steps * TICK;
  for (const m of [...matches]) {
    const E = m.E, G = E.match(), who = inMatch(m);
    // every real player has left: no point running it for the bots
    if (!who.length) { endMatch(m); continue; }
    for (let i = 0; i < steps; i++) {
      E.step(TICK);
      if (++m.tick % SEND_EVERY === 0) {
        const common = JSON.stringify(E.snapCommon()).slice(0, -1);
        for (const c of who) send(c, `${common},"me":${JSON.stringify(E.snapMe(G.players[c.pid]))}}`);
      }
    }
    if (G.state === 'over' && !m.endAt) m.endAt = now + END_DELAY;
    if (m.endAt && now > m.endAt) endMatch(m);
  }
}, 1000 * TICK);

server.listen(PORT, () => console.log(`DUBG server on http://localhost:${PORT}`));
