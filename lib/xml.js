/**
 * lib/xml.js
 * Minimal RSS/Atom <item> parser — extracts title, enclosure URL, pubDate.
 * No external dependencies (uses regex on the raw XML string).
 */

/**
 * Parse a podcast RSS feed string into an array of episode objects.
 * @param {string} xml - Raw XML content
 * @returns {{ title: string, url: string, pubDate: Date|null }[]}
 */
function parseXML(xml) {
  const items = [];

  // Extract all <item>…</item> blocks
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let itemMatch;

  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];

    // Title
    const titleMatch = block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? (titleMatch[1] || titleMatch[2] || '').trim() : 'Unknown Episode';

    // Enclosure URL (audio/video file)
    const encMatch = block.match(/<enclosure[^>]+url="([^"]+)"/i);
    const url = encMatch ? encMatch[1].trim() : null;

    if (!url) continue; // Skip items without a media URL

    // Publication date
    const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    let pubDate = null;
    if (dateMatch) {
      const d = new Date(dateMatch[1].trim());
      if (!isNaN(d.getTime())) pubDate = d;
    }

    items.push({ title, url, pubDate });
  }

  return items;
}

module.exports = { parseXML };
