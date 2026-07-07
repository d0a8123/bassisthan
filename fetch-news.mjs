// Runs server-side (Node 18+, e.g. inside GitHub Actions) — fetches market-relevant
// headlines via Google News RSS (no API key required) and stores them alongside
// the stock data. Only titles/links/timestamps are kept — no article text is
// reproduced, just references out to the original source.

import fs from 'fs';
import path from 'path';

function taipeiDateStr(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = fmt.formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${y}${m}${day}`;
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .trim();
}

function parseRssItems(xml, tag) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml))) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [, ''])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [, ''])[1];
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    if (!title || !link) continue;
    items.push({
      title: decodeEntities(title),
      link: decodeEntities(link),
      pubDate: pubDate.trim(),
      source: sourceMatch ? decodeEntities(sourceMatch[1]) : '',
      tag
    });
  }
  return items;
}

async function fetchFeed(query, tag) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for news query "${query}"`);
  const xml = await res.text();
  return parseRssItems(xml, tag);
}

async function main() {
  fs.mkdirSync(path.join('data', 'news'), { recursive: true });

  const dstr = taipeiDateStr();

  // Two feeds: Taiwan-market-specific, and global macro/geopolitics that tends to move markets.
  const [twNews, globalNews] = await Promise.all([
    fetchFeed('台股 OR 台灣加權指數 OR 台積電 OR 外資 買賣超', 'tw'),
    fetchFeed('聯準會 OR Fed 利率 OR 美股 OR 地緣政治 OR 油價 OR 半導體 關稅', 'global')
  ]);

  // Dedupe by link, keep newest 40 total, sorted by pubDate desc.
  const all = [...twNews, ...globalNews];
  const seen = new Set();
  const deduped = all.filter(item => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });
  deduped.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const trimmed = deduped.slice(0, 40);

  const payload = { date: dstr, fetchedAt: new Date().toISOString(), items: trimmed };

  fs.writeFileSync(path.join('data', 'news', `${dstr}.json`), JSON.stringify(payload));
  fs.writeFileSync(path.join('data', 'news-latest.json'), JSON.stringify(payload));

  console.log(`Saved ${trimmed.length} news items for ${dstr} (${twNews.length} tw, ${globalNews.length} global before dedupe).`);
}

main().catch(e => {
  console.error('News fetch failed:', e.message || e);
  process.exit(1);
});
