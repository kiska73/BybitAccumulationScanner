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

// ====================== CONFIGURAZIONE TIER ======================
const CONFIG = {
  TURNOVER_MIN: 180000,
  BOOK_DEPTH_LIMIT: 100,
  CVD_LIMIT_BYBIT: 2000,
  CVD_LIMIT_BINANCE: 1000,
  SCAN_INTERVAL_MIN: 30,
  MAX_SIGNALS_PER_TIER: 8,
};

const TIERS = {
  NUCLEAR: {
    name: '☢️ NUCLEAR EXPLOSION',
    minScore: 88,
    minCvd: 0.112,
    minBook: 0.045,
    maxConsRange: 4.0,
    maxPricePct: 1.8,
    emoji: '☢️'
  },
  STRONG: {
    name: '🚀🚀 STRONG EXPLOSION',
    minScore: 79,
    minCvd: 0.085,
    minBook: 0.029,
    maxConsRange: 5.5,
    maxPricePct: 2.8,
    emoji: '🚀'
  },
  SOLID: {
    name: '📈 GOOD ACCUMULATION SETUP',
    minScore: 71,
    minCvd: 0.065,
    minBook: 0.021,
    maxConsRange: 7.2,
    maxPricePct: 4.0,
    emoji: '📈'
  }
};

const COOLDOWN_PER_TIER = {
  NUCLEAR: 5 * 60 * 60 * 1000,   // 5 ore
  STRONG:  3.5 * 60 * 60 * 1000, // 3.5 ore
  SOLID:   2 * 60 * 60 * 1000    // 2 ore
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
//  COOLDOWN PER TIER
// ────────────────────────────────────────────────
function checkCooldown(symbol, tier) {
  const last = lastSignals[symbol];
  if (!last) return true;
  return Date.now() - last.timestamp > COOLDOWN_PER_TIER[tier];
}

function updateCooldown(symbol, tier, score) {
  lastSignals[symbol] = { 
    timestamp: Date.now(), 
    tier: tier,
    lastScore: score 
  };
  saveLastSignals();
}

// ────────────────────────────────────────────────
//  LEVEL + POTENZIALITÀ
// ────────────────────────────────────────────────
function getLevel(score, isLong) {
  if (score >= 92) return { emoji: '🚀🚀🚀', text: isLong ? 'ULTRA LONG EXPLOSION' : 'ULTRA SHORT EXPLOSION' };
  if (score >= 86) return { emoji: '🚀🚀', text: isLong ? 'SUPER LONG EXPLOSION' : 'SUPER SHORT EXPLOSION' };
  if (score >= 80) return { emoji: '🚀', text: isLong ? 'BIG LONG EXPLOSION' : 'BIG SHORT EXPLOSION' };
  return { emoji: '📈', text: isLong ? 'LONG SETUP' : 'SHORT SETUP' };
}

function getPotential(score) {
  if (score >= 92) return '🔥🔥🔥 NUCLEARE (22%+)';
  if (score >= 86) return '🔥🔥 ESTREMA (14-22%)';
  if (score >= 79) return '🔥 FORTE (10-16%)';
  return '📈 BUONA (7-12%)';
}

function calculateScore(cvdAbs, bookAbs, pricePct) {
  const base = cvdAbs * 2.45;
  const pricePenalty = Math.abs(pricePct) * 100 * 0.6; // penalty più morbida
  return Math.min(100, Math.max(0, base + bookAbs * 98 - pricePenalty));
}

// ────────────────────────────────────────────────
//  CHECK CONSOLIDATION
// ────────────────────────────────────────────────
async function isInConsolidation(symbol, isBybit, maxRangePct) {
  try {
    const interval = '15';
    const limit = 26;
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
    return rangePct <= maxRangePct;
  } catch {
    return false;
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
//  CONTROLLI COPPIE ATTIVE
// ────────────────────────────────────────────────
async function getActiveControls() {
  const controls = [];
  const now = Date.now();

  for (const [symbol, data] of Object.entries(lastSignals)) {
    if (now - data.timestamp > 6 * 60 * 60 * 1000) continue;

    let status = 'In monitoraggio';
    let currentScore = data.lastScore || 0;

    try {
      const isBybit = await getCurrentPriceChange(symbol, true).then(() => true).catch(() => false); // piccolo hack per capire exchange
      const cvd = isBybit ? await getCvdBybit(symbol) : await getCvdBinance(symbol);
      const bookImb = isBybit ? await getBookImbBybit(symbol) : await getBookImbBinance(symbol);
      const pricePct = await getCurrentPriceChange(symbol, isBybit);

      currentScore = calculateScore(Math.abs(cvd), Math.abs(bookImb), pricePct);

      if (currentScore >= 88) status = '🔥🔥🔥 Ancora Nucleare';
      else if (currentScore >= 80) status = '🚀 Ancora Forte';
      else if (currentScore >= 72) status = '📈 Ancora Buono';
      else status = '⚠️ Indebolito';
    } catch {}

    const tierName = data.tier ? TIERS[data.tier]?.name || data.tier : 'Unknown';
    controls.push(`• <b>${symbol}</b> (${tierName}) → <b>${status}</b> (Score ${currentScore.toFixed(0)})`);
  }

  return controls.length ? `<b>🔄 Coppie in Monitoraggio</b>\n\n${controls.join('\n')}\n\n==============================\n\n` : '';
}

async function getCurrentPriceChange(symbol, isBybit) {
  try {
    if (isBybit) {
      const res = await axios.get(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`, { timeout: 5000 });
      return parseFloat(res.data.result.list?.[0]?.price24hPcnt || 0) / 100;
    } else {
      const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
      return parseFloat(res.data.priceChangePercent) / 100;
    }
  } catch { return 0; }
}

// ────────────────────────────────────────────────
//  CVD & BOOK HELPERS
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
//  ANALISI SEGNALE CON TIER
// ────────────────────────────────────────────────
async function analyzeSpotSignal(symbol, cvd, bookImb, pricePct, turnover, isBybit, tierKey) {
  const tier = TIERS[tierKey];
  const base = symbol.replace(/USDT$|USDC$/, '');
  if (STABLE_BASES.includes(base)) return null;

  const inConsolidation = await isInConsolidation(symbol, isBybit, tier.maxConsRange);
  if (!inConsolidation) return null;

  const cvdAbs = Math.abs(cvd);
  const bookAbs = Math.abs(bookImb);

  if (cvdAbs < tier.minCvd || bookAbs < tier.minBook) return null;
  if (Math.abs(pricePct) * 100 > tier.maxPricePct) return null;

  const score = calculateScore(cvdAbs, bookAbs, pricePct);
  if (score < tier.minScore) return null;

  const isLong = cvd > 0 && bookImb > 0;
  const level = getLevel(score, isLong);
  const potential = getPotential(score);

  const extra = 
    `   Potenzialità: <b>${potential}</b>\n` +
    `   CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
    `   Prezzo 24h: ${(pricePct * 100).toFixed(2)}% | Vol: $${(turnover / 1e6).toFixed(1)}M\n` +
    `   Accumulo: <b>≤${tier.maxConsRange}%</b> — ${tier.name}`;

  const details = buildDetails(symbol, level, score, extra);

  return {
    score,
    details,
    isLong,
    tier: tierKey
  };
}

// ────────────────────────────────────────────────
//  SCAN PER EXCHANGE
// ────────────────────────────────────────────────
async function scanExchange(isBybit) {
  const signals = { NUCLEAR: [], STRONG: [], SOLID: [] };
  const exchangeName = isBybit ? 'Bybit' : 'Binance';

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

      const pricePct = isBybit 
        ? parseFloat(t.price24hPcnt || 0) / 100 
        : parseFloat(t.priceChangePercent) / 100;

      const turnover = isBybit 
        ? parseFloat(t.turnover24h || 0) 
        : parseFloat(t.quoteVolume);

      if (turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = isBybit ? await getCvdBybit(symbol) : await getCvdBinance(symbol);
      const bookImb = isBybit ? await getBookImbBybit(symbol) : await getBookImbBinance(symbol);

      // Prova i tier dal più forte al più debole
      for (const tierKey of ['NUCLEAR', 'STRONG', 'SOLID']) {
        if (!checkCooldown(symbol, tierKey)) continue;

        const signal = await analyzeSpotSignal(symbol, cvd, bookImb, pricePct, turnover, isBybit, tierKey);
        if (signal) {
          signals[tierKey].push(signal);
          updateCooldown(symbol, tierKey, signal.score);
          break; // solo il tier più alto per simbolo
        }
      }
    }
  } catch (err) {
    console.error(`Errore ${exchangeName} Spot:`, err.message);
  }

  return signals;
}

// ────────────────────────────────────────────────
//  SCAN SPOT PRINCIPALE
// ────────────────────────────────────────────────
async function scanSpot() {
  const bybitSignals = await scanExchange(true);
  const binanceSignals = await scanExchange(false);

  const finalSignals = { NUCLEAR: [], STRONG: [], SOLID: [] };

  for (const tier of Object.keys(TIERS)) {
    const all = [...(bybitSignals[tier] || []), ...(binanceSignals[tier] || [])];
    all.sort((a, b) => b.score - a.score);
    finalSignals[tier] = all.slice(0, CONFIG.MAX_SIGNALS_PER_TIER);
  }

  return finalSignals;
}

// ────────────────────────────────────────────────
//  MAIN
// ────────────────────────────────────────────────
async function mainScan() {
  console.log(`[${new Date().toLocaleTimeString('it-IT')}] REVERSAL ACCUMULATION SCAN (3 TIER) avviato...`);
  cleanupOldSignals();

  const controls = await getActiveControls();
  const spot = await scanSpot();

  let fullContent = controls;

  if (spot.NUCLEAR.length > 0) {
    fullContent += `☢️ <b>NUCLEAR EXPLOSION</b>\n\n${spot.NUCLEAR.map(s => s.details).join('\n\n')}\n\n`;
  }
  if (spot.STRONG.length > 0) {
    fullContent += `🚀 <b>STRONG EXPLOSION</b>\n\n${spot.STRONG.map(s => s.details).join('\n\n')}\n\n`;
  }
  if (spot.SOLID.length > 0) {
    fullContent += `📈 <b>GOOD ACCUMULATION SETUP</b>\n\n${spot.SOLID.map(s => s.details).join('\n\n')}\n\n`;
  }

  if (fullContent.trim().length > 50) {
    await sendTelegram(fullContent, '📊 REVERSAL ACCUMULATION EXPLOSION SCAN - 3 TIER');
  } else {
    console.log('❌ Nessun segnale valido in questo scan');
  }
}

// ────────────────────────────────────────────────
//  AVVIO
// ────────────────────────────────────────────────
console.log(`🚀 REVERSAL ACCUMULATION EXPLOSION SCANNER v6.0 (3 TIER) avviato - ogni ${CONFIG.SCAN_INTERVAL_MIN} min`);

mainScan().catch(err => console.error('Errore avvio:', err.message));

setInterval(() => {
  mainScan().catch(err => console.error('Errore scan:', err.message));
}, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
