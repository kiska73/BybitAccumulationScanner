const axios = require("axios");

// ============================= CONFIG =============================
const CONFIG = {
  SCAN_INTERVAL_MIN: 35,
  MIN_QUOTE_VOLUME_USDT: 2_000_000,
  KLINE_INTERVAL: "15m",
  KLINE_LIMIT: 16,
  MAX_RANGE_PCT: 2.6,
  MIN_IMBALANCE_ONE_EXCHANGE_PCT: 68,
  MIN_IMBALANCE_OTHER_PCT: 52,
  MIN_PRESSURE_PCT: 60,                    // stesso valore per buy e sell pressure
  ORDERBOOK_DEPTH: 50,
  CVD_TRADES_LIMIT: 500,
  MIN_WALL_VALUE_USDT: 30_000,
  WALL_BONUS_THRESHOLD_PCT: 6.0,
  REQUEST_TIMEOUT_MS: 8000,
  SLEEP_BETWEEN_SYMBOLS_MS: 300,
};

// ============================= TELEGRAM =============================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID = '820279313';

async function sendTelegram(text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

// ============================= UTILS =============================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ax = axios.create({ timeout: CONFIG.REQUEST_TIMEOUT_MS });

const STABLES = ["USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USDD"];

// ============================= RAGGRUPPAMENTO BOOK (1 decimale in meno) =============================
function aggregateLevels(levels, isBid = true) {
  const grouped = new Map();

  for (const [priceStr, qtyStr] of levels) {
    let price = parseFloat(priceStr);
    const qty = parseFloat(qtyStr);
    const value = price * qty;

    let groupedPrice;
    if (price >= 1) groupedPrice = Math.floor(price * 10) / 10;
    else if (price >= 0.1) groupedPrice = Math.floor(price * 100) / 100;
    else if (price >= 0.01) groupedPrice = Math.floor(price * 1000) / 1000;
    else if (price >= 0.001) groupedPrice = Math.floor(price * 10000) / 10000;
    else if (price >= 0.0001) groupedPrice = Math.floor(price * 10000) / 10000;
    else groupedPrice = Math.floor(price * 1000000) / 1000000;

    if (!grouped.has(groupedPrice)) grouped.set(groupedPrice, 0);
    grouped.set(groupedPrice, grouped.get(groupedPrice) + value);
  }

  let result = Array.from(grouped, ([price, value]) => [price, value]);
  result.sort((a, b) => isBid ? b[0] - a[0] : a[0] - b[0]);
  return result;
}

// ============================= FUNZIONI DATA =============================
async function getHighVolumeSymbols() {
  try {
    const { data } = await ax.get("https://api.binance.com/api/v3/ticker/24hr");
    return data
      .filter(t => t.symbol.endsWith("USDT"))
      .filter(t => !STABLES.some(s => t.symbol.includes(s)))
      .filter(t => parseFloat(t.quoteVolume) >= CONFIG.MIN_QUOTE_VOLUME_USDT)
      .map(t => t.symbol);
  } catch (err) {
    console.error("Errore tickers:", err.message);
    return [];
  }
}

async function get4hRangePercent(symbol) {
  try {
    const { data } = await ax.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${CONFIG.KLINE_INTERVAL}&limit=${CONFIG.KLINE_LIMIT}`
    );
    if (!data?.length) return 999;

    const highs = data.map(c => parseFloat(c[2]));
    const lows  = data.map(c => parseFloat(c[3]));

    const maxH = Math.max(...highs);
    const minL = Math.min(...lows);

    return minL > 0 ? ((maxH - minL) / minL) * 100 : 999;
  } catch {
    return 999;
  }
}

async function getOrderbookData(exchange, symbol) {
  try {
    let url;
    if (exchange === "binance") {
      url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`;
    } else {
      url = `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`;
    }

    const { data } = await ax.get(url);

    let rawBids = exchange === "binance" ? data.bids : (data.result?.b || []);
    let rawAsks = exchange === "binance" ? data.asks : (data.result?.a || []);

    const bids = aggregateLevels(rawBids, true);
    const asks = aggregateLevels(rawAsks, false);

    let bidValue = 0, askValue = 0, largestBidValue = 0, largestAskValue = 0;

    bids.forEach(([p, v]) => {
      bidValue += v;
      if (v > largestBidValue) largestBidValue = v;
    });

    asks.forEach(([p, v]) => {
      askValue += v;
      if (v > largestAskValue) largestAskValue = v;
    });

    const totalValue = bidValue + askValue;

    return {
      bidImbalancePct: totalValue > 0 ? Math.min((bidValue / totalValue) * 100, 99.9) : 0,
      askImbalancePct: totalValue > 0 ? Math.min((askValue / totalValue) * 100, 99.9) : 0,
      largestBidPct: totalValue > 0 ? (largestBidValue / totalValue) * 100 : 0,
      largestAskPct: totalValue > 0 ? (largestAskValue / totalValue) * 100 : 0,
      largestBidValue: Math.round(largestBidValue),
      largestAskValue: Math.round(largestAskValue),
      totalValue: Math.round(totalValue)
    };
  } catch (err) {
    console.error(`Orderbook error ${symbol} (${exchange}):`, err.message);
    return {
      bidImbalancePct: 0, askImbalancePct: 0,
      largestBidPct: 0, largestAskPct: 0,
      largestBidValue: 0, largestAskValue: 0,
      totalValue: 0
    };
  }
}

async function getTradePressure(symbol) {
  try {
    const { data } = await ax.get(
      `https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=${CONFIG.CVD_TRADES_LIMIT}`
    );
    let buyVol = 0, totalVol = 0;
    for (const t of data) {
      const qty = parseFloat(t.qty);
      totalVol += qty;
      if (!t.isBuyerMaker) buyVol += qty;   // aggressive buy
    }
    const buyPct = totalVol > 0 ? (buyVol / totalVol) * 100 : 0;
    return { buyPct, sellPct: 100 - buyPct };
  } catch {
    return { buyPct: 0, sellPct: 0 };
  }
}

function calculateScore(rangePct, imbBin, imbByb, pressurePct, maxLargestPct, maxLargestValue) {
  let score = 0;

  if      (rangePct <= 0.9)  score += 32;
  else if (rangePct <= 1.3)  score += 27;
  else if (rangePct <= 1.8)  score += 20;

  const maxImb  = Math.max(imbBin, imbByb);
  const avgImb  = (imbBin + imbByb) / 2;

  if      (maxImb >= 85)     score += 34;
  else if (maxImb >= 80)     score += 28;
  else if (maxImb >= 75)     score += 24;
  else if (maxImb >= 72)     score += 20;
  else if (avgImb  >= 68)    score += 16;

  if      (pressurePct >= 66) score += 25;
  else if (pressurePct >= 62) score += 20;
  else if (pressurePct >= 58) score += 14;

  if (maxLargestPct >= CONFIG.WALL_BONUS_THRESHOLD_PCT && 
      maxLargestValue >= CONFIG.MIN_WALL_VALUE_USDT) {
    score += 8;
  }

  return Math.min(score, 100);
}

function getLevel(score, isLong) {
  const emoji = isLong ? "🔥" : "💣";
  if (score >= 85) return `NUCLEARE ${emoji}${emoji}${emoji}`;
  if (score >= 70) return `OTTIMO ${emoji}${emoji}`;
  if (score >= 55) return `BUONO ${emoji}`;
  return null;
}

// ============================= SCAN =============================
async function scan() {
  console.log(`[SCAN ${new Date().toISOString()}] Ricerca accumulo LONG 🔥 + distribuzione SHORT 💣`);

  const symbols = await getHighVolumeSymbols();
  console.log(`→ ${symbols.length} simboli volume OK`);

  const longSignals = [];
  const shortSignals = [];

  for (const symbol of symbols) {
    const [rangePct, binanceBook, bybitBook, pressure] = await Promise.all([
      get4hRangePercent(symbol),
      getOrderbookData("binance", symbol),
      getOrderbookData("bybit", symbol),
      getTradePressure(symbol),
    ]);

    await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);

    if (rangePct > CONFIG.MAX_RANGE_PCT) continue;

    // ====================== LONG (bid wall + buy pressure) ======================
    const maxBidImb = Math.max(binanceBook.bidImbalancePct, bybitBook.bidImbalancePct);
    const minBidImb = Math.min(binanceBook.bidImbalancePct, bybitBook.bidImbalancePct);

    if (maxBidImb >= CONFIG.MIN_IMBALANCE_ONE_EXCHANGE_PCT &&
        minBidImb >= CONFIG.MIN_IMBALANCE_OTHER_PCT &&
        pressure.buyPct >= CONFIG.MIN_PRESSURE_PCT) {

      const maxLargestBidPct  = Math.max(binanceBook.largestBidPct, bybitBook.largestBidPct);
      const maxLargestBidValue = Math.max(binanceBook.largestBidValue, bybitBook.largestBidValue);

      const score = calculateScore(rangePct, binanceBook.bidImbalancePct, bybitBook.bidImbalancePct, pressure.buyPct, maxLargestBidPct, maxLargestBidValue);
      const level = getLevel(score, true);

      if (level) {
        const strongExchange = binanceBook.bidImbalancePct > bybitBook.bidImbalancePct ? "Binance" : "Bybit";
        longSignals.push({
          symbol, score, level, rangePct,
          imbBin: binanceBook.bidImbalancePct,
          imbByb: bybitBook.bidImbalancePct,
          pressure: pressure.buyPct,
          strongExchange,
          maxWallPct: maxLargestBidPct,
          maxWallValue: maxLargestBidValue
        });
      }
    }

    // ====================== SHORT (ask wall + sell pressure) ======================
    const maxAskImb = Math.max(binanceBook.askImbalancePct, bybitBook.askImbalancePct);
    const minAskImb = Math.min(binanceBook.askImbalancePct, bybitBook.askImbalancePct);

    if (maxAskImb >= CONFIG.MIN_IMBALANCE_ONE_EXCHANGE_PCT &&
        minAskImb >= CONFIG.MIN_IMBALANCE_OTHER_PCT &&
        pressure.sellPct >= CONFIG.MIN_PRESSURE_PCT) {

      const maxLargestAskPct  = Math.max(binanceBook.largestAskPct, bybitBook.largestAskPct);
      const maxLargestAskValue = Math.max(binanceBook.largestAskValue, bybitBook.largestAskValue);

      const score = calculateScore(rangePct, binanceBook.askImbalancePct, bybitBook.askImbalancePct, pressure.sellPct, maxLargestAskPct, maxLargestAskValue);
      const level = getLevel(score, false);

      if (level) {
        const strongExchange = binanceBook.askImbalancePct > bybitBook.askImbalancePct ? "Binance" : "Bybit";
        shortSignals.push({
          symbol, score, level, rangePct,
          imbBin: binanceBook.askImbalancePct,
          imbByb: bybitBook.askImbalancePct,
          pressure: pressure.sellPct,
          strongExchange,
          maxWallPct: maxLargestAskPct,
          maxWallValue: maxLargestAskValue
        });
      }
    }
  }

  if (longSignals.length === 0 && shortSignals.length === 0) {
    console.log("Nessun segnale valido");
    return;
  }

  longSignals.sort((a, b) => b.score - a.score);
  shortSignals.sort((a, b) => b.score - a.score);

  let msg = `<b>🔥 ACCUMULO LONG + 💣 SHORT</b>\n\n`;

  // LONG SECTION
  if (longSignals.length > 0) {
    msg += `<b>🔥 LONG (Bid Wall + Buy Pressure)</b>\n\n`;
    for (const s of longSignals.slice(0, 10)) {
      msg += `<b>${s.symbol}</b> ${s.level}\n`;
      msg += `Score: <b>${s.score}</b>\n`;
      msg += `Range 4h: <b>${s.rangePct.toFixed(2)}%</b>\n`;
      msg += `Bid Binance: <b>${s.imbBin.toFixed(1)}%</b>\n`;
      msg += `Bid Bybit:   <b>${s.imbByb.toFixed(1)}%</b>\n`;
      msg += `Book più forte: ${s.strongExchange}\n`;
      msg += `Market Buy:  <b>${s.pressure.toFixed(1)}%</b>\n`;
      if (s.maxWallPct >= CONFIG.WALL_BONUS_THRESHOLD_PCT) {
        msg += `Largest bid wall: <b>${s.maxWallPct.toFixed(1)}%</b> (~$${s.maxWallValue.toLocaleString()}) — <i>absorption forte</i>\n`;
      }
      msg += `\n`;
    }
  }

  // SHORT SECTION
  if (shortSignals.length > 0) {
    if (longSignals.length > 0) msg += `────────────────────\n\n`;
    msg += `<b>💣 SHORT (Ask Wall + Sell Pressure)</b>\n\n`;
    for (const s of shortSignals.slice(0, 10)) {
      msg += `<b>${s.symbol}</b> ${s.level}\n`;
      msg += `Score: <b>${s.score}</b>\n`;
      msg += `Range 4h: <b>${s.rangePct.toFixed(2)}%</b>\n`;
      msg += `Ask Binance: <b>${s.imbBin.toFixed(1)}%</b>\n`;
      msg += `Ask Bybit:   <b>${s.imbByb.toFixed(1)}%</b>\n`;
      msg += `Book più forte: ${s.strongExchange}\n`;
      msg += `Market Sell: <b>${s.pressure.toFixed(1)}%</b>\n`;
      if (s.maxWallPct >= CONFIG.WALL_BONUS_THRESHOLD_PCT) {
        msg += `Largest ask wall: <b>${s.maxWallPct.toFixed(1)}%</b> (~$${s.maxWallValue.toLocaleString()}) — <i>vendita forte</i>\n`;
      }
      msg += `\n`;
    }
  }

  await sendTelegram(msg);
  console.log(`→ Inviati ${longSignals.length} Long 🔥 + ${shortSignals.length} Short 💣`);
}

// ============================= AVVIO =============================
scan();
setInterval(scan, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
