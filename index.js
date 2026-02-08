import express from 'express';
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
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.private_key;
const FUNDER = process.env.FUNDER_ADDRESS || process.env.funder_address;
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || '1');
const API_SECRET = process.env.API_SECRET; // Simple auth token for n8n

// ============================================================
// CLIENT INITIALIZATION
// ============================================================
let client = null;
let clientReady = false;
let initError = null;

async function initClient() {
  try {
    console.log('Initializing Polymarket CLOB client...');
    console.log(`  Funder: ${FUNDER}`);
    console.log(`  Signature Type: ${SIGNATURE_TYPE}`);
    
    const signer = new Wallet(PRIVATE_KEY);
    console.log(`  Signer: ${signer.address}`);

    // Step 1: Create temp client to derive API credentials
    const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
    const apiCreds = await tempClient.createOrDeriveApiKey();
    console.log(`  API Key: ${apiCreds.key.substring(0, 8)}...`);

    // Step 2: Initialize full trading client
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

// Get account balance / open positions
app.get('/balance', auth, async (req, res) => {
  try {
    // Check open orders
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

// Get market price for a token
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

// ============================================================
// PLACE A BET (MARKET ORDER)
// ============================================================
app.post('/bet', auth, async (req, res) => {
  try {
    const { 
      tokenId,        // CLOB token ID for the outcome
      side,           // "BUY" or "SELL"
      amount,         // Amount in USDC to spend
      price,          // Limit price (optional, uses midpoint if not set)
      orderType       // "FOK" (fill-or-kill) or "GTC" (good-till-cancel)
    } = req.body;

    if (!tokenId || !side || !amount) {
      return res.status(400).json({ 
        error: 'Missing required fields: tokenId, side, amount' 
      });
    }

    const sideEnum = side.toUpperCase() === 'BUY' ? Side.BUY : Side.SELL;
    
    // Get current market price if no limit price specified
    let orderPrice = price;
    if (!orderPrice) {
      const mid = await client.getMidpoint(tokenId);
      // For BUY: bid slightly above mid to ensure fill
      // For SELL: ask slightly below mid
      orderPrice = sideEnum === Side.BUY 
        ? Math.min(parseFloat(mid) + 0.02, 0.99)
        : Math.max(parseFloat(mid) - 0.02, 0.01);
    }

    // Calculate size (shares) from amount and price
    const size = parseFloat(amount) / parseFloat(orderPrice);

    console.log(`📊 Placing order: ${side} ${size.toFixed(2)} shares @ ${orderPrice}`);
    console.log(`   Token: ${tokenId.substring(0, 20)}...`);
    console.log(`   Amount: $${amount}`);

    // Get tick size for the market
    let tickSize = '0.01';
    let negRisk = false;
    try {
      // Try to get market info for proper tick size
      const marketInfo = await client.getMarket(tokenId);
      if (marketInfo?.minimum_tick_size) {
        tickSize = marketInfo.minimum_tick_size;
      }
    } catch (e) {
      // Default tick size is fine
    }

    // Round price to tick size
    const tickDecimal = parseFloat(tickSize);
    const roundedPrice = Math.round(orderPrice / tickDecimal) * tickDecimal;

    const response = await client.createAndPostOrder({
      tokenID: tokenId,
      price: roundedPrice,
      size: Math.floor(size * 100) / 100, // Round down to 2 decimals
      side: sideEnum,
    }, {
      tickSize,
      negRisk,
    });

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
    res.status(500).json({ 
      error: err.message,
      detail: err.response?.data || err.stack?.substring(0, 500)
    });
  }
});

// ============================================================
// CANCEL AN ORDER
// ============================================================
app.delete('/order/:orderId', auth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await client.cancelOrder(orderId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET TRADE HISTORY
// ============================================================
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

// ============================================================
// LOOKUP MARKET TOKEN IDS
// ============================================================
app.get('/market/:conditionId', auth, async (req, res) => {
  try {
    const { conditionId } = req.params;
    const market = await client.getMarket(conditionId);
    res.json(market);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Polymarket Trader running on port ${PORT}`);
  console.log(`  PRIVATE_KEY set: ${!!PRIVATE_KEY}`);
  console.log(`  FUNDER set: ${!!FUNDER}`);
  console.log(`  SIGNATURE_TYPE: ${SIGNATURE_TYPE}`);
  try {
    await initClient();
  } catch (err) {
    console.error('Client init failed (server still running):', err.message);
  }
});
