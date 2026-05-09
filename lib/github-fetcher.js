/**
 * lib/github-fetcher.js
 * Fetches M3U playlists from all registered GitHub repos,
 * deduplicates channels, checks which streams are alive,
 * then writes a merged working playlist to disk.
 */

const fs   = require('fs');
const path = require('path');
const { fetchText, parseM3U, checkStream } = require('./updater');
const { GITHUB_M3U_SOURCES } = require('./github-sources');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const MERGED_FILE = path.join(DATA_DIR, 'github-merged.m3u');
const DEAD_FILE   = path.join(DATA_DIR, 'github-dead.m3u');
const REPORT_FILE = path.join(DATA_DIR, 'github-report.json');

const MAX_PARALLEL    = 30;   // concurrent stream checks
const FETCH_TIMEOUT   = 20000; // ms per M3U download
const EPG_URL         = 'https://www.epgdata.com/epg.php?type=m3u';

// ─── Fetch all sources ────────────────────────────────────────────────────────

/**
 * Fetch one source, returning { source, entries, error }.
 */
async function fetchSource(source) {
  try {
    const content = await fetchText(source.raw, FETCH_TIMEOUT);
    if (!content || content.trim().length < 20) {
      return { source, entries: [], error: 'Empty or no response' };
    }
    const entries = parseM3U(content);
    return { source, entries, error: null };
  } catch (err) {
    return { source, entries: [], error: err.message };
  }
}

/**
 * Fetch all GitHub sources in parallel (IO-bound, so full parallel is fine).
 */
async function fetchAllSources() {
  console.log(`[github-fetcher] Fetching ${GITHUB_M3U_SOURCES.length} GitHub M3U sources…`);
  const results = await Promise.all(GITHUB_M3U_SOURCES.map(fetchSource));

  const summary = [];
  for (const r of results) {
    const status = r.error ? `❌ ${r.error}` : `✅ ${r.entries.length} channels`;
    console.log(`  [${r.source.label}] ${status}`);
    summary.push({ label: r.source.label, repo: r.source.repo, count: r.entries.length, error: r.error });
  }
  return { results, summary };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Merge all entries, deduplicating by stream URL.
 * When the same URL appears in multiple repos we keep the entry with the
 * richest metadata (longest extinf line) and record which repos carry it.
 */
function mergeAndDeduplicate(results) {
  const byUrl = new Map(); // url → { entry, repos[] }

  for (const { source, entries } of results) {
    for (const entry of entries) {
      const key = entry.url.trim().toLowerCase();
      if (!key || key.startsWith('#')) continue;
      if (byUrl.has(key)) {
        byUrl.get(key).repos.push(source.label);
        // prefer the longer (richer) extinf
        if (entry.extinf.length > byUrl.get(key).entry.extinf.length) {
          byUrl.get(key).entry = entry;
        }
      } else {
        byUrl.set(key, { entry, repos: [source.label] });
      }
    }
  }

  const merged = [...byUrl.values()].map(({ entry, repos }) => ({
    ...entry,
    sources: repos,
  }));

  console.log(`[github-fetcher] Deduplicated: ${merged.length} unique URLs from all sources`);
  return merged;
}

// ─── Parallel stream checking ─────────────────────────────────────────────────

async function checkStreamsParallel(entries) {
  const active = [];
  const dead   = [];
  const total  = entries.length;
  let   done   = 0;

  for (let i = 0; i < total; i += MAX_PARALLEL) {
    const batch   = entries.slice(i, i + MAX_PARALLEL);
    const results = await Promise.all(
      batch.map((e) => checkStream(e.url).then((r) => ({ e, r })))
    );
    for (const { e, r } of results) {
      if (r.ok) active.push(e);
      else       dead.push({ ...e, _checkError: r.error });
    }
    done += batch.length;
    const pct = ((done / total) * 100).toFixed(0);
    process.stdout.write(
      `\r[github-fetcher] Checking streams… ${done}/${total} (${pct}%) | ✅ ${active.length}  ❌ ${dead.length}   `
    );
  }
  process.stdout.write('\n');
  return { active, dead };
}

// ─── M3U writer ───────────────────────────────────────────────────────────────

function writeM3U(filePath, entries, header = '') {
  const lines = [`#EXTM3U url-tvg="${EPG_URL}"${header ? ' ' + header : ''}`];
  for (const e of entries) {
    // Append source repos as a comment so users know provenance
    const repoComment = e.sources ? ` <!-- sources: ${e.sources.join(', ')} -->` : '';
    lines.push(e.extinf + repoComment, e.url);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  console.log(`[github-fetcher] Wrote ${entries.length} entries → ${path.basename(filePath)}`);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Full pipeline:
 *   1. Fetch all GitHub M3U sources
 *   2. Deduplicate by URL
 *   3. Check each stream
 *   4. Write github-merged.m3u (working) + github-dead.m3u
 *   5. Write github-report.json
 *
 * Returns the report object.
 */
async function fetchAndCheckGitHub() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const startTime = Date.now();
  console.log('\n[github-fetcher] ═══ GitHub M3U Fetch & Check Started ═══');

  // Step 1 – fetch
  const { results, summary } = await fetchAllSources();

  const fetchedCount  = results.reduce((n, r) => n + r.entries.length, 0);
  const sourcesOk     = summary.filter((s) => !s.error).length;
  const sourcesFailed = summary.filter((s) =>  s.error).length;
  console.log(`[github-fetcher] Fetched ${fetchedCount} total entries from ${sourcesOk}/${GITHUB_M3U_SOURCES.length} sources`);

  // Step 2 – deduplicate
  const merged = mergeAndDeduplicate(results);

  // Step 3 – check streams
  console.log(`[github-fetcher] Checking ${merged.length} unique streams…`);
  const { active, dead } = await checkStreamsParallel(merged);

  // Step 4 – write playlists
  writeM3U(MERGED_FILE, active);
  writeM3U(DEAD_FILE,   dead);

  // Step 5 – report
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const errorBreakdown = {};
  for (const d of dead) {
    const k = d._checkError || 'Unknown';
    errorBreakdown[k] = (errorBreakdown[k] || 0) + 1;
  }

  const report = {
    updatedAt:      new Date().toISOString(),
    elapsedSeconds: parseFloat(elapsedSec),
    sources: {
      total:   GITHUB_M3U_SOURCES.length,
      ok:      sourcesOk,
      failed:  sourcesFailed,
      detail:  summary,
    },
    channels: {
      fetched:     fetchedCount,
      unique:      merged.length,
      active:      active.length,
      dead:        dead.length,
      activeRatio: merged.length ? ((active.length / merged.length) * 100).toFixed(1) + '%' : '0%',
    },
    errorBreakdown,
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[github-fetcher] ═══ Done in ${elapsedSec}s | Active: ${active.length} | Dead: ${dead.length} ═══\n`);
  return report;
}

module.exports = { fetchAndCheckGitHub };
