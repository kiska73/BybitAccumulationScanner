const axios = require("axios");

// ============================= // CONFIG // =============================
const CONFIG = {
  SCAN_INTERVAL_MIN: 20,
  MIN_TURNOVER_USDT: 2_200_000,
  ORDERBOOK_DEPTH: 200,
  CVD_TRADES_LIMIT: 1000,
  REQUEST_TIMEOUT_MS: 10000,
  SLEEP_BETWEEN_SYMBOLS_MS: 920,
  MAX_SYMBOLS_PER_SCAN: 160
};

// ============================= // TELEGRAM // =============================
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

// ============================= // UTILS // =============================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const axiosInstance = axios.create({ timeout: CONFIG.REQUEST_TIMEOUT_MS });

// ============================= // MEMORIA SEGNALI // =============================
const activeSignals = new Map();

// ============================= // FILTRO STABLE // =============================
const STABLES = ["USDC", "BUSD", "FDUSD", "TUSD", "USDP", "DAI", "UST", "USTC", "USDD"];

// ============================= // DATA FUNCTIONS // =============================
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

async function getFunding(symbol) {
  try {
    const res = await axios.get(
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`,
      { timeout: 6500 }
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
      { timeout: 6500 }
    );
    const list = res.data.result?.list ?? [];
    if (list.length < 2) return 0;
    const cur = parseFloat(list[0].openInterest);
    const prev = parseFloat(list[1].openInterest);
    return prev > 0 ? ((cur - prev) / prev) * 100 : 0;
  } catch {
    return 0;
  }
}

// ============================= // SCORE + DIRECTION // =============================
function calculateScoreAndDirection(cvd, book, oiChange) {
  const absBook = Math.abs(book);
  const absCvd = Math.abs(cvd);
  const absOi = Math.abs(oiChange || 0);

  let score = 0;
  score += absBook * 48;
  score += absCvd * 35;
  score += absOi * 22;

  if (absBook > 0.32) score += 14;
  if (absCvd > 0.24) score += 11;
  if (absOi > 2.2) score += 9;

  const aligned = (book > 0 && cvd > 0) || (book < 0 && cvd < 0);
  if (aligned) score += 12;

  let direction = null;
  if (book > 0.18 && cvd > 0.09 && (oiChange || 0) > 0.6) direction = "LONG";
  else if (book < -0.18 && cvd < -0.09 && (oiChange || 0) < -0.6) direction = "SHORT";

  return { score: Math.min(Math.max(score, 0), 100), direction };
}

// ============================= // CLASSIFY + POWER LEVEL // =============================
function classifyAndPower(score) {
  if (score > 84) return { level: "NUCLEARE", power: 3 };
  if (score > 67) return { level: "POTENTE",  power: 2 };
  if (score > 49) return { level: "BUONO",    power: 1 };
  return null;
}

// ============================= // FORMAT // =============================
function formatSignal(s) {
  const { level, power } = classifyAndPower(s.score);
  if (!level) return "";

  let powerStr = "";
  let dirEmoji = "";

  if (s.type.includes("LONG")) {
    dirEmoji = "x long";
    powerStr = "🔥".repeat(power);
  } else if (s.type.includes("SHORT")) {
    dirEmoji = "short";
    powerStr = "💣".repeat(power);
  }

  let msg = `<b>${s.symbol}</b> ${powerStr} ${dirEmoji}\n`;
  msg += `${level} ${dirEmoji}\n`;
  msg += `Score: <b>${s.score.toFixed(0)}</b>\n`;
  msg += `CVD: ${(s.cvd * 100).toFixed(1)}%\n`;
  msg += `Book: ${(s.book * 100).toFixed(1)}%\n`;
  msg += `OI Δ: ${s.oiChange.toFixed(1)}%\n`;
  msg += `Funding: ${s.funding.toFixed(5)}\n\n`;

  return msg;
}

// ============================= // SCAN // =============================
async function performScan() {
  console.log("Starting REVERSAL SCAN —", new Date().toISOString());

  let tickersRes;
  try {
    tickersRes = await axiosInstance.get("https://api.binance.com/api/v3/ticker/24hr");
  } catch (err) {
    console.error("Impossibile scaricare tickers");
    return [];
  }

  const symbols = tickersRes.data
    .filter(t => t.symbol.endsWith("USDT"))
    .filter(t => parseFloat(t.quoteVolume) > CONFIG.MIN_TURNOVER_USDT)
    .filter(t => !STABLES.some(s => t.symbol.includes(s)))
    .filter(t => {
      const high = parseFloat(t.highPrice);
      const low = parseFloat(t.lowPrice);
      if (high === low) return false;
      const range24 = ((high - low) / low) * 100;
      return range24 >= 3 && range24 <= 9;
    })
    .map(t => t.symbol)
    .slice(0, CONFIG.MAX_SYMBOLS_PER_SCAN);

  console.log(`→ ${symbols.length} simboli da analizzare`);

  const results = [];
  let discarded = 0;

  for (const symbol of symbols) {
    const [cvd, bookObj, range12h, funding, oiChange] = await Promise.all([
      getCVD(symbol),
      getOrderbookImbalance(symbol),
      getVolatilityPercent(symbol),
      getFunding(symbol),
      getOIChange(symbol)
    ]);

    const book = bookObj.imbalance;

    if (Math.abs(book) < 0.18 || Math.abs(cvd) < 0.09) {
      discarded++;
      await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
      continue;
    }

    const { score, direction } = calculateScoreAndDirection(cvd, book, oiChange);
    if (!direction) {
      discarded++;
      await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
      continue;
    }

    const classification = classifyAndPower(score);
    if (!classification) {
      discarded++;
      await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
      continue;
    }

    const fullType = `${classification.level} ${direction}`;

    const existing = activeSignals.get(symbol);
    if (!existing) {
      activeSignals.set(symbol, { updates: 1, lastOI: oiChange });
      results.push({
        symbol,
        type: fullType,
        score,
        cvd,
        book,
        oiChange,
        funding
      });
    } else if (existing.updates < 12) {
      if (Math.abs(oiChange - existing.lastOI) > 0.7) {
        existing.updates++;
        existing.lastOI = oiChange;
        results.push({
          symbol,
          type: fullType + " (UPDATE)",
          score,
          cvd,
          book,
          oiChange,
          funding
        });
      }
    }

    await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
  }

  if (discarded > 0) console.log(`→ ${discarded} simboli scartati`);

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 12);
}

// ============================= // MAIN // =============================
async function main() {
  const signals = await performScan();
  if (signals.length === 0) {
    console.log("Nessun segnale");
    return;
  }

  let msg = "<b>REVERSAL SCAN</b>\n\n";
  for (const s of signals) {
    msg += formatSignal(s);
  }

  await sendTelegramMessage(msg);
  console.log(`→ Inviati ${signals.length} segnali`);
}

main();
setInterval(main, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000);
