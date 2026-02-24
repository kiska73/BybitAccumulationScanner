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

// ====================== CONFIGURAZIONE LIVELLI ======================
const CONFIG = {
  TURNOVER_MIN: 2000000,             // Aumentato a 2M per qualità
  BOOK_DEPTH_LIMIT: 150,             // Più profondità
  CVD_LIMIT_BYBIT: 3000,             // Più dati CVD
  CVD_LIMIT_BINANCE: 1500,           // Più dati CVD
  SCAN_INTERVAL_MIN: 20,             // Scan più frequenti ma selettivi
  MAX_SIGNALS_PER_LEVEL: 4,          // Pochi segnali (max 4 per livello)
};

const LEVELS = {
  ULTRA: {
    name: '🚀🚀🚀 ULTRA EXPLOSION',
    minScore: 92,                    // Più selettivo
    minCvd: 0.135,                   // Più alto
    minBook: 0.058,                  // Più alto
    maxConsRange: 3.2,               // Range stretto
    maxPricePct: 1.2,                // Meno variazione
    emoji: '🚀🚀🚀'
  },
  SUPER: {
    name: '🚀🚀 SUPER EXPLOSION',
    minScore: 85,                    // Più selettivo
    minCvd: 0.105,                   // Più alto
    minBook: 0.040,                  // Più alto
    maxConsRange: 4.2,               // Stretto
    maxPricePct: 1.8,                // Ridotto
    emoji: '🚀🚀'
  },
  BIG: {
    name: '🚀 BIG EXPLOSION',         // Rimossa "ACCUMULATION SETUP"
    minScore: 78,                    // Più selettivo (niente schifo)
    minCvd: 0.085,                   // Più alto
    minBook: 0.030,                  // Più alto
    maxConsRange: 5.5,               // Stretto
    maxPricePct: 2.5,                // Ridotto
    emoji: '🚀'
  }
};

const COOLDOWN_PER_LEVEL = {
  ULTRA: 7 * 60 * 60 * 1000,   // 7 ore (rarissimi)
  SUPER: 5 * 60 * 60 * 1000,   // 5 ore
  BIG:   3 * 60 * 60 * 1000    // 3 ore
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
//  COOLDOWN PER LIVELLO
// ────────────────────────────────────────────────
function checkCooldown(symbol, level) {
  const last = lastSignals[symbol];
  if (!last) return true;
  return Date.now() - last.timestamp > COOLDOWN_PER_LEVEL[level];
}

function updateCooldown(symbol, level, score) {
  lastSignals[symbol] = { 
    timestamp: Date.now(), 
    level: level,
    lastScore: score 
  };
  saveLastSignals();
}

// ────────────────────────────────────────────────
//  POTENZIALITÀ (migliorata, solo buoni)
// ────────────────────────────────────────────────
function getPotential(score) {
  if (score >= 95) return '🔥🔥🔥 NUCLEARE (25%+)';
  if (score >= 88) return '🔥🔥 ESTREMA (16-25%)';
  if (score >= 82) return '🔥 FORTE (11-16%)';
  return '🔥 SOLIDA (8-12%)';  // Solo "solida" ora
}

function calculateScore(cvdAbs, bookAbs, pricePct) {
  const base = cvdAbs * 2.85;  // Peso CVD aumentato per qualità
  const pricePenalty = Math.abs(pricePct) * 100 * 0.45; // Penalty ridotta
  return Math.min(100, Math.max(0, base + bookAbs * 120 - pricePenalty));  // Peso book aumentato
}

// ────────────────────────────────────────────────
//  CHECK CONSOLIDATION
// ────────────────────────────────────────────────
async function isInConsolidation(symbol, isBybit, maxRangePct) {
  try {
    const interval = '15';
    const limit = 32;  // ~8 ore
    let url;
    if (isBybit) {
      url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    } else {
      url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}m&limit=${limit}`;
    }
    const res = await axios.get(url, { timeout: 8000 });
    const klines = isBybit ? res.data.result : res.data;
    if (klines.length < 16) return false;

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
//  BUILD DETAILS (semplificato, pochi dati)
// ────────────────────────────────────────────────
function buildDetails(symbol, level, score, extraLines) {
  return (
    `${level.emoji} <b>${symbol}</b> — ${level.text}\n` +
    `   Score: <b>${score.toFixed(0)}</b>\n` +
    extraLines
  );
}

// ────────────────────────────────────────────────
//  CONTROLLI COPPIE ATTIVE (semplificato)
// ────────────────────────────────────────────────
async function getActiveControls() {
  const controls = [];
  const now = Date.now();

  for (const [symbol, data] of Object.entries(lastSignals)) {
    if (now - data.timestamp > 10 * 60 * 60 * 1000) continue;

    let status = 'Monitor';
    let currentScore = data.lastScore || 0;

    try {
      const isBybit = await getCurrentPriceChange(symbol, true).then(() => true).catch(() => false);
      const cvd = isBybit ? await getCvdBybit(symbol) : await getCvdBinance(symbol);
      const bookImb = isBybit ? await getBookImbBybit(symbol) : await getBookImbBinance(symbol);
      const pricePct = await getCurrentPriceChange(symbol, isBybit);

      currentScore = calculateScore(Math.abs(cvd), Math.abs(bookImb), pricePct);

      if (currentScore >= 92) status = '🔥🔥🔥 Ultra';
      else if (currentScore >= 85) status = '🚀 Super';
      else if (currentScore >= 78) status = '📈 Big';
      else status = '⚠️ Debole';
    } catch {}

    const levelName = data.level ? LEVELS[data.level]?.name.split(' ')[1] : '??'; // Semplificato
    controls.push(`• <b>${symbol}</b> (${levelName}) → ${status} (${currentScore.toFixed(0)})`);
  }

  return controls.length ? `<b>🔄 Monitor</b>\n${controls.join('\n')}\n\n===\n\n` : '';
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
//  ANALISI SEGNALE CON LIVELLI
// ────────────────────────────────────────────────
async function analyzeSpotSignal(symbol, cvd, bookImb, pricePct, turnover, isBybit, levelKey) {
  const level = LEVELS[levelKey];
  const base = symbol.replace(/USDT$|USDC$/, '');
  if (STABLE_BASES.includes(base)) return null;

  const inConsolidation = await isInConsolidation(symbol, isBybit, level.maxConsRange);
  if (!inConsolidation) return null;

  const cvdAbs = Math.abs(cvd);
  const bookAbs = Math.abs(bookImb);

  if (cvdAbs < level.minCvd || bookAbs < level.minBook) return null;
  if (Math.abs(pricePct) * 100 > level.maxPricePct) return null;

  const score = calculateScore(cvdAbs, bookAbs, pricePct);
  if (score < level.minScore) return null;

  const isLong = cvd > 0 && bookImb > 0;
  const levelObj = { emoji: level.emoji, text: isLong ? `${level.name.split(' ')[1]} LONG` : `${level.name.split(' ')[1]} SHORT` };
  const potential = getPotential(score);

  const extra = 
    `   Pot: <b>${potential}</b>\n` +  // Semplificato
    `   CVD: ${(cvd * 100).toFixed(1)}% | Book: ${(bookImb * 100).toFixed(1)}%\n` +
    `   Vol: $${(turnover / 1e6).toFixed(1)}M`;  // Solo essenziali

  const details = buildDetails(symbol, levelObj, score, extra);

  return {
    score,
    details,
    isLong,
    level: levelKey
  };
}

// ────────────────────────────────────────────────
//  SCAN PER EXCHANGE
// ────────────────────────────────────────────────
async function scanExchange(isBybit) {
  const signals = { ULTRA: [], SUPER: [], BIG: [] };
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

      for (const levelKey of ['ULTRA', 'SUPER', 'BIG']) {
        if (!checkCooldown(symbol, levelKey)) continue;

        const signal = await analyzeSpotSignal(symbol, cvd, bookImb, pricePct, turnover, isBybit, levelKey);
        if (signal) {
          signals[levelKey].push(signal);
          updateCooldown(symbol, levelKey, signal.score);
          break;
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

  const finalSignals = { ULTRA: [], SUPER: [], BIG: [] };

  for (const level of Object.keys(LEVELS)) {
    const all = [...(bybitSignals[level] || []), ...(binanceSignals[level] || [])];
    all.sort((a, b) => b.score - a.score);
    finalSignals[level] = all.slice(0, CONFIG.MAX_SIGNALS_PER_LEVEL);
  }

  return finalSignals;
}

// ────────────────────────────────────────────────
//  MAIN
// ────────────────────────────────────────────────
async function mainScan() {
  console.log(`[${new Date().toLocaleTimeString('it-IT')}] REVERSAL SCAN BUONI avviato...`);
  cleanupOldSignals();

  const controls = await getActiveControls();
  const spot = await scanSpot();

  let fullContent = controls;

  if (spot.ULTRA.length > 0) {
    fullContent += `🚀🚀🚀 <b>ULTRA</b>\n\n${spot.ULTRA.map(s => s.details).join('\n\n')}\n\n`;
  }
  if (spot.SUPER.length > 0) {
    fullContent += `🚀🚀 <b>SUPER</b>\n\n${spot.SUPER.map(s => s.details).join('\n\n')}\n\n`;
  }
  if (spot.BIG.length > 0) {
    fullContent += `🚀 <b>BIG</b>\n\n${spot.BIG.map(s => s.details).join('\n\n')}\n\n`;
  }

  if (fullContent.trim().length > 50) {
    await sendTelegram(fullContent, '📊 REVERSAL EXPLOSION SCAN');
  } else {
    console.log('❌ Nessun segnale buono');
  }
}

// ────────────────────────────────────────────────
//  AVVIO
// ────────────────────────────────────────────────
console.log(`🚀 REVERSAL EXPLOSION SCANNER v9.0 (BUONI PER SCHEI) avviato - ogni ${CONFIG.SCAN_INTERVAL_MIN} min`);

mainScan().catch(err => console.error('Errore avvio:', err.message));

setInterval(() => {
  mainScan().catch(err => console.error('Errore scan:', err.message));
}, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
