// ===============================================
//  REVERSAL EXPLOSION SCANNER v11.5 - REGIME BALANCED
//  🧨 Cacciatore di Breakout Rari (ULTRA/SUPER/BIG)
//  ⚡ Generatore di Opportunità Frequenti Serie (PRE-EXPLOSION)
//  CVD DIRECTION LOCK + Regime filter ammorbidito + tag CONTRO-REGIME
//  v11.5 – 30-50% più segnali in trend marcato di BTC
// ===============================================

const axios = require('axios');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const LAST_FILE = './last_signals.json';
const PRE_FILE  = './last_pre_signals.json';

let lastSignals = {};
let lastPreSignals = {};

if (fs.existsSync(LAST_FILE)) {
  try { lastSignals = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch {}
}
if (fs.existsSync(PRE_FILE)) {
  try { lastPreSignals = JSON.parse(fs.readFileSync(PRE_FILE, 'utf8')); } catch {}
}

function saveLastSignals() { fs.writeFileSync(LAST_FILE, JSON.stringify(lastSignals, null, 2)); }
function saveLastPreSignals() { fs.writeFileSync(PRE_FILE, JSON.stringify(lastPreSignals, null, 2)); }

function cleanupOldSignals() {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const key of Object.keys(lastSignals)) {
    if (lastSignals[key].timestamp < cutoff) { delete lastSignals[key]; cleaned++; }
  }
  if (cleaned > 0) { saveLastSignals(); console.log(`🧹 Puliti ${cleaned} segnali vecchi`); }
}

function cleanupOldPreSignals() {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const key of Object.keys(lastPreSignals)) {
    if (lastPreSignals[key].timestamp < cutoff) { delete lastPreSignals[key]; cleaned++; }
  }
  if (cleaned > 0) { saveLastPreSignals(); console.log(`🧹 Puliti ${cleaned} PRE-segnali vecchi`); }
}

// ====================== CONFIG v11.5 Regime Balanced ======================
const CONFIG = {
  TURNOVER_MIN: 2_000_000,
  BOOK_DEPTH_LIMIT: 500,
  AGGREGATION_MULTIPLIER: 10,
  CVD_LIMIT_BYBIT: 5000,
  SCAN_INTERVAL_MIN: 18,
  MAX_SIGNALS_PER_LEVEL: 5,

  OI_INTERVAL_TIME: '15min',
  OI_LIMIT: 3,
  CANDLE_INTERVAL: '15',
  CANDLE_LIMIT: 3,

  // FULL – bilanciato
  CONFIRM_MIN_CVD_PERPS: 0.108,
  CONFIRM_MIN_OI_DELTA_PCT: 0.39,
  MIN_CANDLE_BODY_RATIO: 0.56,
  MIN_VOLUME_SURGE: 1.68,
  MAX_FUNDING_LONG: 0.00042,
  MIN_FUNDING_SHORT: -0.00042,
  MIN_ATR_PCT: 0.56,

  // PRE – reattivo
  CONSOLIDATION_KLINES: 36,
  CONFIRM_MIN_CVD_PERPS_PRE: 0.082,
  CONFIRM_MIN_OI_DELTA_PCT_PRE: 0.26,
  MIN_CANDLE_BODY_RATIO_PRE: 0.49,
  MIN_VOLUME_SURGE_PRE: 1.48,
  MIN_ATR_PCT_PRE: 0.49,
  MAX_FUNDING_LONG_PRE: 0.00075,
  MIN_FUNDING_SHORT_PRE: -0.00075,

  // REGIME FILTER v11.5 (ammorbidito)
  REGIME_FILTER_ENABLED: true,      // ← false = disattiva completamente
  REGIME_CVD_MULTIPLIER: 1.25,      // era 1.4
  REGIME_SCORE_ADD: 6,              // era +10
};

const LEVELS = {
  ULTRA: { name: '🚀🚀🚀 ULTRA EXPLOSION', minScore: 91, minCvd: 0.132, minBook: 0.055, maxConsRange: 5.2, maxPricePct: 1.35, emoji: '🚀🚀🚀' },
  SUPER: { name: '🚀🚀 SUPER EXPLOSION', minScore: 83, minCvd: 0.102, minBook: 0.038, maxConsRange: 7.8, maxPricePct: 2.1, emoji: '🚀🚀' },
  BIG:   { name: '🚀 BIG EXPLOSION',    minScore: 76, minCvd: 0.082, minBook: 0.029, maxConsRange: 10.5, maxPricePct: 3.0, emoji: '🚀' }
};

const COOLDOWN_PER_LEVEL = { ULTRA: 7*60*60*1000, SUPER: 5*60*60*1000, BIG: 3*60*60*1000 };

const STABLE_BASES = ['USDC','TUSD','FDUSD','BUSD','DAI','PYUSD','USDP','GUSD','FRAX','USDD','USDB','USDS','USDE','RLUSD','USDG','YUSD','USD1'];

// ====================== TELEGRAM & COOLDOWN ======================
async function sendTelegram(content, title) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: `<b>${title}</b>\n\n${content}`,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });
    console.log(`✅ Telegram: ${title}`);
  } catch (e) { console.error('Telegram err:', e.message); }
}

function checkCooldown(key, level) {
  const last = lastSignals[key];
  return !last || Date.now() - last.timestamp > COOLDOWN_PER_LEVEL[level];
}

function updateCooldown(key, level, score, isBybit, isPerps = false) {
  lastSignals[key] = { timestamp: Date.now(), level, lastScore: score, isBybit, isPerps };
  saveLastSignals();
}

function checkCooldownPre(key) {
  const last = lastPreSignals[key];
  return !last || Date.now() - last.timestamp > 4*60*60*1000;
}

function updateCooldownPre(key, score, isBybit, isPerps = false) {
  lastPreSignals[key] = { timestamp: Date.now(), level: 'PRE', lastScore: score, isBybit, isPerps };
  saveLastPreSignals();
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

// ====================== HELPERS ======================
async function getCvdBybit(symbol, category = 'linear') {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/recent-trade?category=${category}&symbol=${symbol}&limit=${CONFIG.CVD_LIMIT_BYBIT}`, { timeout: 8000 });
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
    const res = await axios.get(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${CONFIG.OI_INTERVAL_TIME}&limit=${CONFIG.OI_LIMIT}`, { timeout: 6000 });
    const list = res.data.result.list || [];
    if (list.length < 2) return { deltaPct: 0 };
    const oiNow = parseFloat(list[0].openInterest);
    const oiPrev = parseFloat(list[1].openInterest);
    const deltaPct = oiPrev > 0 ? (oiNow - oiPrev) / oiPrev * 100 : 0;
    return { deltaPct };
  } catch { return { deltaPct: 0 }; }
}

async function getPriceOIDivergence(symbol, expectedLong, oiDeltaProvided) {
  try {
    const oiDelta = oiDeltaProvided;
    const res = await axios.get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=2`, { timeout: 5000 });
    const klines = res.data.result.list || [];
    if (klines.length < 2) return 0.5;
    const pricePct15m = (parseFloat(klines[0][4]) - parseFloat(klines[1][4])) / parseFloat(klines[1][4]) * 100;
    const divergence = (pricePct15m * oiDelta < 0) ? 1.0 : 0.6;
    const directionMatch = (expectedLong && pricePct15m > 0) || (!expectedLong && pricePct15m < 0);
    return directionMatch ? divergence * 1.15 : divergence * 0.85;
  } catch { return 0.5; }
}

async function getDirectionalCandleStrength(symbol, expectedLong) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${CONFIG.CANDLE_INTERVAL}&limit=${CONFIG.CANDLE_LIMIT}`, { timeout: 5000 });
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
    const res = await axios.get(`https://api.bybit.com/v5/market/instruments-info?category=${category}&symbol=${symbol}`, { timeout: 5000 });
    return parseFloat(res.data.result.list?.[0]?.priceFilter?.tickSize || '0.0001');
  } catch { return 0.0001; }
}

async function getBookImbBybit(symbol, category = 'linear') {
  try {
    const tickSize = await getTickSizeBybit(symbol, category);
    const aggStep = tickSize * CONFIG.AGGREGATION_MULTIPLIER;
    const res = await axios.get(`https://api.bybit.com/v5/market/orderbook?category=${category}&symbol=${symbol}&limit=${CONFIG.BOOK_DEPTH_LIMIT}`, { timeout: 8000 });
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

// ====================== UNIFIED PERPS DATA ======================
async function getPerpsConfirmationData(baseSymbol, expectedLong) {
  const perpsSymbol = baseSymbol.endsWith('USDT') ? baseSymbol : baseSymbol + 'USDT';

  const [cvd, oiData, candle, bookImb, funding, volSurge, atrPct] = await Promise.all([
    getCvdBybit(perpsSymbol),
    getOIDeltaBybit(perpsSymbol),
    getDirectionalCandleStrength(perpsSymbol, expectedLong),
    getBookImbBybit(perpsSymbol),
    getFundingRateBybit(perpsSymbol),
    getVolumeSurgeBybit(perpsSymbol),
    getATRPctBybit(perpsSymbol)
  ]);

  const priceOIDiv = await getPriceOIDivergence(perpsSymbol, expectedLong, oiData.deltaPct);

  return {
    cvd,
    oiDelta: oiData.deltaPct,
    absOiDelta: Math.abs(oiData.deltaPct),
    priceOIDiv,
    candle,
    bookImb,
    funding,
    volSurge,
    atrPct
  };
}

// ====================== ANALISI v11.5 (regime ammorbidito + tag) ======================
async function analyzeSignal(symbol, cvdSpot, bookImbSpot, pricePct, turnover, isBybit, levelKey, category = 'spot') {
  const level = LEVELS[levelKey];
  const base = symbol.replace(/USDT|USDC/, '');
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

  // ==================== REGIME FILTER v11.5 ====================
  const isCounterRegime = (isLong && regime === 'bearish') || (!isLong && regime === 'bullish');
  if (CONFIG.REGIME_FILTER_ENABLED && isCounterRegime) {
    if (cvdAbs < level.minCvd * CONFIG.REGIME_CVD_MULTIPLIER ||
        score < level.minScore + CONFIG.REGIME_SCORE_ADD) {
      return null;
    }
  }
  // ============================================================

  const data = await getPerpsConfirmationData(base, isLong);

  const cvdDirectionOK = (isLong && data.cvd > 0) || (!isLong && data.cvd < 0);

  // FULL
  const fullOK = cvdDirectionOK &&
    Math.abs(data.cvd) >= CONFIG.CONFIRM_MIN_CVD_PERPS &&
    data.absOiDelta >= CONFIG.CONFIRM_MIN_OI_DELTA_PCT &&
    data.candle >= CONFIG.MIN_CANDLE_BODY_RATIO &&
    ((isLong && data.bookImb > 0) || (!isLong && data.bookImb < 0)) &&
    (isLong ? data.funding <= CONFIG.MAX_FUNDING_LONG : data.funding >= CONFIG.MIN_FUNDING_SHORT) &&
    data.volSurge >= CONFIG.MIN_VOLUME_SURGE &&
    data.atrPct >= CONFIG.MIN_ATR_PCT;

  if (fullOK) {
    score = Math.min(100, Math.max(82,
      Math.abs(data.cvd) * 100 * 0.38 +
      data.absOiDelta * 2.8 +
      data.priceOIDiv * 24 +
      data.candle * 20 +
      Math.abs(data.bookImb) * 85 +
      (data.volSurge - 1) * 18 +
      data.atrPct * 12
    ));
    if (score < level.minScore) return null;

    let extra = `   Pot: <b>${getPotential(score)}</b>\n   CVD: ${(data.cvd*100).toFixed(1)}% | OIΔ: ${data.oiDelta.toFixed(1)}% (signed)\n   Candle: ${(data.candle*100).toFixed(0)}% | ATR: ${data.atrPct.toFixed(1)}%\n   Vol: $${(turnover/1e6).toFixed(1)}M`;
    if (isCounterRegime) extra += `\n   ⚔️ CONTRO-REGIME BTC`;

    const levelText = isLong ? `${level.name.split(' ')[1]} LONG` : `${level.name.split(' ')[1]} SHORT`;
    const type = category === 'linear' ? 'Perps' : (isBybit ? 'Spot Bybit' : 'Spot Binance');

    return {
      score,
      details: `${level.emoji} <b>${symbol}</b> — ${levelText} (${type})\n   Score: <b>${score.toFixed(0)}</b>\n${extra}`,
      isLong,
      level: levelKey,
      type: 'FULL'
    };
  }

  // PRE
  const preOK = cvdDirectionOK &&
    Math.abs(data.cvd) >= CONFIG.CONFIRM_MIN_CVD_PERPS_PRE &&
    data.absOiDelta >= CONFIG.CONFIRM_MIN_OI_DELTA_PCT_PRE &&
    data.candle >= CONFIG.MIN_CANDLE_BODY_RATIO_PRE &&
    ((isLong && data.bookImb > 0) || (!isLong && data.bookImb < 0)) &&
    (isLong ? data.funding <= CONFIG.MAX_FUNDING_LONG_PRE : data.funding >= CONFIG.MIN_FUNDING_SHORT_PRE) &&
    (data.volSurge >= CONFIG.MIN_VOLUME_SURGE_PRE || data.atrPct >= CONFIG.MIN_ATR_PCT_PRE);

  if (preOK) {
    const preScore = Math.min(100, Math.max(72,
      Math.abs(data.cvd) * 100 * 0.38 +
      data.absOiDelta * 2.5 +
      data.priceOIDiv * 20 +
      data.candle * 18 +
      Math.abs(data.bookImb) * 80 +
      (data.volSurge - 1) * 15 +
      data.atrPct * 10
    ));

    let extra = `   Pot: <b>ALTA (PRE)</b>\n   CVD: ${(data.cvd*100).toFixed(1)}% | OIΔ: ${data.oiDelta.toFixed(1)}% (signed)\n   Candle: ${(data.candle*100).toFixed(0)}% | ATR: ${data.atrPct.toFixed(1)}%\n   Vol: $${(turnover/1e6).toFixed(1)}M\n   <i>Quasi pronto → manca 1-2 conferme perps</i>`;
    if (isCounterRegime) extra += `\n   ⚔️ CONTRO-REGIME BTC`;

    const levelText = isLong ? `PRE LONG` : `PRE SHORT`;
    const type = category === 'linear' ? 'Perps' : (isBybit ? 'Spot Bybit' : 'Spot Binance');

    return {
      score: preScore,
      details: `⚡ <b>PRE-EXPLOSION ${symbol}</b> — ${levelText} (${type})\n   Pre-Score: <b>${preScore.toFixed(0)}</b>\n${extra}`,
      isLong,
      level: 'PRE',
      type: 'PRE'
    };
  }

  return null;
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
      ? `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=15&limit=${CONFIG.CONSOLIDATION_KLINES}`
      : `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=${CONFIG.CONSOLIDATION_KLINES}`;
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
    const res = await axios.get(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${CONFIG.BOOK_DEPTH_LIMIT}`, { timeout: 10000 });
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

// ====================== SCAN SPOT ======================
async function scanSpotExchange(isBybit) {
  const fullSignals = { ULTRA: [], SUPER: [], BIG: [] };
  const preSignals = [];
  const preProcessed = new Set();

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
          if (signal.type === 'FULL') {
            fullSignals[levelKey].push(signal);
            updateCooldown(symbol, levelKey, signal.score, isBybit, false);
            break;
          } else if (signal.type === 'PRE' && !preProcessed.has(symbol) && checkCooldownPre(symbol)) {
            preSignals.push(signal);
            preProcessed.add(symbol);
            updateCooldownPre(symbol, signal.score, isBybit, false);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Errore scan spot ${isBybit ? 'Bybit' : 'Binance'}:`, err.message);
  }
  return { fullSignals, preSignals };
}

// ====================== SCAN PERPS ======================
async function scanPerpsBybit() {
  const fullSignals = { ULTRA: [], SUPER: [], BIG: [] };
  const preSignals = [];
  const preProcessed = new Set();

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

      const perpsKey = `${symbol}-perps`;
      for (const levelKey of ['ULTRA', 'SUPER', 'BIG']) {
        if (!checkCooldown(perpsKey, levelKey)) continue;

        const signal = await analyzeSignal(symbol, cvd, bookImb, pricePct, turnover, true, levelKey, 'linear');
        if (signal) {
          if (signal.type === 'FULL') {
            fullSignals[levelKey].push(signal);
            updateCooldown(perpsKey, levelKey, signal.score, true, true);
            break;
          } else if (signal.type === 'PRE' && !preProcessed.has(perpsKey) && checkCooldownPre(perpsKey)) {
            preSignals.push(signal);
            preProcessed.add(perpsKey);
            updateCooldownPre(perpsKey, signal.score, true, true);
          }
        }
      }
    }
  } catch (err) {
    console.error('Errore scan Perps Bybit:', err.message);
  }
  return { fullSignals, preSignals };
}

// ====================== MAIN ======================
async function mainScan() {
  console.log(`[${new Date().toLocaleTimeString('it-IT')}] REVERSAL EXPLOSION v11.5 Regime Balanced - CVD DIRECTION LOCK avviato...`);
  cleanupOldSignals();
  cleanupOldPreSignals();

  const bybitSpotResult = await scanSpotExchange(true);
  const binanceSpotResult = await scanSpotExchange(false);
  const bybitPerpsResult = await scanPerpsBybit();

  const finalSignals = { ULTRA: [], SUPER: [], BIG: [] };
  const finalPerps = { ULTRA: [], SUPER: [], BIG: [] };

  for (const level of ['ULTRA', 'SUPER', 'BIG']) {
    const allSpot = [...(bybitSpotResult.fullSignals[level] || []), ...(binanceSpotResult.fullSignals[level] || [])];
    allSpot.sort((a, b) => b.score - a.score);
    finalSignals[level] = allSpot.slice(0, CONFIG.MAX_SIGNALS_PER_LEVEL);

    const allPerpsLevel = bybitPerpsResult.fullSignals[level] || [];
    allPerpsLevel.sort((a, b) => b.score - a.score);
    finalPerps[level] = allPerpsLevel.slice(0, CONFIG.MAX_SIGNALS_PER_LEVEL);
  }

  let allPre = [...(bybitSpotResult.preSignals || []), ...(binanceSpotResult.preSignals || []), ...(bybitPerpsResult.preSignals || [])];
  allPre.sort((a, b) => b.score - a.score);
  const finalPre = allPre.slice(0, 8);

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

  if (finalPre.length) {
    content += `⚡ === PRE-EXPLOSIONS (opportunità in costruzione) ===\n\n${finalPre.map(s => s.details).join('\n\n')}\n\n`;
  }

  if (content.trim().length > 30) {
    await sendTelegram(content, '📊 EXPLOSION SCAN v11.5 Regime Balanced - CVD DIRECTION LOCK');
  } else {
    console.log('❌ Nessun segnale');
  }
}

// ====================== AVVIO ======================
console.log(`🚀 REVERSAL EXPLOSION SCANNER v11.5 Regime Balanced avviato ogni ${CONFIG.SCAN_INTERVAL_MIN} min`);
mainScan().catch(err => console.error('Errore avvio:', err.message));
setInterval(() => mainScan().catch(err => console.error('Errore scan:', err.message)), CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
