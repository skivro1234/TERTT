/**
 * lib/github-search.js
 *
 * Searches GitHub's code-search API for ALL public .m3u / .m3u8 files,
 * fetches every raw file found, parses channels, checks each stream,
 * and emits real-time events via a callback.
 *
 * GitHub code search:
 *   GET https://api.github.com/search/code?q=extension:m3u&per_page=100&page=N
 *   Rate limit (unauthenticated): 10 req/min  → we add a token if GITHUB_TOKEN is set
 *   Max results GitHub exposes:  1 000 items (10 pages × 100)
 *   With a token the secondary rate-limit is 30 search-req/min.
 *
 * Events emitted via `emit(type, payload)`:
 *   phase        { phase: 'search'|'fetch'|'check'|'done'|'stopped' }
 *   page         { page, totalCount, itemsThisPage, filesQueued }
 *   file_start   { repo, path, rawUrl }
 *   file_done    { repo, path, rawUrl, channels, ok: bool, error? }
 *   hit          { repo, path, name, url, group }        ← working stream found
 *   check_prog   { checked, total, active, dead }
 *   done         { stats }
 *   error        { message }
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { URL } = require('url');
const { parseM3U } = require('./updater');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'search-results.m3u');
const DEAD_FILE   = path.join(DATA_DIR, 'search-dead.m3u');
const REPORT_FILE = path.join(DATA_DIR, 'search-report.json');

const GH_TOKEN     = process.env.GITHUB_TOKEN || '';
const USER_AGENT   = 'iptv-m3u-server/3.0';
const FETCH_TO     = 18000;   // ms to download one raw file
const CHECK_TO     = 5000;    // ms per stream HEAD check
const CHECK_PARA   = 25;      // concurrent stream checks
const SEARCH_DELAY = 2200;    // ms between search pages (rate-limit safety)
const FETCH_PARA   = 6;       // concurrent raw-file downloads

// ── Abort controller ─────────────────────────────────────────────────────────
let _abortFlag = false;
function abort()      { _abortFlag = true; }
function resetAbort() { _abortFlag = false; }
function isAborted()  { return _abortFlag; }

// ── Low-level HTTP ────────────────────────────────────────────────────────────
function httpGet(urlStr, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch { return resolve({ status: 0, body: null, headers: {} }); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'User-Agent': USER_AGENT, ...headers },
      timeout:  timeoutMs,
    };

    const req = lib.request(opts, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return resolve(httpGet(res.headers.location, headers, timeoutMs));
      }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { body += c; if (body.length > 8_000_000) req.destroy(); });
      res.on('end',  () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, headers: {} }); });
    req.on('error',   () =>                  resolve({ status: 0, body: null, headers: {} }));
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── GitHub API helpers ────────────────────────────────────────────────────────
function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (GH_TOKEN) h['Authorization'] = `Bearer ${GH_TOKEN}`;
  return h;
}

/**
 * Search one page. Returns { totalCount, items } or null on error.
 */
async function searchPage(query, page) {
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
  const res = await httpGet(url, ghHeaders(), 20000);
  if (!res.body || res.status !== 200) return null;
  try {
    const json = JSON.parse(res.body);
    return { totalCount: json.total_count || 0, items: json.items || [] };
  } catch { return null; }
}

/**
 * Build the raw.githubusercontent.com URL for a code-search item.
 */
function rawUrl(item) {
  // item.html_url: https://github.com/owner/repo/blob/ref/path/to/file.m3u
  // raw:           https://raw.githubusercontent.com/owner/repo/ref/path/to/file.m3u
  try {
    const m = item.html_url.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  } catch {}
  // fallback via git_url (slower but works)
  return null;
}

// ── Stream check ──────────────────────────────────────────────────────────────
function checkStream(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ ok: false, error: 'Invalid URL' }); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'HEAD',
      headers:  { 'User-Agent': USER_AGENT },
      timeout:  CHECK_TO,
    };
    const req = lib.request(opts, (res) => {
      if (res.statusCode < 400) return resolve({ ok: true, error: null });
      resolve({ ok: false, error: `HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    req.on('error',   (e) =>               resolve({ ok: false, error: e.message.slice(0,50) }));
    req.end();
  });
}

// ── M3U writer ────────────────────────────────────────────────────────────────
function writeM3U(filePath, entries) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const lines = ['#EXTM3U'];
  for (const e of entries) lines.push(e.extinf || `#EXTINF:-1,${e.name}`, e.url);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runSearch(emit) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  resetAbort();

  const startTime   = Date.now();
  const seenUrls    = new Set();   // dedup raw file URLs
  const seenStreams  = new Set();   // dedup stream URLs
  const allItems    = [];          // { repo, path, rawUrl }
  const active      = [];
  const dead        = [];

  const stats = {
    startedAt:    new Date().toISOString(),
    pagesSearched: 0,
    filesFound:   0,
    filesFetched: 0,
    filesFailed:  0,
    channelsTotal:0,
    channelsUnique:0,
    active:       0,
    dead:         0,
    stopped:      false,
  };

  // ── Phase 1: search pages ──────────────────────────────────────────────────
  emit('phase', { phase: 'search', message: 'Searching GitHub for .m3u files…' });

  const queries = ['extension:m3u', 'extension:m3u8', 'filename:.m3u EXTM3U', 'filename:.m3u8 EXTM3U'];

  for (const query of queries) {
    if (isAborted()) break;
    emit('phase', { phase: 'search', message: `Query: "${query}"` });

    for (let page = 1; page <= 10; page++) {
      if (isAborted()) break;

      const result = await searchPage(query, page);
      if (!result) {
        emit('error', { message: `Search page ${page} failed (rate limit or API error) — waiting 15s…` });
        await sleep(15000);
        // retry once
        const retry = await searchPage(query, page);
        if (!retry) break;
        Object.assign(result || {}, retry);
        if (!result) break;
      }

      stats.pagesSearched++;
      const items = result.items || [];

      for (const item of items) {
        const raw = rawUrl(item);
        if (!raw || seenUrls.has(raw)) continue;
        seenUrls.add(raw);
        const repo = item.repository?.full_name || 'unknown/unknown';
        const fpath = item.path || '';
        allItems.push({ repo, path: fpath, rawUrl: raw });
        stats.filesFound++;
      }

      emit('page', {
        query,
        page,
        totalCount:    result.totalCount,
        itemsThisPage: items.length,
        filesQueued:   stats.filesFound,
      });

      if (items.length < 100) break; // last page
      await sleep(SEARCH_DELAY);
    }

    await sleep(SEARCH_DELAY);
  }

  if (isAborted()) {
    emit('phase', { phase: 'stopped', message: 'Stopped during search phase.' });
    stats.stopped = true;
    stats.elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    fs.writeFileSync(REPORT_FILE, JSON.stringify({ ...stats, stoppedAt: new Date().toISOString() }, null, 2));
    emit('done', { stats });
    return;
  }

  // ── Phase 2: fetch raw files ───────────────────────────────────────────────
  emit('phase', { phase: 'fetch', message: `Fetching ${allItems.length} raw M3U files…` });

  const allEntries = []; // all parsed channel entries across all files

  for (let i = 0; i < allItems.length; i += FETCH_PARA) {
    if (isAborted()) break;
    const batch = allItems.slice(i, i + FETCH_PARA);

    await Promise.all(batch.map(async (item) => {
      if (isAborted()) return;
      emit('file_start', { repo: item.repo, path: item.path, rawUrl: item.rawUrl });

      const res = await httpGet(item.rawUrl, {}, FETCH_TO);
      stats.filesFetched++;

      if (!res.body || res.status !== 200 || res.body.trim().length < 10) {
        stats.filesFailed++;
        emit('file_done', { repo: item.repo, path: item.path, rawUrl: item.rawUrl, channels: 0, ok: false, error: `HTTP ${res.status}` });
        return;
      }

      // must look like an M3U
      if (!res.body.includes('#EXTM3U') && !res.body.includes('#EXTINF')) {
        stats.filesFailed++;
        emit('file_done', { repo: item.repo, path: item.path, rawUrl: item.rawUrl, channels: 0, ok: false, error: 'Not an M3U' });
        return;
      }

      const entries = parseM3U(res.body);
      stats.channelsTotal += entries.length;

      // deduplicate by stream URL
      const newEntries = [];
      for (const e of entries) {
        const key = e.url.trim().toLowerCase();
        if (!key || seenStreams.has(key)) continue;
        seenStreams.add(key);
        newEntries.push({ ...e, _repo: item.repo, _path: item.path });
      }
      stats.channelsUnique += newEntries.length;
      allEntries.push(...newEntries);

      emit('file_done', { repo: item.repo, path: item.path, rawUrl: item.rawUrl, channels: entries.length, unique: newEntries.length, ok: true });
    }));
  }

  if (isAborted()) {
    emit('phase', { phase: 'stopped', message: 'Stopped during fetch phase.' });
    stats.stopped = true;
    stats.elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    fs.writeFileSync(REPORT_FILE, JSON.stringify({ ...stats, stoppedAt: new Date().toISOString() }, null, 2));
    emit('done', { stats });
    return;
  }

  // ── Phase 3: check streams ─────────────────────────────────────────────────
  const total = allEntries.length;
  emit('phase', { phase: 'check', message: `Checking ${total} unique streams…` });

  for (let i = 0; i < total; i += CHECK_PARA) {
    if (isAborted()) break;
    const batch = allEntries.slice(i, i + CHECK_PARA);
    const results = await Promise.all(batch.map((e) => checkStream(e.url).then((r) => ({ e, r }))));

    for (const { e, r } of results) {
      if (r.ok) {
        active.push(e);
        stats.active++;
        emit('hit', { repo: e._repo, path: e._path, name: e.name, url: e.url, group: e.group });
      } else {
        dead.push({ ...e, _checkError: r.error });
        stats.dead++;
      }
    }

    const checked = Math.min(i + CHECK_PARA, total);
    emit('check_prog', { checked, total, active: stats.active, dead: stats.dead });
  }

  // ── Phase 4: write results ─────────────────────────────────────────────────
  writeM3U(OUTPUT_FILE, active);
  writeM3U(DEAD_FILE,   dead);

  stats.elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
  stats.stopped = isAborted();
  fs.writeFileSync(REPORT_FILE, JSON.stringify(stats, null, 2), 'utf-8');

  emit('phase', { phase: 'done', message: `Done! ${stats.active} working streams found.` });
  emit('done', { stats });
}

module.exports = { runSearch, abort, isAborted };
