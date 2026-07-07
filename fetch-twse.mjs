// Runs server-side (Node 18+, e.g. inside GitHub Actions) — no browser, no CORS.
// Fetches TWSE institutional flow (T86) and daily trading (MI_INDEX) data,
// parses it down to a compact shape, and writes it into ./data/.

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

function parseNum(s) {
  if (s === undefined || s === null) return 0;
  const n = parseFloat(String(s).replace(/,/g, '').replace(/X|--/g, '').trim());
  return isNaN(n) ? 0 : n;
}

function parseT86(t86) {
  return (t86.data || []).map(row => {
    const code = String(row[0]).trim();
    const name = String(row[1]).trim();
    const foreign = parseNum(row[4]) + parseNum(row[7]);
    const trust = parseNum(row[10]);
    const dealer = parseNum(row[11]);
    const total = parseNum(row[row.length - 1]);
    return { code, name, foreign, trust, dealer, total };
  }).filter(r => r.code);
}

function parseMI(mi) {
  return (mi.data || []).map(row => {
    const code = String(row[0]).trim();
    const name = String(row[1]).trim();
    const volume = parseNum(row[2]);
    const turnover = parseNum(row[4]);
    const close = parseNum(row[8]);
    const dirSymbol = String(row[9] || '').includes('-') ? -1 : (String(row[9] || '').includes('+') ? 1 : 0);
    const diff = parseNum(row[10]) * (dirSymbol < 0 ? -1 : 1);
    const pct = close && diff ? (diff / (close - diff)) * 100 : 0;
    return { code, name, volume, turnover, close, diff, pct };
  }).filter(r => r.code && r.turnover > 0);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const dateArg = process.argv[2];
  const dstr = dateArg || taipeiDateStr();

  fs.mkdirSync('data', { recursive: true });
  const gitkeepPath = path.join('data', '.gitkeep');
  if (!fs.existsSync(gitkeepPath)) fs.writeFileSync(gitkeepPath, '');

  const t86Url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${dstr}&selectType=ALL&response=json`;
  const miUrl = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${dstr}&type=ALLBUT0999&response=json`;

  console.log(`Fetching TWSE data for ${dstr}...`);
  const [t86, mi] = await Promise.all([fetchJson(t86Url), fetchJson(miUrl)]);

  if (!t86.data || t86.data.length === 0 || !mi.data || mi.data.length === 0) {
    console.log(`No data for ${dstr} (holiday, weekend, or not yet published). Skipping.`);
    return;
  }

  const inst = parseT86(t86);
  const vol = parseMI(mi);
  const data = { date: dstr, inst, vol, fetchedAt: new Date().toISOString() };

  fs.writeFileSync(path.join('data', `${dstr}.json`), JSON.stringify(data));

  const indexPath = path.join('data', 'index.json');
  let dates = [];
  if (fs.existsSync(indexPath)) {
    try { dates = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch { dates = []; }
  }
  if (!dates.includes(dstr)) {
    dates.push(dstr);
    dates.sort();
  }
  fs.writeFileSync(indexPath, JSON.stringify(dates));
  fs.writeFileSync(path.join('data', 'latest.json'), JSON.stringify({ latest: dstr }));

  console.log(`Saved ${dstr}: ${inst.length} institutional rows, ${vol.length} trading rows.`);
}

main().catch(e => {
  console.error('Fetch failed:', e.message || e);
  process.exit(1);
});
