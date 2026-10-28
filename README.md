# DUBG: Dawg Unknown Battle Ground

Browser battle royale. 30 players (empty spots filled with bots) break out of a prison,
loot a city at night, and fight inside a shrinking zone.

## Run it on your own computer

```
npm install
npm start
```

Open http://localhost:3000. Friends on the same Wi-Fi can join at `http://<your-computer's-IP>:3000`.

## Put it online (Render, free)

1. Push this folder to a GitHub repository.
2. On https://render.com, choose **New > Blueprint** and pick the repository.
   `render.yaml` sets up a free Node web service in the **Singapore** region.
3. When the deploy finishes, Render gives you a link like `https://dubg.onrender.com`.
   Send that link to your friends.

On the free plan the server sleeps after 15 minutes with nobody connected. The first person
to open the link waits about a minute while it wakes up.

## How a match works

- Everyone who opens the link types a name and lands in the lobby.
- The first person in is the host and presses **Start match**.
- Bots fill the remaining spots up to 30.
- People who join during a match watch it and play in the next one.

## Files

- `server.js`: serves the page, runs the lobby and the match (30 ticks per second, 15 updates per second to players).
- `shared/game.js`: map generation, collision and all game rules. Used by the server and the browser.
- `public/index.html`: the game client. Draws the game, predicts your own movement, smooths everyone else.
- `preview.html`: the old single-player version with bots only.
