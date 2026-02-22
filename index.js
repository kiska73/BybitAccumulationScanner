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
  PRICE_MAX_PCT_PERP: 5.0,
  PRICE_MAX_PCT_SPOT: 2.0,
  TURNOVER_MIN: 250000,
  OI_MIN: 0.8,               // ← abbassato
  CVD_MIN_PERP: 0.025,       // ← abbassato
  CVD_MIN_SPOT: 0.08,
  BOOK_MIN_IMB: 0.025,       // ← abbassato
  MAX_SIGNALS_PER_TYPE: 8,
  SCAN_INTERVAL_MIN: 30,
  MIN_SCORE: 70,
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
//  LEVEL & SCORE
// ────────────────────────────────────────────────
function getLevel(score, isLong) {
  if (score >= 90) {
    return {
      emoji: '🚀🚀🚀',
      text: isLong ? 'ULTRA SQUEEZE' : 'ULTRA LONG SQUEEZE',
    };
  }
  if (score >= 80) {
    return {
      emoji: '🚀🚀',
      text: isLong ? 'SUPER SQUEEZE' : 'SUPER LONG SQUEEZE',
    };
  }
  if (score >= 70) {
    return {
      emoji: '🚀',
      text: isLong ? 'BIG SQUEEZE' : 'BIG LONG SQUEEZE',
    };
  }
  return null;
}

function calculateScore(oiOrCvd, bookImb, pricePct, isPerp) {
  const base = isPerp ? oiOrCvd * 2.8 : oiOrCvd * 2.2;
  const pricePenalty = Math.abs(pricePct) * 100;
  const priceBonus = isPerp ? CONFIG.PRICE_MAX_PCT_PERP : CONFIG.PRICE_MAX_PCT_SPOT;

  return Math.min(100, Math.max(0, base + bookImb * 95 + priceBonus - pricePenalty));
}

// ────────────────────────────────────────────────
//  BUILD MESSAGE - SENZA LINK
// ────────────────────────────────────────────────
function buildDetails(symbol, level, score, extraLines) {
  return (
    `${level.emoji} <b>${symbol}</b> — ${level.text}\n` +
    `   Score: <b>${score.toFixed(0)}/100</b>\n` +
    extraLines
  );
}

// ────────────────────────────────────────────────
//  CONTROLLI COPPIE ATTIVE
// ────────────────────────────────────────────────
async function getActiveControls() {
  const controls = [];
  const now = Date.now();

  for (const [symbol, data] of Object.entries(lastSignals)) {
    if (now - data.timestamp > COOLDOWN_MS) continue;

    let status = 'In monitoraggio';
    let currentScore = data.lastScore || 0;
    let typeLabel = data.type || '???';

    try {
      const isPerp = data.type.includes('Perp');
      const cat = isPerp ? 'linear' : 'spot';

      const tickerRes = await axios.get(
        `https://api.bybit.com/v5/market/tickers?category=${cat}&symbol=${symbol}`,
        { timeout: 5000 }
      );

      const t = tickerRes.data.result.list?.[0];
      if (!t) continue;

      const pricePct = parseFloat(t.price24hPcnt || 0);

      let cvd = 0;
      let bookImb = 0;
      let oiPct = 0;

      if (isPerp) {
        oiPct = await getOiChange(symbol);
        cvd = await getCvdBybit(symbol, true);
        bookImb = await getBookImbBybit(symbol, true);
        currentScore = calculateScore(oiPct, bookImb, pricePct, true);
      } else {
        const isBybit = data.type.includes('Bybit');
        cvd = isBybit ? await getCvdBybit(symbol, false) : await getCvdBinance(symbol);
        bookImb = isBybit ? await getBookImbBybit(symbol, false) : await getBookImbBinance(symbol);
        currentScore = calculateScore(cvd, bookImb, pricePct, false);
      }

      if (currentScore >= 85) status = 'Ancora Molto Forte 🔥🔥🔥';
      else if (currentScore >= 70) status = 'Ancora Forte 🔥';
      else status = 'Indebolito ⚠️';
    } catch {}

    controls.push(`• <b>${symbol}</b> (${typeLabel}) → <b>${status}</b> (Score ${currentScore.toFixed(0)})`);
  }

  return controls.length
    ? `<b>🔄 Controllo Coppie Attive</b>\n\n${controls.join('\n')}\n\n==============================\n\n`
    : '';
}

// ────────────────────────────────────────────────
//  SCAN BYBIT PERPETUAL
// ────────────────────────────────────────────────
async function scanBybitPerp() {
  const candidates = [];

  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', { timeout: 10000 });
    const tickers = res.data.result.list || [];

    for (const t of tickers) {
      const symbol = t.symbol;
      if (!symbol.endsWith('USDT') || !checkCooldown(symbol)) continue;

      const base = symbol.slice(0, -4);
      if (STABLE_BASES.includes(base)) continue;

      const pricePct = parseFloat(t.price24hPcnt || 0);
      const turnover = parseFloat(t.turnover24h || 0);

      if (Math.abs(pricePct) * 100 >= CONFIG.PRICE_MAX_PCT_PERP || turnover < CONFIG.TURNOVER_MIN) continue;

      const oiPct = await getOiChange(symbol);
      if (oiPct < CONFIG.OI_MIN) continue;

      const cvd = await getCvdBybit(symbol, true);
      const bookImb = await getBookImbBybit(symbol, true);

      let isLong = false;
      let effectiveBook = bookImb;

      if (cvd >= CONFIG.CVD_MIN_PERP && bookImb >= CONFIG.BOOK_MIN_IMB) {
        isLong = true;
      } else if (cvd <= -CONFIG.CVD_MIN_PERP && bookImb <= -CONFIG.BOOK_MIN_IMB) {
        isLong = false;
        effectiveBook = -bookImb;
      } else {
        continue;
      }

      const score = calculateScore(oiPct, effectiveBook, pricePct, true);
      if (score < CONFIG.MIN_SCORE) continue;

      const level = getLevel(score, isLong);
      if (!level) continue;

      const extra = (
        `   OI 1h: +${oiPct.toFixed(2)}% | CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
        `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: ${(turnover / 1e6).toFixed(1)}M`
      );

      const details = buildDetails(symbol, level, score, extra);

      candidates.push({ score, details, isLong });
      updateCooldown(symbol, isLong ? 'Bybit Perp (Rialzo - Short Squeeze)' : 'Bybit Perp (Ribasso - Long Squeeze)', score);
    }
  } catch (err) {
    console.error('Errore scan Bybit Perp:', err.message);
  }

  candidates.sort((a, b) => b.score - a.score);

  const longCandidates = candidates.filter(c => c.isLong).slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);
  const shortCandidates = candidates.filter(c => !c.isLong).slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);

  return { long: longCandidates, short: shortCandidates };
}

// ────────────────────────────────────────────────
//  SCAN BYBIT SPOT
// ────────────────────────────────────────────────
async function scanBybitSpot() {
  const candidates = [];

  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', { timeout: 10000 });
    const tickers = res.data.result.list || [];

    for (const t of tickers) {
      const symbol = t.symbol;
      if (!symbol.endsWith('USDT') || !checkCooldown(symbol)) continue;

      const base = symbol.slice(0, -4);
      if (STABLE_BASES.includes(base)) continue;

      const pricePct = parseFloat(t.price24hPcnt || 0);
      const turnover = parseFloat(t.turnover24h || 0);

      if (Math.abs(pricePct) * 100 > CONFIG.PRICE_MAX_PCT_SPOT || turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = await getCvdBybit(symbol, false);
      if (cvd < CONFIG.CVD_MIN_SPOT) continue;

      const bookImb = await getBookImbBybit(symbol, false);
      if (bookImb < CONFIG.BOOK_MIN_IMB) continue;

      const score = calculateScore(cvd, bookImb, pricePct, false);
      if (score < CONFIG.MIN_SCORE) continue;

      const level = getLevel(score, true);
      if (!level) continue;

      const extra = (
        `   CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
        `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: ${(turnover / 1e6).toFixed(1)}M`
      );

      const details = buildDetails(symbol, level, score, extra);

      candidates.push({ score, details });
      updateCooldown(symbol, 'Bybit Spot (Rialzo)', score);
    }
  } catch (err) {
    console.error('Errore scan Bybit Spot:', err.message);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);
}

// ────────────────────────────────────────────────
//  SCAN BINANCE SPOT
// ────────────────────────────────────────────────
async function scanBinanceSpot() {
  const candidates = [];

  try {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 10000 });
    const tickers = res.data.filter(t => t.symbol.endsWith('USDT'));

    for (const t of tickers) {
      const symbol = t.symbol;
      if (!checkCooldown(symbol)) continue;

      const base = symbol.slice(0, -4);
      if (STABLE_BASES.includes(base)) continue;

      const pricePct = parseFloat(t.priceChangePercent) / 100;
      const turnover = parseFloat(t.quoteVolume);

      if (Math.abs(pricePct) * 100 > CONFIG.PRICE_MAX_PCT_SPOT || turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = await getCvdBinance(symbol);
      if (cvd < CONFIG.CVD_MIN_SPOT) continue;

      const bookImb = await getBookImbBinance(symbol);
      if (bookImb < CONFIG.BOOK_MIN_IMB) continue;

      const score = calculateScore(cvd, bookImb, pricePct, false);
      if (score < CONFIG.MIN_SCORE) continue;

      const level = getLevel(score, true);
      if (!level) continue;

      const extra = (
        `   CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
        `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: $${(turnover / 1e6).toFixed(1)}M`
      );

      const details = buildDetails(symbol, level, score, extra);

      candidates.push({ score, details });
      updateCooldown(symbol, 'Binance Spot (Rialzo)', score);
    }
  } catch (err) {
    console.error('Errore scan Binance Spot:', err.message);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);
}

// ────────────────────────────────────────────────
//  HELPER API CALLS
// ────────────────────────────────────────────────
async function getOiChange(symbol) {
  try {
    const res = await axios.get(
      `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&interval=1h&limit=3`,
      { timeout: 8000 }
    );
    const lst = res.data.result.list || [];
    if (lst.length < 2) return 0;

    const now = parseFloat(lst[0].openInterest);
    const prev = parseFloat(lst[1].openInterest);
    return prev > 0 ? ((now - prev) / prev) * 100 : 0;
  } catch {
    return 0;
  }
}

async function getCvdBybit(symbol, isPerp) {
  const cat = isPerp ? 'linear' : 'spot';
  try {
    const res = await axios.get(
      `https://api.bybit.com/v5/market/recent-trade?category=${cat}&symbol=${symbol}&limit=1000`,
      { timeout: 8000 }
    );
    const trades = res.data.result.list || [];
    let delta = 0;
    let total = 0;

    for (const t of trades) {
      const size = parseFloat(t.size);
      total += size;
      delta += t.side === 'Buy' ? size : -size;
    }
    return total > 0 ? delta / total : 0;
  } catch {
    return 0;
  }
}

async function getBookImbBybit(symbol, isPerp) {
  const cat = isPerp ? 'linear' : 'spot';
  try {
    const res = await axios.get(
      `https://api.bybit.com/v5/market/orderbook?category=${cat}&symbol=${symbol}&limit=20`,
      { timeout: 8000 }
    );
    const d = res.data.result;
    let bids = 0;
    let asks = 0;
    const len = Math.min(20, d.b?.length || 0, d.a?.length || 0);

    for (let i = 0; i < len; i++) {
      bids += parseFloat(d.b[i][1]);
      asks += parseFloat(d.a[i][1]);
    }

    const total = bids + asks;
    return total > 0 ? (bids - asks) / total : 0;
  } catch {
    return 0;
  }
}

async function getCvdBinance(symbol) {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=500`, {
      timeout: 8000,
    });
    const trades = res.data;
    let delta = 0;
    let total = 0;

    for (const t of trades) {
      const q = parseFloat(t.qty);
      total += q;
      delta += t.isBuyerMaker ? -q : q;
    }
    return total > 0 ? delta / total : 0;
  } catch {
    return 0;
  }
}

async function getBookImbBinance(symbol) {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`, {
      timeout: 8000,
    });
    const d = res.data;
    let bids = 0;
    let asks = 0;
    const len = Math.min(20, d.bids.length, d.asks.length);

    for (let i = 0; i < len; i++) {
      bids += parseFloat(d.bids[i][1]);
      asks += parseFloat(d.asks[i][1]);
    }

    const total = bids + asks;
    return total > 0 ? (bids - asks) / total : 0;
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────
//  MAIN SCAN
// ────────────────────────────────────────────────
async function mainScan() {
  console.log(`[${new Date().toLocaleTimeString('it-IT')}] Full scan avviato...`);
  cleanupOldSignals();

  const controls = await getActiveControls();

  const perp = await scanBybitPerp();
  const bybitSpot = await scanBybitSpot();
  const binanceSpot = await scanBinanceSpot();

  const sections = [];

  if (perp.long.length > 0) {
    sections.push(`🔥 BYBIT PERP — SHORT SQUEEZE (Bullish)\n\n${perp.long.join('\n\n')}`);
  }
  if (perp.short.length > 0) {
    sections.push(`🔥 BYBIT PERP — LONG SQUEEZE (Bearish)\n\n${perp.short.join('\n\n')}`);
  }
  if (bybitSpot.length > 0) {
    sections.push(`🔥 BYBIT SPOT — LONG SQUEEZE\n\n${bybitSpot.join('\n\n')}`);
  }
  if (binanceSpot.length > 0) {
    sections.push(`🔥 BINANCE SPOT — LONG SQUEEZE\n\n${binanceSpot.join('\n\n')}`);
  }

  const fullContent = controls + (sections.length > 0 ? sections.join('\n\n=====================\n\n') : '');

  if (fullContent.trim()) {
    await sendTelegram(fullContent, '📈-SQUEEZE SCAN- 📉');
  } else {
    console.log('Nessun segnale valido in questo scan');
  }
}

// ────────────────────────────────────────────────
//  AVVIO
// ────────────────────────────────────────────────
console.log(`🚀 FULL SCANNER v3.6 (cooldown 4 ore) avviato - ogni ${CONFIG.SCAN_INTERVAL_MIN} minuti`);

mainScan().catch(err => console.error('Errore avvio scan iniziale:', err.message));

setInterval(() => {
  mainScan().catch(err => console.error('Errore durante scan periodico:', err.message));
}, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
