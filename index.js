const axios = require('axios');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID = '820279313';

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 ore
const LAST_FILE = './last_signals.json';

let lastSignals = {};
if (fs.existsSync(LAST_FILE)) {
  try {
    lastSignals = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8'));
  } catch (e) {
    console.log('Errore lettura last_signals.json');
  }
}

function saveLastSignals() {
  fs.writeFileSync(LAST_FILE, JSON.stringify(lastSignals, null, 2));
}

function cleanupOldSignals() {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000; // 24 ore
  let cleaned = 0;
  Object.keys(lastSignals).forEach(key => {
    if (lastSignals[key] < cutoff) {
      delete lastSignals[key];
      cleaned++;
    }
  });
  if (cleaned > 0) {
    saveLastSignals();
    console.log(`🧹 Puliti ${cleaned} segnali vecchi dal JSON`);
  }
}

const CONFIG = {
  PRICE_MAX_PCT_PERP: 5.0,
  PRICE_MAX_PCT_SPOT: 2.0,
  TURNOVER_MIN: 250000,
  OI_MIN: 1.0,
  CVD_MIN_PERP: 0.03,
  CVD_MIN_SPOT: 0.08,
  BOOK_MIN_IMB: 0.03,
  MAX_SIGNALS_PER_TYPE: 8,
  SCAN_INTERVAL_MIN: 30,
  MIN_SCORE: 70
};

const STABLE_BASES = [
  'USDC', 'TUSD', 'FDUSD', 'BUSD', 'DAI', 'PYUSD', 'USDP', 'GUSD',
  'FRAX', 'USDD', 'USDB', 'USDS', 'USDE', 'RLUSD', 'USDG', 'YUSD', 'USD1'
]; // Esclude pair stable-USDT

// ====================== TELEGRAM ======================
async function sendTelegram(content, title) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.includes('INSERISCI')) {
    console.log('⚠️ Token Telegram non configurato');
    return;
  }
  const header = `<b>🚀 ${title}</b>\n\n`;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: header + content,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    console.log(`✅ Inviato messaggio unico Telegram: ${title}`);
  } catch (e) {
    console.log('Errore Telegram:', e.message);
  }
}

// ====================== COOLDOWN ======================
function checkCooldown(symbol) {
  return Date.now() - (lastSignals[symbol] || 0) > COOLDOWN_MS;
}
function updateCooldown(symbol) {
  lastSignals[symbol] = Date.now();
  saveLastSignals();
}

// ====================== LEVEL & SCORE ======================
function getLevel(score) {
  if (score >= 85) return { emoji: '🔥🔥🔥', text: 'SUPER SQUEEZE' };
  if (score >= 70) return { emoji: '📈📈', text: 'FORTE' };
  return null; // sotto 70 → scartato
}

function calculateScore(oiOrCvd, bookImb, pricePct, isPerp) {
  const base = isPerp ? oiOrCvd * 1.45 : oiOrCvd * 2.2;
  const pricePenalty = Math.abs(pricePct) * 100;
  const priceBonus = isPerp ? CONFIG.PRICE_MAX_PCT_PERP : CONFIG.PRICE_MAX_PCT_SPOT;
  return Math.min(100, Math.max(0, base + bookImb * 95 + priceBonus - pricePenalty));
}

// ====================== SCAN COMMON ======================
function buildDetails(symbol, level, score, extraLines, linkBase, linkSuffix = '') {
  return `${level.emoji} <b><a href="${linkBase}${symbol}${linkSuffix}">${symbol}</a></b> — ${level.text}\n` +
         `   Score: <b>${score.toFixed(0)}/100</b>\n` +
         extraLines;
}

// ====================== BYBIT PERPETUAL ======================
async function scanBybitPerp() {
  const candidates = [];
  try {
    const tickers = (await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', { timeout: 10000 })).data.result.list || [];
    for (const t of tickers) {
      const symbol = t.symbol;
      if (!symbol.endsWith('USDT') || !checkCooldown(symbol)) continue;

      const base = symbol.slice(0, -4);
      if (STABLE_BASES.includes(base)) continue; // nuovo: escludi stable-USDT

      const pricePct = parseFloat(t.price24hPcnt || 0);
      const turnover = parseFloat(t.turnover24h || 0);
      if (Math.abs(pricePct) * 100 >= CONFIG.PRICE_MAX_PCT_PERP || turnover < CONFIG.TURNOVER_MIN) continue;

      const oiPct = await getOiChange(symbol);
      if (oiPct < CONFIG.OI_MIN) continue;

      const cvd = await getCvdBybit(symbol, true);
      if (cvd < CONFIG.CVD_MIN_PERP) continue;

      const bookImb = await getBookImbBybit(symbol, true);
      if (bookImb < CONFIG.BOOK_MIN_IMB) continue;

      const score = calculateScore(oiPct, bookImb, pricePct, true);
      if (score < CONFIG.MIN_SCORE) continue;

      const level = getLevel(score);
      if (!level) continue;

      const extra = `   OI 1h: +${oiPct.toFixed(2)}% | CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
                    `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: $${(turnover / 1e6).toFixed(1)}M`;

      const details = buildDetails(symbol, level, score, extra, 'https://www.bybit.com/trade/usdt/');

      candidates.push({ score, details });
      updateCooldown(symbol);
    }
  } catch (e) {
    console.log('Errore Bybit Perp:', e.message);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);
}

// ====================== BYBIT SPOT ======================
async function scanBybitSpot() {
  const candidates = [];
  try {
    const tickers = (await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', { timeout: 10000 })).data.result.list || [];
    for (const t of tickers) {
      const symbol = t.symbol;
      if (!symbol.endsWith('USDT') || !checkCooldown(symbol)) continue;

      const base = symbol.slice(0, -4);
      if (STABLE_BASES.includes(base)) continue; // nuovo: escludi stable-USDT

      const pricePct = parseFloat(t.price24hPcnt || 0);
      const turnover = parseFloat(t.turnover24h || 0);
      if (Math.abs(pricePct) * 100 > CONFIG.PRICE_MAX_PCT_SPOT || turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = await getCvdBybit(symbol, false);
      if (cvd < CONFIG.CVD_MIN_SPOT) continue;

      const bookImb = await getBookImbBybit(symbol, false);
      if (bookImb < CONFIG.BOOK_MIN_IMB) continue;

      const score = calculateScore(cvd, bookImb, pricePct, false);
      if (score < CONFIG.MIN_SCORE) continue;

      const level = getLevel(score);
      if (!level) continue;

      const extra = `   CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
                    `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: $${(turnover / 1e6).toFixed(1)}M`;

      const details = buildDetails(symbol, level, score, extra, 'https://www.bybit.com/trade/spot/');

      candidates.push({ score, details });
      updateCooldown(symbol);
    }
  } catch (e) {
    console.log('Errore Bybit Spot:', e.message);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);
}

// ====================== BINANCE SPOT ======================
async function scanBinanceSpot() {
  const candidates = [];
  try {
    const tickers = (await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 10000 })).data
      .filter(t => t.symbol.endsWith('USDT'));
    for (const t of tickers) {
      const symbol = t.symbol;
      if (!checkCooldown(symbol)) continue;

      const base = symbol.slice(0, -4);
      if (STABLE_BASES.includes(base)) continue; // nuovo: escludi stable-USDT

      const pricePct = parseFloat(t.priceChangePercent) / 100;
      const turnover = parseFloat(t.quoteVolume);
      if (Math.abs(pricePct) * 100 > CONFIG.PRICE_MAX_PCT_SPOT || turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = await getCvdBinance(symbol);
      if (cvd < CONFIG.CVD_MIN_SPOT) continue;

      const bookImb = await getBookImbBinance(symbol);
      if (bookImb < CONFIG.BOOK_MIN_IMB) continue;

      const score = calculateScore(cvd, bookImb, pricePct, false);
      if (score < CONFIG.MIN_SCORE) continue;

      const level = getLevel(score);
      if (!level) continue;

      const extra = `   CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
                    `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: $${(turnover / 1e6).toFixed(1)}M`;

      const details = buildDetails(symbol, level, score, extra, 'https://www.binance.com/en/trade/', `${base}_USDT`);

      candidates.push({ score, details });
      updateCooldown(symbol);
    }
  } catch (e) {
    console.log('Errore Binance Spot:', e.message);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);
}

// ====================== HELPER API ======================
async function getOiChange(symbol) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&interval=1h&limit=3`, { timeout: 8000 });
    const lst = res.data.result.list || [];
    if (lst.length < 2) return 0;
    const now = parseFloat(lst[0].openInterest);
    const prev = parseFloat(lst[1].openInterest);
    return prev > 0 ? ((now - prev) / prev) * 100 : 0;
  } catch (e) {
    return 0;
  }
}

async function getCvdBybit(symbol, isPerp) {
  const cat = isPerp ? 'linear' : 'spot';
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/recent-trade?category=${cat}&symbol=${symbol}&limit=500`, { timeout: 8000 });
    const trades = res.data.result.list || [];
    let delta = 0, total = 0;
    for (const t of trades) {
      const size = parseFloat(t.size);
      total += size;
      delta += t.side === 'Buy' ? size : -size;
    }
    return total > 0 ? delta / total : 0;
  } catch (e) {
    return 0;
  }
}

async function getBookImbBybit(symbol, isPerp) {
  const cat = isPerp ? 'linear' : 'spot';
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/orderbook?category=${cat}&symbol=${symbol}&limit=20`, { timeout: 8000 });
    const d = res.data.result;
    let bids = 0, asks = 0;
    const len = Math.min(20, d.b?.length || 0, d.a?.length || 0);
    for (let i = 0; i < len; i++) {
      bids += parseFloat(d.b[i][1]);
      asks += parseFloat(d.a[i][1]);
    }
    const total = bids + asks;
    return total > 0 ? (bids - asks) / total : 0;
  } catch (e) {
    return 0;
  }
}

async function getCvdBinance(symbol) {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=500`, { timeout: 8000 });
    const trades = res.data;
    let delta = 0, total = 0;
    for (const t of trades) {
      const q = parseFloat(t.qty);
      total += q;
      delta += t.isBuyerMaker ? -q : q;
    }
    return total > 0 ? delta / total : 0;
  } catch (e) {
    return 0;
  }
}

async function getBookImbBinance(symbol) {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`, { timeout: 8000 });
    const d = res.data;
    let bids = 0, asks = 0;
    const len = Math.min(20, d.bids.length, d.asks.length);
    for (let i = 0; i < len; i++) {
      bids += parseFloat(d.bids[i][1]);
      asks += parseFloat(d.asks[i][1]);
    }
    const total = bids + asks;
    return total > 0 ? (bids - asks) / total : 0;
  } catch (e) {
    return 0;
  }
}

// ====================== MAIN SCAN ======================
async function mainScan() {
  console.log(`[${new Date().toLocaleTimeString('it-IT')}] Full scan avviato...`);
  cleanupOldSignals();

  const perpSignals = await scanBybitPerp();
  const bybitSpotSignals = await scanBybitSpot();
  const binanceSignals = await scanBinanceSpot();

  const sections = [];
  if (perpSignals.length > 0) {
    sections.push(`<b>BYBIT PERPETUAL SQUEEZE</b>\n\n${perpSignals.join('\n\n')}`);
  }
  if (bybitSpotSignals.length > 0) {
    sections.push(`<b>BYBIT SPOT SQUEEZE</b>\n\n${bybitSpotSignals.join('\n\n')}`);
  }
  if (binanceSignals.length > 0) {
    sections.push(`<b>BINANCE SPOT SQUEEZE</b>\n\n${binanceSignals.join('\n\n')}`);
  }

  if (sections.length > 0) {
    const fullContent = sections.join('\n\n==============================\n\n');
    await sendTelegram(fullContent, `FULL SQUEEZE SCAN - ${new Date().toLocaleString('it-IT')}`);
  } else {
    console.log('Nessun segnale valido in questo scan');
  }
}

// ====================== AVVIO ======================
console.log(`🚀 FULL SCANNER v3.3 avviato - solo segnali FORTI (≥70/100) - esclusi stable-USDT - ogni ${CONFIG.SCAN_INTERVAL_MIN} minuti`);
mainScan();

setInterval(() => {
  mainScan().catch(err => console.log('Errore generale scan:', err.message));
}, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
