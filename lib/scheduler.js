/**
 * lib/scheduler.js
 * Schedules automatic daily IPTV updates (original + GitHub fetch).
 */

const { updateIPTV } = require('./updater');
const { generatePlaylist } = require('./playlist');
const { fetchAndCheckGitHub } = require('./github-fetcher');

const UPDATE_INTERVAL_MS   = parseInt(process.env.UPDATE_INTERVAL_HOURS   || '24', 10) * 3600000;
const GITHUB_INTERVAL_MS   = parseInt(process.env.GITHUB_INTERVAL_HOURS   || '12', 10) * 3600000;

let updateTimer = null;
let githubTimer = null;

async function runUpdate() {
  console.log('[scheduler] Running scheduled IPTV update…');
  try {
    await updateIPTV();
    await generatePlaylist();
    console.log('[scheduler] Scheduled update complete.');
  } catch (err) {
    console.error('[scheduler] Scheduled update failed:', err.message);
  }
}

async function runGitHubFetch() {
  console.log('[scheduler] Running scheduled GitHub M3U fetch…');
  try {
    await fetchAndCheckGitHub();
    console.log('[scheduler] GitHub fetch complete.');
  } catch (err) {
    console.error('[scheduler] GitHub fetch failed:', err.message);
  }
}

function scheduleUpdates() {
  if (process.env.UPDATE_ON_START === 'true') {
    console.log('[scheduler] Running initial update on startup…');
    runUpdate();
  }
  if (process.env.GITHUB_FETCH_ON_START === 'true') {
    console.log('[scheduler] Running initial GitHub fetch on startup…');
    runGitHubFetch();
  }

  updateTimer = setInterval(runUpdate,       UPDATE_INTERVAL_MS);
  githubTimer = setInterval(runGitHubFetch,  GITHUB_INTERVAL_MS);
  console.log(`[scheduler] Auto-update every ${UPDATE_INTERVAL_MS/3600000}h | GitHub fetch every ${GITHUB_INTERVAL_MS/3600000}h`);
}

function stopSchedule() {
  if (updateTimer) clearInterval(updateTimer);
  if (githubTimer) clearInterval(githubTimer);
}

module.exports = { scheduleUpdates, stopSchedule, runUpdate, runGitHubFetch };
