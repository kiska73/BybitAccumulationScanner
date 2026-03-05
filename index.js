const axios = require("axios");

// ============================= CONFIG =============================
const CONFIG = {
  SCAN_INTERVAL_MS: 30 * 60 * 1000,       // 30 minuti tra scan completi
  MIN_TURNOVER_USDT: 2_200_000,
  ORDERBOOK_DEPTH: 50,                    // 50 livelli (uno 0 in meno come richiesto)
  CVD_TRADES_LIMIT: 1000,
  REQUEST_TIMEOUT_MS: 10000,
  SLEEP_BETWEEN_SYMBOLS_MS: 850,
  GROUP_SIZE: 60,
  PAUSE_BETWEEN_GROUPS_MS: 100 * 1000
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

// ============================= BYBIT PERP FILTER (cache) =============================
let bybitPerpSymbols = new Set();

async function loadBybitPerpSymbols() {
  console.log("🔄 Caricamento lista Bybit Perpetual Linear...");
  let cursor = '';
  let total = 0;

  do {
    try {
      const url = `https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await axios.get(url, { timeout: 8000 });
      const list = res.data.result?.list || [];

      for (const item of list) {
        if (item.contractType === "LinearPerpetual" && 
            item.quoteCoin === "USDT" && 
            item.status === "Trading") {
          bybitPerpSymbols.add(item.symbol);
        }
      }
      total += list.length;
      cursor = res.data.result?.nextPageCursor || '';
    } catch (e) {
      console.error("Errore Bybit instruments:", e.message);
      break;
    }
  } while (cursor);

  console.log(`✅ Bybit Perpetual Linear caricati: ${bybitPerpSymbols.size} simboli`);
}

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
  } catch { return 0; }
}

async function getOrderbookImbalance(symbol) {
  try {
    const res = await axiosInstance.get(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`
    );
    
    const bids = res.data.bids;
    const asks = res.data.asks;

    if (bids.length === 0 || asks.length === 0) return { imbalance: 0 };

    let bidValue = 0;   // valore in USDT
    let askValue = 0;   // valore in USDT

    // RAGGRUPPAMENTO COME RICHIESTO: sommiamo QTY * PRICE
    // Questo toglie automaticamente "uno 0" sui coin a 0.0001 (normalizza tutto in valore reale USDT)
    for (const [priceStr, qtyStr] of bids) {
      const price = parseFloat(priceStr);
      const qty   = parseFloat(qtyStr);
      bidValue += qty * price;
    }

    for (const [priceStr, qtyStr] of asks) {
      const price = parseFloat(priceStr);
      const qty   = parseFloat(qtyStr);
      askValue += qty * price;
    }

    const totalValue = bidValue + askValue;
    const imbalance = totalValue > 0 ? (bidValue - askValue) / totalValue : 0;

    return { imbalance };
  } catch {
    return { imbalance: 0 };
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
  } catch { return 0; }
}

async function getFunding(symbol) {
  try {
    const res = await axios.get(
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`,
      { timeout: 6500 }
    );
    return parseFloat(res.data.result?.list?.[0]?.fundingRate ?? 0);
  } catch { return 0; }
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
  } catch { return 0; }
}

// ============================= SCORE + DIRECTION =============================
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

// ============================= CLASSIFY + POWER =============================
function classifyAndPower(score) {
  if (score > 84) return { level: "NUCLEARE", power: 3 };
  if (score > 67) return { level: "POTENTE",  power: 2 };
  if (score > 49) return { level: "BUONO",    power: 1 };
  return null;
}

// ============================= FORMAT (con fonte dati) =============================
function formatSignal(s) {
  const { level, power } = classifyAndPower(s.score);
  let powerStr = "";
  let dirText = "";

  if (s.type.includes("LONG")) {
    dirText = "x long";
    powerStr = "🔥".repeat(power);
  } else if (s.type.includes("SHORT")) {
    dirText = "short";
    powerStr = "💣".repeat(power);
  }

  let msg = `<b>${s.symbol}</b> ${powerStr} ${dirText}\n`;
  msg += `${level} ${dirText}\n`;
  msg += `Score: <b>${s.score.toFixed(0)}</b>\n`;
  msg += `CVD: ${(s.cvd * 100).toFixed(1)}%\n`;
  msg += `Book: ${(s.book * 100).toFixed(1)}%\n`;
  msg += `OI Δ: ${s.oiChange.toFixed(1)}%\n`;
  msg += `Funding: ${s.funding.toFixed(5)}\n`;
  msg += `Fonte dati: <b>Binance Spot</b> (Book + CVD) + <b>Bybit Perpetual</b> (Funding + OI)\n\n`;
  return msg;
}

// ============================= SCAN =============================
async function performScan() {
  console.log(`[START SCAN] ${new Date().toISOString()}`);

  await loadBybitPerpSymbols();

  let tickersRes;
  try {
    tickersRes = await axiosInstance.get("https://api.binance.com/api/v3/ticker/24hr");
  } catch (err) {
    console.error("Errore tickers Binance:", err.message);
    return [];
  }

  let allSymbols = tickersRes.data
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
    .map(t => t.symbol);

  console.log(`→ Trovati ${allSymbols.length} simboli Binance validi`);

  const groups = [];
  for (let i = 0; i < allSymbols.length; i += CONFIG.GROUP_SIZE) {
    groups.push(allSymbols.slice(i, i + CONFIG.GROUP_SIZE));
  }

  const results = [];
  let totalProcessed = 0;
  let totalDiscarded = 0;

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    console.log(`Gruppo ${g+1}/${groups.length} (${group.length} simboli)`);

    for (const symbol of group) {
      totalProcessed++;

      let bybitSymbol = symbol;
      if (!bybitPerpSymbols.has(symbol)) {
        const memecoinVar = `1000${symbol.replace("USDT", "")}USDT`;
        if (bybitPerpSymbols.has(memecoinVar)) {
          bybitSymbol = memecoinVar;
        } else {
          totalDiscarded++;
          await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
          continue;
        }
      }

      const [cvd, bookObj, funding, oiChange] = await Promise.all([
        getCVD(symbol),
        getOrderbookImbalance(symbol),
        getFunding(bybitSymbol),
        getOIChange(bybitSymbol)
      ]);

      const book = bookObj.imbalance;

      if (Math.abs(book) < 0.18 || Math.abs(cvd) < 0.09) {
        totalDiscarded++;
        await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
        continue;
      }

      const { score, direction } = calculateScoreAndDirection(cvd, book, oiChange);
      if (!direction) {
        totalDiscarded++;
        await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
        continue;
      }

      const classification = classifyAndPower(score);
      if (!classification) {
        totalDiscarded++;
        await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
        continue;
      }

      const fullType = `${classification.level} ${direction}`;

      const existing = activeSignals.get(symbol);
      if (!existing) {
        activeSignals.set(symbol, { updates: 1, lastOI: oiChange });
        results.push({ symbol, type: fullType, score, cvd, book, oiChange, funding });
      } else if (existing.updates < 12) {
        if (Math.abs(oiChange - existing.lastOI) > 0.7) {
          existing.updates++;
          existing.lastOI = oiChange;
          results.push({ symbol, type: fullType + " (UPDATE)", score, cvd, book, oiChange, funding });
        }
      }

      await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);
    }

    if (g < groups.length - 1) {
      console.log(`⏳ Pausa ${CONFIG.PAUSE_BETWEEN_GROUPS_MS / 1000}s...`);
      await sleep(CONFIG.PAUSE_BETWEEN_GROUPS_MS);
    }
  }

  console.log(`[FINE SCAN] Processati ${totalProcessed} | Scartati ${totalDiscarded} | Segnali ${results.length}`);

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

  let msg = "<b>REVERSAL SCAN — FULL (Bybit Only)</b>\n\n";
  for (const s of signals) {
    msg += formatSignal(s);
  }

  await sendTelegramMessage(msg);
  console.log(`📤 Inviati ${signals.length} segnali`);
}

// Avvio
main();
setInterval(main, CONFIG.SCAN_INTERVAL_MS);
