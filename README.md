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

## How to play

- **Find match**: joins the public queue. A match starts as soon as 10 players are queued,
  or after 20 seconds with whoever is waiting. Bots fill the rest of the 30 spots.
- **Create private room**: gives you a 5-letter code and an invite link. Only people with the
  code can join. The room boss starts the match, and everyone returns to the room afterwards.
- **Join private room**: type the code (or open an invite link, which fills it in).
- A match is deleted as soon as every real player has left it, and a room is deleted when it is empty.

Server settings (environment variables): `QUEUE_SIZE` (default 10), `QUEUE_WAIT` in seconds
(default 20), `MAX_MATCHES` running at once (default 12).

To add another server (for example a Gulf one), add it to the `SERVERS` list in `public/index.html`.

## Files

- `server.js`: serves the page, runs matchmaking, private rooms and every match (30 ticks per second, 15 updates per second to players).
- `shared/game.js`: map generation, collision and all game rules. Used by the server and the browser.
- `public/index.html`: the game client. Draws the game, predicts your own movement, smooths everyone else.
- `public/r3d.js`: the 3D view (three.js, tilted camera). The 2D drawing in `index.html` is only a fallback for devices without WebGL.
- `public/assets/`: gun models (`pistol.glb`, `smg.glb`, `shotgun.glb`, `rifle.glb`), CC0 by Quaternius (quaternius.com), from poly.pizza.
  Players and cars are built from boxes in `r3d.js`, so every outfit (hoodie, skin, hat, crew colour) carries over from the game data.
- `preview.html`: the old single-player version with bots only.
