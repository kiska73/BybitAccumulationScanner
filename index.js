const axios = require("axios");

// =============================
// CONFIGURAZIONE
// =============================
const CONFIG = {
  SCAN_INTERVAL_MIN: 20,
  MIN_TURNOVER_USDT: 2_000_000,
  ORDERBOOK_DEPTH: 200,
  CVD_TRADES_LIMIT: 1000,
  REQUEST_TIMEOUT_MS: 10000,
  SLEEP_BETWEEN_SYMBOLS_MS: 800,     // più lento → più gentile con le API
  SLEEP_BETWEEN_BATCHES_MS: 2000,
};

// =============================
// TELEGRAM
// =============================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

async function sendTelegramMessage(text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "HTML",
      },
      { timeout: 8000 }
    );
  } catch (err) {
    console.error("Errore invio Telegram:", err.message);
  }
}

// =============================
// UTILITÀ
// =============================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const axiosInstance = axios.create({
  timeout: CONFIG.REQUEST_TIMEOUT_MS,
});

// =============================
// FUNZIONI DI DATO
// =============================
async function getCVD(symbol) {
  try {
    const res = await axiosInstance.get(
      `https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=${CONFIG.CVD_TRADES_LIMIT}`
    );
    let delta = 0;
    let totalVolume = 0;

    for (const trade of res.data) {
      const qty = parseFloat(trade.qty);
      totalVolume += qty;
      delta += trade.isBuyerMaker ? -qty : qty;
    }

    return totalVolume > 0 ? delta / totalVolume : 0;
  } catch (err) {
    console.log(`${symbol} → CVD error: ${err.message}`);
    return 0;
  }
}

async function getOrderbookImbalance(symbol) {
  try {
    const res = await axiosInstance.get(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`
    );

    let bidsVolume = 0;
    let asksVolume = 0;

    for (const bid of res.data.bids) bidsVolume += parseFloat(bid[1]);
    for (const ask of res.data.asks) asksVolume += parseFloat(ask[1]);

    const total = bidsVolume + asksVolume;
    const imbalance = total > 0 ? (bidsVolume - asksVolume) / total : 0;

    return {
      imbalance,
      bids: bidsVolume,
      asks: asksVolume,
    };
  } catch (err) {
    console.log(`${symbol} → Orderbook error: ${err.message}`);
    return { imbalance: 0, bids: 0, asks: 0 };
  }
}

async function getVolatilityPercent(symbol) {
  try {
    const res = await axiosInstance.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=48`
    );

    let highest = -Infinity;
    let lowest = Infinity;

    for (const kline of res.data) {
      const high = parseFloat(kline[2]);
      const low  = parseFloat(kline[3]);
      if (high > highest) highest = high;
      if (low  < lowest)  lowest  = low;
    }

    const range = (highest - lowest) / lowest * 100;
    return isFinite(range) ? range : 100;
  } catch {
    return 100;
  }
}

async function getLatestFundingRate(symbol) {
  try {
    const res = await axiosInstance.get(
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`
    );
    return parseFloat(res.data.result.list[0].fundingRate) || 0;
  } catch {
    return 0;
  }
}

async function getOIChangePercent(symbol) {
  try {
    const res = await axiosInstance.get(
      `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=2`
    );

    const current = parseFloat(res.data.result.list[0].openInterest);
    const previous = parseFloat(res.data.result.list[1].openInterest);

    return previous > 0 ? (current - previous) / previous * 100 : 0;
  } catch {
    return 0;
  }
}

// =============================
// DETECTION RULES
// =============================
function detectLiquidityWall(book) {
  const ratio = Math.max(book.bids, book.asks) / Math.min(book.bids, book.asks);
  return ratio > 3 ? "LIQUIDITY WALL" : null;
}

function detectSpoofing(book) {
  return Math.abs(book.imbalance) > 0.9 ? "SPOOFING SUSPECTED" : null;
}

function detectWhaleAbsorption(cvd, rangePercent) {
  return Math.abs(cvd) > 0.2 && rangePercent < 2 ? "WHALE ABSORPTION" : null;
}

function detectSqueezeRisk(funding, oiChange, cvd) {
  if (funding > 0.001 && oiChange > 2 && cvd < 0) return "LONG SQUEEZE RISK";
  if (funding < -0.001 && oiChange > 2 && cvd > 0) return "SHORT SQUEEZE RISK";
  return null;
}

// =============================
// SCORING
// =============================
function calculateScore(data) {
  let score = 0;
  score += Math.abs(data.cvd)          * 40;
  score += Math.abs(data.book)          * 30;
  score += Math.max(0, 20 - data.range) * 1.5;
  score += Math.abs(data.oiChange)      * 5;
  if (data.funding < 0) score += 5;

  return Math.min(100, score);
}

function classifyScore(score) {
  if (score > 85) return "EXPLOSION";
  if (score > 65) return "BUILDING";
  if (score > 45) return "ACCUMULATION";
  return null;
}

// =============================
// FORMATTING
// =============================
function formatSignal(r) {
  let msg = `<b>${r.symbol}</b>\n`;
  msg += `${r.type}\n`;
  msg += `Score: <b>${r.score.toFixed(0)}</b>\n`;
  msg += `CVD: ${(r.cvd * 100).toFixed(1)}%\n`;
  msg += `Book: ${(r.book * 100).toFixed(1)}%\n`;
  msg += `OI Δ: ${r.oiChange.toFixed(1)}%\n`;
  msg += `Funding: ${r.funding.toFixed(5)}\n`;

  if (r.squeeze) msg += `${r.squeeze}\n`;
  if (r.whale)   msg += `${r.whale}\n`;
  if (r.wall)    msg += `${r.wall}\n`;
  if (r.spoof)   msg += `${r.spoof}\n`;

  msg += "\n";
  return msg;
}

// =============================
// SCAN PRINCIPALE
// =============================
async function performScan() {
  console.log(`[${new Date().toISOString()}] Inizio scan...`);

  let tickers;
  try {
    const res = await axiosInstance.get("https://api.binance.com/api/v3/ticker/24hr");
    tickers = res.data;
  } catch (err) {
    console.error("Impossibile scaricare tickers:", err.message);
    return [];
  }

  const candidates = tickers
    .filter(t => t.symbol.endsWith("USDT"))
    .filter(t => parseFloat(t.quoteVolume) >= CONFIG.MIN_TURNOVER_USDT)
    .map(t => t.symbol);

  console.log(`Trovati ${candidates.length} simboli con volume ≥ ${CONFIG.MIN_TURNOVER_USDT}`);

  const results = [];

  for (const symbol of candidates) {
    try {
      const [cvd, book, range, funding, oiChange] = await Promise.all([
        getCVD(symbol),
        getOrderbookImbalance(symbol),
        getVolatilityPercent(symbol),
        getLatestFundingRate(symbol),
        getOIChangePercent(symbol),
      ]);

      const data = {
        cvd: cvd,
        book: book.imbalance,
        range: range,
        funding: funding,
        oiChange: oiChange,
      };

      const score = calculateScore(data);
      const type = classifyScore(score);

      if (!type) {
        await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
        continue;
      }

      const signal = {
        symbol,
        score,
        type,
        cvd,
        book: book.imbalance,
        range,
        funding,
        oiChange,
        squeeze: detectSqueezeRisk(funding, oiChange, cvd),
        whale: detectWhaleAbsorption(cvd, range),
        wall: detectLiquidityWall(book),
        spoof: detectSpoofing(book),
      };

      results.push(signal);

      console.log(`${symbol} → ${type} (score ${score.toFixed(0)})`);
    } catch (err) {
      console.log(`${symbol} → errore generico: ${err.message}`);
    }

    await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 10);
}

// =============================
// MAIN LOOP
// =============================
async function main() {
  const signals = await performScan();

  if (signals.length > 0) {
    let message = "<b>REVERSAL EXPLOSION SCAN</b>\n\n";
    for (const sig of signals) {
      message += formatSignal(sig);
    }
    await sendTelegramMessage(message);
    console.log(`Inviato ${signals.length} segnali`);
  } else {
    console.log("Nessun segnale significativo");
  }
}

// Avvia subito e poi ogni X minuti
main();

setInterval(main, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
