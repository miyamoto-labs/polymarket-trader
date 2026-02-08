# Polymarket Trading Microservice

A lightweight Express.js API that wraps the Polymarket CLOB client for automated trading from n8n.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check + status |
| GET | `/balance` | Open orders |
| GET | `/price/:tokenId` | Market price + spread |
| POST | `/bet` | Place a bet |
| DELETE | `/order/:orderId` | Cancel order |
| GET | `/trades` | Trade history |

## Place a Bet

```bash
curl -X POST https://your-app.railway.app/bet \
  -H "Content-Type: application/json" \
  -H "x-api-key: pm-trader-erik-2026" \
  -d '{
    "tokenId": "71321045679252212594626385532706912750332728571942532289631379312455583992563",
    "side": "BUY",
    "amount": 5,
    "price": 0.65
  }'
```

## Deploy to Railway

1. Push to GitHub
2. Connect repo on railway.app
3. Set environment variables:
   - `PRIVATE_KEY`
   - `FUNDER_ADDRESS`
   - `SIGNATURE_TYPE`
   - `API_SECRET`
4. Deploy

## n8n Integration

The n8n workflow calls `POST /bet` when user taps ✅ on a Telegram pick.
Auth via `x-api-key` header.
