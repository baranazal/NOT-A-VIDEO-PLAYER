import WebTorrent from 'webtorrent';
import http from 'http';
import { readFile, rm, stat, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname, resolve, normalize } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const CACHE_DIR = join(__dirname, '.cache');
const PUBLIC_DIR = join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const MEDIA_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
  '.ogg': 'video/ogg', '.ogv': 'video/ogg'
};

process.on('uncaughtException', err => {
  if (err.message?.includes('prematurely')) return;
  console.error('Uncaught:', err);
});
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

const client = new WebTorrent();
const torrents = new Map();
const pendingMagnets = new Set();

await mkdir(CACHE_DIR, { recursive: true });

function parseInfoHash(magnet) {
  const match = magnet.match(/btih:([a-f0-9]{40})/i);
  return match ? match[1].toLowerCase() : null;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1e6) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getContentType(name) {
  const ext = extname(name).toLowerCase();
  return MEDIA_TYPES[ext] || 'application/octet-stream';
}

function torrentInfo(torrent) {
  return {
    infoHash: torrent.infoHash,
    name: torrent.name,
    files: torrent.files.map((f, i) => ({
      index: i,
      name: f.name,
      length: f.length,
      path: f.path
    }))
  };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const fullPath = resolve(PUBLIC_DIR, '.' + normalize(filePath));

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  stat(fullPath)
    .then(() => readFile(fullPath))
    .then(content => {
      const mime = MIME_TYPES[extname(filePath)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    })
    .catch(() => {
      res.writeHead(404);
      res.end('Not found');
    });
}

async function handleAdd(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }

  const { magnet } = body;
  if (!magnet || typeof magnet !== 'string' || !magnet.startsWith('magnet:')) {
    return json(res, 400, { error: 'Invalid magnet link' });
  }

  const hash = parseInfoHash(magnet);
  if (hash && torrents.has(hash)) {
    return json(res, 200, torrentInfo(torrents.get(hash)));
  }
  if (pendingMagnets.has(magnet)) {
    return json(res, 409, { error: 'This torrent is already being added' });
  }

  pendingMagnets.add(magnet);
  console.log('Adding torrent...');

  let cancelled = false;

  const torrent = client.add(magnet, { path: CACHE_DIR, destroyStoreOnDestroy: true });

  res.on('close', () => {
    if (res.writableFinished) return;
    cancelled = true;
    pendingMagnets.delete(magnet);
    const name = torrent.name;
    console.log('Client cancelled, destroying torrent' + (name ? `: ${name}` : ''));
    try { torrent.destroy(); } catch (e) { console.error('Destroy error:', e.message); }
    if (name) {
      rm(join(CACHE_DIR, name), { recursive: true, force: true })
        .catch(e => console.error('Cache cleanup error:', e.message));
    }
  });

  torrent.on('ready', () => {
    pendingMagnets.delete(magnet);
    if (cancelled) return;
    console.log(`Torrent ready: ${torrent.name} (${torrent.files.length} files)`);
    torrents.set(torrent.infoHash, torrent);
    json(res, 200, torrentInfo(torrent));
  });

  torrent.on('error', err => {
    pendingMagnets.delete(magnet);
    console.error('Torrent error:', err.message);
    json(res, 500, { error: err.message });
  });
}

function handleList(req, res) {
  const list = [];
  for (const torrent of torrents.values()) {
    list.push(torrentInfo(torrent));
  }
  json(res, 200, { torrents: list });
}

function handleStats(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const hash = url.searchParams.get('hash');

  if (!hash) return json(res, 400, { error: 'Missing hash parameter' });

  const torrent = torrents.get(hash);
  if (!torrent) return json(res, 404, { error: 'Torrent not found' });

  json(res, 200, {
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    progress: torrent.progress,
    downloaded: torrent.downloaded,
    numPeers: torrent.numPeers,
    timeRemaining: torrent.timeRemaining
  });
}

function handleStream(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const hash = url.searchParams.get('hash');
  const fileIndex = parseInt(url.searchParams.get('file') || '0', 10);

  if (!hash) { res.writeHead(400); res.end('Missing hash'); return; }

  const torrent = torrents.get(hash);
  if (!torrent) { res.writeHead(404); res.end('Torrent not found'); return; }

  if (isNaN(fileIndex) || fileIndex < 0 || fileIndex >= torrent.files.length) {
    res.writeHead(400); res.end('Invalid file index'); return;
  }

  const file = torrent.files[fileIndex];
  const range = req.headers.range;
  const fileSize = file.length;
  const contentType = getContentType(file.name);

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (isNaN(start) || start < 0 || start >= fileSize || end >= fileSize || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType
    });

    const stream = file.createReadStream({ start, end });
    stream.on('error', err => console.error('Stream read error:', err.message));
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });
    const stream = file.createReadStream();
    stream.on('error', err => console.error('Stream read error:', err.message));
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

function handleOpenVLC(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const hash = url.searchParams.get('hash');
  const fileIndex = url.searchParams.get('file') || '0';

  if (!hash) return json(res, 400, { error: 'Missing hash parameter' });
  if (!torrents.has(hash)) return json(res, 404, { error: 'Torrent not found' });

  const streamUrl = `http://localhost:${PORT}/api/stream?hash=${hash}&file=${fileIndex}`;
  console.log(`Opening in VLC: ${streamUrl}`);
  spawn('open', ['-a', 'VLC', streamUrl]);

  json(res, 200, { ok: true });
}

async function handleRemove(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const hash = url.searchParams.get('hash');

  if (hash) {
    const torrent = torrents.get(hash);
    if (torrent) {
      const name = torrent.name;
      try {
        torrent.destroy();
      } catch (e) {
        console.error('Error destroying torrent:', e.message);
      }
      torrents.delete(hash);
      if (name) {
        try {
          await rm(join(CACHE_DIR, name), { recursive: true, force: true });
          console.log(`Cache cleared for: ${name}`);
        } catch (e) {
          console.error('Error removing cached files:', e.message);
        }
      }
    }
  }

  if (torrents.size === 0) {
    try {
      await rm(CACHE_DIR, { recursive: true, force: true });
      await mkdir(CACHE_DIR, { recursive: true });
      console.log('Cache cleared.');
    } catch (e) {
      console.error('Error clearing cache:', e.message);
    }
  }

  json(res, 200, { ok: true });
}

const routes = {
  'POST /api/add': handleAdd,
  'GET /api/torrents': handleList,
  'GET /api/stats': handleStats,
  'GET /api/stream': handleStream,
  'GET /api/open-vlc': handleOpenVLC,
  'DELETE /api/remove': handleRemove
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const routeKey = `${req.method} ${url.pathname}`;
  const handler = routes[routeKey];

  if (handler) {
    handler(req, res);
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    serveStatic(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  Magnet Player running at http://localhost:${PORT}\n`);
});

function cleanup() {
  console.log('\nCleaning up...');
  try { client.destroy(); } catch (e) { console.error('Client destroy error:', e.message); }
  rm(CACHE_DIR, { recursive: true, force: true })
    .catch(e => console.error('Cache cleanup error:', e.message))
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
