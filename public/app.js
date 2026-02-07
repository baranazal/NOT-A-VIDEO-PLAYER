const activeTorrents = new Map();
const pendingAdds = new Map();
let statsInterval = null;

const VIDEO_EXTS = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.ogg', '.ogv'];
const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a'];

const $ = id => document.getElementById(id);

function isPlayable(name) {
  const lower = name.toLowerCase();
  return VIDEO_EXTS.some(e => lower.endsWith(e)) || AUDIO_EXTS.some(e => lower.endsWith(e));
}

function parseInfoHash(magnet) {
  const match = magnet.match(/btih:([a-f0-9]{40})/i);
  return match ? match[1].toLowerCase() : null;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function showToast(msg, type = 'error') {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function checkEmpty() {
  $('emptyState').style.display =
    activeTorrents.size === 0 && !document.querySelector('.loading-card')
      ? 'block' : 'none';
}

function startStatsPolling() {
  if (statsInterval) return;
  statsInterval = setInterval(updateAllStats, 1000);
}

function stopStatsPolling() {
  if (activeTorrents.size === 0 && statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

async function updateAllStats() {
  for (const hash of activeTorrents.keys()) {
    try {
      const resp = await fetch(`/api/stats?hash=${hash}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const dl = $('dl-' + hash);
      const ul = $('ul-' + hash);
      const peers = $('peers-' + hash);
      const down = $('down-' + hash);
      const prog = $('prog-' + hash);
      if (dl) dl.textContent = formatBytes(data.downloadSpeed) + '/s';
      if (ul) ul.textContent = formatBytes(data.uploadSpeed) + '/s';
      if (peers) peers.textContent = data.numPeers;
      if (down) down.textContent = formatBytes(data.downloaded);
      if (prog) prog.style.width = (data.progress * 100).toFixed(1) + '%';
    } catch (e) {
      console.warn('Stats fetch failed for', hash, e.message);
    }
  }
}

async function playInVLC(hash, fileIndex) {
  showToast('Opening in VLC...', 'success');
  try {
    const resp = await fetch(`/api/open-vlc?hash=${hash}&file=${fileIndex}`);
    if (!resp.ok) showToast('Failed to open VLC');
  } catch (e) {
    showToast('Failed to open VLC: ' + e.message);
  }
}

async function removeTorrent(hash) {
  try {
    await fetch(`/api/remove?hash=${hash}`, { method: 'DELETE' });
  } catch (e) {
    console.warn('Remove request failed:', e.message);
  }

  activeTorrents.delete(hash);
  $('torrent-' + hash)?.remove();
  checkEmpty();
  stopStatsPolling();
}

function renderTorrentCard(data) {
  if ($('torrent-' + data.infoHash)) return;

  const card = document.createElement('div');
  card.className = 'torrent-card';
  card.id = 'torrent-' + data.infoHash;

  const header = document.createElement('div');
  header.className = 'torrent-header';

  const title = document.createElement('h3');
  title.textContent = data.name || 'Unknown';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => removeTorrent(data.infoHash));

  header.append(title, removeBtn);
  card.appendChild(header);

  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.innerHTML = `
    <div class="stat-card"><div class="label">Download</div><div class="value" id="dl-${data.infoHash}">0 B/s</div></div>
    <div class="stat-card"><div class="label">Upload</div><div class="value" id="ul-${data.infoHash}">0 B/s</div></div>
    <div class="stat-card"><div class="label">Peers</div><div class="value" id="peers-${data.infoHash}">0</div></div>
    <div class="stat-card"><div class="label">Downloaded</div><div class="value" id="down-${data.infoHash}">0 B</div></div>
  `;
  card.appendChild(stats);

  const progressBar = document.createElement('div');
  progressBar.className = 'progress-bar';
  progressBar.innerHTML = `<div class="fill" id="prog-${data.infoHash}"></div>`;
  card.appendChild(progressBar);

  for (const file of data.files) {
    const div = document.createElement('div');
    div.className = 'file-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = file.name;

    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'size';
    sizeSpan.textContent = formatBytes(file.length);

    div.append(nameSpan, sizeSpan);

    if (isPlayable(file.name)) {
      const vlcBtn = document.createElement('button');
      vlcBtn.className = 'file-btn';
      vlcBtn.textContent = 'Play in VLC';
      vlcBtn.addEventListener('click', () => playInVLC(data.infoHash, file.index));
      div.appendChild(vlcBtn);
    } else {
      div.style.opacity = '0.4';
    }

    card.appendChild(div);
  }

  $('torrentList').prepend(card);
}

async function addMagnet() {
  const input = $('magnetInput');
  const magnet = input.value.trim();

  if (!magnet) return showToast('Please paste a magnet link.');
  if (!magnet.startsWith('magnet:')) return showToast('Invalid magnet link.');

  const hash = parseInfoHash(magnet);
  if (hash && activeTorrents.has(hash)) {
    input.value = '';
    return showToast('Torrent already added.');
  }

  input.value = '';
  $('emptyState').style.display = 'none';

  const loadingId = 'loading-' + Date.now();
  const controller = new AbortController();
  pendingAdds.set(loadingId, controller);

  const loadingCard = document.createElement('div');
  loadingCard.className = 'loading-card';
  loadingCard.id = loadingId;

  const spinner = document.createElement('div');
  spinner.className = 'spinner';

  const text = document.createElement('span');
  text.className = 'loading-text';
  text.textContent = 'Connecting to peers...';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'remove-btn loading-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    controller.abort();
    loadingCard.remove();
    pendingAdds.delete(loadingId);
    checkEmpty();
  });

  loadingCard.append(spinner, text, cancelBtn);
  $('torrentList').prepend(loadingCard);

  try {
    const resp = await fetch('/api/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet }),
      signal: controller.signal
    });
    const data = await resp.json();

    pendingAdds.delete(loadingId);
    $(loadingId)?.remove();

    if (data.error) {
      showToast(data.error);
      checkEmpty();
      return;
    }

    activeTorrents.set(data.infoHash, data);
    renderTorrentCard(data);
    startStatsPolling();

    const playableFiles = data.files.filter(f => isPlayable(f.name));
    if (playableFiles.length > 0) {
      const biggest = playableFiles.reduce((a, b) => a.length > b.length ? a : b);
      playInVLC(data.infoHash, biggest.index);
    }
  } catch (e) {
    pendingAdds.delete(loadingId);
    $(loadingId)?.remove();
    if (e.name !== 'AbortError') {
      showToast('Failed to connect to server: ' + e.message);
    }
    checkEmpty();
  }
}

async function loadExisting() {
  try {
    const resp = await fetch('/api/torrents');
    if (!resp.ok) return;
    const data = await resp.json();
    for (const t of data.torrents) {
      if (!activeTorrents.has(t.infoHash)) {
        activeTorrents.set(t.infoHash, t);
        renderTorrentCard(t);
      }
    }
    if (data.torrents.length > 0) startStatsPolling();
    checkEmpty();
  } catch (e) {
    console.warn('Failed to load existing torrents:', e.message);
  }
}

function initTheme() {
  const themeBtn = $('themeToggle');
  const saved = localStorage.getItem('theme') || 'dark';

  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    themeBtn.textContent = '\u2600\uFE0F';
  } else {
    themeBtn.textContent = '\uD83C\uDF19';
  }

  themeBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    if (next === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      themeBtn.textContent = '\u2600\uFE0F';
    } else {
      document.documentElement.removeAttribute('data-theme');
      themeBtn.textContent = '\uD83C\uDF19';
    }
    localStorage.setItem('theme', next);
  });
}

function init() {
  initTheme();
  $('loadBtn').addEventListener('click', addMagnet);
  $('magnetInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addMagnet();
  });
  loadExisting();
}

init();
