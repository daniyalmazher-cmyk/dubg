// Give (or with a negative amount, take) Tonnies, e.g.
//   node scripts/tonnies.js Outfitter 1000
// Uses DATABASE_URL when set, like the server. With the local accounts file, stop the server first:
// it keeps the file in memory and would write over the change.
const db = require('../db.js');

const [name, amount] = process.argv.slice(2), n = Math.trunc(+amount);
if (!name || !n) { console.log('usage: node scripts/tonnies.js <player> <amount>'); process.exit(1); }

(async () => {
  await db.init();
  const user = await db.userByName(name.toLowerCase());
  if (!user) { console.log(`No player called ${name}.`); process.exit(1); }
  const balance = await db.addTonnies(user.id, n);
  await db.close();
  console.log(`${user.name} now has ${balance.toLocaleString()} Tonnies`);
})().catch(e => { console.error(e.message); process.exit(1); });
