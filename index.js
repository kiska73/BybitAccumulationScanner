const axios = require("axios");

// ============================= CONFIG =============================
const CONFIG = {
  SCAN_INTERVAL_MIN: 33,
  MIN_QUOTE_VOLUME_USDT: 2_000_000,

  KLINE_INTERVAL: "15m",
  KLINE_LIMIT: 16,
  MAX_RANGE_PCT: 2.6,

  MIN_IMBALANCE_ONE_EXCHANGE_PCT: 68,
  MIN_IMBALANCE_OTHER_PCT: 52,

  MIN_PRESSURE_PCT: 60,

  ORDERBOOK_DEPTH: 50,
  CVD_TRADES_LIMIT: 500,

  MIN_WALL_VALUE_USDT: 30000,
  WALL_BONUS_THRESHOLD_PCT: 6,

  MAX_WALL_DISTANCE_PCT: 1.0,   // distanza massima wall dal prezzo

  ABSORPTION_RANGE_PCT: 1.2,    // nuovo: threshold per absorption bonus

  REQUEST_TIMEOUT_MS: 8000,
  SLEEP_BETWEEN_SYMBOLS_MS: 300
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
    console.log("Telegram error", err.message);
  }
}

// ============================= UTILS =============================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ax = axios.create({ timeout: CONFIG.REQUEST_TIMEOUT_MS });

const STABLES = ["USDC","FDUSD","TUSD","USDP","DAI","BUSD","USDD"];
const EXCLUDED_SYMBOLS = ["BTCUSDT","ETHUSDT"];

// ============================= AGGREGA ORDERBOOK =============================
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
    else groupedPrice = Math.floor(price * 1000000) / 1000000;

    if (!grouped.has(groupedPrice)) grouped.set(groupedPrice, 0);

    grouped.set(groupedPrice, grouped.get(groupedPrice) + value);
  }

  let result = Array.from(grouped, ([price, value]) => [price, value]);

  result.sort((a,b)=> isBid ? b[0]-a[0] : a[0]-b[0]);

  return result;
}

// ============================= SYMBOLS =============================
async function getHighVolumeSymbols(){

  try{

    const {data} = await ax.get("https://api.binance.com/api/v3/ticker/24hr");

    return data
      .filter(t=>t.symbol.endsWith("USDT"))
      .filter(t=>!STABLES.some(s=>t.symbol.includes(s)))
      .filter(t=>!EXCLUDED_SYMBOLS.includes(t.symbol))
      .filter(t=>parseFloat(t.quoteVolume)>=CONFIG.MIN_QUOTE_VOLUME_USDT)
      .map(t=>t.symbol);

  }catch{

    return [];

  }

}

// ============================= RANGE =============================
async function getRange(symbol){

  try{

    const {data}=await ax.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${CONFIG.KLINE_INTERVAL}&limit=${CONFIG.KLINE_LIMIT}`
    );

    const highs=data.map(c=>parseFloat(c[2]));
    const lows=data.map(c=>parseFloat(c[3]));

    const maxH=Math.max(...highs);
    const minL=Math.min(...lows);

    return ((maxH-minL)/minL)*100;

  }catch{

    return 999;

  }

}

// ============================= PREZZO =============================
async function getPrice(symbol){

  try{

    const {data}=await ax.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );

    return parseFloat(data.price);

  }catch{

    return 0;

  }

}

// ============================= ORDERBOOK =============================
async function getOrderbook(exchange,symbol){

  try{

    let url;

    if(exchange==="binance"){
      url=`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`;
    }else{
      url=`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${symbol}&limit=${CONFIG.ORDERBOOK_DEPTH}`;
    }

    const {data}=await ax.get(url);

    let rawBids = exchange==="binance" ? data.bids : data.result.b;
    let rawAsks = exchange==="binance" ? data.asks : data.result.a;

    const bids=aggregateLevels(rawBids,true);
    const asks=aggregateLevels(rawAsks,false);

    let bidValue=0;
    let askValue=0;

    let largestBidValue=0;
    let largestAskValue=0;

    let largestBidPrice=0;
    let largestAskPrice=0;

    bids.forEach(([p,v])=>{
      bidValue+=v;
      if(v>largestBidValue){
        largestBidValue=v;
        largestBidPrice=p;
      }
    });

    asks.forEach(([p,v])=>{
      askValue+=v;
      if(v>largestAskValue){
        largestAskValue=v;
        largestAskPrice=p;
      }
    });

    const total=bidValue+askValue;

    return{

      bidImbalancePct:(bidValue/total)*100,
      askImbalancePct:(askValue/total)*100,

      largestBidPct:(largestBidValue/total)*100,
      largestAskPct:(largestAskValue/total)*100,

      largestBidValue:Math.round(largestBidValue),
      largestAskValue:Math.round(largestAskValue),

      largestBidPrice,
      largestAskPrice

    };

  }catch{

    return null;

  }

}

// ============================= TRADE PRESSURE =============================
async function getTradePressure(symbol){

  try{

    const {data}=await ax.get(
      `https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=${CONFIG.CVD_TRADES_LIMIT}`
    );

    let buy=0;
    let total=0;

    for(const t of data){

      const qty=parseFloat(t.qty);

      total+=qty;

      if(!t.isBuyerMaker) buy+=qty;

    }

    const buyPct=(buy/total)*100;

    return{
      buyPct,
      sellPct:100-buyPct
    };

  }catch{

    return {buyPct:0,sellPct:0};

  }

}

// ============================= SCORE =============================
function score(range,imb1,imb2,pressure,wallPct){

  let s=0;

  if(range<=1)s+=30;
  else if(range<=1.6)s+=20;

  const maxImb=Math.max(imb1,imb2);

  if(maxImb>=85)s+=30;
  else if(maxImb>=78)s+=25;
  else if(maxImb>=72)s+=20;

  if(pressure>=65)s+=25;
  else if(pressure>=60)s+=20;

  if(wallPct>=CONFIG.WALL_BONUS_THRESHOLD_PCT)s+=10;

  // absorption bonus
  if(range <= CONFIG.ABSORPTION_RANGE_PCT && pressure >= 65){
    s += 15;
  }

  return Math.min(s,100);

}

// ============================= SCAN =============================
async function scan(){

  console.log("SCAN START");

  const symbols=await getHighVolumeSymbols();

  const longSignals=[];
  const shortSignals=[];

  for(const symbol of symbols){

    const[
      range,
      price,
      binance,
      bybit,
      pressure
    ]=await Promise.all([
      getRange(symbol),
      getPrice(symbol),
      getOrderbook("binance",symbol),
      getOrderbook("bybit",symbol),
      getTradePressure(symbol)
    ]);

    await sleep(CONFIG.SLEEP_BETWEEN_SYMBOLS_MS);

    if(!binance||!bybit)continue;

    if(range>CONFIG.MAX_RANGE_PCT)continue;

    // ================= LONG =================

    const maxBidWallPrice = binance.largestBidValue > bybit.largestBidValue
      ? binance.largestBidPrice
      : bybit.largestBidPrice;

    const wallDistance = Math.abs((price - maxBidWallPrice) / price) * 100;

    if(wallDistance <= CONFIG.MAX_WALL_DISTANCE_PCT){

      const maxBid=Math.max(binance.bidImbalancePct,bybit.bidImbalancePct);
      const minBid=Math.min(binance.bidImbalancePct,bybit.bidImbalancePct);

      if(
        maxBid>=CONFIG.MIN_IMBALANCE_ONE_EXCHANGE_PCT &&
        minBid>=CONFIG.MIN_IMBALANCE_OTHER_PCT &&
        pressure.buyPct>=CONFIG.MIN_PRESSURE_PCT
      ){

        const strongestBook =
          binance.bidImbalancePct > bybit.bidImbalancePct
            ? "Binance"
            : "Bybit";

        const largestWallValue =
          binance.largestBidValue > bybit.largestBidValue
            ? binance.largestBidValue
            : bybit.largestBidValue;

        const largestWallPct = Math.max(
          binance.largestBidPct,
          bybit.largestBidPct
        );

        if(largestWallValue >= CONFIG.MIN_WALL_VALUE_USDT){

          const sc=score(
            range,
            binance.bidImbalancePct,
            bybit.bidImbalancePct,
            pressure.buyPct,
            largestWallPct
          );

          if(sc>=55){

            longSignals.push({
              symbol,
              score: sc,
              range,
              binanceBid: binance.bidImbalancePct,
              bybitBid: bybit.bidImbalancePct,
              pressure: pressure.buyPct,
              strongestBook,
              wallValue: largestWallValue,
              wallPct: largestWallPct
            });

          }

        }

      }

    }

    // ================= SHORT =================

    const maxAskWallPrice = binance.largestAskValue > bybit.largestAskValue
      ? binance.largestAskPrice
      : bybit.largestAskPrice;

    const askDistance = Math.abs((price - maxAskWallPrice) / price) * 100;

    if(askDistance <= CONFIG.MAX_WALL_DISTANCE_PCT){

      const maxAsk=Math.max(binance.askImbalancePct,bybit.askImbalancePct);
      const minAsk=Math.min(binance.askImbalancePct,bybit.askImbalancePct);

      if(
        maxAsk>=CONFIG.MIN_IMBALANCE_ONE_EXCHANGE_PCT &&
        minAsk>=CONFIG.MIN_IMBALANCE_OTHER_PCT &&
        pressure.sellPct>=CONFIG.MIN_PRESSURE_PCT
      ){

        const strongestBook =
          binance.askImbalancePct > bybit.askImbalancePct
            ? "Binance"
            : "Bybit";

        const largestWallValue =
          binance.largestAskValue > bybit.largestAskValue
            ? binance.largestAskValue
            : bybit.largestAskValue;

        const largestWallPct = Math.max(
          binance.largestAskPct,
          bybit.largestAskPct
        );

        if(largestWallValue >= CONFIG.MIN_WALL_VALUE_USDT){

          const sc=score(
            range,
            binance.askImbalancePct,
            bybit.askImbalancePct,
            pressure.sellPct,
            largestWallPct
          );

          if(sc>=55){

            shortSignals.push({
              symbol,
              score: sc,
              range,
              binanceAsk: binance.askImbalancePct,
              bybitAsk: bybit.askImbalancePct,
              pressure: pressure.sellPct,
              strongestBook,
              wallValue: largestWallValue,
              wallPct: largestWallPct
            });

          }

        }

      }

    }

  }

  if(longSignals.length===0 && shortSignals.length===0){
    console.log("No signals");
    return;
  }

  let msg="<b>🔥 ACCUMULO LONG + 💣 SHORT</b>\n\n";

  if(longSignals.length){

    msg+="🔥 <b>LONG (Bid Wall + Buy Pressure)</b>\n\n";

    longSignals.sort((a,b)=>b.score-a.score);

    longSignals.slice(0,10).forEach(s=>{

      msg+=`<b>${s.symbol}</b>\n`;
      msg+=`Score: ${s.score}\n`;
      msg+=`Range 4h: ${s.range.toFixed(2)}%\n`;
      msg+=`Bid Binance: ${s.binanceBid.toFixed(1)}%\n`;
      msg+=`Bid Bybit: ${s.bybitBid.toFixed(1)}%\n`;
      msg+=`Book più forte: ${s.strongestBook}\n`;
      msg+=`Market Buy: ${s.pressure.toFixed(1)}%\n`;
      msg+=`Largest bid wall: ${s.wallPct.toFixed(1)}% (~$${s.wallValue.toLocaleString()})\n\n`;

    });

  }

  if(shortSignals.length){

    msg+="💣 <b>SHORT (Ask Wall + Sell Pressure)</b>\n\n";

    shortSignals.sort((a,b)=>b.score-a.score);

    shortSignals.slice(0,10).forEach(s=>{

      msg+=`<b>${s.symbol}</b>\n`;
      msg+=`Score: ${s.score}\n`;
      msg+=`Range 4h: ${s.range.toFixed(2)}%\n`;
      msg+=`Ask Binance: ${s.binanceAsk.toFixed(1)}%\n`;
      msg+=`Ask Bybit: ${s.bybitAsk.toFixed(1)}%\n`;
      msg+=`Book più forte: ${s.strongestBook}\n`;
      msg+=`Market Sell: ${s.pressure.toFixed(1)}%\n`;
      msg+=`Largest ask wall: ${s.wallPct.toFixed(1)}% (~$${s.wallValue.toLocaleString()})\n\n`;

    });

  }

  await sendTelegram(msg);

}

// ============================= START =============================
scan();
setInterval(scan,CONFIG.SCAN_INTERVAL_MIN*60*1000);
