// DUBG server: serves the game page and runs a shared lobby plus any number of matches over WebSockets.
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
// Everyone joins one lobby. Starting splits the waiting players into matches of up to
// MAX_PLAYERS; each match runs its own copy of the game code, so several can run at once.
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const clients = new Map();   // ws -> { cid, name, match, pid }
const matches = new Set();   // { id, E, seed, tick, endAt }
let nextCid = 1, nextMatch = 1;

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const named = () => [...clients.values()].filter(c => c.name);
const waiting = () => named().filter(c => !c.match);
const members = m => [...clients.entries()].filter(([, c]) => c.match === m);
const hostCid = () => { const w = waiting(); return w.length ? w[0].cid : null; };
function broadcastLobby() {
  const host = hostCid();
  const players = named().map(c => ({ cid: c.cid, name: c.name, playing: !!c.match }));
  for (const [ws, c] of clients) if (c.name) send(ws, { t: 'lobby', state: c.match ? 'match' : 'lobby', host, players, games: matches.size });
}
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

function startMatches() {
  const w = waiting();
  for (let i = 0; i < w.length; i += D.MAX_PLAYERS) {
    const humans = w.slice(i, i + D.MAX_PLAYERS);
    const m = { id: nextMatch++, E: D.instance(), seed: Math.floor(Math.random() * 1e9), tick: 0, endAt: 0 };
    m.E.createMatch(humans.map(c => ({ name: c.name })), m.seed);
    matches.add(m);
    humans.forEach((c, pid) => { c.match = m; c.pid = pid; });
    const roster = m.E.roster(), items = m.E.itemList(), st = m.E.match().state;
    for (const [ws, c] of members(m)) send(ws, { t: 'match', seed: m.seed, you: c.pid, roster, items, st });
    console.log(`match ${m.id} started: ${humans.length} players, ${D.MAX_PLAYERS - humans.length} bots`);
  }
  broadcastLobby();
}
function leaveMatch(c) {
  const m = c.match; if (!m) return;
  const p = m.E.match().players[c.pid];
  if (p && p.alive) m.E.humanLeft(p);
  c.match = null; c.pid = null;
}
function endMatch(m) {
  matches.delete(m);
  for (const [, c] of members(m)) { c.match = null; c.pid = null; }
  console.log(`match ${m.id} ended`);
  broadcastLobby();
}

wss.on('connection', ws => {
  const c = { cid: nextCid++, name: null, match: null, pid: null };
  clients.set(ws, c);
  send(ws, { t: 'hello', cid: c.cid });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const me = c.match ? c.match.E.match().players[c.pid] : null;
    switch (m.t) {
      case 'join':
        if (c.name) return;
        c.name = uniqueName(cleanName(m.name));
        send(ws, { t: 'joined', cid: c.cid, name: c.name });
        broadcastLobby();
        break;
      case 'start':
        if (!c.match && c.cid === hostCid()) startMatches();
        break;
      case 'leave':
        if (c.match) { leaveMatch(c); broadcastLobby(); }
        break;
      case 'in':
        if (me) c.match.E.setInput(me, m);
        break;
      case 'act':
        if (me) c.match.E.humanAction(me, String(m.a), m.v);
        break;
      case 'ping':
        send(ws, { t: 'pong', c: m.c });
        break;
    }
  });
  ws.on('close', () => {
    leaveMatch(c);
    clients.delete(ws);
    broadcastLobby();
  });
});

// ---------- game loop ----------
let last = Date.now(), acc = 0;
setInterval(() => {
  const now = Date.now();
  acc += Math.min(0.25, (now - last) / 1000); last = now;
  if (!matches.size) { acc = 0; return; }
  const steps = Math.floor(acc / TICK); acc -= steps * TICK;
  for (const m of [...matches]) {
    const E = m.E, G = E.match(), who = members(m);
    // every real player has left: no point running it for the bots
    if (!who.length) { endMatch(m); continue; }
    for (let i = 0; i < steps; i++) {
      E.step(TICK);
      if (++m.tick % SEND_EVERY === 0) {
        const common = JSON.stringify(E.snapCommon()).slice(0, -1);
        for (const [ws, c] of who) send(ws, `${common},"me":${JSON.stringify(E.snapMe(G.players[c.pid]))}}`);
      }
    }
    if (G.state === 'over' && !m.endAt) m.endAt = now + END_DELAY;
    if (m.endAt && now > m.endAt) endMatch(m);
  }
}, 1000 * TICK);

server.listen(PORT, () => console.log(`DUBG server on http://localhost:${PORT}`));
