const fetch = require('node-fetch');
const cron = require('node-cron');

const BASE_URL = 'https://api.bybit.com';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function get(endpoint) {
  const response = await fetch(BASE_URL + endpoint);
  if (!response.ok) throw new Error('API error');
  return await response.json();
}

function isHammer(kline) {
  const open = parseFloat(kline[1]);
  const high = parseFloat(kline[2]);
  const low = parseFloat(kline[3]);
  const close = parseFloat(kline[4]);

  const body = Math.abs(open - close);
  const range = high - low;
  if (range === 0) return false;

  const lowerShadow = Math.min(open, close) - low;
  const upperShadow = high - Math.max(open, close);

  return body <= 0.3 * range &&
         lowerShadow >= 2 * body &&
         upperShadow <= 0.5 * body &&
         close > open;
}

async function getBidRatioNotional(symbol) {
  const data = await get(`/v5/market/orderbook?category=linear&symbol=${symbol}&limit=500`);
  const bids = data.result.b;
  const asks = data.result.a;

  let totalBid = 0;
  let totalAsk = 0;

  bids.forEach(level => {
    const price = parseFloat(level[0]);
    const qty = parseFloat(level[1]);
    totalBid += price * qty;
  });

  asks.forEach(level => {
    const price = parseFloat(level[0]);
    const qty = parseFloat(level[1]);
    totalAsk += price * qty;
  });

  if (totalBid + totalAsk === 0) return 0;
  return totalBid / (totalBid + totalAsk);
}

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram non configurato - alert:', message);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

async function scan() {
  try {
    console.log('Inizio scan...');
    const tickersData = await get('/v5/market/tickers?category=linear');
    const list = tickersData.result.list;

    const candidates = [];
    for (const item of list) {
      if (!item.symbol.endsWith('USDT')) continue;
      const turnover24h = parseFloat(item.turnover24h);
      if (turnover24h < 5000000) continue;
      candidates.push({ symbol: item.symbol, turnover24h });
    }

    candidates.sort((a, b) => b.turnover24h - a.turnover24h);
    const topSymbols = candidates.slice(0, 100).map(c => c.symbol);

    console.log(`Scanning ${topSymbols.length} top perpetual...`);

    for (const symbol of topSymbols) {
      try {
        await new Promise(resolve => setTimeout(resolve, 100)); // rate limit safe

        const klineData = await get(`/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=2`);
        const klines = klineData.result.list;
        if (klines.length < 2) continue;

        const lastClosed = klines[0]; // index 0 = candela chiusa più recente
        if (!isHammer(lastClosed)) continue;

        const bidRatio = await getBidRatioNotional(symbol);
        if (bidRatio < 0.65) continue;

        // Trova ticker per price + funding
        const ticker = list.find(t => t.symbol === symbol);
        if (!ticker) continue;

        const price = parseFloat(ticker.lastPrice);
        const funding = parseFloat(ticker.fundingRate);

        const fundingEmoji = funding < 0 ? '🔥 NEGATIVO (shorts pagano!)' : '❄️ positivo';

        const message = `🚀 <b>ACCUMULAZIONE POTENZIALE BYBIT</b> 🚀\n\n` +
                        `<b>${symbol}</b>\n` +
                        `Prezzo attuale: <b>$${price.toFixed(4)}</b>\n` +
                        `Hammer bullish 1H ✅\n` +
                        `Bid ratio (notional): <b>${(bidRatio * 100).toFixed(2)}%</b> ✅\n` +
                        `Funding rate: <b>${(funding * 100).toFixed(5)}%</b> ${fundingEmoji}\n\n` +
                        `<a href='https://www.tradingview.com/chart/?symbol=BYBIT:${symbol}'>TradingView Chart</a> | ` +
                        `<a href='https://www.bybit.com/trade/usdt/${symbol}'>Trade su Bybit</a>`;

        await sendTelegram(message);
        console.log(`🚀 ALERT INVIATO: ${symbol} - Bid ${(bidRatio * 100).toFixed(2)}%`);

      } catch (e) {
        console.error(`Errore su ${symbol}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Errore scan generale:', e.message);
  }
}

// Scheduler: ogni ora al minuto 01
cron.schedule('1 * * * *', () => {
  scan();
});

console.log('Scanner Bybit Node.js avviato. Primo scan al prossimo minuto 01');
