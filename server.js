/**
 * IPTV M3U Server - Node.js
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { updateIPTV }          = require('./lib/updater');
const { generatePlaylist }    = require('./lib/playlist');
const { scheduleUpdates }     = require('./lib/scheduler');
const { fetchAndCheckGitHub } = require('./lib/github-fetcher');
const { runSearch, abort, isAborted } = require('./lib/github-search');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Helpers ──────────────────────────────────────────────────────────────────
function serveM3U(res, filePath, notFoundMsg) {
  if (!fs.existsSync(filePath)) return res.status(404).send(notFoundMsg + '\n');
  res.setHeader('Content-Type', 'application/x-mpegurl');
  res.sendFile(filePath);
}
function serveJSON(res, reportPath, emptyMsg) {
  if (!fs.existsSync(reportPath)) return res.json({ message: emptyMsg });
  try { res.json(JSON.parse(fs.readFileSync(reportPath, 'utf-8'))); }
  catch { res.json({ message: 'Report file is corrupt.' }); }
}

// ─── Playlist routes ──────────────────────────────────────────────────────────
app.get('/health',          (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/index.m3u',       (req, res) => serveM3U(res, path.join(DATA_DIR,'index.m3u'),          '# Not generated yet.'));
app.get('/dead.m3u',        (req, res) => serveM3U(res, path.join(DATA_DIR,'index_dead.m3u'),     '# No dead channels yet.'));
app.get('/playlist.m3u',    (req, res) => serveM3U(res, path.join(DATA_DIR,'playlist.m3u'),       '# Not generated yet.'));
app.get('/iptv-org.m3u',    (req, res) => serveM3U(res, path.join(DATA_DIR,'iptv-org.m3u'),       '# Not generated yet.'));
app.get('/github.m3u',      (req, res) => serveM3U(res, path.join(DATA_DIR,'github-merged.m3u'),  '# POST /api/github-fetch first.'));
app.get('/github-dead.m3u', (req, res) => serveM3U(res, path.join(DATA_DIR,'github-dead.m3u'),   '# No dead GitHub channels yet.'));
app.get('/search.m3u',      (req, res) => serveM3U(res, path.join(DATA_DIR,'search-results.m3u'),'# POST /api/search/start first.'));
app.get('/search-dead.m3u', (req, res) => serveM3U(res, path.join(DATA_DIR,'search-dead.m3u'),   '# No dead search channels yet.'));

// ─── Stats routes ─────────────────────────────────────────────────────────────
app.get('/api/stats',         (req, res) => serveJSON(res, path.join(DATA_DIR,'report.json'),        'No report yet.'));
app.get('/api/github-stats',  (req, res) => serveJSON(res, path.join(DATA_DIR,'github-report.json'), 'No GitHub report yet.'));
app.get('/api/search-stats',  (req, res) => serveJSON(res, path.join(DATA_DIR,'search-report.json'), 'No search report yet.'));
app.get('/api/github-sources',(req, res) => {
  const { GITHUB_M3U_SOURCES } = require('./lib/github-sources');
  res.json({ total: GITHUB_M3U_SOURCES.length, sources: GITHUB_M3U_SOURCES });
});

// ─── Action routes ────────────────────────────────────────────────────────────
app.post('/api/update', async (req, res) => {
  res.json({ message: 'Update started.' });
  try { await updateIPTV(); } catch (e) { console.error('[server] update:', e.message); }
});
app.post('/api/generate-playlist', async (req, res) => {
  res.json({ message: 'Playlist generation started.' });
  try { await generatePlaylist(); } catch (e) { console.error('[server] playlist:', e.message); }
});
app.post('/api/github-fetch', async (req, res) => {
  res.json({ message: 'GitHub fetch started.' });
  try { await fetchAndCheckGitHub(); } catch (e) { console.error('[server] gh-fetch:', e.message); }
});

// ─── GitHub Search: SSE stream ────────────────────────────────────────────────
// Tracks active SSE clients so we can push events from the background job
const sseClients = new Set();
let searchRunning = false;

// SSE connection — browser connects here and receives live events
app.get('/api/search/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx compat
  res.flushHeaders();

  // Send current running state immediately on connect
  const initPayload = JSON.stringify({ running: searchRunning });
  res.write(`event: init\ndata: ${initPayload}\n\n`);

  // Keep-alive ping every 15s
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  sseClients.add(res);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch {}
  }
}

// Start a new search
app.post('/api/search/start', async (req, res) => {
  if (searchRunning) {
    return res.json({ ok: false, message: 'Search already running.' });
  }
  res.json({ ok: true, message: 'Search started.' });
  searchRunning = true;
  broadcast('status', { running: true });

  try {
    await runSearch((type, payload) => broadcast(type, payload));
  } catch (err) {
    broadcast('error', { message: err.message });
    console.error('[server] search error:', err.message);
  }

  searchRunning = false;
  broadcast('status', { running: false });
});

// Stop a running search
app.post('/api/search/stop', (req, res) => {
  if (!searchRunning) return res.json({ ok: false, message: 'No search running.' });
  abort();
  res.json({ ok: true, message: 'Stop signal sent.' });
});

// Current search status
app.get('/api/search/status', (req, res) => {
  res.json({ running: searchRunning, aborted: isAborted() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] IPTV server on port ${PORT}`);
  console.log(`  GET  /search.m3u          → Search results (working streams)`);
  console.log(`  GET  /api/search/stream   → SSE live event stream`);
  console.log(`  POST /api/search/start    → Start GitHub raw search`);
  console.log(`  POST /api/search/stop     → Stop running search`);
  scheduleUpdates();
});
