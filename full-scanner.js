const axios = require('axios');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID = '820279313';

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 ore
const LAST_FILE = './last_signals.json';

let lastSignals = {};
if (fs.existsSync(LAST_FILE)) {
  try { lastSignals = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch (e) {}
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
    console.log(🧹 Puliti ${cleaned} segnali vecchi dal JSON);
  }
}

const CONFIG = {
  PRICE_MAX_PCT_PERP: 1.8,
  PRICE_MAX_PCT_SPOT: 2.0,
  TURNOVER_MIN: 250000,
  OI_MIN: 2.0,
  CVD_MIN_PERP: 0.04,
  CVD_MIN_SPOT: 0.08,
  BOOK_MIN_IMB: 0.05,
  MAX_SIGNALS_PER_TYPE: 10,
  SCAN_INTERVAL_MIN: 30
};

// ====================== TELEGRAM ======================
async function sendTelegram(content, title) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.includes('INSERISCI')) {
    console.log('⚠️ Token Telegram non configurato');
    return;
  }
  const header = <b>🚀 ${title} - ${new Date().toLocaleString('it-IT')}</b>\n\n;
  try {
    await axios.post(https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage, {
      chat_id: TELEGRAM_CHAT_ID,
      text: header + content,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
  } catch (e) { console.log('Errore Telegram:', e.message); }
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
  if (score >= 85) return { emoji: '🔥🔥🔥', text: 'SUPER SQUEEZE (90%+)' };
  if (score >= 70) return { emoji: '📈📈', text: 'FORTE (70-89%)' };
  if (score >= 50) return { emoji: '📈', text: 'BUONO (50-69%)' };
  return { emoji: '👀', text: 'DA TENERE D’OCCHIO' };
}

function calculateScore(oiOrCvd, bookImb, pricePct, isPerp) {
  const base = isPerp ? oiOrCvd * 1.45 : oiOrCvd * 2.2;
  return Math.min(100, Math.max(0,
    base +
    bookImb * 95 +
    (isPerp ? CONFIG.PRICE_MAX_PCT_PERP : CONFIG.PRICE_MAX_PCT_SPOT) - Math.abs(pricePct) * 100
  ));
}

// ====================== BYBIT PERPETUAL ======================
async function scanBybitPerp() {
  const signals = [];
  try {
    const tickers = (await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', { timeout: 10000 })).data.result.list || [];
    for (const t of tickers) {
      const symbol = t.symbol;
      if (!symbol.endsWith('USDT') || !checkCooldown(symbol)) continue;

      const pricePct = parseFloat(t.price24hPcnt);
      const funding = parseFloat(t.fundingRate);
      const turnover = parseFloat(t.turnover24h || 0);
      if (Math.abs(pricePct) >= CONFIG.PRICE_MAX_PCT_PERP / 100 || funding > 0 || turnover < CONFIG.TURNOVER_MIN) continue;

      const oiPct = await getOiChange(symbol);
      if (oiPct < CONFIG.OI_MIN) continue;

      const cvd = await getCvdBybit(symbol, true);
      if (cvd < CONFIG.CVD_MIN_PERP) continue;

      const bookImb = await getBookImbBybit(symbol, true);
      if (bookImb < CONFIG.BOOK_MIN_IMB) continue;

      const score = calculateScore(oiPct, bookImb, pricePct, true);
      const level = getLevel(score);

      const details = \( {level.emoji} <b><a href="https://www.bybit.com/trade/usdt/ \){symbol}">${symbol}</a></b> — ${level.text}\n +
                      `   Score: <b>${score.toFixed(0)}/100</b>\n` +
                      `   OI 1h: +${oiPct.toFixed(2)}% | CVD: ${(cvd*100).toFixed(1)}% | Book: ${(bookImb*100).toFixed(1)}%\n` +
                      `   Prezzo 24h: ${pricePct.toFixed(2)}% | Vol: \[ {(turnover/1e6).toFixed(1)}M`;

      signals.push(details);
      updateCooldown(symbol);
      if (signals.length >= CONFIG.MAX_SIGNALS_PER_TYPE) break;
    }
  } catch (e) { console.log('Errore Bybit Perp:', e.message); }
  return signals;
}

// ====================== BYBIT SPOT ======================
async function scanBybitSpot() {
  const signals = [];
  try {
    const tickers = (await axios.get('https://api.bybit.com/v5/market/tickers?category=spot', { timeout: 10000 })).data.result.list || [];
    for (const t of tickers) {
      const symbol = t.symbol;
      if (!symbol.endsWith('USDT') || !checkCooldown(symbol)) continue;

      const pricePct = parseFloat(t.price24hPcnt);
      const turnover = parseFloat(t.turnover24h || 0);
      if (Math.abs(pricePct) * 100 > CONFIG.PRICE_MAX_PCT_SPOT || turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = await getCvdBybit(symbol, false);
      if (cvd < CONFIG.CVD_MIN_SPOT) continue;

      const bookImb = await getBookImbBybit(symbol, false);
      if (bookImb < CONFIG.BOOK_MIN_IMB) continue;

      const score = calculateScore(cvd, bookImb, pricePct, false);
      const level = getLevel(score);

      const details = \( {level.emoji} <b><a href="https://www.bybit.com/trade/spot/ \){symbol}">${symbol}</a></b> — ${level.text}\n +
                      `   Score: <b>${score.toFixed(0)}/100</b>\n` +
                      `   CVD: ${(cvd*100).toFixed(1)}% | Book: ${(bookImb*100).toFixed(1)}% | Vol: \]{(turnover/1e6).toFixed(1)}M`;

      signals.push(details);
      updateCooldown(symbol);
      if (signals.length >= CONFIG.MAX_SIGNALS_PER_TYPE) break;
    }
  } catch (e) { console.log('Errore Bybit Spot:', e.message); }
  return signals;
}

// ====================== BINANCE SPOT ======================
async function scanBinanceSpot() {
  const signals = [];
  try {
    const tickers = (await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 10000 })).data.filter(t => t.symbol.endsWith('USDT'));
    for (const t of tickers) {
      const symbol = t.symbol;
      if (!checkCooldown(symbol)) continue;

      const pricePct = parseFloat(t.priceChangePercent) / 100;
      const turnover = parseFloat(t.quoteVolume);
      if (Math.abs(pricePct) * 100 > CONFIG.PRICE_MAX_PCT_SPOT || turnover < CONFIG.TURNOVER_MIN) continue;

      const cvd = await getCvdBinance(symbol);
      if (cvd < CONFIG.CVD_MIN_SPOT) continue;

      const bookImb = await getBookImbBinance(symbol);
      if (bookImb < CONFIG.BOOK_MIN_IMB) continue;

      const score = calculateScore(cvd, bookImb, pricePct, false);
      const level = getLevel(score);

      const details = \( {level.emoji} <b><a href="https://www.binance.com/trade/ \){symbol}?layout=pro">${symbol}</a></b> — ${level.text}\n +
                      `   Score: <b>${score.toFixed(0)}/100</b>\n` +
                      `   CVD: ${(cvd*100).toFixed(1)}% | Book: ${(bookImb*100).toFixed(1)}% | Vol: $${(turnover/1e6).toFixed(1)}M`;

      signals.push(details);
      updateCooldown(symbol);
      if (signals.length >= CONFIG.MAX_SIGNALS_PER_TYPE) break;
    }
  } catch (e) { console.log('Errore Binance Spot:', e.message); }
  return signals;
}

// ====================== HELPER API ======================
async function getOiChange(symbol) {
  const res = await axios.get(https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=3, { timeout: 8000 });
  const lst = res.data.result.list || [];
  if (lst.length < 2) return 0;
  const now = parseFloat(lst[0].openInterest);
  const prev = parseFloat(lst[1].openInterest);
  return prev > 0 ? (now - prev) / prev * 100 : 0;
}

async function getCvdBybit(symbol, isPerp) {
  const cat = isPerp ? 'linear' : 'spot';
  const res = await axios.get(https://api.bybit.com/v5/market/recent-trade?category=\( {cat}&symbol= \){symbol}&limit=500, { timeout: 8000 });
  const trades = res.data.result.list || [];
  let delta = 0, total = 0;
  for (const t of trades) {
    const size = parseFloat(t.size);
    total += size;
    delta += t.side === 'Buy' ? size : -size;
  }
  return total > 0 ? delta / total : 0;
}

async function getBookImbBybit(symbol, isPerp) {
  const cat = isPerp ? 'linear' : 'spot';
  const res = await axios.get(https://api.bybit.com/v5/market/orderbook?category=\( {cat}&symbol= \){symbol}&limit=20, { timeout: 8000 });
  const d = res.data.result;
  let bids = 0, asks = 0;
  const len = Math.min(20, d.b?.length || 0, d.a?.length || 0);
  for (let i = 0; i < len; i++) {
    bids += parseFloat(d.b[i][1]);
    asks += parseFloat(d.a[i][1]);
  }
  const total = bids + asks;
  return total > 0 ? (bids - asks) / total : 0;
}

async function getCvdBinance(symbol) {
  const res = await axios.get(https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=500, { timeout: 8000 });
  const trades = res.data;
  let delta = 0, total = 0;
  for (const t of trades) {
    const q = parseFloat(t.qty);
    total += q;
    delta += t.isBuyerMaker ? -q : q;
  }
  return total > 0 ? delta / total : 0;
}

async function getBookImbBinance(symbol) {
  const res = await axios.get(https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20, { timeout: 8000 });
  const d = res.data;
  let bids = 0, asks = 0;
  const len = Math.min(20, d.bids.length, d.asks.length);
  for (let i = 0; i < len; i++) {
    bids += parseFloat(d.bids[i][1]);
    asks += parseFloat(d.asks[i][1]);
  }
  const total = bids + asks;
  return total > 0 ? (bids - asks) / total : 0;
}

// ====================== MAIN SCAN ======================
async function mainScan() {
  console.log([${new Date().toLocaleTimeString('it-IT')}] Full scan avviato...);
  cleanupOldSignals();

  const perpSignals = await scanBybitPerp();
  if (perpSignals.length) await sendTelegram(perpSignals.join('\n\n'), 'BYBIT PERPETUAL SQUEEZE');

  const bybitSpotSignals = await scanBybitSpot();
  if (bybitSpotSignals.length) await sendTelegram(bybitSpotSignals.join('\n\n'), 'BYBIT SPOT SQUEEZE');

  const binanceSignals = await scanBinanceSpot();
  if (binanceSignals.length) await sendTelegram(binanceSignals.join('\n\n'), 'BINANCE SPOT SQUEEZE');

  if (!perpSignals.length && !bybitSpotSignals.length && !binanceSignals.length) {
    console.log('Nessun segnale valido in questo scan');
  }
}

// ====================== AVVIO ======================
console.log(🚀 FULL SCANNER v3.0 (Perp + Spot Bybit + Binance) avviato - ogni ${CONFIG.SCAN_INTERVAL_MIN} minuti);
mainScan(); // primo scan immediato

setInterval(() => {
  mainScan().catch(err => console.log('Errore generale scan:', err.message));
}, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
