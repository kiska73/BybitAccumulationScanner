const axios = require("axios");

// ============================= CONFIG =============================
const CONFIG = {
  SCAN_INTERVAL_MS: 30 * 60 * 1000,       // 30 minuti tra scan completi
  MIN_TURNOVER_USDT: 2_200_000,
  ORDERBOOK_DEPTH: 50,
  CVD_TRADES_LIMIT: 1000,
  REQUEST_TIMEOUT_MS: 10000,
  SLEEP_BETWEEN_SYMBOLS_MS: 850,
  GROUP_SIZE: 50,                         // ridotto perché più chiamate per simbolo
  PAUSE_BETWEEN_GROUPS_MS: 120 * 1000
};

// ============================= TELEGRAM =============================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID = '820279313';

async function sendTelegramMessage(text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: "HTML" }
    );
  } catch (err) {
    console.log("Telegram error:", err.message);
  }
}

// ============================= UTILS =============================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const axiosInstance = axios.create({ timeout: CONFIG.REQUEST_TIMEOUT_MS });

// ============================= MEMORIA SEGNALI =============================
const activeSignals = new Map();

// ============================= FILTRO STABLE =============================
const STABLES = ["USDC", "BUSD", "FDUSD", "TUSD", "USDP", "DAI", "UST", "USTC", "USDD"];

// ============================= CACHE BYBIT =============================
let bybitPerpSymbols = new Set();
let bybitSpotSymbols = new Set();

async function loadBybitPerpSymbols() {
  console.log("🔄 Caricamento Bybit Perpetual Linear...");
  let cursor = '';
  do {
    try {
      const url = `https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await axios.get(url, { timeout: 8000 });
      const list = res.data.result?.list || [];
      for (const item of list) {
        if (item.contractType === "LinearPerpetual" && item.quoteCoin === "USDT" && item.status === "Trading") {
          bybitPerpSymbols.add(item.symbol);
        }
      }
      cursor = res.data.result?.nextPageCursor || '';
    } catch (e) { console.error("Bybit perp error:", e.message); break; }
  } while (cursor);
  console.log(`✅ Bybit Perpetual: ${bybitPerpSymbols.size} simboli`);
}

async function loadBybitSpotSymbols() {
  console.log("🔄 Caricamento Bybit Spot USDT...");
  let cursor = '';
  do {
    try {
      const url = `https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await axios.get(url, { timeout: 8000 });
      const list = res.data.result?.list || [];
      for (const item of list) {
        if (item.quoteCoin === "USDT" && item.status === "Trading") {
          bybitSpotSymbols.add(item.symbol);
        }
      }
      cursor = res.data.result?.nextPageCursor || '';
    } catch (e) { console.error("Bybit spot error:", e.message); break; }
  } while (cursor);
  console.log(`✅ Bybit Spot: ${bybitSpotSymbols.size} simboli`);
}

// ============================= DATA FUNCTIONS =============================
// Binance (rimangono uguali)
async function getCVD(symbol) {
  try {
    const res = await axiosInstance.get(`https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=${CONFIG.CVD_TRADES_LIMIT}`);
    let delta = 0, total = 0;
    for (const t of res.data) {
      const qty = parseFloat(t.qty);
      total += qty;
      delta += t.isBuyerMaker ? -qty : qty;
    }
    return total > 0 ? delta / total : 0;
  } catch { return 0; }
}

async function getOrderbookImbalance(symbol) {
  try {
    const res = await axiosInstance.get(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`);
    const bids = res.data.bids || [];
    const asks = res.data.asks || [];
    let bidValue = 0, askValue = 0;
    for (const [p, q] of bids) { bidValue += parseFloat(q) * parseFloat(p); }
    for (const [p, q] of asks) { askValue += parseFloat(q) * parseFloat(p); }
    const total = bidValue + askValue;
    return total > 0 ? (bidValue - askValue) / total : 0;
  } catch { return 0; }
}

// === NUOVE FUNZIONI BYBIT SPOT ===
async function getBybitSpotOrderbook(symbol) {
  try {
    const res = await axiosInstance.get(`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`);
    const bids = res.data.result?.b || [];
    const asks = res.data.result?.a || [];
    let bidValue = 0, askValue = 0;
    for (const [p, q] of bids) { bidValue += parseFloat(q) * parseFloat(p); }
    for (const [p, q] of asks) { askValue += parseFloat(q) * parseFloat(p); }
    const total = bidValue + askValue;
    return total > 0 ? (bidValue - askValue) / total : 0;
  } catch { return 0; }
}

// === NUOVA FUNZIONE BYBIT PERP ORDERBOOK (per confronto) ===
async function getBybitPerpOrderbook(symbol) {
  try {
    const res = await axiosInstance.get(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`);
    const bids = res.data.result?.b || [];
    const asks = res.data.result?.a || [];
    let bidValue = 0, askValue = 0;
    for (const [p, q] of bids) { bidValue += parseFloat(q) * parseFloat(p); }
    for (const [p, q] of asks) { askValue += parseFloat(q) * parseFloat(p); }
    const total = bidValue + askValue;
    return total > 0 ? (bidValue - askValue) / total : 0;
  } catch { return 0; }
}

async function getFunding(symbol) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`, { timeout: 6500 });
    return parseFloat(res.data.result?.list?.[0]?.fundingRate ?? 0);
  } catch { return 0; }
}

async function getOIChange(symbol) {
  try {
    const res = await axios.get(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=15min&limit=2`, { timeout: 6500 });
    const list = res.data.result?.list ?? [];
    if (list.length < 2) return 0;
    const cur = parseFloat(list[0].openInterest);
    const prev = parseFloat(list[1].openInterest);
    return prev > 0 ? ((cur - prev) / prev) * 100 : 0;
  } catch { return 0; }
}

// ============================= SCORE + CONFLUENZA =============================
function calculateCompositeScoreAndDirection(binanceBook, bybitSpotBook, bybitPerpBook, cvd, oiChange) {
  const books = [binanceBook, bybitSpotBook, bybitPerpBook];
  const avgBook = books.reduce((a, b) => a + b, 0) / 3;
  const absBooks = books.map(Math.abs);
  const maxBook = Math.max(...absBooks);
  const positiveCount = books.filter(b => b > 0.15).length;   // almeno 2/3 positivi = buona confluenza

  let score = 0;
  score += Math.abs(avgBook) * 45;
  score += Math.abs(cvd) * 32;
  score += Math.abs(oiChange || 0) * 23;

  if (maxBook > 0.45) score += 18;
  if (positiveCount >= 2) score += 15;
  if (positiveCount === 3) score += 12;
  if (Math.abs(cvd) > 0.22) score += 10;

  const aligned = (avgBook > 0 && cvd > 0) || (avgBook < 0 && cvd < 0);
  if (aligned) score += 14;

  let direction = null;
  if (avgBook > 0.22 && cvd > 0.10 && (oiChange || 0) > 0.5 && positiveCount >= 2) {
    direction = "LONG";
  } else if (avgBook < -0.22 && cvd < -0.10 && (oiChange || 0) < -0.5 && positiveCount >= 2) {
    direction = "SHORT";
  }

  return { 
    score: Math.min(Math.max(score, 0), 100), 
    direction, 
    avgBook,
    positiveCount 
  };
}

function classifyAndPower(score) {
  if (score > 82) return { level: "NUCLEARE", power: 3 };
  if (score > 68) return { level: "POTENTE",  power: 2 };
  if (score > 52) return { level: "BUONO",    power: 1 };
  return null;
}

// ============================= FORMAT (confronto multi-exchange) =============================
function formatSignal(s) {
  const { level, power } = classifyAndPower(s.score);
  const powerStr = s.direction.includes("LONG") ? "🔥".repeat(power) : "💣".repeat(power);
  const dirText = s.direction.includes("LONG") ? "x LONG" : "SHORT";

  let msg = `<b>${s.symbol}</b> ${powerStr} ${dirText}\n`;
  msg += `${level} ${dirText}\n`;
  msg += `Score: <b>${s.score.toFixed(0)}</b> | Confluenza: ${s.positiveCount}/3\n`;
  msg += `Book Binance Spot: <b>${(s.binanceBook * 100).toFixed(1)}%</b>\n`;
  msg += `Book Bybit Spot:    <b>${(s.bybitSpotBook * 100).toFixed(1)}%</b>\n`;
  msg += `Book Bybit Perp:   <b>${(s.bybitPerpBook * 100).toFixed(1)}%</b>\n`;
  msg += `Book Medio: <b>${(s.avgBook * 100).toFixed(1)}%</b>\n`;
  msg += `CVD Binance: ${(s.cvd * 100).toFixed(1)}%\n`;
  msg += `OI Δ: ${s.oiChange.toFixed(1)}% ${s.oiChange > 0 ? '📈' : '📉'}\n`;
  msg += `Funding: ${s.funding.toFixed(5)}\n`;
  msg += `Fonte: <b>Binance Spot + Bybit Spot + Bybit Perp</b>\n\n`;
  return msg;
}

// ============================= SCAN =============================
async function performScan() {
  console.log(`[START SCAN MULTI-EXCHANGE] ${new Date().toISOString()}`);

  await Promise.all([loadBybitPerpSymbols(), loadBybitSpotSymbols()]);

  // 1. Binance tickers (filtro volume + range)
  let binanceTickers = [];
  try {
    const res = await axiosInstance.get("https://api.binance.com/api/v3/ticker/24hr");
    binanceTickers = res.data
      .filter(t => t.symbol.endsWith("USDT"))
      .filter(t => parseFloat(t.quoteVolume) > CONFIG.MIN_TURNOVER_USDT)
      .filter(t => !STABLES.some(s => t.symbol.includes(s)))
      .filter(t => {
        const h = parseFloat(t.highPrice), l = parseFloat(t.lowPrice);
        const range = l > 0 ? ((h - l) / l) * 100 : 0;
        return range >= 3 && range <= 9;
      })
      .map(t => t.symbol);
  } catch (e) { console.error("Binance tickers error:", e.message); }

  // 2. Solo simboli presenti su TUTTE e tre le piattaforme
  const candidates = binanceTickers.filter(sym => 
    bybitSpotSymbols.has(sym) && bybitPerpSymbols.has(sym)
  );

  console.log(`→ Trovati ${candidates.length} simboli con presenza su Binance Spot + Bybit Spot + Bybit Perp`);

  const groups = [];
  for (let i = 0; i < candidates.length; i += CONFIG.GROUP_SIZE) {
    groups.push(candidates.slice(i, i + CONFIG.GROUP_SIZE));
  }

  const results = [];
  let totalProcessed = 0;

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    console.log(`Gruppo ${g+1}/${groups.length}`);

    for (const symbol of group) {
      totalProcessed++;

      // === FETCH MULTI-EXCHANGE ===
      const [binanceBook, bybitSpotBook, bybitPerpBook, cvd, funding, oiChange] = await Promise.all([
        getOrderbookImbalance(symbol),
        getBybitSpotOrderbook(symbol),
        getBybitPerpOrderbook(symbol),
        getCVD(symbol),
        getFunding(symbol),
        getOIChange(symbol)
      ]);

      const absMaxBook = Math.max(Math.abs(binanceBook), Math.abs(bybitSpotBook), Math.abs(bybitPerpBook));
      if (absMaxBook < 0.20 || Math.abs(cvd) < 0.09) {
        await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
        continue;
      }

      const { score, direction, avgBook, positiveCount } = calculateCompositeScoreAndDirection(
        binanceBook, bybitSpotBook, bybitPerpBook, cvd, oiChange
      );

      if (!direction) {
        await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
        continue;
      }

      const classification = classifyAndPower(score);
      if (!classification) {
        await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
        continue;
      }

      const fullType = `${classification.level} ${direction}`;

      const existing = activeSignals.get(symbol);
      if (!existing || existing.updates < 12) {
        if (!existing || Math.abs(oiChange - (existing.lastOI || 0)) > 0.7) {
          activeSignals.set(symbol, { updates: (existing?.updates || 0) + 1, lastOI: oiChange });
          results.push({
            symbol,
            type: fullType,
            score,
            direction,
            binanceBook,
            bybitSpotBook,
            bybitPerpBook,
            avgBook,
            cvd,
            oiChange,
            funding,
            positiveCount
          });
        }
      }

      await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
    }

    if (g < groups.length - 1) await sleep(CONFIG.PAUSE_BETWEEN_GROUPS_MS);
  }

  console.log(`[FINE SCAN] Processati ${totalProcessed} | Segnali ${results.length}`);

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 12);
}

// ============================= MAIN =============================
async function main() {
  const signals = await performScan();
  if (signals.length === 0) {
    console.log("Nessun segnale questa volta");
    return;
  }

  let msg = "<b>🔥 REVERSAL SCAN — MULTI-EXCHANGE (Binance + Bybit Spot + Perp)</b>\n\n";
  for (const s of signals) {
    msg += formatSignal(s);
  }

  await sendTelegramMessage(msg);
  console.log(`📤 Inviati ${signals.length} segnali con confluenza multi-exchange`);
}

// Avvio
main();
setInterval(main, CONFIG.SCAN_INTERVAL_MS);
