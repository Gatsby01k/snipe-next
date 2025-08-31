# Creator-Snipe x100 (Solana) — Next.js

Готовый к запуску проект: авто-мониторинг Dexscreener, Buy/Sell через Jupiter v6, риск-чек (RugCheck/эвристика), частичная продажа и быстрый своп в USDC.

## Запуск
```bash
npm install
cp .env.example .env.local
npm run dev
```

Открой `http://localhost:3000`, нажми **Connect Wallet**.

## Env
В `.env.local` укажи RPC:
```
NEXT_PUBLIC_SOLANA_RPC=https://api.mainnet-beta.solana.com
```

## Деплой
Залей на GitHub → импортируй в Vercel → добавь переменную `NEXT_PUBLIC_SOLANA_RPC` → Deploy.
