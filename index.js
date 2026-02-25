const axios = require('axios');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID = '820279313';

const LAST_FILE = './last_signals.json';

let lastSignals = {};

if (fs.existsSync(LAST_FILE)) {
  try {
    lastSignals = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8'));
  } catch (err) {
    console.error('Errore nella lettura di last_signals.json:', err.message);
  }
}

function saveLastSignals() {
  fs.writeFileSync(LAST_FILE, JSON.stringify(lastSignals, null, 2));
}

function cleanupOldSignals() {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const key of Object.keys(lastSignals)) {
    if (lastSignals[key].timestamp < cutoff) {
      delete lastSignals[key];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    saveLastSignals();
    console.log(`🧹 Puliti ${cleaned} segnali vecchi`);
  }
}

// ====================== CONFIGURAZIONE ======================
const CONFIG = {
  TURNOVER_MIN: 1800000,           // leggermente abbassato
  BOOK_DEPTH_LIMIT: 150,
  CVD_LIMIT_BYBIT: 3000,
  CVD_LIMIT_BINANCE: 1500,
  SCAN_INTERVAL_MIN: 20,
  MAX_SIGNALS_PER_LEVEL: 5,        // un po' più segnali
};

const LEVELS = {
  ULTRA: { name: '🚀🚀🚀 ULTRA EXPLOSION', minScore: 90, minCvd: 0.125, minBook: 0.052, maxConsRange: 3.4, maxPricePct: 1.4, emoji: '🚀🚀🚀' },
  SUPER: { name: '🚀🚀 SUPER EXPLOSION',   minScore: 83, minCvd: 0.098, minBook: 0.037, maxConsRange: 4.6, maxPricePct: 2.0, emoji: '🚀🚀' },
  BIG:   { name: '🚀 BIG EXPLOSION',       minScore: 76, minCvd: 0.078, minBook: 0.027, maxConsRange: 5.8, maxPricePct: 2.7, emoji: '🚀' }
};

const COOLDOWN_PER_LEVEL = {
  ULTRA: 7 * 60 * 60 * 1000,
  SUPER: 5 * 60 * 60 * 1000,
  BIG:   3 * 60 * 60 * 1000
};

const STABLE_BASES = ['USDC','TUSD','FDUSD','BUSD','DAI','PYUSD','USDP','GUSD','FRAX','USDD','USDB','USDS','USDE','RLUSD','USDG','YUSD','USD1'];

// ────────────────────────────────────────────────
//  TELEGRAM + COOLDOWN
// ────────────────────────────────────────────────
async function sendTelegram(content, title) {
  const header = `<b>${title}</b>\n\n`;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: header + content,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });
  } catch (err) {
    console.error('Errore Telegram:', err.message);
  }
}

function checkCooldown(key, level) {
  const last = lastSignals[key];
  if (!last) return true;
  return Date.now() - last.timestamp > COOLDOWN_PER_LEVEL[level];
}

function updateCooldown(key, level, score, isBybit, isPerps = false) {
  lastSignals[key] = {
    timestamp: Date.now(),
    level,
    lastScore: score,
    isBybit,
    isPerps,
    baseSymbol: isPerps ? key.replace('-perps', '') : key
  };
  saveLastSignals();
}

// ────────────────────────────────────────────────
//  SCORE + POTENZIALITÀ
// ────────────────────────────────────────────────
function getPotential(score) {
  if (score >= 94) return '🔥🔥🔥 NUCLEARE (25%+)';
  if (score >= 87) return '🔥🔥 ESTREMA (16-25%)';
  if (score >= 82) return '🔥 FORTE (11-16%)';
  return '🔥 SOLIDA (8-12%)';
}

function calculateScore(cvdAbs, bookAbs, pricePct) {
  const base = cvdAbs * 2.85;
  const pricePenalty = Math.abs(pricePct) * 100 * 0.45;
  return Math.min(100, Math.max(0, base + bookAbs * 120 - pricePenalty));
}

// ────────────────────────────────────────────────
//  CONSOLIDATION + HELPERS (corretti)
// ────────────────────────────────────────────────
async function isInConsolidation(symbol, isBybit, maxRangePct, category = 'spot') {
  try {
    const interval = '15';
    const limit = 32;
    let url = isBybit 
      ? `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`
      : `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}m&limit=${limit}`;

    const res = await axios.get(url, { timeout: 8000 });
    const klines = isBybit ? res.data.result : res.data;   // Bybit usa .result (array diretto)
    if (klines.length < 16) return false;

    let high = -Infinity, low = Infinity;
    for (const k of klines) {
      const h = parseFloat(isBybit ? k[2] : k[2]);
      const l = parseFloat(isBybit ? k[3] : k[3]);
      if (h > high) high = h;
      if (l < low) low = l;
    }
    const rangePct = ((high - low) / low) * 100;
    return rangePct <= maxRangePct;
  } catch (e) {
    return false;
  }
}

// ────────────────────────────────────────────────
//  BUILD DETAILS + MONITOR
// ────────────────────────────────────────────────
function buildDetails(symbol, level, score, extraLines, type) {
  return `${level.emoji} <b>${symbol}</b> — ${level.text} (${type})\n` +
         `   Score: <b>${score.toFixed(0)}</b>\n` +
         extraLines;
}

async function getActiveControls() {
  const controls = [];
  const now = Date.now();

  for (const [key, data] of Object.entries(lastSignals)) {
    if (now - data.timestamp > 10 * 60 * 60 * 1000) continue;

    const symbolToUse = data.isPerps ? data.baseSymbol : key;
    const category = data.isPerps ? 'linear' : 'spot';

    let status = 'Monitor';
    let currentScore = data.lastScore || 0;

    try {
      const cvd = data.isBybit 
        ? await getCvdBybit(symbolToUse, category) 
        : await getCvdBinance(symbolToUse);
      const bookImb = data.isBybit 
        ? await getBookImbBybit(symbolToUse, category) 
        : await getBookImbBinance(symbolToUse);
      const pricePct = await getCurrentPriceChange(symbolToUse, data.isBybit, category);

      currentScore = calculateScore(Math.abs(cvd), Math.abs(bookImb), pricePct);

      if (currentScore >= 90) status = '🔥🔥🔥 Ultra';
      else if (currentScore >= 83) status = '🚀 Super';
      else if (currentScore >= 76) status = '📈 Big';
      else status = '⚠️ Debole';
    } catch {}

    const levelName = data.level ? LEVELS[data.level]?.name.split(' ')[1] || '??' : '??';
    controls.push(`• <b>${key}</b> (${levelName}) → ${status} (${currentScore.toFixed(0)})`);
  }

  return controls.length ? `<b>🔄 Monitor Attivi</b>\n${controls.join('\n')}\n\n===\n\n` : '';
}

async function getCurrentPriceChange(symbol, isBybit, category = 'spot') {
  try {
    if (isBybit) {
      const res = await axios.get(`https://api.bybit.com/v5/market/tickers?category=${category}&symbol=${symbol}`, { timeout: 5000 });
      return parseFloat(res.data.result.list?.[0]?.price24hPcnt || 0) / 100;
    } else {
      const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
      return parseFloat(res.data.priceChangePercent) / 100;
    }
  } catch { return 0; }
}

// CVD & BOOK (corretti)
async function getCvdBybit(symbol, category = 'spot') {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/recent-trade?category=${category}&symbol=${symbol}&limit=${CONFIG.CVD_LIMIT_BYBIT}`, { timeout: 9000 });
    const trades = res.data.result.list || [];
    let delta = 0, total = 0;
    for (const t of trades) {
      const size = parseFloat(t.size);
      total += size;
      delta += t.side === 'Buy' ? size : -size;
    }
    return total > 0 ? delta / total : 0;
  } catch { return 0; }
}

async function getCvdBinance(symbol) {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=${CONFIG.CVD_LIMIT_BINANCE}`, { timeout: 9000 });
    const trades = res.data;
    let delta = 0, total = 0;
    for (const t of trades) {
      const q = parseFloat(t.qty);
      total += q;
      delta += t.isBuyerMaker ? -q : q;
    }
    return total > 0 ? delta / total : 0;
  } catch { return 0; }
}

async function getBookImbBybit(symbol, category = 'spot') {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/orderbook?category=${category}&symbol=${symbol}&limit=${CONFIG.BOOK_DEPTH_LIMIT}`, { timeout: 8000 });
    const d = res.data.result;
    let bids = 0, asks = 0;
    const len = Math.min(CONFIG.BOOK_DEPTH_LIMIT, d.b?.length || 0, d.a?.length || 0);
    for (let i = 0; i < len; i++) {
      bids += parseFloat(d.b[i][1]);
      asks += parseFloat(d.a[i][1]);
    }
    const total = bids + asks;
    return total > 0 ? (bids - asks) / total : 0;
  } catch { return 0; }
}

async function getBookImbBinance(symbol) {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${CONFIG.BOOK_DEPTH_LIMIT}`, { timeout: 8000 });
    const d = res.data;
    let bids = 0, asks = 0;
    const len = Math.min(CONFIG.BOOK_DEPTH_LIMIT, d.bids.length, d.asks.length);
    for (let i = 0; i < len; i++) {
      bids += parseFloat(d.bids[i][1]);
      asks += parseFloat(d.asks[i][1]);
    }
    const total = bids + asks;
    return total > 0 ? (bids - asks) / total : 0;
  } catch { return 0; }
}

// ────────────────────────────────────────────────
//  ANALISI SEGNALE (con accumulo ottimizzato)
// ────────────────────────────────────────────────
async function analyzeSignal(symbol, cvd, bookImb, pricePct, turnover, isBybit, levelKey, category = 'spot') {
  const level = LEVELS[levelKey];
  const base = symbol.replace(/USDT|USDC/, '');
  if (STABLE_BASES.includes(base)) return null;

  const inConsolidation = await isInConsolidation(symbol, isBybit, level.maxConsRange, category);
  if (!inConsolidation) return null;

  const cvdAbs = Math.abs(cvd);
  const bookAbs = Math.abs(bookImb);

  if (cvdAbs < level.minCvd || bookAbs < level.minBook) return null;
  if (Math.abs(pricePct) * 100 > level.maxPricePct) return null;

  const score = calculateScore(cvdAbs, bookAbs, pricePct);
  if (score < level.minScore) return null;

  const isLong = bookImb > 0;   // ← accumulo reale (book carico sui bid)

  const levelObj = { 
    emoji: level.emoji, 
    text: isLong ? `${level.name.split(' ')[1]} LONG` : `${level.name.split(' ')[1]} SHORT` 
  };

  const potential = getPotential(score);
  const extra = `   Pot: <b>${potential}</b>\n   CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n   Vol: $${(turnover / 1e6).toFixed(1)}M`;

  const type = category === 'linear' ? 'Perps Bybit' : (isBybit ? 'Spot Bybit' : 'Spot Binance');
  const details = buildDetails(symbol, levelObj, score, extra, type);

  return { score, details, isLong, level: levelKey };
}

// ────────────────────────────────────────────────
//  SCAN SPOT + PERPS
// ────────────────────────────────────────────────
async function scanSpotExchange(isBybit) {
  const signals = { ULTRA: [], SUPER: [], BIG: [] };
  try {
    let tickers = [];
    if (isBybit) {
      const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', { timeout: 10000 });
      tickers = res.data.result.list || [];
    } else {
      const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 10000 });
      tickers = res.data;
    }

    for (const t of tickers) {
      const symbol = isBybit ? t.symbol : t.symbol;
      if (!symbol.endsWith('USDT')) continue;

      const pricePct = isBybit ? parseFloat(t.price24hPcnt || 0) / 100 : parseFloat(t.priceChangePercent) / 100;
      const turnover = isBybit ? parseFloat(t.turnover24h || 0) : parseFloat(t.quoteVolume);
      if (turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = isBybit ? await getCvdBybit(symbol) : await getCvdBinance(symbol);
      const bookImb = isBybit ? await getBookImbBybit(symbol) : await getBookImbBinance(symbol);

      for (const levelKey of ['ULTRA', 'SUPER', 'BIG']) {
        if (!checkCooldown(symbol, levelKey)) continue;
        const signal = await analyzeSignal(symbol, cvd, bookImb, pricePct, turnover, isBybit, levelKey);
        if (signal) {
          signals[levelKey].push(signal);
          updateCooldown(symbol, levelKey, signal.score, isBybit, false);
          break;
        }
      }
    }
  } catch (err) {
    console.error(`Errore Spot ${isBybit ? 'Bybit' : 'Binance'}:`, err.message);
  }
  return signals;
}

async function scanPerpsBybit() {
  const signals = { ULTRA: [], SUPER: [], BIG: [] };
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', { timeout: 10000 });
    const tickers = res.data.result.list || [];

    for (const t of tickers) {
      const symbol = t.symbol;
      if (!symbol.endsWith('USDT')) continue;

      const pricePct = parseFloat(t.price24hPcnt || 0) / 100;
      const turnover = parseFloat(t.turnover24h || 0);
      if (turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = await getCvdBybit(symbol, 'linear');
      const bookImb = await getBookImbBybit(symbol, 'linear');

      for (const levelKey of ['ULTRA', 'SUPER', 'BIG']) {
        const perpsKey = `${symbol}-perps`;
        if (!checkCooldown(perpsKey, levelKey)) continue;

        const signal = await analyzeSignal(symbol, cvd, bookImb, pricePct, turnover, true, levelKey, 'linear');
        if (signal) {
          signals[levelKey].push(signal);
          updateCooldown(perpsKey, levelKey, signal.score, true, true);
          break;
        }
      }
    }
  } catch (err) {
    console.error('Errore Bybit Perps:', err.message);
  }
  return signals;
}

// ────────────────────────────────────────────────
//  MAIN
// ────────────────────────────────────────────────
async function mainScan() {
  console.log(`[${new Date().toLocaleTimeString('it-IT')}] REVERSAL SCAN v10.3 avviato...`);
  cleanupOldSignals();

  const controls = await getActiveControls();
  const bybitSpot = await scanSpotExchange(true);
  const binanceSpot = await scanSpotExchange(false);
  const bybitPerps = await scanPerpsBybit();

  const finalSpot = { ULTRA: [], SUPER: [], BIG: [] };
  const finalPerps = { ULTRA: [], SUPER: [], BIG: [] };

  for (const level of Object.keys(LEVELS)) {
    const allSpot = [...(bybitSpot[level] || []), ...(binanceSpot[level] || [])];
    allSpot.sort((a, b) => b.score - a.score);
    finalSpot[level] = allSpot.slice(0, CONFIG.MAX_SIGNALS_PER_LEVEL);

    const allPerps = bybitPerps[level] || [];
    allPerps.sort((a, b) => b.score - a.score);
    finalPerps[level] = allPerps.slice(0, CONFIG.MAX_SIGNALS_PER_LEVEL);
  }

  let fullContent = controls;

  if (finalSpot.ULTRA.length > 0) fullContent += `🚀🚀🚀 <b>ULTRA SPOT</b>\n\n${finalSpot.ULTRA.map(s => s.details).join('\n\n')}\n\n`;
  if (finalSpot.SUPER.length > 0) fullContent += `🚀🚀 <b>SUPER SPOT</b>\n\n${finalSpot.SUPER.map(s => s.details).join('\n\n')}\n\n`;
  if (finalSpot.BIG.length > 0)   fullContent += `🚀 <b>BIG SPOT</b>\n\n${finalSpot.BIG.map(s => s.details).join('\n\n')}\n\n`;

  if (finalPerps.ULTRA.length + finalPerps.SUPER.length + finalPerps.BIG.length > 0) {
    fullContent += `=== PERPS BYBIT ===\n\n`;
    if (finalPerps.ULTRA.length > 0) fullContent += `🚀🚀🚀 <b>ULTRA PERPS</b>\n\n${finalPerps.ULTRA.map(s => s.details).join('\n\n')}\n\n`;
    if (finalPerps.SUPER.length > 0) fullContent += `🚀🚀 <b>SUPER PERPS</b>\n\n${finalPerps.SUPER.map(s => s.details).join('\n\n')}\n\n`;
    if (finalPerps.BIG.length > 0)   fullContent += `🚀 <b>BIG PERPS</b>\n\n${finalPerps.BIG.map(s => s.details).join('\n\n')}\n\n`;
  }

  if (fullContent.trim().length > 50) {
    await sendTelegram(fullContent, '📊 REVERSAL EXPLOSION SCAN + PERPS');
  } else {
    console.log('❌ Nessun segnale buono in questo scan');
  }
}

// ────────────────────────────────────────────────
//  AVVIO
// ────────────────────────────────────────────────
console.log(`🚀 REVERSAL EXPLOSION SCANNER v10.3 (FIX + PERPS) avviato - ogni ${CONFIG.SCAN_INTERVAL_MIN} min`);

mainScan().catch(err => console.error('Errore avvio:', err.message));

setInterval(() => {
  mainScan().catch(err => console.error('Errore scan:', err.message));
}, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
