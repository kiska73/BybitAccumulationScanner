const axios = require('axios');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID = '820279313';

const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 ore
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

const CONFIG = {
  PRICE_MAX_PCT_SPOT: 1.5,          // prezzo non deve già essere esploso
  TURNOVER_MIN: 250000,
  CVD_MIN_SPOT: 0.105,              // più selettivo
  BOOK_MIN_IMB: 0.04,               // book davvero carico
  CONSOLIDATION_MAX_RANGE_PCT: 3.8, // range massimo nelle ultime ~7 ore
  CONSOLIDATION_CANDLES: 28,        // 28 candele 15m = ~7 ore
  MAX_SIGNALS_PER_TYPE: 3,
  SCAN_INTERVAL_MIN: 30,
  MIN_SCORE: 80,                    // qualità alta
  BOOK_DEPTH_LIMIT: 100,
  CVD_LIMIT_BYBIT: 2000,
  CVD_LIMIT_BINANCE: 1000,
};

const STABLE_BASES = [
  'USDC', 'TUSD', 'FDUSD', 'BUSD', 'DAI', 'PYUSD', 'USDP', 'GUSD',
  'FRAX', 'USDD', 'USDB', 'USDS', 'USDE', 'RLUSD', 'USDG', 'YUSD', 'USD1'
];

// ────────────────────────────────────────────────
//  TELEGRAM
// ────────────────────────────────────────────────
async function sendTelegram(content, title) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.includes('INSERISCI')) {
    console.warn('⚠️ Token Telegram non configurato');
    return;
  }
  const header = `<b>${title}</b>\n\n`;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: header + content,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });
    console.log(`✅ Telegram inviato: ${title}`);
  } catch (err) {
    console.error('Errore invio Telegram:', err.message);
  }
}

// ────────────────────────────────────────────────
//  COOLDOWN
// ────────────────────────────────────────────────
function checkCooldown(symbol) {
  return Date.now() - (lastSignals[symbol]?.timestamp || 0) > COOLDOWN_MS;
}

function updateCooldown(symbol, type, score) {
  lastSignals[symbol] = { timestamp: Date.now(), type, lastScore: score };
  saveLastSignals();
}

// ────────────────────────────────────────────────
//  LEVEL + POTENZIALITÀ
// ────────────────────────────────────────────────
function getLevel(score, isLong) {
  if (score >= 92) return { emoji: '🚀🚀🚀', text: isLong ? 'ULTRA LONG EXPLOSION' : 'ULTRA SHORT EXPLOSION' };
  if (score >= 86) return { emoji: '🚀🚀', text: isLong ? 'SUPER LONG EXPLOSION' : 'SUPER SHORT EXPLOSION' };
  if (score >= 80) return { emoji: '🚀', text: isLong ? 'BIG LONG EXPLOSION' : 'BIG SHORT EXPLOSION' };
  return null;
}

function getPotential(score) {
  if (score >= 92) return '🔥🔥🔥 NUCLEARE (22%+ in poche ore)';
  if (score >= 86) return '🔥🔥 ESTREMA (14-22%)';
  return '🔥 BUONA (8-14%)';
}

function calculateScore(cvdAbs, bookAbs, pricePct) {
  const base = cvdAbs * 2.45;
  const pricePenalty = Math.abs(pricePct) * 100;
  return Math.min(100, Math.max(0, base + bookAbs * 98 + CONFIG.PRICE_MAX_PCT_SPOT - pricePenalty));
}

// ────────────────────────────────────────────────
//  CHECK CONSOLIDATION (ACCUMULO REALE)
// ────────────────────────────────────────────────
async function isInConsolidation(symbol, isBybit) {
  try {
    const interval = '15';
    const limit = CONFIG.CONSOLIDATION_CANDLES;
    let url;
    if (isBybit) {
      url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    } else {
      url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}m&limit=${limit}`;
    }
    const res = await axios.get(url, { timeout: 8000 });
    const klines = isBybit ? res.data.result : res.data;
    if (klines.length < 12) return false;

    let high = -Infinity, low = Infinity;
    for (const k of klines) {
      const h = parseFloat(isBybit ? k[2] : k[2]);
      const l = parseFloat(isBybit ? k[3] : k[3]);
      if (h > high) high = h;
      if (l < low) low = l;
    }
    const rangePct = (high - low) / low * 100;
    return rangePct <= CONFIG.CONSOLIDATION_MAX_RANGE_PCT;
  } catch {
    return false; // se errore API, saltiamo il segnale (sicurezza)
  }
}

// ────────────────────────────────────────────────
//  BUILD DETAILS
// ────────────────────────────────────────────────
function buildDetails(symbol, level, score, extraLines) {
  return (
    `${level.emoji} <b>${symbol}</b> — ${level.text}\n` +
    `   Score: <b>${score.toFixed(0)}/100</b>\n` +
    extraLines
  );
}

// ────────────────────────────────────────────────
//  CONTROLLI COPPIE ATTIVE (invariato)
// ────────────────────────────────────────────────
async function getActiveControls() {
  const controls = [];
  const now = Date.now();

  for (const [symbol, data] of Object.entries(lastSignals)) {
    if (now - data.timestamp > COOLDOWN_MS) continue;

    let status = 'In monitoraggio';
    let currentScore = data.lastScore || 0;

    try {
      const isBybit = data.type.includes('Bybit');
      const cvd = isBybit ? await getCvdBybit(symbol) : await getCvdBinance(symbol);
      const bookImb = isBybit ? await getBookImbBybit(symbol) : await getBookImbBinance(symbol);
      const pricePct = await getCurrentPriceChange(symbol, isBybit);

      currentScore = calculateScore(Math.abs(cvd), Math.abs(bookImb), pricePct);

      if (currentScore >= 88) status = 'Ancora Molto Forte 🔥🔥🔥';
      else if (currentScore >= 80) status = 'Ancora Forte 🔥';
      else status = 'Indebolito ⚠️';
    } catch {}

    controls.push(`• <b>${symbol}</b> (${data.type}) → <b>${status}</b> (Score ${currentScore.toFixed(0)})`);
  }

  return controls.length ? `<b>🔄 Controllo Coppie Attive</b>\n\n${controls.join('\n')}\n\n==============================\n\n` : '';
}

async function getCurrentPriceChange(symbol, isBybit) {
  try {
    if (isBybit) {
      const res = await axios.get(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`, { timeout: 5000 });
      return parseFloat(res.data.result.list?.[0]?.price24hPcnt || 0);
    } else {
      const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
      return parseFloat(res.data.priceChangePercent) / 100;
    }
  } catch { return 0; }
}

// ────────────────────────────────────────────────
//  HELPER CVD & BOOK
// ────────────────────────────────────────────────
async function getCvdBybit(symbol) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/recent-trade?category=spot&symbol=${symbol}&limit=${CONFIG.CVD_LIMIT_BYBIT}`, { timeout: 9000 });
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

async function getBookImbBybit(symbol) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${symbol}&limit=${CONFIG.BOOK_DEPTH_LIMIT}`, { timeout: 8000 });
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
//  ANALISI SEGNALE (con accumulo + inversione)
// ────────────────────────────────────────────────
async function analyzeSpotSignal(symbol, cvd, bookImb, pricePct, turnover, isBybit) {
  const base = symbol.replace('USDT', '');
  if (STABLE_BASES.includes(base)) return null;

  // 1. Controllo accumulo (range stretto)
  const inConsolidation = await isInConsolidation(symbol, isBybit);
  if (!inConsolidation) return null;

  const cvdAbs = Math.abs(cvd);
  const bookAbs = Math.abs(bookImb);

  if (cvdAbs < CONFIG.CVD_MIN_SPOT || bookAbs < CONFIG.BOOK_MIN_IMB) return null;

  const isLong = cvd > 0 && bookImb > 0;

  const score = calculateScore(cvdAbs, bookAbs, pricePct);
  if (score < CONFIG.MIN_SCORE) return null;

  const level = getLevel(score, isLong);
  if (!level) return null;

  const potential = getPotential(score);
  const directionText = isLong ? 'LONG EXPLOSION (Rialzo → Vai LONG)' : 'SHORT EXPLOSION (Ribasso → Vai SHORT)';

  const extra = (
    `   Potenzialità: <b>${potential}</b>\n` +
    `   CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
    `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: $${(turnover / 1e6).toFixed(1)}M\n` +
    `   Accumulo: <b>Range stretto ${CONFIG.CONSOLIDATION_MAX_RANGE_PCT}%</b>`
  );

  const details = buildDetails(symbol, level, score, extra);

  return {
    score,
    details,
    isLong,
    type: `${isBybit ? 'Bybit' : 'Binance'} Spot (${directionText})`
  };
}

// ────────────────────────────────────────────────
//  SCAN SPOT (invariato)
// ────────────────────────────────────────────────
async function scanSpot() {
  const longCandidates = [];
  const shortCandidates = [];

  // Bybit Spot
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', { timeout: 10000 });
    for (const t of res.data.result.list || []) {
      const symbol = t.symbol;
      if (!symbol.endsWith('USDT') || !checkCooldown(symbol)) continue;

      const pricePct = parseFloat(t.price24hPcnt || 0);
      const turnover = parseFloat(t.turnover24h || 0);
      if (Math.abs(pricePct) * 100 > CONFIG.PRICE_MAX_PCT_SPOT || turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = await getCvdBybit(symbol);
      const bookImb = await getBookImbBybit(symbol);

      const signal = await analyzeSpotSignal(symbol, cvd, bookImb, pricePct, turnover, true);
      if (signal) {
        (signal.isLong ? longCandidates : shortCandidates).push(signal);
        updateCooldown(symbol, signal.type, signal.score);
      }
    }
  } catch (err) { console.error('Errore Bybit Spot:', err.message); }

  // Binance Spot
  try {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 10000 });
    for (const t of res.data.filter(t => t.symbol.endsWith('USDT'))) {
      const symbol = t.symbol;
      if (!checkCooldown(symbol)) continue;

      const pricePct = parseFloat(t.priceChangePercent) / 100;
      const turnover = parseFloat(t.quoteVolume);
      if (Math.abs(pricePct) * 100 > CONFIG.PRICE_MAX_PCT_SPOT || turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = await getCvdBinance(symbol);
      const bookImb = await getBookImbBinance(symbol);

      const signal = await analyzeSpotSignal(symbol, cvd, bookImb, pricePct, turnover, false);
      if (signal) {
        (signal.isLong ? longCandidates : shortCandidates).push(signal);
        updateCooldown(symbol, signal.type, signal.score);
      }
    }
  } catch (err) { console.error('Errore Binance Spot:', err.message); }

  longCandidates.sort((a, b) => b.score - a.score);
  shortCandidates.sort((a, b) => b.score - a.score);

  return {
    long: longCandidates.slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details),
    short: shortCandidates.slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details)
  };
}

// ────────────────────────────────────────────────
//  MAIN
// ────────────────────────────────────────────────
async function mainScan() {
  console.log(`[${new Date().toLocaleTimeString('it-IT')}] REVERSAL ACCUMULATION SCAN avviato...`);
  cleanupOldSignals();

  const controls = await getActiveControls();
  const spot = await scanSpot();

  const sections = [];
  if (spot.long.length > 0) {
    sections.push(`🔥 LONG EXPLOSION (Rialzo — Vai LONG)\n\n${spot.long.join('\n\n')}`);
  }
  if (spot.short.length > 0) {
    sections.push(`🔥 SHORT EXPLOSION (Ribasso — Vai SHORT)\n\n${spot.short.join('\n\n')}`);
  }

  const fullContent = controls + (sections.length > 0 ? sections.join('\n\n=====================\n\n') : '');

  if (fullContent.trim()) {
    await sendTelegram(fullContent, '📈 REVERSAL ACCUMULATION EXPLOSION SCAN 📉');
  } else {
    console.log('Nessun segnale valido in questo scan');
  }
}

// ────────────────────────────────────────────────
//  AVVIO
// ────────────────────────────────────────────────
console.log(`🚀 REVERSAL ACCUMULATION EXPLOSION SCANNER v5.0 avviato - ogni ${CONFIG.SCAN_INTERVAL_MIN} min`);

mainScan().catch(err => console.error('Errore avvio:', err.message));

setInterval(() => {
  mainScan().catch(err => console.error('Errore scan:', err.message));
}, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
