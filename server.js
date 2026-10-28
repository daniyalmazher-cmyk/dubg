// DUBG server: serves the game page and runs one shared lobby + match over WebSockets.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const D = require('./shared/game.js');

const PORT = process.env.PORT || 3000;
const TICK = 1 / 30;           // simulation step
const SEND_EVERY = 2;          // snapshots at 15 per second
const END_DELAY = 12000;       // results screen before returning to the lobby

// ---------- static files ----------
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/shared/game.js': ['shared/game.js', 'text/javascript; charset=utf-8'],
};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  const f = FILES[url];
  if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, f[0]), (err, data) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// ---------- lobby ----------
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const clients = new Map();   // ws -> { cid, name, pid }
let nextCid = 1;
const room = { state: 'lobby', hostCid: null, endAt: 0, tick: 0 };

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const named = () => [...clients.values()].filter(c => c.name);
function lobbyMsg() {
  return { t: 'lobby', state: room.state, host: room.hostCid, players: named().map(c => ({ cid: c.cid, name: c.name, playing: c.pid != null })) };
}
function broadcastLobby() { const m = JSON.stringify(lobbyMsg()); for (const ws of clients.keys()) send(ws, m); }
function cleanName(s) {
  const n = String(s || '').replace(/[^\w .\-]/g, '').trim().slice(0, 14);
  return n || 'Dawg' + Math.floor(Math.random() * 900 + 100);
}
function uniqueName(n) {
  const used = new Set(named().map(c => c.name.toLowerCase()));
  let out = n, k = 2;
  while (used.has(out.toLowerCase())) out = `${n.slice(0, 12)}${k++}`;
  return out;
}
function matchMsg(pid) {
  const G = D.match();
  return { t: 'match', seed: room.seed, you: pid, roster: D.roster(), items: D.itemList(), st: G.state };
}

function startMatch() {
  const humans = named().slice(0, D.MAX_PLAYERS);
  room.seed = Math.floor(Math.random() * 1e9);
  D.createMatch(humans.map(c => ({ name: c.name })), room.seed);
  for (const c of clients.values()) c.pid = null;
  humans.forEach((c, i) => { c.pid = i; });
  room.state = 'match'; room.endAt = 0; room.tick = 0;
  for (const [ws, c] of clients) if (c.name) send(ws, matchMsg(c.pid));
  broadcastLobby();
  console.log(`match started: ${humans.length} players, ${D.MAX_PLAYERS - humans.length} bots`);
}
function endMatch() {
  room.state = 'lobby'; room.endAt = 0;
  for (const c of clients.values()) c.pid = null;
  broadcastLobby();
}

wss.on('connection', ws => {
  const c = { cid: nextCid++, name: null, pid: null };
  clients.set(ws, c);
  send(ws, { t: 'hello', cid: c.cid });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const G = D.match();
    const me = room.state === 'match' && c.pid != null ? G.players[c.pid] : null;
    switch (m.t) {
      case 'join':
        if (c.name) return;
        c.name = uniqueName(cleanName(m.name));
        if (room.hostCid == null) room.hostCid = c.cid;
        send(ws, { t: 'joined', cid: c.cid, name: c.name });
        if (room.state === 'match') send(ws, matchMsg(null));
        broadcastLobby();
        break;
      case 'start':
        if (c.cid === room.hostCid && room.state === 'lobby') startMatch();
        break;
      case 'in':
        if (me) D.setInput(me, m);
        break;
      case 'act':
        if (me) D.humanAction(me, String(m.a), m.v);
        break;
      case 'ping':
        send(ws, { t: 'pong', c: m.c });
        break;
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    if (room.state === 'match' && c.pid != null) D.humanLeft(D.match().players[c.pid]);
    if (room.hostCid === c.cid) { const next = named()[0]; room.hostCid = next ? next.cid : null; }
    broadcastLobby();
  });
});

// ---------- game loop ----------
let last = Date.now(), acc = 0;
setInterval(() => {
  const now = Date.now();
  acc += Math.min(0.25, (now - last) / 1000); last = now;
  if (room.state !== 'match') { acc = 0; return; }
  const G = D.match();
  while (acc >= TICK) {
    acc -= TICK;
    D.step(TICK);
    room.tick++;
    if (room.tick % SEND_EVERY === 0) {
      const common = JSON.stringify(D.snapCommon()).slice(0, -1);
      for (const [ws, c] of clients) {
        if (!c.name) continue;
        send(ws, c.pid != null ? `${common},"me":${JSON.stringify(D.snapMe(G.players[c.pid]))}}` : common + '}');
      }
    }
  }
  if (G.state === 'over' && !room.endAt) room.endAt = now + END_DELAY;
  if (room.endAt && now > room.endAt) endMatch();
  // nobody left watching: stop simulating
  if (room.state === 'match' && named().length === 0) endMatch();
}, 1000 * TICK);

server.listen(PORT, () => console.log(`DUBG server on http://localhost:${PORT}`));
