# Not a Video Player

A local web app that takes magnet links and streams them to VLC. You paste a magnet link into the browser, the server downloads the torrent in the background, and opens the biggest playable file in VLC automatically. That's it.

## Why this exists

Browser-based torrent clients (WebTorrent in the browser) can only connect to WebRTC peers, which means most real-world torrents won't work. Moving the torrent engine to a Node.js backend solves this -- it connects to the full BitTorrent network over TCP/UDP like any normal torrent client, then streams the file over a local HTTP endpoint that VLC can play from.

## How it works

The project has two parts: a Node.js server and a plain HTML/CSS/JS frontend.

### Server (server.js)

The server does three things:

1. **Manages torrents.** When you add a magnet link, the server passes it to WebTorrent which handles peer discovery, metadata fetching, and downloading. Each torrent is tracked in a Map by its info hash. The server also handles duplicate detection -- if you paste the same magnet twice, it returns the existing torrent instead of adding it again.

2. **Streams files over HTTP.** Once a torrent is ready, its files are available at `/api/stream?hash=...&file=...`. This endpoint supports range requests, so VLC can seek through the file while it's still downloading. The server reads chunks from the torrent and pipes them directly to the HTTP response.

3. **Launches VLC.** The `/api/open-vlc` endpoint runs `open -a VLC` with the stream URL. VLC connects back to the server's stream endpoint and starts playing.

Downloaded files are cached in a `.cache` directory inside the project. When you remove a torrent, its cached files are deleted. When all torrents are removed, the entire cache directory is wiped. On shutdown (Ctrl+C), the server destroys all torrents and cleans up the cache.

### Frontend (public/)

The frontend is plain HTML, CSS, and JavaScript -- no frameworks, no build step. It talks to the server through a simple REST API:

- `POST /api/add` -- Add a magnet link. Returns torrent info (name, files, info hash).
- `GET /api/torrents` -- List all active torrents. Used on page load to restore the UI after a refresh.
- `GET /api/stats?hash=...` -- Get download speed, upload speed, peers, and progress for a torrent.
- `GET /api/stream?hash=...&file=...` -- Stream a file. Supports range requests.
- `GET /api/open-vlc?hash=...&file=...` -- Open a file in VLC.
- `DELETE /api/remove?hash=...` -- Remove a torrent and clean its cache.

Each added torrent gets a card showing its name, files, download stats, and a progress bar. Stats are polled every second. Playable files get a "Play in VLC" button. Non-playable files are shown but dimmed.

When a torrent is still connecting to peers, a loading card appears with a cancel button. Cancelling aborts the fetch on the client side and destroys the torrent on the server side, including its cached files.

The UI persists across page refreshes -- on load, the frontend fetches `/api/torrents` and rebuilds cards for any torrents still active on the server.

There's a dark/light theme toggle that saves to localStorage. The theme is applied in a script tag in the head to avoid a flash of the wrong theme on load.

## Supported formats

These file types get a "Play in VLC" button:

**Video:** MP4, MKV, AVI, MOV, WEBM, M4V, OGV

**Audio:** MP3, FLAC, WAV, AAC, OGG, M4A

Other file types in a torrent are still downloaded but can't be played from the UI.

## Setup

Requires Node.js and VLC installed on your machine.

```
npm install
npm start
```

Open http://localhost:8080 in your browser. Paste a magnet link and hit Add.

## Project structure

```
server.js          -- Backend: torrent management, file streaming, VLC launch
public/
  index.html       -- Page structure
  style.css        -- All styles, dark/light theme variables
  app.js           -- Frontend logic: API calls, DOM rendering, stats polling
.cache/            -- Temporary torrent downloads (auto-cleaned)
```

## Notes

- This is a macOS tool. The VLC launch uses `open -a VLC` which is macOS-specific. On Linux you'd change it to `vlc` directly, on Windows to `start vlc`.
- The server listens on port 8080 by default. Set the `PORT` environment variable to change it.
- Cache is stored locally and cleaned up on torrent removal or server shutdown. Nothing persists between server restarts.
- There's no authentication. This is meant to run locally, not exposed to the internet.
