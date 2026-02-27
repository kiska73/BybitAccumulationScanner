// ===============================================
//  REVERSAL EXPLOSION SCANNER v10.5 - EXPLOSION HUNTER
//  Solo segnali forti su Bybit Perps (long & short)
//  ULTRA / SUPER / BIG - messaggio pulito
// ===============================================

const axios = require('axios');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const LAST_FILE = './last_signals.json';

let lastSignals = {};

if (fs.existsSync(LAST_FILE)) {
  try {
    lastSignals = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8'));
  } catch (err) {
    console.error('Errore lettura last_signals.json:', err.message);
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

// ====================== CONFIG ======================
const CONFIG = {
  TURNOVER_MIN: 2_000_000,
  BOOK_DEPTH_LIMIT: 500,
  AGGREGATION_MULTIPLIER: 10,
  CVD_LIMIT_BYBIT: 5000,
  SCAN_INTERVAL_MIN: 20,
  MAX_SIGNALS_PER_LEVEL: 4,
  CONSOLIDATION_KLINES: 48,

  OI_INTERVAL_TIME: '15min',
  OI_LIMIT: 3,
  CANDLE_INTERVAL: '15',
  CANDLE_LIMIT: 3,

  CONFIRM_MIN_CVD_PERPS: 0.125,
  CONFIRM_MIN_OI_DELTA_PCT: 0.55,
  MIN_CANDLE_BODY_RATIO: 0.62,
  MIN_VOLUME_SURGE: 1.95,
  MAX_FUNDING_LONG: 0.0001,
  MIN_FUNDING_SHORT: -0.0001,
  MIN_ATR_PCT: 0.65,
};

const LEVELS = {
  ULTRA: { name: '🚀🚀🚀 ULTRA EXPLOSION', minScore: 94, minCvd: 0.145, minBook: 0.065, maxConsRange: 2.8, maxPricePct: 1.0, emoji: '🚀🚀🚀' },
  SUPER: { name: '🚀🚀 SUPER EXPLOSION', minScore: 87, minCvd: 0.115, minBook: 0.045, maxConsRange: 3.9, maxPricePct: 1.6, emoji: '🚀🚀' },
  BIG:   { name: '🚀 BIG EXPLOSION',    minScore: 80, minCvd: 0.095, minBook: 0.035, maxConsRange: 5.0, maxPricePct: 2.3, emoji: '🚀' }
};

const COOLDOWN_PER_LEVEL = {
  ULTRA: 7 * 60 * 60 * 1000,
  SUPER: 5 * 60 * 60 * 1000,
  BIG:   3 * 60 * 60 * 1000,
};

const STABLE_BASES = ['USDC','TUSD','FDUSD','BUSD','DAI','PYUSD','USDP','GUSD','FRAX','USDD','USDB','USDS','USDE','RLUSD','USDG','YUSD','USD1'];

// ====================== TELEGRAM ======================
async function sendTelegram(content, title) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.includes('INSERISCI')) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: `<b>\( {title}</b>\n\n \){content}`,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });
    console.log(`✅ Telegram inviato: ${title}`);
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

// ====================== SCORE ======================
function getPotential(score) {
  if (score >= 96) return 'NUCLEARE 25%+';
  if (score >= 91) return 'ESTREMA 18-30%';
  if (score >= 85) return 'FORTE 12-20%';
  return 'SOLIDA 8-14%';
}

function calculateScore(cvdAbs, bookAbs, pricePct) {
  const base = cvdAbs * 2.85;
  const pricePenalty = Math.abs(pricePct) * 100 * 0.45;
  return Math.min(100, Math.max(0, base + bookAbs * 120 - pricePenalty));
}

// ====================== BYBIT PERPS HELPERS ======================
async function getCvdBybit(symbol, category = 'linear') {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/recent-trade?category=\( {category}&symbol= \){symbol}&limit=${CONFIG.CVD_LIMIT_BYBIT}`, { timeout: 8000 });
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

async function getOIDeltaBybit(symbol) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=\( {symbol}&intervalTime= \){CONFIG.OI_INTERVAL_TIME}&limit=${CONFIG.OI_LIMIT}`, { timeout: 6000 });
    const list = res.data.result.list || [];
    if (list.length < 2) return { deltaPct: 0 };
    const oiNow = parseFloat(list[0].openInterest);
    const oiPrev = parseFloat(list[1].openInterest);
    const deltaPct = oiPrev > 0 ? (oiNow - oiPrev) / oiPrev * 100 : 0;
    return { deltaPct: Math.abs(deltaPct) };
  } catch { return { deltaPct: 0 }; }
}

async function getPriceOIDivergence(symbol, expectedLong) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=2`, { timeout: 5000 });
    const klines = res.data.result.list || [];
    if (klines.length < 2) return 0.5;
    const pricePct15m = (parseFloat(klines[0][4]) - parseFloat(klines[1][4])) / parseFloat(klines[1][4]) * 100;
    const oiData = await getOIDeltaBybit(symbol);
    const divergence = (pricePct15m * oiData.deltaPct < 0) ? 1.0 : 0.6;
    const directionMatch = (expectedLong && pricePct15m > 0) || (!expectedLong && pricePct15m < 0);
    return directionMatch ? divergence * 1.15 : divergence * 0.85;
  } catch { return 0.5; }
}

async function getDirectionalCandleStrength(symbol, expectedLong) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=\( {symbol}&interval= \){CONFIG.CANDLE_INTERVAL}&limit=${CONFIG.CANDLE_LIMIT}`, { timeout: 5000 });
    const k = res.data.result.list?.[0];
    if (!k) return 0;
    const open = parseFloat(k[1]), close = parseFloat(k[4]), high = parseFloat(k[2]), low = parseFloat(k[3]);
    const body = Math.abs(close - open);
    const range = high - low;
    const bodyRatio = range > 0 ? body / range : 0;
    const isGreen = close > open;
    const directionOK = (expectedLong && isGreen) || (!expectedLong && !isGreen);
    return directionOK ? Math.min(1, bodyRatio * 1.1) : bodyRatio * 0.6;
  } catch { return 0; }
}

async function getFundingRateBybit(symbol) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`, { timeout: 4000 });
    return parseFloat(res.data.result.list?.[0]?.fundingRate || 0);
  } catch { return 0; }
}

async function getVolumeSurgeBybit(symbol) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=8`, { timeout: 5000 });
    const klines = res.data.result.list || [];
    if (klines.length < 6) return 1.0;
    const lastVol = parseFloat(klines[0][5]);
    let avg = 0;
    for (let i = 1; i <= 5; i++) avg += parseFloat(klines[i][5]);
    avg /= 5;
    return avg > 0 ? lastVol / avg : 1.0;
  } catch { return 1.0; }
}

async function getATRPctBybit(symbol) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=15`, { timeout: 5000 });
    const klines = res.data.result.list || [];
    if (klines.length < 14) return 0;
    let trSum = 0;
    for (let i = 0; i < 14; i++) {
      const h = parseFloat(klines[i][2]);
      const l = parseFloat(klines[i][3]);
      const cPrev = (i + 1 < klines.length) ? parseFloat(klines[i + 1][4]) : parseFloat(klines[i][4]);
      trSum += Math.max(h - l, Math.abs(h - cPrev), Math.abs(l - cPrev));
    }
    const atr = trSum / 14;
    const price = parseFloat(klines[0][4]);
    return (atr / price) * 100;
  } catch { return 0; }
}

async function getTickSizeBybit(symbol, category = 'linear') {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/instruments-info?category=\( {category}&symbol= \){symbol}`, { timeout: 5000 });
    return parseFloat(res.data.result.list?.[0]?.priceFilter?.tickSize || '0.0001');
  } catch { return 0.0001; }
}

async function getBookImbBybit(symbol, category = 'linear') {
  try {
    const tickSize = await getTickSizeBybit(symbol, category);
    const aggStep = tickSize * CONFIG.AGGREGATION_MULTIPLIER;
    const res = await axios.get(`https://api.bybit.com/v5/market/orderbook?category=\( {category}&symbol= \){symbol}&limit=${CONFIG.BOOK_DEPTH_LIMIT}`, { timeout: 8000 });
    const d = res.data.result;
    const bidMap = new Map(), askMap = new Map();
    for (const [p, q] of d.b || []) {
      const price = parseFloat(p);
      const rounded = Math.floor(price / aggStep) * aggStep;
      bidMap.set(rounded, (bidMap.get(rounded) || 0) + parseFloat(q));
    }
    for (const [p, q] of d.a || []) {
      const price = parseFloat(p);
      const rounded = Math.ceil(price / aggStep) * aggStep;
      askMap.set(rounded, (askMap.get(rounded) || 0) + parseFloat(q));
    }
    const sortedBids = Array.from(bidMap.entries()).sort((a, b) => b[0] - a[0]);
    const sortedAsks = Array.from(askMap.entries()).sort((a, b) => a[0] - b[0]);
    let bids = 0, asks = 0;
    const len = Math.min(CONFIG.BOOK_DEPTH_LIMIT, sortedBids.length, sortedAsks.length);
    for (let i = 0; i < len; i++) {
      bids += sortedBids[i]?.[1] || 0;
      asks += sortedAsks[i]?.[1] || 0;
    }
    const total = bids + asks;
    return total > 0 ? (bids - asks) / total : 0;
  } catch { return 0; }
}

// ====================== CONFERMA ESPLOSIONE ======================
async function confirmWithBybitPerps(baseSymbol, levelKey, expectedLong) {
  const perpsSymbol = baseSymbol.endsWith('USDT') ? baseSymbol : baseSymbol + 'USDT';

  const cvd = await getCvdBybit(perpsSymbol);
  if (Math.abs(cvd) < CONFIG.CONFIRM_MIN_CVD_PERPS) return null;
  if ((expectedLong && cvd < 0) || (!expectedLong && cvd > 0)) return null;

  const oi = await getOIDeltaBybit(perpsSymbol);
  if (oi.deltaPct < CONFIG.CONFIRM_MIN_OI_DELTA_PCT) return null;

  const priceOIDiv = await getPriceOIDivergence(perpsSymbol, expectedLong);
  const candle = await getDirectionalCandleStrength(perpsSymbol, expectedLong);
  if (candle < CONFIG.MIN_CANDLE_BODY_RATIO) return null;

  const bookImb = await getBookImbBybit(perpsSymbol);
  if ((expectedLong && bookImb <= 0) || (!expectedLong && bookImb >= 0)) return null;

  const funding = await getFundingRateBybit(perpsSymbol);
  const volSurge = await getVolumeSurgeBybit(perpsSymbol);
  const atrPct = await getATRPctBybit(perpsSymbol);

  const fundingOK = expectedLong ? funding <= CONFIG.MAX_FUNDING_LONG : funding >= CONFIG.MIN_FUNDING_SHORT;
  if (!fundingOK) return null;
  if (volSurge < CONFIG.MIN_VOLUME_SURGE) return null;
  if (atrPct < CONFIG.MIN_ATR_PCT) return null;

  const finalScore = Math.min(100, Math.max(82,
    Math.abs(cvd) * 100 * 0.38 +
    oi.deltaPct * 2.8 +
    priceOIDiv * 24 +
    candle * 20 +
    Math.abs(bookImb) * 85 +
    (volSurge - 1) * 18 +
    atrPct * 12
  ));

  if (finalScore < LEVELS[levelKey].minScore) return null;

  return { score: finalScore, cvd, oiDelta: oi.deltaPct, candle, bookImb, funding, volSurge, atrPct };
}

// ====================== ANALISI ======================
async function analyzeSignal(symbol, cvdSpot, bookImbSpot, pricePct, turnover, isBybit, levelKey, category = 'spot') {
  const level = LEVELS[levelKey];
  const base = symbol.replace(/USDT\( |USDC \)/, '');
  if (STABLE_BASES.includes(base)) return null;

  const inCons = await isInConsolidation(symbol, isBybit, level.maxConsRange, category);
  if (!inCons) return null;

  const regime = await getBtcRegime(isBybit);
  const isLong = bookImbSpot > 0;
  if ((isLong && cvdSpot <= 0) || (!isLong && cvdSpot >= 0)) return null;

  const cvdAbs = Math.abs(cvdSpot);
  const bookAbs = Math.abs(bookImbSpot);
  if (cvdAbs < level.minCvd || bookAbs < level.minBook) return null;
  if (Math.abs(pricePct) * 100 > level.maxPricePct) return null;

  let score = calculateScore(cvdAbs, bookAbs, pricePct);
  if (score < level.minScore) return null;

  if ((isLong && regime === 'bearish') || (!isLong && regime === 'bullish')) {
    if (cvdAbs < level.minCvd * 1.4 || score < level.minScore + 10) return null;
  }

  const conf = await confirmWithBybitPerps(base, levelKey, isLong);
  if (!conf) return null;

  score = conf.score;

  const extra = `   Pot: <b>${getPotential(score)}</b>\n   CVD: ${(conf.cvd*100).toFixed(1)}% | OIΔ: ${conf.oiDelta.toFixed(1)}%\n   Candle: ${(conf.candle*100).toFixed(0)}% | ATR: ${conf.atrPct.toFixed(1)}%\n   Vol: $${(turnover/1e6).toFixed(1)}M`;

  const levelText = isLong ? `\( {level.name.split(' ')[1]} LONG` : ` \){level.name.split(' ')[1]} SHORT`;
  const type = category === 'linear' ? 'Perps' : (isBybit ? 'Spot Bybit' : 'Spot Binance');

  return {
    score,
    details: `\( {level.emoji} <b> \){symbol}</b> — \( {levelText} ( \){type})\n   Score: <b>\( {score.toFixed(0)}</b>\n \){extra}`,
    isLong,
    level: levelKey
  };
}

// ====================== ALTRE FUNZIONI ======================
async function getBtcRegime(isBybit) {
  try {
    const symbol = 'BTCUSDT';
    let pct1h = 0, pct24h = 0;
    if (isBybit) {
      const r24 = await axios.get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`, { timeout: 4000 });
      pct24h = parseFloat(r24.data.result.list?.[0]?.price24hPcnt || 0);
      const r1h = await axios.get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=2`, { timeout: 4000 });
      const list = r1h.data.result.list || [];
      if (list.length >= 2) pct1h = (parseFloat(list[0][4]) - parseFloat(list[1][4])) / parseFloat(list[1][4]) * 100;
    } else {
      const r24 = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 4000 });
      pct24h = parseFloat(r24.data.priceChangePercent);
      const r1h = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=2`, { timeout: 4000 });
      if (r1h.data.length >= 2) pct1h = (parseFloat(r1h.data[1][4]) - parseFloat(r1h.data[0][4])) / parseFloat(r1h.data[0][4]) * 100;
    }
    if (pct1h < -1 || pct24h < -2) return 'bearish';
    if (pct1h > 1 || pct24h > 2) return 'bullish';
    return 'neutral';
  } catch { return 'neutral'; }
}

async function isInConsolidation(symbol, isBybit, maxRangePct, category = 'spot') {
  try {
    let url = isBybit 
      ? `https://api.bybit.com/v5/market/kline?category=\( {category}&symbol= \){symbol}&interval=15&limit=${CONFIG.CONSOLIDATION_KLINES}`
      : `https://api.binance.com/api/v3/klines?symbol=\( {symbol}&interval=15m&limit= \){CONFIG.CONSOLIDATION_KLINES}`;
    const res = await axios.get(url, { timeout: 8000 });
    const klines = isBybit ? res.data.result.list : res.data;
    if (klines.length < CONFIG.CONSOLIDATION_KLINES / 2) return false;
    let high = -Infinity, low = Infinity;
    for (const k of klines) {
      const h = parseFloat(isBybit ? k[2] : k[2]);
      const l = parseFloat(isBybit ? k[3] : k[3]);
      if (h > high) high = h;
      if (l < low) low = l;
    }
    const rangePct = (high - low) / low * 100;
    return rangePct <= maxRangePct;
  } catch { return false; }
}

async function getCvdBinance(symbol) {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=2000`, { timeout: 12000 });
    let delta = 0, total = 0;
    for (const t of res.data) {
      const q = parseFloat(t.qty);
      total += q;
      delta += t.isBuyerMaker ? -q : q;
    }
    return total > 0 ? delta / total : 0;
  } catch { return 0; }
}

async function getTickSizeBinance(symbol) {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`, { timeout: 5000 });
    const filters = res.data.symbols?.[0]?.filters || [];
    const priceFilter = filters.find(f => f.filterType === 'PRICE_FILTER');
    return parseFloat(priceFilter?.tickSize || '0.0001');
  } catch { return 0.0001; }
}

async function getBookImbBinance(symbol) {
  try {
    const tickSize = await getTickSizeBinance(symbol);
    const aggStep = tickSize * CONFIG.AGGREGATION_MULTIPLIER;
    const res = await axios.get(`https://api.binance.com/api/v3/depth?symbol=\( {symbol}&limit= \){CONFIG.BOOK_DEPTH_LIMIT}`, { timeout: 10000 });
    const d = res.data;
    const bidMap = new Map(), askMap = new Map();
    for (const [p, q] of d.bids) {
      const price = parseFloat(p);
      const rounded = Math.floor(price / aggStep) * aggStep;
      bidMap.set(rounded, (bidMap.get(rounded) || 0) + parseFloat(q));
    }
    for (const [p, q] of d.asks) {
      const price = parseFloat(p);
      const rounded = Math.ceil(price / aggStep) * aggStep;
      askMap.set(rounded, (askMap.get(rounded) || 0) + parseFloat(q));
    }
    const sortedBids = Array.from(bidMap.entries()).sort((a, b) => b[0] - a[0]);
    const sortedAsks = Array.from(askMap.entries()).sort((a, b) => a[0] - b[0]);
    let bids = 0, asks = 0;
    const len = Math.min(CONFIG.BOOK_DEPTH_LIMIT, sortedBids.length, sortedAsks.length);
    for (let i = 0; i < len; i++) {
      bids += sortedBids[i]?.[1] || 0;
      asks += sortedAsks[i]?.[1] || 0;
    }
    const total = bids + asks;
    return total > 0 ? (bids - asks) / total : 0;
  } catch { return 0; }
}

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
      const symbol = t.symbol;
      if (!symbol.endsWith('USDT')) continue;
      const pricePct = isBybit ? parseFloat(t.price24hPcnt || 0) : parseFloat(t.priceChangePercent) / 100;
      const turnover = isBybit ? parseFloat(t.turnover24h || 0) : parseFloat(t.quoteVolume);
      if (turnover < CONFIG.TURNOVER_MIN) continue;
      const cvd = isBybit ? await getCvdBybit(symbol, 'spot') : await getCvdBinance(symbol);
      const bookImb = isBybit ? await getBookImbBybit(symbol, 'spot') : await getBookImbBinance(symbol);
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
    console.error(`Errore scan spot ${isBybit ? 'Bybit' : 'Binance'}:`, err.message);
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
      const pricePct = parseFloat(t.price24hPcnt || 0);
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
    console.error('Errore scan Perps Bybit:', err.message);
  }
  return signals;
}

// ====================== MAIN ======================
async function mainScan() {
  console.log(`[${new Date().toLocaleTimeString('it-IT')}] REVERSAL EXPLOSION v10.5 avviato...`);
  cleanupOldSignals();

  const bybitSpot = await scanSpotExchange(true);
  const binanceSpot = await scanSpotExchange(false);
  const bybitPerps = await scanPerpsBybit();

  const finalSignals = { ULTRA: [], SUPER: [], BIG: [] };
  const finalPerps = { ULTRA: [], SUPER: [], BIG: [] };

  for (const level of ['ULTRA', 'SUPER', 'BIG']) {
    const allSpot = [...(bybitSpot[level] || []), ...(binanceSpot[level] || [])];
    allSpot.sort((a, b) => b.score - a.score);
    finalSignals[level] = allSpot.slice(0, CONFIG.MAX_SIGNALS_PER_LEVEL);

    const allPerps = bybitPerps[level] || [];
    allPerps.sort((a, b) => b.score - a.score);
    finalPerps[level] = allPerps.slice(0, CONFIG.MAX_SIGNALS_PER_LEVEL);
  }

  let content = '';
  if (finalSignals.ULTRA.length) content += `🚀🚀🚀 <b>ULTRA</b>\n\n${finalSignals.ULTRA.map(s => s.details).join('\n\n')}\n\n`;
  if (finalSignals.SUPER.length) content += `🚀🚀 <b>SUPER</b>\n\n${finalSignals.SUPER.map(s => s.details).join('\n\n')}\n\n`;
  if (finalSignals.BIG.length)   content += `🚀 <b>BIG</b>\n\n${finalSignals.BIG.map(s => s.details).join('\n\n')}\n\n`;

  if (finalPerps.ULTRA.length || finalPerps.SUPER.length || finalPerps.BIG.length) {
    content += `=== PERPS BYBIT ===\n\n`;
    if (finalPerps.ULTRA.length) content += `🚀🚀🚀 <b>ULTRA PERPS</b>\n\n${finalPerps.ULTRA.map(s => s.details).join('\n\n')}\n\n`;
    if (finalPerps.SUPER.length) content += `🚀🚀 <b>SUPER PERPS</b>\n\n${finalPerps.SUPER.map(s => s.details).join('\n\n')}\n\n`;
    if (finalPerps.BIG.length)   content += `🚀 <b>BIG PERPS</b>\n\n${finalPerps.BIG.map(s => s.details).join('\n\n')}\n\n`;
  }

  if (content.trim().length > 30) {
    await sendTelegram(content, '📊 EXPLOSION SCAN v10.5');
  } else {
    console.log('❌ Nessun segnale');
  }
}

// ====================== AVVIO ======================
console.log(`🚀 REVERSAL EXPLOSION SCANNER v10.5 - EXPLOSION HUNTER avviato ogni ${CONFIG.SCAN_INTERVAL_MIN} min`);
mainScan().catch(err => console.error('Errore avvio:', err.message));
setInterval(() => mainScan().catch(err => console.error('Errore scan:', err.message)), CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
