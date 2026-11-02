// Give a player items, e.g.
//   node scripts/grant.js Outfitter Skeleton            (every piece of a set)
//   node scripts/grant.js Outfitter head:skeleton       (one item: area:id)
// Add --remove to take them away. Uses DATABASE_URL when set, like the server. With the local accounts file,
// stop the server first: it keeps the file in memory and would write over the change.
const D = require('../shared/game.js');
const db = require('../db.js');

const [name, what, flag] = process.argv.slice(2);
if (!name || !what) { console.log('usage: node scripts/grant.js <player> <"Set name" | area:id> [--remove]'); process.exit(1); }
const items = [];
for (const slot of D.SLOTS) for (const it of D.COSMETICS[slot]) {
  const set = it.set && D.SETS[it.set], w = what.toLowerCase();
  if (set && (it.set === w || set.name.toLowerCase() === w) || `${slot}:${it.id}` === what) items.push(`${slot}:${it.id}`);
}
if (!items.length) { console.log(`No set or item called "${what}".`); process.exit(1); }

(async () => {
  await db.init();
  const user = await db.userByName(name.toLowerCase());
  if (!user) { console.log(`No player called ${name}.`); process.exit(1); }
  const had = new Set(Array.isArray(user.owned) ? user.owned : []);
  for (const i of items) if (flag === '--remove') had.delete(i); else had.add(i);
  await db.setOwned(user.id, [...had]);
  await db.close();
  console.log(`${user.name} now owns: ${[...had].join(', ') || 'nothing extra'}`);
})().catch(e => { console.error(e.message); process.exit(1); });
