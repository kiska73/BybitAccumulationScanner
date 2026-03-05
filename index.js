const axios = require("axios");

// ============================= CONFIG =============================
const CONFIG = {
  SCAN_INTERVAL_MIN: 35,
  MIN_QUOTE_VOLUME_USDT: 2_000_000,
  KLINE_INTERVAL: "5m",
  KLINE_LIMIT: 48,                     // 4 ore esatte
  MAX_RANGE_PCT: 2.2,
  MIN_IMBALANCE_ONE_EXCHANGE_PCT: 68,
  MIN_IMBALANCE_OTHER_PCT: 52,
  MIN_BUY_PRESSURE_PCT: 60,
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

    if (price >= 1) {
      groupedPrice = Math.floor(price * 10) / 10;           // 123.45 → 123.4
    } else if (price >= 0.1) {
      groupedPrice = Math.floor(price * 100) / 100;         // 1.2345 → 1.23
    } else if (price >= 0.01) {
      groupedPrice = Math.floor(price * 1000) / 1000;       // 0.12345 → 0.123
    } else if (price >= 0.001) {
      groupedPrice = Math.floor(price * 10000) / 10000;     // 0.012345 → 0.0123
    } else if (price >= 0.0001) {
      groupedPrice = Math.floor(price * 10000) / 10000;     // 0.00012345 → 0.0001  ← quello che volevi
    } else if (price >= 0.00001) {
      groupedPrice = Math.floor(price * 100000) / 100000;
    } else {
      groupedPrice = Math.floor(price * 1000000) / 1000000;
    }

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

    // RAGGRUPPAMENTO CON 1 DECIMALE IN MENO
    const bids = aggregateLevels(rawBids, true);
    const asks = aggregateLevels(rawAsks, false);

    let bidValue = 0, askValue = 0, largestBidValue = 0;

    bids.forEach(([p, v]) => {
      bidValue += v;
      if (v > largestBidValue) largestBidValue = v;
    });

    asks.forEach(([p, v]) => {
      askValue += v;
    });

    const totalValue = bidValue + askValue;
    const imbalancePct = totalValue > 0 ? (bidValue / totalValue) * 100 : 0;
    const largestBidPct = totalValue > 0 ? (largestBidValue / totalValue) * 100 : 0;

    return {
      imbalancePct: Math.min(imbalancePct, 99.9),
      largestBidPct,
      largestBidValue: Math.round(largestBidValue),
      totalValue: Math.round(totalValue)
    };
  } catch (err) {
    console.error(`Orderbook error ${symbol} (${exchange}):`, err.message);
    return {
      imbalancePct: 0,
      largestBidPct: 0,
      largestBidValue: 0,
      totalValue: 0
    };
  }
}

async function getBuyPressurePct(symbol) {
  try {
    const { data } = await ax.get(
      `https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=${CONFIG.CVD_TRADES_LIMIT}`
    );
    let buyVol = 0, totalVol = 0;
    for (const t of data) {
      const qty = parseFloat(t.qty);
      totalVol += qty;
      if (!t.isBuyerMaker) buyVol += qty;
    }
    return totalVol > 0 ? (buyVol / totalVol) * 100 : 0;
  } catch {
    return 0;
  }
}

function calculateScore(rangePct, imbBin, imbByb, buyPct, maxLargestBidPct, maxLargestBidValue) {
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

  if      (buyPct >= 66)     score += 25;
  else if (buyPct >= 62)     score += 20;
  else if (buyPct >= 58)     score += 14;

  if (maxLargestBidPct >= CONFIG.WALL_BONUS_THRESHOLD_PCT && 
      maxLargestBidValue >= CONFIG.MIN_WALL_VALUE_USDT) {
    score += 8;
  }

  return Math.min(score, 100);
}

function getLevel(score) {
  if (score >= 85) return "NUCLEARE 🚀🚀🚀";
  if (score >= 70) return "OTTIMO 🚀🚀";
  if (score >= 55) return "BUONO 🚀";
  return null;
}

// ============================= SCAN =============================
async function scan() {
  console.log(`[SCAN ${new Date().toISOString()}] Ricerca accumulo spot + bid wall`);

  const symbols = await getHighVolumeSymbols();
  console.log(`→ ${symbols.length} simboli volume OK`);

  const signals = [];

  for (const symbol of symbols) {
    const [rangePct, binanceBook, bybitBook, buyPct] = await Promise.all([
      get4hRangePercent(symbol),
      getOrderbookData("binance", symbol),
      getOrderbookData("bybit", symbol),
      getBuyPressurePct(symbol),
    ]);

    await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);

    if (rangePct > CONFIG.MAX_RANGE_PCT) continue;

    const maxImb = Math.max(binanceBook.imbalancePct, bybitBook.imbalancePct);
    const minImb = Math.min(binanceBook.imbalancePct, bybitBook.imbalancePct);

    if (maxImb < CONFIG.MIN_IMBALANCE_ONE_EXCHANGE_PCT) continue;
    if (minImb < CONFIG.MIN_IMBALANCE_OTHER_PCT) continue;

    if (buyPct < CONFIG.MIN_BUY_PRESSURE_PCT) continue;

    const maxLargestBidPct  = Math.max(binanceBook.largestBidPct, bybitBook.largestBidPct);
    const maxLargestBidValue = Math.max(binanceBook.largestBidValue, bybitBook.largestBidValue);

    const score = calculateScore(
      rangePct,
      binanceBook.imbalancePct,
      bybitBook.imbalancePct,
      buyPct,
      maxLargestBidPct,
      maxLargestBidValue
    );

    const level = getLevel(score);

    if (level) {
      const strongExchange = binanceBook.imbalancePct > bybitBook.imbalancePct ? "Binance" : "Bybit";
      const strongImbValue = Math.max(binanceBook.imbalancePct, bybitBook.imbalancePct);

      signals.push({
        symbol,
        score,
        level,
        rangePct,
        imbBin: binanceBook.imbalancePct,
        imbByb: bybitBook.imbalancePct,
        buyPct,
        strongExchange,
        strongImbValue,
        maxLargestBidPct,
        maxLargestBidValue
      });
    }
  }

  if (signals.length === 0) {
    console.log("Nessun segnale valido");
    return;
  }

  signals.sort((a, b) => b.score - a.score);

  let msg = `<b>ACCUMULO SPOT</b>\n\n`;

  for (const s of signals.slice(0, 10)) {
    msg += `<b>${s.symbol}</b> ${s.level}\n`;
    msg += `Score: <b>${s.score}</b>\n`;
    msg += `Range 4h: <b>${s.rangePct.toFixed(2)}%</b>\n`;
    msg += `Bid Binance: <b>${s.imbBin.toFixed(1)}%</b>\n`;
    msg += `Bid Bybit:   <b>${s.imbByb.toFixed(1)}%</b>\n`;
    msg += `Book più forte: ${s.strongExchange} (${s.strongImbValue.toFixed(1)}%)\n`;
    msg += `Market Buy:  <b>${s.buyPct.toFixed(1)}%</b>\n`;

    if (s.maxLargestBidPct >= CONFIG.WALL_BONUS_THRESHOLD_PCT) {
      msg += `Largest bid wall: <b>${s.maxLargestBidPct.toFixed(1)}%</b> (~$${Math.round(s.maxLargestBidValue).toLocaleString()}) — <i>absorption forte</i>\n`;
    }
    msg += `\n`;
  }

  await sendTelegram(msg);
  console.log(`→ Inviati ${signals.length} segnali`);
}

// ============================= AVVIO =============================
scan();
setInterval(scan, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
