const axios = require("axios");

// ============================= CONFIG =============================
const CONFIG = {
  SCAN_INTERVAL_MIN: 20,
  MIN_TURNOVER_USDT: 1_800_000,      // un po' più permissivo
  ORDERBOOK_DEPTH: 200,
  CVD_TRADES_LIMIT: 1000,
  REQUEST_TIMEOUT_MS: 10000,
  SLEEP_BETWEEN_SYMBOLS_MS: 950,     // ↑ per ridurre rischio ban
  MAX_SYMBOLS_PER_SCAN: 180,         // protezione rate-limit
};

// ============================= TELEGRAM =============================
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

// ============================= UTILS =============================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const axiosInstance = axios.create({ timeout: CONFIG.REQUEST_TIMEOUT_MS });

// ============================= MEMORIA SEGNALI =============================
const activeSignals = new Map();

// ============================= FILTRO STABLE =============================
const STABLES = ["USDC", "BUSD", "FDUSD", "TUSD", "USDP", "DAI", "UST", "USTC", "USDD"];

// ============================= DATA FUNCTIONS =============================
async function getCVD(symbol) {
  try {
    const res = await axiosInstance.get(
      `https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=${CONFIG.CVD_TRADES_LIMIT}`
    );
    let delta = 0, total = 0;
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

async function getOrderbookImbalance(symbol) {
  try {
    const res = await axiosInstance.get(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`
    );
    let bids = 0, asks = 0;
    for (const b of res.data.bids) bids += parseFloat(b[1]);
    for (const a of res.data.asks) asks += parseFloat(a[1]);
    const total = bids + asks;
    const imbalance = total > 0 ? (bids - asks) / total : 0;
    return { imbalance, bids, asks };
  } catch {
    return { imbalance: 0, bids: 0, asks: 0 };
  }
}

async function getVolatilityPercent(symbol) {
  try {
    const res = await axiosInstance.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=48`
    );
    let high = -Infinity, low = Infinity;
    for (const k of res.data) {
      const h = parseFloat(k[2]), l = parseFloat(k[3]);
      if (h > high) high = h;
      if (l < low) low = l;
    }
    return low > 0 ? ((high - low) / low) * 100 : 0;
  } catch {
    return 0;
  }
}

// Bybit – con fallback
async function getFunding(symbol) {
  try {
    const res = await axios.get(
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`,
      { timeout: 6000 }
    );
    return parseFloat(res.data.result?.list?.[0]?.fundingRate ?? 0);
  } catch {
    return 0;
  }
}

async function getOIChange(symbol) {
  try {
    const res = await axios.get(
      `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=2`,
      { timeout: 6000 }
    );
    const list = res.data.result?.list ?? [];
    if (list.length < 2) return 0;
    const cur = parseFloat(list[0].openInterest);
    const prev = parseFloat(list[1].openInterest);
    return prev > 0 ? ((cur - prev) / prev) * 100 : 0;
  } catch {
    return 0;   // ← non blocca più il segnale
  }
}

// ============================= SCORE =============================
function calculateScore(data) {
  let score = 0;

  // pesi base (più equilibrati)
  score += Math.abs(data.cvd)   * 38;
  score += Math.abs(data.book)  * 28;
  score += Math.abs(data.oiChange || 0) * 18;

  // bonus realistici
  if (Math.abs(data.cvd)   > 0.22) score += 8;
  if (Math.abs(data.book)  > 0.18) score += 7;
  if (data.oiChange > 1.8)         score += 9;
  if (data.oiChange > 3.2)         score += 6;   // extra per squeeze veri
  if (data.funding < -0.0005)      score += 5;   // short funding → long squeeze più probabile

  return Math.min(Math.max(score, 0), 100);
}

// ============================= CLASSIFY =============================
function classify(score) {
  if (score > 78) return "EXPLOSION";
  if (score > 62) return "BUILDING";
  if (score > 44) return "ACCUMULATION";
  return null;
}

// ============================= FORMAT =============================
function formatSignal(s) {
  let msg = `<b>${s.symbol}</b>\n`;
  msg += `${s.type}\n`;
  msg += `Score: <b>${s.score.toFixed(0)}</b>\n`;
  msg += `CVD: ${(s.cvd * 100).toFixed(1)}%\n`;
  msg += `Book: ${(s.book * 100).toFixed(1)}%\n`;
  msg += `OI Δ: ${s.oiChange?.toFixed(1) ?? "—"}%\n`;
  msg += `Funding: ${s.funding?.toFixed(5) ?? "—"}%\n\n`;
  return msg;
}

// ============================= SCAN =============================
async function performScan() {
  console.log("Starting scan —", new Date().toISOString());

  let tickers;
  try {
    const res = await axiosInstance.get("https://api.binance.com/api/v3/ticker/24hr");
    tickers = res.data;
  } catch (err) {
    console.error("Cannot fetch tickers", err.message);
    return [];
  }

  let symbols = tickers
    .filter(t => t.symbol.endsWith("USDT"))
    .filter(t => parseFloat(t.quoteVolume) > CONFIG.MIN_TURNOVER_USDT)
    .filter(t => !STABLES.some(s => t.symbol.includes(s)))
    .map(t => t.symbol)
    .slice(0, CONFIG.MAX_SYMBOLS_PER_SCAN);

  console.log(`→ ${symbols.length} symbols to check`);

  const results = [];
  let discardedLowScore = 0;

  for (const symbol of symbols) {
    const [cvd, bookObj, range, funding, oiChange] = await Promise.all([
      getCVD(symbol),
      getOrderbookImbalance(symbol),
      getVolatilityPercent(symbol),
      getFunding(symbol),
      getOIChange(symbol)
    ]);

    const book = bookObj.imbalance;

    // filtri anti-rumore (allentati)
    if (Math.abs(cvd)     < 0.09) continue;
    if (Math.abs(book)    < 0.065) continue;
    if (Math.abs(oiChange || 0) < 0.5 && oiChange !== 0) continue; // 0 è ok (Bybit fallito)
    if (range             < 2.8)  continue;   // ← alzato

    const score = calculateScore({ cvd, book, oiChange, funding });

    // debug – vedi cosa scartiamo
    if (score < 38 && score > 0) {
      discardedLowScore++;
      // console.log(`${symbol.padEnd(12)} | score ${score.toFixed(1)}`.padEnd(30), `cvd ${cvd.toFixed(3)} book ${book.toFixed(3)} oi ${oiChange?.toFixed(2) ?? "—"}`);
    }

    const type = classify(score);
    if (!type) continue;

    const existing = activeSignals.get(symbol);
    if (!existing) {
      activeSignals.set(symbol, { updates: 1, lastOI: oiChange ?? 0 });
      results.push({ symbol, type, score, cvd, book, oiChange, funding });
    } else if (existing.updates < 12) {
      if (Math.abs((oiChange ?? 0) - existing.lastOI) > 0.6) {
        existing.updates++;
        existing.lastOI = oiChange ?? existing.lastOI;
        results.push({ symbol, type: "UPDATE", score, cvd, book, oiChange, funding });
      }
    }

    await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
  }

  if (discardedLowScore > 0) {
    console.log(`→ ${discardedLowScore} simboli scartati per score < 38`);
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 10);
}

// ============================= MAIN =============================
async function main() {
  const signals = await performScan();
  if (signals.length === 0) {
    console.log("No signals this round");
    return;
  }

  let msg = "<b>REVERSAL EXPLOSION SCAN</b>\n\n";
  for (const s of signals) {
    msg += formatSignal(s);
  }

  await sendTelegramMessage(msg);
  console.log(`→ Inviati ${signals.length} segnali`);
}

main();
setInterval(main, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
