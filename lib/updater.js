/**
 * lib/updater.js
 * Fetches remote M3U, checks stream health concurrently,
 * then writes active/dead lists to disk.
 * Translated from scripts/update_iptv.py (Chinese → English, Python → Node.js)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_URL = 'https://live.zbds.top/tv/iptv4.m3u';  // Remote M3U source
const INDEX_FILE = path.join(DATA_DIR, 'index.m3u');
const DEAD_FILE  = path.join(DATA_DIR, 'index_dead.m3u');
const REPORT_FILE = path.join(DATA_DIR, 'report.json');
const EPG_URL    = 'https://zhr-0731.github.io/IPTV-m3u/epg/epg.xml';

// Only keep channels from these groups (Chinese national/satellite/local TV)
const TARGET_GROUPS = new Set(['央视频道', '卫视频道', '地方频道']);

const TIMEOUT_MS   = 5000;   // Stream check timeout
const MAX_PARALLEL = 20;     // Concurrent checks
const USER_AGENT   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch text content from a URL (follows redirects, returns string or null).
 */
function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      timeout: timeoutMs,
    };

    const req = lib.request(options, (res) => {
      // Follow redirects (up to 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(fetchText(res.headers.location, timeoutMs));
      }
      if (res.statusCode >= 400) return resolve(null);
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Check if a stream URL is alive (HEAD request, then GET fallback).
 * Returns { ok: boolean, error: string|null }
 */
function checkStream(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ ok: false, error: 'Invalid URL' }); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    };

    const req = lib.request(options, (res) => {
      if (res.statusCode < 400) return resolve({ ok: true, error: null });
      resolve({ ok: false, error: `HTTP ${res.statusCode}` });
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message.slice(0, 60) }));
    req.end();
  });
}

// ─── M3U Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse an M3U string into an array of channel objects.
 */
function parseM3U(content) {
  const entries = [];
  const lines = content.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXTINF:')) continue;
    const extinf = line;
    const groupMatch = extinf.match(/group-title="([^"]*)"/);
    const nameMatch  = extinf.match(/tvg-name="([^"]+)"/) || extinf.match(/,(.+)$/);
    const group = groupMatch ? groupMatch[1].trim() : '';
    const name  = nameMatch  ? nameMatch[1].trim()  : 'Unknown Channel';
    const urlLine = lines[i + 1] || '';
    if (urlLine && !urlLine.startsWith('#')) {
      entries.push({ extinf, name, url: urlLine, group });
    }
  }
  return entries;
}

/**
 * Natural sort helper (handles numbers in channel names).
 */
function naturalKey(text) {
  return text.split(/(\d+)/).map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p.toLowerCase()));
}

function naturalCompare(a, b) {
  const ka = naturalKey(a.name);
  const kb = naturalKey(b.name);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const va = ka[i] ?? '';
    const vb = kb[i] ?? '';
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Write sorted channels to an M3U file.
 */
function writeM3U(filePath, entries) {
  const sorted = [...entries].sort(naturalCompare);
  const lines  = [`#EXTM3U url-tvg="${EPG_URL}"`];
  for (const e of sorted) {
    lines.push(e.extinf, e.url);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  console.log(`[updater] Wrote ${sorted.length} channels → ${path.basename(filePath)}`);
}

/**
 * Load entries from a local M3U file (returns [] if missing).
 */
function loadLocalEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return parseM3U(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

// ─── Parallel Stream Check ────────────────────────────────────────────────────

/**
 * Run stream checks in batches of MAX_PARALLEL.
 */
async function checkStreamsParallel(entries) {
  const active = [];
  const dead   = [];
  const total  = entries.length;
  let   done   = 0;

  for (let i = 0; i < total; i += MAX_PARALLEL) {
    const batch   = entries.slice(i, i + MAX_PARALLEL);
    const results = await Promise.all(batch.map((e) => checkStream(e.url).then((r) => ({ e, r }))));
    for (const { e, r } of results) {
      if (r.ok) active.push(e);
      else       dead.push({ ...e, error: r.error });
    }
    done += batch.length;
    console.log(`[updater] Progress: ${done}/${total} (active: ${active.length}, dead: ${dead.length})`);
  }

  return { active, dead };
}

// ─── Main Update Function ─────────────────────────────────────────────────────

async function updateIPTV() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const startTime = Date.now();
  console.log('[updater] === IPTV Update Started ===');

  // Load existing local entries
  const localActive = loadLocalEntries(INDEX_FILE);
  const localDead   = loadLocalEntries(DEAD_FILE);
  const localNames  = new Set([...localActive, ...localDead].map((e) => e.name));
  console.log(`[updater] Local: ${localActive.length} active, ${localDead.length} dead`);

  // Fetch remote M3U
  console.log(`[updater] Fetching remote M3U: ${SOURCE_URL}`);
  const remoteContent = await fetchText(SOURCE_URL);
  let remoteNew = [];
  let remoteTotal = 0;
  let remoteTargetCount = 0;

  if (remoteContent) {
    const allRemote = parseM3U(remoteContent);
    remoteTotal = allRemote.length;
    const targetRemote = allRemote.filter((e) => TARGET_GROUPS.has(e.group));
    remoteTargetCount = targetRemote.length;
    remoteNew = targetRemote.filter((e) => !localNames.has(e.name));
    console.log(`[updater] Remote: ${remoteTotal} total, ${remoteTargetCount} in target groups, ${remoteNew.length} new`);
  } else {
    console.warn('[updater] Could not fetch remote M3U. Checking local only.');
  }

  // Check all channels
  const toCheck = [...localActive, ...localDead, ...remoteNew];
  console.log(`[updater] Checking ${toCheck.length} streams…`);
  const { active, dead } = await checkStreamsParallel(toCheck);

  // Write results
  writeM3U(INDEX_FILE, active);
  writeM3U(DEAD_FILE,  dead);

  // Error summary
  const errorCounts = {};
  for (const d of dead) {
    const key = d.error || 'Unknown';
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  }

  // Write report
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const report = {
    updatedAt: new Date().toISOString(),
    elapsedSeconds: parseFloat(elapsedSec),
    source: { url: SOURCE_URL, total: remoteTotal, inTargetGroups: remoteTargetCount },
    before: { active: localActive.length, dead: localDead.length },
    after:  { active: active.length, dead: dead.length },
    netChange: active.length - localActive.length,
    errorBreakdown: errorCounts,
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[updater] === Update done in ${elapsedSec}s | Active: ${active.length} | Dead: ${dead.length} ===`);

  return report;
}

module.exports = { updateIPTV, parseM3U, fetchText };
