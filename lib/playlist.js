/**
 * lib/playlist.js
 * Fetches music M3U + podcast RSS feeds and merges them into playlist.m3u.
 * Translated from generate_playlist.py (Chinese → English, Python → Node.js)
 */

const fs   = require('fs');
const path = require('path');
const { parseXML } = require('./xml');
const { fetchText } = require('./updater');

const DATA_DIR     = path.join(__dirname, '..', 'data');
const OUTPUT_FILE  = path.join(DATA_DIR, 'playlist.m3u');

// Source URLs (original project's feeds)
const MUSIC_M3U_URL  = 'http://zhr-0731.github.io/IPTV-m3u/music.m3u';
const PODCAST_URLS   = [
  'https://zhr-0731.github.io/IPTV-m3u/podcast/89148451.xml',
  'https://zhr-0731.github.io/IPTV-m3u/podcast/101474678.xml',
  'https://zhr-0731.github.io/IPTV-m3u/podcast/31903470.xml',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseM3ULines(content) {
  return content.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Pick `count` random items from an array (no repeats).
 */
function sampleRandom(arr, count) {
  const copy = [...arr];
  const result = [];
  for (let i = 0; i < Math.min(count, copy.length); i++) {
    const idx = Math.floor(Math.random() * (copy.length - i));
    result.push(copy[idx]);
    copy[idx] = copy[copy.length - 1 - i];
  }
  return result;
}

/**
 * Pick the most recently published item, or random if no dates available.
 */
function selectLatest(items) {
  if (!items.length) return null;
  const dated = items.filter((it) => it.pubDate);
  if (dated.length) {
    return dated.reduce((a, b) => (a.pubDate > b.pubDate ? a : b));
  }
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Build the merged M3U string.
 */
function buildM3U(origLines, prependItem, randomItems, appendItem) {
  const lines = ['#EXTM3U'];

  if (prependItem) {
    lines.push(`#EXTINF:-1,${prependItem.title}`, prependItem.url);
  }

  // Add original music lines (skip the first #EXTM3U header if present)
  const start = origLines.length && origLines[0].startsWith('#EXTM3U') ? 1 : 0;
  lines.push(...origLines.slice(start).filter((l) => l));

  for (const item of randomItems) {
    lines.push(`#EXTINF:-1,${item.title}`, item.url);
  }

  if (appendItem) {
    lines.push(`#EXTINF:-1,${appendItem.title}`, appendItem.url);
  }

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function generatePlaylist() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('[playlist] Fetching sources…');

  // 1. Music M3U
  const musicContent = await fetchText(MUSIC_M3U_URL);
  const origLines = musicContent ? parseM3ULines(musicContent) : [];
  console.log(`[playlist] Music M3U: ${origLines.length} lines`);

  // 2. Podcast feeds
  const [xml1, xml2, xml3] = await Promise.all(PODCAST_URLS.map(fetchText));

  const items1 = xml1 ? parseXML(xml1) : [];
  const items2 = xml2 ? parseXML(xml2) : [];
  const items3 = xml3 ? parseXML(xml3) : [];

  console.log(`[playlist] Feed 1: ${items1.length} episodes | Feed 2: ${items2.length} | Feed 3: ${items3.length}`);

  // Build:
  // - prependItem: random pick from feed 1
  // - randomItems: 4 random picks from feed 2
  // - appendItem:  latest from feed 3
  const prependItem = items1.length ? items1[Math.floor(Math.random() * items1.length)] : null;
  const randomItems = sampleRandom(items2, 4);
  const appendItem  = selectLatest(items3);

  const m3u = buildM3U(origLines, prependItem, randomItems, appendItem);
  fs.writeFileSync(OUTPUT_FILE, m3u, 'utf-8');
  console.log(`[playlist] Written → ${OUTPUT_FILE}`);
}

module.exports = { generatePlaylist };
