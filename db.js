// DUBG accounts storage. Uses Postgres when DATABASE_URL is set (production), otherwise a JSON file in data/
// for local play. Render's disk is wiped on every deploy, so the live site needs DATABASE_URL.
const fs = require('fs');
const path = require('path');
// local runs read DATABASE_URL from .env (git-ignored); on Render it comes from the service's environment
for (const f of ['.env.local', '.env']) try { process.loadEnvFile(path.join(__dirname, f)); } catch (e) { if (e.code !== 'ENOENT') throw e; }

const SQL = `
create table if not exists users (
  id serial primary key,
  name text not null,
  name_lower text not null unique,
  pass text not null,
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  token text primary key,
  user_id integer not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
alter table users add column if not exists look jsonb;
alter table users add column if not exists owned jsonb;
alter table users add column if not exists tonnies integer not null default 0;`;

function postgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5 });
  const one = async (q, v) => (await pool.query(q, v)).rows[0] || null;
  return {
    kind: 'postgres',
    init: () => pool.query(SQL),
    userByName: lower => one('select id, name, pass, look, owned, tonnies from users where name_lower = $1', [lower]),
    // null when the name is taken
    createUser: (name, lower, pass) => one('insert into users (name, name_lower, pass) values ($1, $2, $3) on conflict (name_lower) do nothing returning id, name, look, owned, tonnies', [name, lower, pass]),
    createSession: (token, userId, expires) => pool.query('insert into sessions (token, user_id, expires_at) values ($1, $2, $3)', [token, userId, new Date(expires)]),
    userBySession: token => one('select u.id, u.name, u.look, u.owned, u.tonnies from sessions s join users u on u.id = s.user_id where s.token = $1 and s.expires_at > now()', [token]),
    deleteSession: token => pool.query('delete from sessions where token = $1', [token]),
    setLook: (id, look) => pool.query('update users set look = $2 where id = $1', [id, JSON.stringify(look)]),
    setOwned: (id, owned) => pool.query('update users set owned = $2 where id = $1', [id, JSON.stringify(owned)]),
    // adds (or with a negative n, takes) Tonnies and returns the new balance
    addTonnies: async (id, n) => { const r = await one('update users set tonnies = tonnies + $2 where id = $1 returning tonnies', [id, n]); return r ? r.tonnies : 0; },
    // spends price Tonnies and adds items to what the account owns, in one step; null if the balance is short
    buy: (id, price, items) => one(`update users set tonnies = tonnies - $2, owned = coalesce(owned, '[]'::jsonb) || $3::jsonb
      where id = $1 and tonnies >= $2 returning tonnies, owned`, [id, price, JSON.stringify(items)]),
    close: () => pool.end(),
  };
}

function jsonFile(file) {
  let data = { nextId: 1, users: [], sessions: {} };
  let saving = Promise.resolve();
  // write to a temp file and rename, so a crash mid-write can't leave half a file
  const save = () => (saving = saving.then(() => {
    const tmp = file + '.tmp';
    return fs.promises.writeFile(tmp, JSON.stringify(data)).then(() => fs.promises.rename(tmp, file));
  }));
  const pick = u => u && { id: u.id, name: u.name, pass: u.pass, look: u.look || null, owned: u.owned || null, tonnies: u.tonnies || 0 };
  return {
    kind: 'file ' + path.relative(process.cwd(), file),
    async init() {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      try { data = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
    async userByName(lower) { return pick(data.users.find(u => u.name_lower === lower)); },
    async createUser(name, lower, pass) {
      if (data.users.some(u => u.name_lower === lower)) return null;
      const u = { id: data.nextId++, name, name_lower: lower, pass, created_at: new Date().toISOString() };
      data.users.push(u); await save();
      return { id: u.id, name, look: null, owned: null, tonnies: 0 };
    },
    async createSession(token, userId, expires) { data.sessions[token] = { user_id: userId, expires }; await save(); },
    async userBySession(token) {
      const s = data.sessions[token];
      if (!s || s.expires < Date.now()) return null;
      const u = data.users.find(x => x.id === s.user_id);
      return u ? { id: u.id, name: u.name, look: u.look || null, owned: u.owned || null, tonnies: u.tonnies || 0 } : null;
    },
    async deleteSession(token) { delete data.sessions[token]; await save(); },
    async setLook(id, look) { const u = data.users.find(x => x.id === id); if (u) { u.look = look; await save(); } },
    async setOwned(id, owned) { const u = data.users.find(x => x.id === id); if (u) { u.owned = owned; await save(); } },
    async addTonnies(id, n) { const u = data.users.find(x => x.id === id); if (!u) return 0; u.tonnies = (u.tonnies || 0) + n; await save(); return u.tonnies; },
    async buy(id, price, items) {
      const u = data.users.find(x => x.id === id);
      if (!u || (u.tonnies || 0) < price) return null;
      u.tonnies -= price; u.owned = [...(u.owned || []), ...items]; await save();
      return { tonnies: u.tonnies, owned: u.owned };
    },
    close: () => saving,
  };
}

module.exports = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL) : jsonFile(path.join(__dirname, 'data', 'accounts.json'));
