const axios = require("axios");

// =============================
// CONFIG
// =============================

const CONFIG = {

  SCAN_INTERVAL_MIN: 20,
  MIN_TURNOVER_USDT: 2_000_000,

  ORDERBOOK_DEPTH: 200,
  CVD_TRADES_LIMIT: 1000,

  REQUEST_TIMEOUT_MS: 10000,

  SLEEP_BETWEEN_SYMBOLS_MS: 700

};

// =============================
// TELEGRAM
// =============================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s'; 
const TELEGRAM_CHAT_ID = '820279313';

async function sendTelegramMessage(text) {

  try {

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "HTML"
      }
    );

  } catch (err) {

    console.log("Telegram error:", err.message);

  }

}

// =============================
// UTILS
// =============================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const axiosInstance = axios.create({
  timeout: CONFIG.REQUEST_TIMEOUT_MS
});

// =============================
// MEMORIA SEGNALI
// =============================

const activeSignals = new Map();

// =============================
// FILTRO STABLE
// =============================

const STABLES = [
  "USDC",
  "BUSD",
  "FDUSD",
  "TUSD",
  "USDP",
  "DAI",
  "UST",
  "USTC",
  "USDD"
];

// =============================
// DATA FUNCTIONS
// =============================

async function getCVD(symbol) {

  try {

    const res = await axiosInstance.get(
      `https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=${CONFIG.CVD_TRADES_LIMIT}`
    );

    let delta = 0;
    let total = 0;

    for (const t of res.data) {

      const qty = parseFloat(t.qty);

      total += qty;

      delta += t.isBuyerMaker ? -qty : qty;

    }

    return total > 0 ? delta / total : 0;

  } catch {

    return 0;

  }

}

// =============================

async function getOrderbookImbalance(symbol) {

  try {

    const res = await axiosInstance.get(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`
    );

    let bids = 0;
    let asks = 0;

    for (const b of res.data.bids) bids += parseFloat(b[1]);
    for (const a of res.data.asks) asks += parseFloat(a[1]);

    const total = bids + asks;

    const imbalance = total > 0 ? (bids - asks) / total : 0;

    return { imbalance, bids, asks };

  } catch {

    return { imbalance: 0, bids: 0, asks: 0 };

  }

}

// =============================

async function getVolatilityPercent(symbol) {

  try {

    const res = await axiosInstance.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=48`
    );

    let high = -Infinity;
    let low = Infinity;

    for (const k of res.data) {

      const h = parseFloat(k[2]);
      const l = parseFloat(k[3]);

      if (h > high) high = h;
      if (l < low) low = l;

    }

    return ((high - low) / low) * 100;

  } catch {

    return 0;

  }

}

// =============================

async function getFunding(symbol) {

  try {

    const res = await axiosInstance.get(
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`
    );

    return parseFloat(res.data.result.list[0].fundingRate);

  } catch {

    return 0;

  }

}

// =============================

async function getOIChange(symbol) {

  try {

    const res = await axiosInstance.get(
      `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=2`
    );

    const cur = parseFloat(res.data.result.list[0].openInterest);
    const prev = parseFloat(res.data.result.list[1].openInterest);

    return prev > 0 ? ((cur - prev) / prev) * 100 : 0;

  } catch {

    return 0;

  }

}

// =============================
// SCORE
// =============================

function calculateScore(data) {

  let score = 0;

  score += Math.abs(data.cvd) * 45;
  score += Math.abs(data.book) * 25;
  score += Math.abs(data.oiChange) * 12;

  if (data.oiChange > 3) score += 6;
  if (Math.abs(data.cvd) > 0.35) score += 6;
  if (Math.abs(data.book) > 0.25) score += 4;

  if (data.funding < 0) score += 3;

  return Math.min(score, 100);

}

// =============================
// CLASSIFY
// =============================

function classify(score) {

  if (score > 85) return "EXPLOSION";
  if (score > 70) return "BUILDING";
  if (score > 60) return "ACCUMULATION";

  return null;

}

// =============================
// FORMAT
// =============================

function formatSignal(s) {

  let msg = `<b>${s.symbol}</b>\n`;

  msg += `${s.type}\n`;
  msg += `Score: <b>${s.score.toFixed(0)}</b>\n`;
  msg += `CVD: ${(s.cvd * 100).toFixed(1)}%\n`;
  msg += `Book: ${(s.book * 100).toFixed(1)}%\n`;
  msg += `OI Δ: ${s.oiChange.toFixed(1)}%\n`;
  msg += `Funding: ${s.funding.toFixed(5)}\n\n`;

  return msg;

}

// =============================
// SCAN
// =============================

async function performScan() {

  console.log("Starting scan");

  const res = await axiosInstance.get(
    "https://api.binance.com/api/v3/ticker/24hr"
  );

  const tickers = res.data;

  const symbols = tickers
    .filter(t => t.symbol.endsWith("USDT"))
    .filter(t => parseFloat(t.quoteVolume) > CONFIG.MIN_TURNOVER_USDT)
    .filter(t => !STABLES.some(s => t.symbol.includes(s)))
    .map(t => t.symbol);

  const results = [];

  for (const symbol of symbols) {

    const [cvd, book, range, funding, oiChange] = await Promise.all([
      getCVD(symbol),
      getOrderbookImbalance(symbol),
      getVolatilityPercent(symbol),
      getFunding(symbol),
      getOIChange(symbol)
    ]);

    // anti noise

    if (Math.abs(cvd) < 0.12) continue;
    if (Math.abs(book.imbalance) < 0.08) continue;
    if (Math.abs(oiChange) < 0.7) continue;
    if (range < 1.2) continue;

    const score = calculateScore({
      cvd,
      book: book.imbalance,
      oiChange,
      funding
    });

    const type = classify(score);

    if (!type) continue;

    const existing = activeSignals.get(symbol);

    if (!existing) {

      activeSignals.set(symbol, {
        updates: 1,
        lastOI: oiChange
      });

      results.push({
        symbol,
        type,
        score,
        cvd,
        book: book.imbalance,
        oiChange,
        funding
      });

    } else {

      if (existing.updates < 10) {

        if (Math.abs(oiChange - existing.lastOI) > 0.5) {

          existing.updates++;

          existing.lastOI = oiChange;

          results.push({
            symbol,
            type: "UPDATE",
            score,
            cvd,
            book: book.imbalance,
            oiChange,
            funding
          });

        }

      }

    }

    await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);

  }

  results.sort((a, b) => b.score - a.score);

  return results.slice(0, 10);

}

// =============================
// MAIN
// =============================

async function main() {

  const signals = await performScan();

  if (signals.length === 0) {

    console.log("No signals");

    return;

  }

  let msg = "<b>REVERSAL EXPLOSION SCAN</b>\n\n";

  for (const s of signals) {

    msg += formatSignal(s);

  }

  await sendTelegramMessage(msg);

}

// =============================

main();

setInterval(
  main,
  CONFIG.SCAN_INTERVAL_MIN * 60 * 1000
);
