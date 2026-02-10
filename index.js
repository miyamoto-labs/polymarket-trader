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

    // Use env creds if available, otherwise derive
    if (process.env.CLOB_API_KEY && process.env.CLOB_SECRET && process.env.CLOB_PASSPHRASE) {
      apiCreds = {
        key: process.env.CLOB_API_KEY,
        secret: process.env.CLOB_SECRET,
        passphrase: process.env.CLOB_PASSPHRASE
      };
      console.log(`  API Key (from env): ${apiCreds.key.substring(0, 8)}...`);
    } else {
      const tempClient = new ClobClient(HOST, CHAIN_ID, signer, undefined, SIGNATURE_TYPE, FUNDER);
      apiCreds = await tempClient.createOrDeriveApiKey();
      console.log(`  API Key (derived): ${apiCreds.key.substring(0, 8)}...`);
    }

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
      // Check neg-risk status via CLOB endpoint
      const nrResp = await fetch(`${HOST}/neg-risk?token_id=${tokenId}`);
      const nrData = await nrResp.json();
      if (nrData.neg_risk === true) negRisk = true;
    } catch (e) { /* default false */ }
    try {
      // Try tick-size endpoint first (works with token IDs)
      const tsResp = await client.getTickSize(tokenId);
      if (tsResp) tickSize = tsResp.toString();
    } catch (e) {
      try {
        const marketInfo = await client.getMarket(tokenId);
        if (marketInfo?.minimum_tick_size) tickSize = marketInfo.minimum_tick_size.toString();
      } catch (e2) {
        console.log(`⚠️ Using default tick size ${tickSize}`);
      }
    }

    const tickDecimal = parseFloat(tickSize);
    const roundedPrice = Math.round(orderPrice / tickDecimal) * tickDecimal;

    const finalSize = Math.floor(size * 100) / 100;
    if (!finalSize || finalSize <= 0 || isNaN(roundedPrice) || roundedPrice <= 0 || roundedPrice >= 1) {
      return res.status(400).json({ error: `Invalid order params: size=${finalSize}, price=${roundedPrice}` });
    }

    console.log(`   Tick: ${tickSize}, negRisk: ${negRisk}, roundedPrice: ${roundedPrice}, size: ${finalSize}`);

    const response = await client.createAndPostOrder({
      tokenID: tokenId,
      price: roundedPrice,
      size: finalSize,
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

// Create a per-user CLOB client from their API credentials
async function createUserClient(apiKey, apiSecret, apiPassphrase, privateKey, signatureType = 1) {
  const userCreds = { key: apiKey, secret: apiSecret, passphrase: apiPassphrase };
  
  // Create signer from private key if provided (for EOA / type 1)
  let userSigner = undefined;
  if (privateKey) {
    try {
      userSigner = new Wallet(privateKey);
      console.log(`  User signer created: ${userSigner.address}`);
    } catch (err) {
      console.error(`  Failed to create signer: ${err.message}`);
    }
  }
  
  const userClient = new ClobClient(HOST, CHAIN_ID, userSigner, userCreds, signatureType, FUNDER);
  return userClient;
}

// Forward order (uses CLOB client directly)
app.post('/forward-order', auth, async (req, res) => {
  try {
    const { tokenId, side, amount, price, apiKey, apiSecret, apiPassphrase, privateKey, signatureType } = req.body;
    if (!tokenId || !side || !amount) return res.status(400).json({ error: 'Need tokenId, side, amount' });

    // Determine which client to use
    let orderClient;
    let isUserWallet = false;
    if (apiKey && apiSecret && apiPassphrase) {
      try {
        const userSignatureType = signatureType || 1; // Default to EOA
        orderClient = await createUserClient(apiKey, apiSecret, apiPassphrase, privateKey, userSignatureType);
        isUserWallet = true;
        console.log(`[forward-order] Using user wallet (key: ${apiKey.substring(0, 8)}..., type: ${userSignatureType})`);
      } catch (credErr) {
        return res.status(400).json({ error: `Invalid API credentials: ${credErr.message}` });
      }
    } else {
      if (!clientReady) return res.status(503).json({ error: 'Default client not ready', detail: initError });
      orderClient = client;
      console.log(`[forward-order] Using default wallet`);
    }

    const sideEnum = side === 'SELL' ? Side.SELL : Side.BUY;
    const orderPrice = parseFloat(price) || 0.5;
    const amt = parseFloat(amount) || 5;
    const size = amt / orderPrice;

    console.log(`[forward-order] Input: tokenId=${tokenId?.substring(0,20)}... side=${side} amount=${amt} price=${orderPrice} size=${size}`);

    let tickSize = '0.01', negRisk = false;
    try {
      const nrResp = await fetch(`${HOST}/neg-risk?token_id=${tokenId}`);
      const nrData = await nrResp.json();
      if (nrData.neg_risk === true) negRisk = true;
    } catch(e) { console.log('[forward-order] neg-risk check failed:', e.message); }
    try {
      const tsResp = await orderClient.getTickSize(tokenId);
      if (tsResp != null) tickSize = String(tsResp);
    } catch(e) {
      // Fall back to default client for market data if user client fails
      if (isUserWallet && clientReady) {
        try {
          const tsResp = await client.getTickSize(tokenId);
          if (tsResp != null) tickSize = String(tsResp);
        } catch(e2) {}
      }
      console.log('[forward-order] tick-size check failed:', e.message);
    }

    const tickDecimal = parseFloat(tickSize);
    const roundedPrice = Math.round(orderPrice / tickDecimal) * tickDecimal;

    const finalSize = Math.floor(size * 100) / 100;
    if (!finalSize || finalSize <= 0 || isNaN(roundedPrice) || roundedPrice <= 0 || roundedPrice >= 1) {
      return res.status(400).json({ error: `Invalid order params: size=${finalSize}, price=${roundedPrice}, amt=${amt}` });
    }

    console.log(`[forward-order] ${side} ${finalSize} shares @ ${roundedPrice} (negRisk=${negRisk}, tickSize=${tickSize})`);

    const response = await orderClient.createAndPostOrder({
      tokenID: tokenId,
      price: roundedPrice,
      size: finalSize,
      side: sideEnum,
    }, { tickSize, negRisk });

    console.log(`[forward-order] Result:`, JSON.stringify(response));

    res.json({
      success: response.success || !!response.orderID,
      orderID: response.orderID || response.orderid,
      status: response.status,
      userWallet: isUserWallet,
      ...response
    });
  } catch (err) {
    console.error('forward-order error:', err.message);
    res.status(500).json({ error: err.message.substring(0, 500) });
  }
});

// ============================================================
// Wallet Management
// ============================================================

// Create new wallet
app.post('/create-wallet', auth, async (req, res) => {
  try {
    const { telegramUserId } = req.body;
    
    if (!telegramUserId) {
      return res.status(400).json({ error: 'Missing telegramUserId' });
    }
    
    console.log(`[create-wallet] Generating new wallet for user ${telegramUserId}`);
    
    // Generate new random wallet
    const newWallet = Wallet.createRandom();
    const walletAddress = newWallet.address;
    const privateKey = newWallet.privateKey;
    
    console.log(`[create-wallet] Created wallet: ${walletAddress}`);
    
    // Derive CLOB API credentials from the wallet
    const tempClient = new ClobClient(HOST, CHAIN_ID, newWallet, undefined, SIGNATURE_TYPE, FUNDER);
    const apiCreds = await tempClient.createOrDeriveApiKey();
    
    if (!apiCreds || !apiCreds.key || !apiCreds.secret || !apiCreds.passphrase) {
      return res.status(500).json({ error: 'Failed to derive API credentials' });
    }
    
    console.log(`[create-wallet] Derived API key: ${apiCreds.key.substring(0, 8)}...`);
    
    // Return wallet info + API credentials
    // NOTE: Private key is returned so bot can store it encrypted
    res.json({
      walletAddress,
      privateKey,
      apiKey: apiCreds.key,
      apiSecret: apiCreds.secret,
      apiPassphrase: apiCreds.passphrase
    });
    
  } catch (err) {
    console.error('[create-wallet] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Import existing wallet
app.post('/import-wallet', auth, async (req, res) => {
  try {
    const { telegramUserId, privateKey } = req.body;
    
    if (!telegramUserId || !privateKey) {
      return res.status(400).json({ error: 'Missing telegramUserId or privateKey' });
    }
    
    console.log(`[import-wallet] Importing wallet for user ${telegramUserId}`);
    
    // Create wallet from private key
    let wallet;
    try {
      wallet = new Wallet(privateKey);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid private key format' });
    }
    
    const walletAddress = wallet.address;
    console.log(`[import-wallet] Wallet address: ${walletAddress}`);
    
    // Derive CLOB API credentials
    const tempClient = new ClobClient(HOST, CHAIN_ID, wallet, undefined, SIGNATURE_TYPE, FUNDER);
    const apiCreds = await tempClient.createOrDeriveApiKey();
    
    if (!apiCreds || !apiCreds.key || !apiCreds.secret || !apiCreds.passphrase) {
      return res.status(500).json({ error: 'Failed to derive API credentials' });
    }
    
    console.log(`[import-wallet] Derived API key: ${apiCreds.key.substring(0, 8)}...`);
    
    // Return wallet info + API credentials
    res.json({
      walletAddress,
      apiKey: apiCreds.key,
      apiSecret: apiCreds.secret,
      apiPassphrase: apiCreds.passphrase
    });
    
  } catch (err) {
    console.error('[import-wallet] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Polymarket Trader running on port ${PORT}`);
  await initClient();
});
