import express from 'express';
import { execFileSync } from 'child_process';
import cors from 'cors';
import { Wallet } from 'ethers';
import { ClobClient, Side } from '@polymarket/clob-client';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// CONFIGURATION
// ============================================================
const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FUNDER = process.env.FUNDER_ADDRESS;
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || '1');
const API_SECRET = process.env.API_SECRET;

// ============================================================
// CLIENT INITIALIZATION
// ============================================================
let client = null;
let clientReady = false;
let initError = null;
let signer = null;
let apiCreds = null;

async function initClient() {
  try {
    console.log('Initializing Polymarket CLOB client...');
    console.log(`  Funder: ${FUNDER}`);
    console.log(`  Signature Type: ${SIGNATURE_TYPE}`);
    
    signer = new Wallet(PRIVATE_KEY);
    console.log(`  Signer: ${signer.address}`);

    const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
    apiCreds = await tempClient.createOrDeriveApiKey();
    console.log(`  API Key: ${apiCreds.key.substring(0, 8)}...`);

    client = new ClobClient(
      HOST,
      CHAIN_ID,
      signer,
      apiCreds,
      SIGNATURE_TYPE,
      FUNDER
    );

    clientReady = true;
    console.log('✅ Client initialized successfully');
  } catch (err) {
    initError = err.message;
    console.error('❌ Client initialization failed:', err.message);
  }
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function auth(req, res, next) {
  const token = req.headers['x-api-key'] || req.query.key;
  if (API_SECRET && token !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!clientReady) {
    return res.status(503).json({ error: 'Client not ready', detail: initError });
  }
  next();
}

// ============================================================
// ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'polymarket-trader',
    status: clientReady ? 'ready' : 'initializing',
    error: initError,
    funder: FUNDER,
    signatureType: SIGNATURE_TYPE
  });
});

// Get open orders
app.get('/balance', auth, async (req, res) => {
  try {
    const openOrders = await client.getOpenOrders();
    res.json({
      openOrders: openOrders.length,
      orders: openOrders.slice(0, 10).map(o => ({
        id: o.id,
        market: o.asset_id?.substring(0, 20),
        side: o.side,
        price: o.price,
        size: o.original_size,
        filled: o.size_matched
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get market price
app.get('/price/:tokenId', auth, async (req, res) => {
  try {
    const { tokenId } = req.params;
    const mid = await client.getMidpoint(tokenId);
    const book = await client.getOrderBook(tokenId);
    res.json({
      tokenId,
      midpoint: mid,
      bestBid: book?.bids?.[0]?.price || null,
      bestAsk: book?.asks?.[0]?.price || null,
      spread: book?.asks?.[0]?.price && book?.bids?.[0]?.price 
        ? (parseFloat(book.asks[0].price) - parseFloat(book.bids[0].price)).toFixed(4)
        : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Place a bet
app.post('/bet', auth, async (req, res) => {
  try {
    const { tokenId, side, amount, price } = req.body;

    if (!tokenId || !side || !amount) {
      return res.status(400).json({ error: 'Missing required fields: tokenId, side, amount' });
    }

    const sideEnum = side.toUpperCase() === 'BUY' ? Side.BUY : Side.SELL;
    
    let orderPrice = price;
    if (!orderPrice) {
      const mid = await client.getMidpoint(tokenId);
      orderPrice = sideEnum === Side.BUY 
        ? Math.min(parseFloat(mid) + 0.02, 0.99)
        : Math.max(parseFloat(mid) - 0.02, 0.01);
    }

    const size = parseFloat(amount) / parseFloat(orderPrice);

    console.log(`📊 Placing order: ${side} ${size.toFixed(2)} shares @ ${orderPrice}`);
    console.log(`   Token: ${tokenId.substring(0, 20)}...`);
    console.log(`   Amount: $${amount}`);

    let tickSize = '0.01';
    let negRisk = false;
    try {
      const marketInfo = await client.getMarket(tokenId);
      if (marketInfo?.minimum_tick_size) tickSize = marketInfo.minimum_tick_size;
      if (marketInfo?.neg_risk) negRisk = marketInfo.neg_risk;
    } catch (e) {}

    const tickDecimal = parseFloat(tickSize);
    const roundedPrice = Math.round(orderPrice / tickDecimal) * tickDecimal;

    const response = await client.createAndPostOrder({
      tokenID: tokenId,
      price: roundedPrice,
      size: Math.floor(size * 100) / 100,
      side: sideEnum,
    }, { tickSize, negRisk });

    console.log(`✅ Order placed: ${JSON.stringify(response)}`);

    res.json({
      success: true,
      orderId: response.orderID || response.orderid,
      status: response.status,
      side,
      price: roundedPrice,
      size: Math.floor(size * 100) / 100,
      amount: parseFloat(amount),
      tokenId,
      response
    });
  } catch (err) {
    console.error(`❌ Order failed: ${err.message}`);
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// Cancel order
app.delete('/order/:orderId', auth, async (req, res) => {
  try {
    const result = await client.cancelOrder(req.params.orderId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trade history
app.get('/trades', auth, async (req, res) => {
  try {
    const trades = await client.getTrades();
    res.json({
      count: trades.length,
      trades: trades.slice(0, 20).map(t => ({
        id: t.id,
        market: t.asset_id?.substring(0, 20),
        side: t.side,
        price: t.price,
        size: t.size,
        status: t.status,
        timestamp: t.created_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Market lookup
app.get('/market/:conditionId', auth, async (req, res) => {
  try {
    const market = await client.getMarket(req.params.conditionId);
    res.json(market);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order store (in-memory for n8n workflow)
const orderStore = {};
const ORDER_TTL = 86400000;

app.post('/store-order', auth, (req, res) => {
  const { key, data } = req.body;
  if (!key || !data) return res.status(400).json({ error: 'Need key and data' });
  orderStore[key] = { ...data, ts: Date.now() };
  for (const k of Object.keys(orderStore)) {
    if (Date.now() - orderStore[k].ts > ORDER_TTL) delete orderStore[k];
  }
  res.json({ success: true, key });
});

app.get('/get-order/:key', auth, (req, res) => {
  const order = orderStore[req.params.key];
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

// Forward order via curl (for proxy/CF bypass)
app.post('/forward-order', auth, async (req, res) => {
  try {
    const { tokenId, side, amount, price } = req.body;
    if (!tokenId || !side || !amount) return res.status(400).json({ error: 'Need tokenId, side, amount' });
    
    const orderPayload = {
      tokenID: tokenId,
      price: price || 0.5,
      side: side === 'SELL' ? Side.SELL : Side.BUY,
      size: parseFloat(amount)
    };
    
    let tickSize = '0.01', negRisk = false;
    try {
      const m = await client.getMarket(tokenId);
      tickSize = m?.minimum_tick_size || '0.01';
      negRisk = m?.neg_risk || false;
    } catch(e) {}
    
    const signedOrder = await client.createOrder(orderPayload, { tickSize, negRisk });
    const orderBody = JSON.stringify(signedOrder);
    
    // Build L2 auth headers
    let polyHeaders = {};
    try {
      polyHeaders = await client.createL2Headers('POST', '/order', orderBody);
    } catch(e) {
      console.log('L2 headers fallback:', e.message);
    }
    
    const args = ['-s', '-w', '\n%{http_code}', '-X', 'POST', 'https://clob.polymarket.com/order'];
    for (const [k, v] of Object.entries(polyHeaders)) {
      args.push('-H', `${k}: ${v}`);
    }
    args.push('-H', 'Content-Type: application/json');
    args.push('-d', orderBody);
    
    if (process.env.PROXY_URL) {
      args.push('-x', process.env.PROXY_URL);
    }
    
    console.log('[forward-order] Curling with proxy:', !!process.env.PROXY_URL);
    const result = execFileSync('curl', args, { timeout: 30000, encoding: 'utf8' });
    const lines = result.trim().split('\n');
    const httpCode = parseInt(lines.pop()) || 0;
    const body = lines.join('\n');
    
    let parsed;
    try { parsed = JSON.parse(body); } catch(e) { parsed = { raw: body.substring(0, 500) }; }
    
    const isCF = body.includes('<!DOCTYPE') || body.includes('cloudflare');
    res.json({
      success: httpCode === 200 && !isCF && (parsed.success !== false),
      status: httpCode,
      isCloudflare: isCF,
      ...parsed
    });
  } catch (err) {
    console.error('forward-order error:', err.message);
    res.status(500).json({ error: err.message.substring(0, 500) });
  }
});

// ============================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Polymarket Trader running on port ${PORT}`);
  await initClient();
});
