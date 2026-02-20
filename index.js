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
];

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
function getLevel(score, isLong) {
  if (score >= 85) return { emoji: isLong ? '🔥🔥🔥' : '📉📉📉', text: isLong ? 'SUPER SHORT SQUEEZE' : 'SUPER LONG SQUEEZE' };
  if (score >= 70) return { emoji: isLong ? '📈📈' : '📉📉', text: isLong ? 'FORTE SHORT SQUEEZE' : 'FORTE LONG SQUEEZE' };
  return null;
}

function calculateScore(oiOrCvd, bookImb, pricePct, isPerp) {
  const base = isPerp ? oiOrCvd * 1.45 : oiOrCvd * 2.2;
  const pricePenalty = Math.abs(pricePct) * 100;
  const priceBonus = isPerp ? CONFIG.PRICE_MAX_PCT_PERP : CONFIG.PRICE_MAX_PCT_SPOT;
  return Math.min(100, Math.max(0, base + bookImb * 95 + priceBonus - pricePenalty));
}

// ====================== POTENZIALE ESPLOSIONE INTRADAY REALISTICO ======================
function getExplosionPotential(score, cvdAbs, bookAbs, pricePct24h, spacePct, isLong, isPerp) {
  const strength = (score / 70) * (1 + cvdAbs * 3) * (1 + bookAbs * 5);
  
  let multiplier;
  if (isPerp) {
    multiplier = isLong ? 4.0 : 3.5; // short squeeze perp più esplosivo
  } else {
    multiplier = 2.8; // spot meno volatile/leveraged
  }
  
  let estimated = strength * multiplier;
  const maxCap = isPerp ? 20 : 15;
  estimated = Math.min(maxCap, Math.max(5, Math.round(estimated)));

  const levelText = estimated >= (isPerp ? 16 : 12) ? 'NUCLEARE 🔥🔥🔥' :
                    estimated >= (isPerp ? 12 : 9)  ? 'Very Strong 🔥🔥' :
                    estimated >= (isPerp ? 8 : 6)   ? 'Strong 🔥' : 'Moderate';

  const estimatedLow = Math.round(estimated * 0.75);
  const toExtreme = Math.max(1.5, spacePct).toFixed(1);

  return {
    toExtreme,
    estimatedLow,
    estimatedHigh: estimated,
    level: levelText
  };
}

// ====================== BUILD DETAILS ======================
function buildDetails(symbol, level, score, extraLines, potential, linkBase, linkSuffix = '') {
  let details = `${level.emoji} <b><a href="${linkBase}${symbol}${linkSuffix}">${symbol}</a></b> — ${level.text}\n` +
                `   Score: <b>${score.toFixed(0)}/100</b>\n` +
                extraLines;

  if (potential) {
    const direction = level.text.includes('SHORT SQUEEZE') ? '↑ UP' : '↓ DOWN';
    const extremeText = level.text.includes('SHORT SQUEEZE') ? 'high 24h' : 'low 24h';
    const sign = level.text.includes('SHORT SQUEEZE') ? '+' : '-';
    details += `\n   Potenziale ${direction}: ${potential.level} (est. ${potential.estimatedLow}-${potential.estimatedHigh}% intraday)\n` +
               `   Spazio verso ${extremeText}: ${sign}${potential.toExtreme}%`;
  }

  return details;
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
      let effectiveCvd = cvd;

      if (cvd >= CONFIG.CVD_MIN_PERP && bookImb >= CONFIG.BOOK_MIN_IMB) {
        isLong = true;
      } else if (cvd <= -CONFIG.CVD_MIN_PERP && bookImb <= -CONFIG.BOOK_MIN_IMB) {
        isLong = false;
        effectiveBook = -bookImb;
        effectiveCvd = -cvd;
      } else {
        continue;
      }

      const score = calculateScore(oiPct, effectiveBook, pricePct, true);
      if (score < CONFIG.MIN_SCORE) continue;

      const level = getLevel(score, isLong);
      if (!level) continue;

      // Spazio reale per potenziale
      const currentPrice = parseFloat(t.lastPrice || 0);
      const high24 = parseFloat(t.highPrice24h || 0);
      const low24 = parseFloat(t.lowPrice24h || 0);
      if (currentPrice === 0) continue;

      let spacePct = isLong 
        ? (high24 - currentPrice) / currentPrice * 100 
        : (currentPrice - low24) / currentPrice * 100;
      spacePct = Math.max(1.5, spacePct);

      const potential = getExplosionPotential(score, Math.abs(effectiveCvd), Math.abs(bookImb), pricePct, spacePct, isLong, true);

      const extra = `   OI 1h: +${oiPct.toFixed(2)}% | CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
                    `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: $${(turnover / 1e6).toFixed(1)}M`;

      const details = buildDetails(symbol, level, score, extra, potential, 'https://www.bybit.com/trade/usdt/');

      candidates.push({ score, details, isLong });
      updateCooldown(symbol);
    }
  } catch (e) {
    console.log('Errore Bybit Perp:', e.message);
  }

  candidates.sort((a, b) => b.score - a.score);

  const longCandidates = candidates.filter(c => c.isLong).slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);
  const shortCandidates = candidates.filter(c => !c.isLong).slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);

  return { long: longCandidates, short: shortCandidates };
}

// ====================== BYBIT SPOT (con potenziale) ======================
async function scanBybitSpot() {
  const candidates = [];
  try {
    const tickers = (await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', { timeout: 10000 })).data.result.list || [];
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

      const level = getLevel(score, true); // spot solo UP
      if (!level) continue;

      // Spazio reale per potenziale (solo UP)
      const currentPrice = parseFloat(t.lastPrice || 0);
      const high24 = parseFloat(t.highPrice24h || 0);
      if (currentPrice === 0) continue;

      const spacePct = (high24 - currentPrice) / currentPrice * 100;
      const potential = getExplosionPotential(score, cvd, bookImb, pricePct, spacePct, true, false);

      const extra = `   CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
                    `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: $${(turnover / 1e6).toFixed(1)}M`;

      const details = buildDetails(symbol, level, score, extra, potential, 'https://www.bybit.com/trade/spot/');

      candidates.push({ score, details });
      updateCooldown(symbol);
    }
  } catch (e) {
    console.log('Errore Bybit Spot:', e.message);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);
}

// ====================== BINANCE SPOT (con potenziale) ======================
async function scanBinanceSpot() {
  const candidates = [];
  try {
    const tickers = (await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 10000 })).data
      .filter(t => t.symbol.endsWith('USDT'));
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

      const level = getLevel(score, true); // spot solo UP
      if (!level) continue;

      // Spazio reale per potenziale (solo UP)
      const currentPrice = parseFloat(t.lastPrice || 0);
      const high24 = parseFloat(t.highPrice || 0);
      if (currentPrice === 0) continue;

      const spacePct = (high24 - currentPrice) / currentPrice * 100;
      const potential = getExplosionPotential(score, cvd, bookImb, pricePct, spacePct, true, false);

      const extra = `   CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
                    `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: $${(turnover / 1e6).toFixed(1)}M`;

      const details = buildDetails(symbol, level, score, extra, potential, 'https://www.binance.com/en/trade/', `${base}_USDT`);

      candidates.push({ score, details });
      updateCooldown(symbol);
    }
  } catch (e) {
    console.log('Errore Binance Spot:', e.message);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, CONFIG.MAX_SIGNALS_PER_TYPE).map(c => c.details);
}

// ====================== HELPER API ====================== (invariati)
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

  const perp = await scanBybitPerp();
  const bybitSpotSignals = await scanBybitSpot();
  const binanceSignals = await scanBinanceSpot();

  const sections = [];
  if (perp.long.length > 0) {
    sections.push(`<b>BYBIT PERPETUAL SHORT SQUEEZE ↑</b>\n\n${perp.long.join('\n\n')}`);
  }
  if (perp.short.length > 0) {
    sections.push(`<b>BYBIT PERPETUAL LONG SQUEEZE ↓</b>\n\n${perp.short.join('\n\n')}`);
  }
  if (bybitSpotSignals.length > 0) {
    sections.push(`<b>BYBIT SPOT PUMP ↑</b>\n\n${bybitSpotSignals.join('\n\n')}`);
  }
  if (binanceSignals.length > 0) {
    sections.push(`<b>BINANCE SPOT PUMP ↑</b>\n\n${binanceSignals.join('\n\n')}`);
  }

  if (sections.length > 0) {
    const fullContent = sections.join('\n\n==============================\n\n');
    await sendTelegram(fullContent, `FULL SQUEEZE SCAN - ${new Date().toLocaleString('it-IT')}`);
  } else {
    console.log('Nessun segnale valido in questo scan');
  }
}

// ====================== AVVIO ======================
console.log(`🚀 FULL SCANNER v3.5 avviato - segnali FORTI + potenziale intraday realistico su PERP e SPOT - ogni ${CONFIG.SCAN_INTERVAL_MIN} minuti`);
mainScan();

setInterval(() => {
  mainScan().catch(err => console.log('Errore generale scan:', err.message));
}, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
