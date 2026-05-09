/**
 * lib/github-sources.js
 * Registry of known public GitHub repos that publish M3U/M3U8 playlists.
 * Each entry has a `raw` URL pointing directly to the file content.
 */

const GITHUB_M3U_SOURCES = [
  // ── iptv-org (the canonical open IPTV project) ────────────────────────────
  { repo: 'iptv-org/iptv',          label: 'iptv-org/index',       raw: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/index.m3u' },
  { repo: 'iptv-org/iptv',          label: 'iptv-org/unsorted',    raw: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/unsorted.m3u' },

  // ── Free-TV ───────────────────────────────────────────────────────────────
  { repo: 'Free-TV/IPTV',           label: 'Free-TV/index',        raw: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8' },

  // ── Garage72 ─────────────────────────────────────────────────────────────
  { repo: 'Garage72/m3u-lists',     label: 'Garage72/ru',          raw: 'https://raw.githubusercontent.com/Garage72/m3u-lists/master/ru-tv-all.m3u8' },

  // ── benmoose ─────────────────────────────────────────────────────────────
  { repo: 'benmoose/traveltv',      label: 'benmoose/traveltv',    raw: 'https://raw.githubusercontent.com/benmoose/traveltv/master/travel.m3u' },

  // ── Commonshq ────────────────────────────────────────────────────────────
  { repo: 'Commonshq/m3u-playlists', label: 'Commonshq/tv',       raw: 'https://raw.githubusercontent.com/Commonshq/m3u-playlists/master/tv.m3u' },

  // ── iptv-hunt ────────────────────────────────────────────────────────────
  { repo: 'ipstreet312/iptv-hunt',  label: 'iptv-hunt/all',        raw: 'https://raw.githubusercontent.com/ipstreet312/iptv-hunt/master/totall.py.m3u' },

  // ── xiaodaizong ──────────────────────────────────────────────────────────
  { repo: 'xiaodaizong/m3u',        label: 'xiaodaizong/cn',       raw: 'https://raw.githubusercontent.com/xiaodaizong/m3u/master/iptv.m3u' },

  // ── fanmingming ──────────────────────────────────────────────────────────
  { repo: 'fanmingming/live',       label: 'fanmingming/cn',       raw: 'https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/ipv6.m3u' },

  // ── YueChan ──────────────────────────────────────────────────────────────
  { repo: 'YueChan/Live',           label: 'YueChan/live',         raw: 'https://raw.githubusercontent.com/YueChan/Live/main/IPTV.m3u' },

  // ── vbskycn ──────────────────────────────────────────────────────────────
  { repo: 'vbskycn/iptv',          label: 'vbskycn/iptv4',        raw: 'https://raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv4.m3u' },
  { repo: 'vbskycn/iptv',          label: 'vbskycn/iptv6',        raw: 'https://raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv6.m3u' },

  // ── joevess ──────────────────────────────────────────────────────────────
  { repo: 'joevess/IPTV',          label: 'joevess/iptv',         raw: 'https://raw.githubusercontent.com/joevess/IPTV/main/home.m3u8' },

  // ── zhr-0731 (original project basis) ────────────────────────────────────
  { repo: 'zhr-0731/IPTV-m3u',     label: 'zhr-0731/tv',          raw: 'https://raw.githubusercontent.com/zhr-0731/IPTV-m3u/main/live.m3u' },
  { repo: 'zhr-0731/IPTV-m3u',     label: 'zhr-0731/music',       raw: 'http://zhr-0731.github.io/IPTV-m3u/music.m3u' },

  // ── zbds ─────────────────────────────────────────────────────────────────
  { repo: 'zbds-top/iptv',         label: 'zbds/iptv4',           raw: 'https://live.zbds.top/tv/iptv4.m3u' },
  { repo: 'zbds-top/iptv',         label: 'zbds/iptv6',           raw: 'https://live.zbds.top/tv/iptv6.m3u' },

  // ── iptv-streams ────────────────────────────────────────────────────────
  { repo: 'gilbN/theme.park',      label: 'siptv/sports',         raw: 'https://raw.githubusercontent.com/iptv-streams/iptv-streams/main/sports.m3u' },

  // ── tv.m3u.mobi mirrors ──────────────────────────────────────────────────
  { repo: 'dp247/FreeviewEdge',    label: 'dp247/freeview-uk',    raw: 'https://raw.githubusercontent.com/dp247/FreeviewEdge/master/playlist.m3u' },

  // ── RijadBurak──────────────────────────────────────────────────────────
  { repo: 'RijadBurak/iptv',       label: 'RijadBurak/all',       raw: 'https://raw.githubusercontent.com/RijadBurak/iptv/main/iptv.m3u' },
];

module.exports = { GITHUB_M3U_SOURCES };
