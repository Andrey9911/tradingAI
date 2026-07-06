# SKILL: Blockchain & RPC — Правила работы с блокчейном в проекте tradingAI

---

## 1. АРХИТЕКТУРА ВЗАИМОДЕЙСТВИЯ С БЛОКЧЕЙНОМ

### 1.1 Поддерживаемые сети и точки входа

| Сеть     | Протокол       | Базовый URL / env                                          | Сервис                    |
|----------|----------------|------------------------------------------------------------|---------------------------|
| Solana   | JSON-RPC 2.0   | `SOLANA_RPC_URL` + `?api-key=` + `SOLANA_RPC_KEY`          | `walletIntelService.mjs`  |
| TON      | REST (TonAPI)  | `TONAPI_BASE_URL` (default `https://tonapi.io/v2`)         | `tonService.mjs`          |
| BSC      | —              | Через GeckoTerminal REST API (индексация, не прямой RPC)   | `tokenDiscoveryService.mjs` |

### 1.2 Слой сервисов — правило изоляции

```
src/services/          ← Чистая бизнес-логика, работа с RPC и API
src/composers/         ← Grammy Composer, вызывает сервисы, форматирует вывод
```

- **Запрещено** импортировать `grammy` в слой `src/services/`.
- Сервис **не знает** о Telegram-контексте (`ctx`). Обратная связь — через callback `onStatusUpdate(message: string)`.
- Composer создаёт экземпляр сервиса, передаёт `onStatusUpdate`, форматирует результат для Telegram.

---

## 2. SOLANA JSON-RPC

### 2.1 Транспортный слой — `solanaRpc(method, params)`

Единая точка вызова Solana RPC. Находится в `WalletIntelService`:

```js
async solanaRpc(method, params = []) {
  const data = await fetchJson(this.solanaRpcUrl, {
    timeoutMs: this.timeoutMs,
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: `${Date.now()}-${Math.random()}`,
      method,
      params,
    },
  });
  if (data.error) throw new Error(data.error.message || `Solana RPC ${method} failed`);
  return data.result;
}
```

**Правила:**
- Всегда `jsonrpc: '2.0'`.
- `id` — уникальная строка `timestamp-random` (не числовой).
- При `data.error` — бросать `Error` с `data.error.message`.
- Возвращать `data.result` (не весь ответ).

### 2.2 Используемые RPC-методы Solana

| Метод                         | Параметры                                                          | Возвращает                     | Назначение                                        |
|-------------------------------|----------------------------------------------------------------------|--------------------------------|---------------------------------------------------|
| `getTokenSupply`              | `[mint]`                                                             | `result.value.uiAmount`        | Общий supply токена                               |
| `getTokenLargestAccounts`     | `[mint]`                                                             | `result.value[]`               | Топ-N холдеров по балансу (token accounts)        |
| `getAccountInfo`              | `[tokenAccount, { commitment: 'confirmed', encoding: 'jsonParsed' }]` | `result.value.data.parsed.info.owner` | Owner wallet из token account                     |
| `getSignaturesForAddress`     | `[address, { limit }]`                                               | `result[]` (signature objects) | История транзакций кошелька                       |
| `getTransaction`              | `[signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]` | Parsed transaction object      | Полные данные транзакции                          |

### 2.3 Паттерн: Token Account → Owner Wallet

Solana хранит балансы SPL-токенов в **Token Accounts** (промежуточные аккаунты).
Чтобы получить реального владельца:

```
mint → getTokenLargestAccounts → tokenAccount.address
      → getAccountInfo(tokenAccount) → .data.parsed.info.owner → wallet pubkey
```

**Важно:** Не путать `tokenAccount` (SPL account) и `owner` (wallet). `getTokenLargestAccounts` возвращает token accounts, а не wallets.

### 2.4 Паттерн: Funding Source Detection

Для определения первоисточника финансирования кошелька:

```
wallet → getSignaturesForAddress(wallet, 1000) → signatures[-1] (oldest)
       → getTransaction(oldest.signature) → parseSystemFunding(tx, wallet)
```

`parseSystemFunding` ищет:
1. `transfer` / `transferchecked` инструкции, где `destination === wallet`.
2. `createaccount` инструкции, где `newAccount === wallet`.
3. Fallback: сравнение `preBalances` / `postBalances` — кто больше всего потерял SOL.

### 2.5 Паттерн: Token Age через Timestamps

```js
// blockTime из getSignaturesForAddress / getTransaction
const walletAgeDays = Math.max(0, Math.round((Date.now() / 1000 - oldestBlockTime) / 86400));
const tokenCreatedAtSec = Date.now() / 1000 - ageMinutes * 60;
```

`blockTime` — **unix seconds** (не milliseconds!).

### 2.6 Encoding и Commitment

- **encoding**: Всегда `'jsonParsed'` для `getAccountInfo` и `getTransaction` — получаем структурированные данные вместо base64.
- **commitment**: Всегда `'confirmed'` (не `'finalized'` — слишком медленно для аналитики; не `'processed'` — слишком нестабильно).
- **maxSupportedTransactionVersion**: `0` — поддержка Versioned Transactions (v0).

---

## 3. TON (The Open Network) — REST API (TonAPI)

### 3.1 Транспортный слой — `TonService.fetchJson(pathname)`

```js
async fetchJson(pathname) {
  // Retry loop с exponential backoff при 429
  const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${this.apiKey}`,  // [SECURE_VARIABLE]
    },
    signal: controller.signal,
  });
}
```

**Правила:**
- Retry при `429 Too Many Requests` с задержкой `retryDelayMs * (attempt + 1)`.
- `404` → специальная ошибка `"TON Jetton not found"`, без retry.
- Авторизация через `Bearer` токен (`TONAPI_KEY`).

### 3.2 Используемые TonAPI endpoints

| Endpoint                                 | Назначение                                  |
|------------------------------------------|---------------------------------------------|
| `GET /jettons/{address}`                 | Информация о Jetton (supply, decimals, admin) |
| `GET /jettons/{address}/holders?limit=N` | Топ-N холдеров Jetton                       |

### 3.3 TON-специфичные паттерны

**Адреса TON:** Используется `@ton/core` → `Address.parse()`:
```js
// Нормализация → raw-формат (для сравнения)
Address.parse(value).toRawString();

// Отображение → bounceable + urlSafe (для пользователя)
Address.parse(value).toString({ bounceable: true, urlSafe: true });
```

**Bigint-арифметика для балансов TON:**
```js
// TON balance хранится как bigint строка → нужна bigint-конвертация
function percentOfSupply(balanceRaw, totalSupplyRaw) {
  const balance = BigInt(balanceRaw);
  const total = BigInt(totalSupplyRaw);
  return Number(balance * 1_000_000n / total) / 10_000; // % с точностью 0.01
}
```

**Admin/Renounced:** Если `admin_address` непустой → admin активен → повышенный риск.

---

## 4. DEX-АГРЕГАТОРЫ (REST API)

### 4.1 Источники данных

| Источник       | URL                                                                  | Метод  | Назначение                |
|----------------|----------------------------------------------------------------------|--------|---------------------------|
| Pump.fun       | `https://frontend-api-v3.pump.fun/coins?...`                        | GET    | Свежие Solana-токены      |
| DexScreener    | `https://api.dexscreener.com/latest/dex/search?q=...`               | GET    | Поиск пар по ключевому слову |
| GeckoTerminal  | `https://api.geckoterminal.com/api/v2/networks/{network}/trending_pools` | GET    | Трендовые пулы по сетям   |
| Pump.fun (dev) | `https://frontend-api-v3.pump.fun/coins/user-created-coins/{wallet}` | GET    | История токенов разработчика |

### 4.2 Паттерн: Multi-source aggregation

```js
const [pumpTokens, dexTokens, geckoTokens] = await Promise.all([
  this.fetchPumpFunTokens(onStatusUpdate),
  this.fetchDexScreenerTokens(onStatusUpdate),
  this.fetchGeckoTerminalTokens(onStatusUpdate),
]);

// Дедупликация по chain:address
const merged = uniqBy(
  [...pumpTokens, ...dexTokens, ...geckoTokens],
  token => `${token.chain}:${token.address || token.pairAddress}`.toLowerCase(),
);
```

### 4.3 Паттерн: Normalizer для каждого источника

Каждый DEX возвращает данные в своём формате. **Обязательно** создавать `normalize*` функцию, приводящую к единому формату:

```js
/** @typedef {Object} NormalizedToken
 * @property {string} chain       — 'solana' | 'eth' | 'bsc' | 'ton'
 * @property {string} address     — mint/contract address
 * @property {string} symbol      — тикер
 * @property {number} price       — цена в USD
 * @property {number} marketCap   — market cap USD
 * @property {number} liquidityUsd — ликвидность USD
 * @property {number} volume24h   — объём торгов 24h USD
 * @property {number} buys24h     — количество покупок 24h
 * @property {number} sells24h    — количество продаж 24h
 * @property {number} holders     — количество холдеров
 * @property {number} ageMinutes  — возраст токена/пула в минутах
 * @property {string} dex         — идентификатор DEX
 * @property {string} pairAddress — адрес торговой пары
 * @property {string} devWallet   — кошелёк создателя (если известен)
 * @property {string} source      — 'Pump.fun' | 'DexScreener' | 'GeckoTerminal'
 * @property {Object} riskFlags   — флаги подозрительности
 */
```

### 4.4 Fallback URLs

Для нестабильных API (Pump.fun) — использовать массив fallback URL:
```js
const urls = [
  'https://frontend-api-v3.pump.fun/coins?...',
  'https://frontend-api.pump.fun/coins?...',
];
for (const url of urls) {
  try { return await fetchJson(url); } catch {}
}
return [];
```

---

## 5. HTTP-ТРАНСПОРТ — ОБЩИЕ ПРАВИЛА

### 5.1 fetchJson — базовая функция

```js
async function fetchJson(url, { timeoutMs = 8000, method = 'GET', body = null } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'tradingai-<service>/1.0',
      },
      body: body ? JSON.stringify(body) : null,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
```

**Обязательные правила:**
1. `AbortController` + `setTimeout` для таймаута (не `fetch timeout` опция).
2. `clearTimeout` в `finally` (предотвращение утечки таймеров).
3. `user-agent` — идентификация сервиса (`tradingai-<service>/1.0`).
4. Проверка `response.ok` перед `.json()`.

### 5.2 Таймауты (env-переменные)

| Переменная                    | Default  | Назначение                        |
|-------------------------------|----------|-----------------------------------|
| `WALLET_INTEL_TIMEOUT_MS`     | `8000`   | Solana RPC + Pump.fun dev history |
| `TOKEN_DISCOVERY_TIMEOUT_MS`  | `8000`   | DexScreener, GeckoTerminal, Pump  |
| `TONAPI_TIMEOUT_MS`           | `8000`   | TonAPI REST                       |
| `TONAPI_RETRY_DELAY_MS`       | `1500`   | Задержка перед retry (TON)        |
| `TONAPI_MAX_RETRIES`          | `2`      | Макс. повторных попыток (TON)     |

### 5.3 Retry-стратегия

- **Solana RPC:** Без retry (один запрос, при ошибке — fallback intel).
- **TonAPI:** Retry при `429` с линейным backoff (`delay * (attempt + 1)`).
- **DEX API:** Без retry, но с fallback URL-ами (Pump.fun).

---

## 6. УТИЛИТАРНЫЕ ФУНКЦИИ — СТАНДАРТНАЯ БИБЛИОТЕКА ПРОЕКТА

Эти функции дублируются в нескольких сервисах. При создании нового блокчейн-сервиса — **копировать, не импортировать** (каждый сервис автономен).

### 6.1 Безопасное приведение типов

```js
// Безопасный Number с fallback
function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

// Первое положительное число из списка
function asPositiveNumber(...values) {
  for (const value of values) {
    const num = toNumber(value, NaN);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}

// Первая непустая строка из списка
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
```

### 6.2 Адресные утилиты

```js
// Краткий формат адреса для отображения (6 + ... + 4)
function shortAddress(address) {
  if (!address) return '—';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Нормализация (trim) для сравнения
function compactAddress(address) {
  return address ? String(address).trim() : '';
}
```

### 6.3 Дедупликация

```js
function uniqBy(items, getKey) {
  const seen = new Set();
  return items.filter(item => {
    const key = getKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

---

## 7. АНАЛИТИЧЕСКИЕ ПАТТЕРНЫ

### 7.1 Risk Classification (Solana)

Балльная система:
| Фактор                           | Баллы |
|----------------------------------|-------|
| Funding Cluster detected         | +3    |
| Previous rugpulls (×1, max 3)    | +1–3  |
| Top holder ≥ 20% supply          | +2    |
| Top-5 holders ≥ 45% supply       | +2    |
| Sniper behavior STRONG           | +2    |
| Sell pressure                    | +1    |

→ `score ≥ 5` → **HIGH**, `score ≥ 2` → **MEDIUM**, иначе **LOW**.

### 7.2 Risk Classification (TON)

Упрощённая модель (нет on-chain funding analysis):
- `top5Pct > 50%` → **HIGH**
- `activeAdmin && top5Pct >= 20%` → **HIGH**
- `activeAdmin` → **MEDIUM**
- `!activeAdmin && top5Pct < 20%` → **LOW**

### 7.3 Funding Cluster Detection

Группировка кошельков по `fundingSource` + проверка:
- ≥ 2 кошелька с одним funding source.
- Интервал финансирования ≤ `CLUSTER_TIME_WINDOW_MINUTES` (default 3 min).
- Координированные продажи (`sells24h >= max(5, buys24h * 0.8)`).

### 7.4 Sniper Detection

```
earlyEntries = holderWallets.filter(w => enteredToken - tokenCreated <= 180s)
≥ 2 → STRONG
= 1 || (age <= 15min && buys > 50) → POSSIBLE
else → NONE
```

### 7.5 Token Scoring (для ранжирования)

```js
score = log10(liquidityUsd + 1) * 20
      + log10(volume24h + 1) * 22
      + log10(holders + 1) * 18
      + buyPressure * 20           // buys / (buys + sells)
      - agePenalty * 10            // min(ageMinutes / 1440, 1)
```

---

## 8. ОБРАБОТКА ОШИБОК И FALLBACK

### 8.1 Fallback Intel

При любой ошибке RPC/API — возвращать `fallbackIntel(reason)`:
```js
function fallbackIntel(reason) {
  return {
    walletAgeDays: null,
    firstFundingSource: 'unknown',
    connectedWallets: 0,
    previousTokens: 0,
    previousRugpulls: 0,
    realizedProfit: 'needs-indexer',
    sniperBehavior: 'NONE',
    transferPattern: 'unknown',
    fundingCluster: { isClustered: false, source: '', wallets: [], reason },
    holderDistribution: { topHolderPct: 0, top5Pct: 0, highSupplyWallets: 0, analyzedWallets: 0 },
    devWallet: '',
    riskLevel: 'UNKNOWN',
    summary: reason,
  };
}
```

### 8.2 Правила обработки ошибок

1. **Никогда не бросать ошибку наружу из `analyzeToken`** — всегда возвращать `fallbackIntel`.
2. Логировать ошибку через `console.error` / `console.warn`.
3. При наличии `onStatusUpdate` — уведомить пользователя через callback.
4. Ошибка одного токена **не должна** блокировать анализ остальных (обработка в цикле).

---

## 9. ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (env)

Все блокчейн-переменные:

```env
# Solana RPC
SOLANA_RPC_URL=https://...            # [SECURE_VARIABLE]
SOLANA_RPC_KEY=...                    # [SECURE_VARIABLE]

# Solana Intel настройки
WALLET_INTEL_TIMEOUT_MS=8000
WALLET_INTEL_MAX_HOLDER_WALLETS=6
WALLET_INTEL_CLUSTER_WINDOW_MINUTES=3
WALLET_INTEL_HIGH_SUPPLY_SHARE=5

# TON
TONAPI_BASE_URL=https://tonapi.io/v2
TONAPI_KEY=...                        # [SECURE_VARIABLE]
TONAPI_TIMEOUT_MS=8000
TONAPI_RETRY_DELAY_MS=1500
TONAPI_MAX_RETRIES=2

# Token Discovery
TOKEN_DISCOVERY_TIMEOUT_MS=8000
SOL_PRICE_USD=180                     # используется Pump.fun для оценки ликвидности

# Фильтры по умолчанию (диапазоны [min, max])
# liquidityUsd: [10000, 150000]
# holders: [500, 10000]
# volume24h: [25000, 500000]
# ageMinutes: [10, 1440]
```

> **Важно:** Доступ к `process.env` должен осуществляться через `src/core/config.mjs` (по правилам проекта), однако текущие сервисы читают env напрямую. При рефакторинге — мигрировать на единый конфиг.

---

## 10. ЧЕКЛИСТ: СОЗДАНИЕ НОВОГО БЛОКЧЕЙН-СЕРВИСА

1. [ ] Создать файл `src/services/<chain>Service.mjs`.
2. [ ] Скопировать утилитарные функции (`toNumber`, `firstString`, `shortAddress`, `fetchJson`).
3. [ ] Реализовать класс с конструктором, принимающим `{ timeoutMs, rpcUrl/apiKey }`.
4. [ ] Единый метод транспорта (`rpc(method, params)` для JSON-RPC или `fetchJson(pathname)` для REST).
5. [ ] `AbortController` + `setTimeout` для всех HTTP-запросов.
6. [ ] Fallback-функция `unknown<Chain>Intel(reason)` с полной структурой.
7. [ ] `analyze<Chain>Token(token, onStatusUpdate)` — главный метод, возвращающий стандартизированную структуру `WalletIntel`.
8. [ ] Интегрировать в `WalletIntelService.analyzeToken()` через `chain === '<chain>'`.
9. [ ] Не импортировать `grammy` в сервис.
10. [ ] Пометить все секреты комментарием `// [SECURE_VARIABLE]`.
11. [ ] Все env-переменные — через `parseInt(..., 10)` / `parseFloat(...)` с fallback значениями.

---

## 11. АНТИПАТТЕРНЫ — ЧТО НЕ ДЕЛАТЬ

| ❌ Антипаттерн | ✅ Правильный подход |
|---|---|
| `require()` для импортов | ESM `import` / `export` |
| Хардкод RPC URL в коде | `process.env` → env-переменная |
| `fetch` без таймаута | `AbortController` + `setTimeout` |
| Бросать ошибку из `analyzeToken` | Вернуть `fallbackIntel(reason)` |
| Числовые `id` в JSON-RPC | Строковый `id`: `${Date.now()}-${Math.random()}` |
| Сравнение адресов без нормализации | `compactAddress()` / `normalizeTonAddress()` |
| `encoding: 'base64'` для Solana | `encoding: 'jsonParsed'` |
| `commitment: 'finalized'` для аналитики | `commitment: 'confirmed'` |
| `any` в JSDoc | Конкретные `@typedef` / `@param` |

---

## 12. ИНТЕГРАЦИЯ CEX (CCXT + TECHNICALINDICATORS)

### 12.1 Архитектура и изоляция
- Логика работы с биржами (CEX) и вычисления индикаторов должна располагаться в слое сервисов, например `src/services/ExchangeService.mjs` или `src/services/ccxtService.mjs`.
- **Запрещено** импортировать Telegram-контекст или `grammy` в этот сервис. Все данные возвращаются в виде структурированных объектов и форматируются на уровне Composer.

### 12.2 Работа с CCXT
- Использовать строгий ESM импорт: `import ccxt from 'ccxt';`.
- Инициализация биржи должна происходить с передачей ключей и обязательным включением `enableRateLimit`:
  ```js
  const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,    // [SECURE_VARIABLE]
    secret: process.env.BINANCE_SECRET,     // [SECURE_VARIABLE]
    enableRateLimit: true,
  });
  ```
- Все вызовы API (например, `fetchOHLCV`) необходимо оборачивать в `try/catch`. При ошибке возвращать безопасный `fallback` объект, не допуская падения приложения. Ошибка логируется и, при необходимости, передается на уровень выше.

### 12.3 Подготовка данных для `technicalindicators`
- Метод `ccxt.fetchOHLCV` возвращает список свечей в формате: `[ timestamp, open, high, low, close, volume ]`.
- Для `technicalindicators` необходимо извлекать отдельные массивы:
  ```js
  const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  const closePrices = ohlcv.map(candle => candle[4]);
  const highPrices = ohlcv.map(candle => candle[2]);
  const lowPrices = ohlcv.map(candle => candle[3]);
  const volumes = ohlcv.map(candle => candle[5]);
  ```

### 12.4 Вычисление индикаторов и типизация (JSDoc)
- Запрещено использовать тип `any`. Использовать JSDoc (`@typedef`, `@param`, `@returns`).
- **Пример расчета RSI:**
  ```js
  import { RSI } from 'technicalindicators';

  /**
   * Вычисляет RSI на основе цен закрытия.
   * @param {number[]} closePrices Массив цен закрытия.
   * @param {number} period Период индикатора (по умолчанию 14).
   * @returns {number[]} Массив значений RSI.
   */
  function calculateRSI(closePrices, period = 14) {
    if (closePrices.length <= period) return [];
    
    return RSI.calculate({
      values: closePrices,
      period,
    });
  }
  ```
- Для комплексных индикаторов (например, MACD) результаты должны описываться через `@typedef`.

