import { z } from 'zod';

/**
 * Бесплатные модели OpenRouter (порядок = приоритет).
 * Переопределение: OPENROUTER_FREE_MODELS="model/a:free,model/b:free"
 */
export const OPENROUTER_FREE_MODELS = [
  'openrouter/free',
  'stepfun/step-3.5-flash:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'google/gemma-4-31b-it:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'cohere/north-mini-code:free'
];

const ROTATE_STATUSES = new Set([408, 429, 502, 503, 504]);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseModelsFromEnv() {
  const raw = process.env.OPENROUTER_FREE_MODELS;
  if (!raw?.trim()) return null;
  const list = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

/** Статусы и тела ответа, при которых пробуем следующую модель без показа ошибки пользователю */
function shouldTryNextModel(httpStatus, body) {
  if (ROTATE_STATUSES.has(httpStatus)) return true;
  if (httpStatus === 400 && body?.error?.message) {
    const m = String(body.error.message).toLowerCase();
    if (
      m.includes('rate') ||
      m.includes('limit') ||
      m.includes('capacity') ||
      m.includes('overload') ||
      m.includes('unavailable') ||
      m.includes('model')
    ) {
      return true;
    }
  }
  if (body?.error && !body?.choices?.length) {
    const code = body.error.code;
    if (code === 429 || code === 503) return true;
    const msg = String(body.error.message || '').toLowerCase();
    if (
      msg.includes('rate') ||
      msg.includes('overloaded') ||
      msg.includes('capacity')
    ) {
      return true;
    }
  }
  return false;
}

// Схема для ответа AI (можно расширить)
const aiResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string(),
      }),
    }),
  ),
});

export class AIService {
  constructor() {
    this.apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.models = parseModelsFromEnv() ?? [...OPENROUTER_FREE_MODELS];
    this.generatedPostsCache = {}; // In-Memory Cache для сгенерированных постов
  }

  /**
   * POST chat/completions с перебором моделей при 429 и др.
   * @param {{ messages: Array, max_tokens?: number, temperature?: number }} opts
   * @returns {Promise<{ choices?: unknown[], error?: unknown }>}
   */
  async chatWithModelFallback(opts, onStatusUpdate) {
    const { messages, max_tokens = 512, temperature = 0.7 } = opts;
    let lastErr = null;

    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[i];
      try {
        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens,
            temperature,
            ...(opts.response_format ? { response_format: opts.response_format } : {})
          }),
        });

        const text = await response.text();
        let data;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          lastErr = new Error(`OpenRouter: невалидный JSON (${model})`);
          if (shouldTryNextModel(response.status, {})) continue;
          throw lastErr;
        }

        if (!response.ok) {
          if (ROTATE_STATUSES.has(response.status)) {
            // Если получили 429 или 5xx, уведомляем интерфейс через колбэк
            if (onStatusUpdate) {
              await onStatusUpdate(`⚠️ [OpenRouter] ${model} → ${response.status}, следующая модель...`);
            }
            continue;
          }
          lastErr = new Error(
            data?.error?.message || `HTTP ${response.status}`,
          );
          if (shouldTryNextModel(response.status, data)) {
            console.warn(
              `[OpenRouter] ${model} → ${response.status}, следующая модель…`,
            );
            if (response.status === 429) await sleep(350 + i * 150);
            else await sleep(120);
            continue;
          }
          throw lastErr;
        }

        if (data?.choices?.[0]?.message?.content != null) {
          return data;
        }

        if (data.error && shouldTryNextModel(200, data)) {
          console.warn(
            `[OpenRouter] ${model} error in body, следующая модель…`,
            data.error,
          );
          lastErr = new Error(data.error.message || 'OpenRouter error');
          await sleep(200);
          continue;
        }

        return data;
      } catch (err) {
        if (onStatusUpdate) {
          await onStatusUpdate(`❌ Ошибка сети на ${model}, пробую другую...`);
        }
      }
    }

    throw lastErr ?? new Error('OpenRouter: все бесплатные модели недоступны');
  }

  /** Получает совет от ИИ по выставленному лимитному ордеру на основе текущих метрик. */
  async getOrderAdvice(metrics) {
    const prompt = `Ты опытный трейдер. Оцени ситуацию:
Монета: ${metrics.symbol}
Ордер на ${metrics.side === 'Buy' ? 'покупку' : 'продажу'} по цене ${metrics.orderPrice}
Текущая цена: ${metrics.currentPrice}
Изменение за 24ч: ${metrics.change24h}%
Объём за 24ч: ${metrics.volume24h}

Дай краткий (1-2 предложения) совет: стоит ли ждать исполнения ордера или лучше его отменить? Учитывай технические индикаторы и рыночную динамику.`;

    try {
      const data = await this.chatWithModelFallback({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.7,
      });
      const validated = aiResponseSchema.parse(data);
      return validated.choices[0].message.content.trim();
    } catch (error) {
      console.error('AI advice error:', error);
      return 'Не удалось получить совет. Проверьте настройки API.';
    }
  }

  /** Формирует совет от ИИ по управлению портфелем (фиксация прибыли или усреднение позиций). */
  async getPortfolioAdvice(sellCandidates, buyCandidates, thresholds = {}) {
    const sellPct = thresholds.sellPct ?? 5;
    const buyPct = thresholds.buyPct ?? 10;

    const line = c =>
      `${c.coin}: спред ${c.spread >= 0 ? '+' : ''}${c.spread.toFixed(2)}% от последней покупки; ` +
      `последняя покупка ${c.lastBuyPrice}, сейчас ${c.currentPrice}; ` +
      `оценка позиции ~${(c.usdValue ?? 0).toFixed(2)} USDT; 24ч ${(c.change24h ?? 0).toFixed(2)}%`;

    const sellText =
      sellCandidates.length > 0
        ? sellCandidates.map(line).join('\n')
        : 'Нет активов выше порога для фиксации прибыли.';
    const buyText =
      buyCandidates.length > 0
        ? buyCandidates.map(line).join('\n')
        : 'Нет активов ниже порога для усреднения.';

    const prompt = `Ты опытный криптотрейдер. У меня спот на Bybit.
Пороги: считаем сигнал к продаже, если текущая цена выше последней цены покупки на ${sellPct}% и более.
Сигнал к докупке/усреднению — если текущая цена ниже последней покупки на ${buyPct}% и более (просадка от точки входа).

Кандидаты на продажу (по спреду):
${sellText}

Кандидаты на докупку/усреднение (просадка от последней покупки):
${buyText}

Дай краткий совет на русском (1 прямое предложение): стоит ли рассматривать фиксацию по «продажам» и усреднение по «покупкам», на что обратить внимание. Без списков и markdown, обычный текст.
Используй эмоджи, где это нужно`;

    try {
      const data = await this.chatWithModelFallback({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
        temperature: 0.7,
      });

      const content = data?.choices?.[0]?.message?.content;

      if (!content) {
        console.error('OpenRouter вернул пустой ответ или ошибку:', data);
        return 'Нейросеть не смогла сформировать совет. Попробуйте позже.';
      }

      return content.trim();
    } catch (err) {
      console.error('Ошибка при запросе к AI:', err.message);
      return '⚠️ Нейросеть сейчас недоступна, но математический анализ выполнен.';
    }
  }

  /** Оценивает точку входа с помощью ИИ на основе метрик объема, RSI, Funding и Open Interest. */
  async evaluateEntrySignal(metrics, onStatusUpdate = null) {
    const closesStr = metrics.closes?.length
      ? metrics.closes.map(c => c.toFixed(8)).join(',')
      : 'нет';

    // Форматируем новые метрики для промпта
    const oiChange = metrics.oiChangePct != null ? `${metrics.oiChangePct > 0 ? '+' : ''}${metrics.oiChangePct.toFixed(2)}% (за 1ч)` : 'н/д (нет фьючерсов)';
    const fundRate = metrics.fundingRate != null ? `${metrics.fundingRate.toFixed(4)}%` : 'н/д';
    const ls = metrics.lsRatio != null ? metrics.lsRatio.toFixed(2) : 'н/д';
    const vSpike = metrics.volumeSpike != null ? `${metrics.volumeSpike.toFixed(2)}x` : 'н/д';

    const prompt = `Ты профессиональный крипто-трейдер и аналитик. Оцени вероятность прибыльного входа (BUY) для монеты в ближайшие 24-48 часов.

Символ: ${metrics.symbol}
Текущая цена: ${metrics.lastPrice} (Изменение 24ч: ${metrics.change24h.toFixed(2)}%)
RSI(14) по закрытиям 1h: ${metrics.rsi14 != null ? metrics.rsi14.toFixed(2) : 'н/д'}
Спред стакана (ликвидность): ${metrics.spreadPct != null ? metrics.spreadPct.toFixed(4) + '%' : 'н/д'}

📊 ДЕРИВАТИВНЫЕ И ОБЪЕМНЫЕ МЕТРИКИ:
- Open Interest (OI) Change: ${oiChange} -> Приток или отток ликвидности.
- Funding Rate: ${fundRate} -> Настроение толпы и риск сжатия (squeeze).
- Long/Short Ratio: ${ls} -> Позиционирование толпы (больше 1 = толпа в лонгах).
- Volume Spike: ${vSpike} -> Текущий объем 1h относительно среднего (поиск аномалий).

ИНСТРУКЦИЯ ПО ЛОГИКЕ АНАЛИЗА (Строго применяй!):
1. Логика OI + Цена:
   - Цена растет + OI растет = Истинный бычий тренд, аккумуляция лонгов [Bullish].
   - Цена растет + OI падает = Фиксация прибыли, тренд выдыхается (Short Cover) [Caution/Bearish].
   - Цена падает + OI растет = Агрессивные продажи, аккумуляция шортов [Bearish].
2. Объемы и RSI: Учитывай зоны перекупленности (RSI > 70) и перепроданности (RSI < 30). Volume Spike > 2.0x подтверждает силу текущего движения.
3. Funding: Сильно отрицательный фандинг при растущей цене и растущем OI — признак мощного шорт-сквиза (сигнал BUY).

На основе метрик выше, дай финальный вердикт. 
Ответь СТРОГО одной строкой JSON без markdown: {"verdict":"BUY"|"WAIT"|"AVOID","reason":"кратко по-русски, укажи влияние OI/Funding"}`;

    try {
      const data = await this.chatWithModelFallback({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100000,
        temperature: 0.35,
      }, onStatusUpdate); // <-- Передаем колбэк дальше

      const raw = data.choices[0].message.content || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { verdict: 'WAIT', reason: 'Не удалось разобрать ответ ИИ.' };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      const v = String(parsed.verdict || '').toUpperCase();
      const verdict = v === 'BUY' ? 'BUY' : v === 'AVOID' ? 'AVOID' : 'WAIT';
      return {
        verdict,
        reason: String(parsed.reason || '').slice(0, 500),
      };
    } catch (err) {
      console.error('evaluateEntrySignal:', err);
      return { verdict: 'WAIT', reason: 'Ошибка запроса к ИИ.' };
    }
  }

  /** Извлекает структурированный JSON торгового сигнала из сырого текста поста Telegram. */
  async parseTelegramSignalPost(rawText) {
    const prompt = `Ты парсер торговых сигналов из Telegram. Извлеки данные из текста поста.
Твой формат ответа:
{
  "symbol": "BASEUSDT",
  "side": "BUY" или "SELL",
  "marketType": "SPOT" или "FUTURES",
  "entry": { "type": "RANGE"|"LEVELS"|"SINGLE", "min": number|null, "max": number|null, "levels": number[] },
  "takeProfits": number[],
  "stopLoss": number|null,
  "leverage": number|null,
  "timeframe": string|null,
  "rawConfidence": "HIGH"|"MEDIUM"|"LOW"|null,
  "warnings": string[]
}
Правила:
- symbol: базовая монета в виде XXXUSDT (если в тексте SOL или $SOL — symbol "SOLUSDT"; если SOL/USDT — "SOLUSDT").
- Если направление покупка лонг — side BUY; шорт/продажа — SELL.
- Если явно спот — SPOT; иначе по умолчанию SPOT если не указаны плечо/фьючерс.
- entry: RANGE если диапазон цен; SINGLE если одна цена; LEVELS если список уровней.
- takeProfits: по возрастанию для лонга; пустой массив если нет.
- stopLoss: число или null если в посте нет SL; тогда warnings включает "NO_STOP_LOSS".
- warnings: краткие коды на английском при проблемах.


Текст поста:
---
${rawText.slice(0, 12000)}
---

... после текста поста верни ТОЛЬКО JSON между маркерами:
<<<START>>>
{...}
<<<END>>>.`;
  }


  /**
   * Универсальный метод оценки токенов и сигналов с помощью ИИ.
   * Поддерживает как токены из Web3 Discovery, так и сигналы пользователей из Signal Analysis.
   * 
   * @param {Object} input - Токен из Discovery или aggregatedData из Signal Analysis
   * @param {Function} [onStatusUpdate] - Функция для обновления статуса анализа
   * @param {Array} [researchContext] - Дополнительный контекст ресерча
   * @returns {Promise<{ verdict: string, riskLevel: string, reason: string }>}
   */
  async evaluateDiscoveredToken(input, onStatusUpdate = null, researchContext = []) {
    const researchText = Array.isArray(researchContext) && researchContext.length
      ? researchContext
        .map((item, index) => `${index + 1}. ${item.summary || item.insights || ''}\nSignals: ${(item.signals || []).join(', ')}`)
        .join('\n\n')
        .slice(0, 5000)
      : 'нет свежего short-term research context';

    // Проверяем тип входных данных (Signal Analysis или Web3 Discovery)
    const isSignalAnalysis = Boolean(input && (input.ticker || input.description || input.market || input.technical_analysis));

    let riskLevel = 'UNKNOWN';
    let features = [];
    let onchainBlock = 'нет on-chain данных (неподдерживаемая сеть или CEX актив)';

    if (isSignalAnalysis) {
      if (input.onchain) {
        riskLevel = input.onchain.riskLevel || 'UNKNOWN';
        features = input.onchain.features || [];
        onchainBlock = JSON.stringify({
          riskLevel,
          features,
          ...(input.onchain.fundingCluster ? { fundingCluster: input.onchain.fundingCluster } : {}),
          ...(input.onchain.sniperBehavior ? { sniperBehavior: input.onchain.sniperBehavior } : {}),
          ...(input.onchain.transferPattern ? { transferPattern: input.onchain.transferPattern } : {}),
          ...(input.onchain.holderDistribution ? { holderDistribution: input.onchain.holderDistribution } : {}),
          ...(input.onchain.knowledgeGraph ? { knowledgeGraph: input.onchain.knowledgeGraph } : {}),
          ...(input.onchain.devWallet ? { devWallet: input.onchain.devWallet } : {}),
          ...(input.onchain.walletAgeDays != null ? { walletAgeDays: input.onchain.walletAgeDays } : {}),
          ...(input.onchain.firstFundingSource ? { firstFundingSource: input.onchain.firstFundingSource } : {}),
          ...(input.onchain.connectedWallets != null ? { connectedWallets: input.onchain.connectedWallets } : {}),
          ...(input.onchain.previousTokens != null ? { previousTokens: input.onchain.previousTokens } : {}),
          ...(input.onchain.previousRugpulls != null ? { previousRugpulls: input.onchain.previousRugpulls } : {}),
          ...(input.onchain.realizedProfit ? { realizedProfit: input.onchain.realizedProfit } : {}),
          ...(input.onchain.summary ? { summary: input.onchain.summary } : {}),
          ...(input.onchain.token ? { token: input.onchain.token } : {}),
          ...(input.onchain.topRecentTrades ? { topRecentTrades: input.onchain.topRecentTrades } : {}),
        }, null, 2);
      }
    } else {
      const wi = input?.walletIntel || {};
      riskLevel = wi.riskLevel || 'UNKNOWN';
      features = wi.features || [];
      if (input?.walletIntel && (features.length > 0 || riskLevel !== 'UNKNOWN')) {
        onchainBlock = JSON.stringify({
          riskLevel,
          features,
          ...(wi.fundingCluster ? { fundingCluster: wi.fundingCluster } : {}),
          ...(wi.sniperBehavior ? { sniperBehavior: wi.sniperBehavior } : {}),
          ...(wi.transferPattern ? { transferPattern: wi.transferPattern } : {}),
        }, null, 2);
      }
    }

    let prompt = '';

    if (isSignalAnalysis) {
      prompt = `Ты профессиональный крипто-аналитик и риск-менеджер. Проанализируй сигнал от пользователя и собранные метрики.

СИГНАЛ ПОЛЬЗОВАТЕЛЯ:
Тикер: ${input.ticker || '—'}
Направление: ${input.direction || 'не указано'}
Описание: ${input.description || 'нет'}

ПРИОРИТЕТ 1 — Рыночные и технические данные:
Рынок: ${JSON.stringify(input.market || {}, null, 2)}
Технический анализ: ${JSON.stringify(input.technical_analysis || {}, null, 2)}
Ликвидность стакана CEX: ${JSON.stringify(input.liquidityClusters || {}, null, 2)}
Деривативы (Funding/OI/LS): ${JSON.stringify(input.derivatives || {}, null, 2)}
Новости: ${JSON.stringify(input.news || {}, null, 2)}

ПРИОРИТЕТ 2 — On-chain Wallet Intelligence (Признаки и Risk Level):
${onchainBlock}

Свежий research context:
${researchText}

ИНСТРУКЦИЯ ПО АНАЛИЗУ (СТРОГИЙ ПРИОРИТЕТ!):
1. **ВЫСШИЙ ПРИОРИТЕТ — ПРИЗНАКИ И РИСК**: Первостепенно опирайся на готовые интерпретированные признаки (features) и уровень риска (riskLevel). В массиве features каждая фича (например developer_trust, holder_concentration, funding_cluster_score, sniper_probability, transfer_pattern_score) уже вычислена и содержит точность (confidence) и причину (reason). Верь этим признакам и риску в первую очередь!
2. **ВТОРОСТЕПЕННЫЙ ПРИОРИТЕТ — СЫРЫЕ ДАННЫЕ**: Сырые рыночные и технические данные (цены, объемы, свечи, RSI, EMA, ордербук) используй ВО ВТОРУЮ ОЧЕРЕДЬ как вспомогательный контекст для определения точек входа/выхода или если riskLevel = UNKNOWN / on-chain признаки отсутствуют.
3. Оцени соответствие сигнала рыночной обстановке с учетом направления (LONG/SHORT), если оно указано.
4. Отвечай СТРОГО на русском языке. Вердикт должен быть строго одним из: "ПОКУПАТЬ", "ПРОДАВАТЬ", "ЖДАТЬ", "ИЗБЕГАТЬ".
5. Если есть Take Profit/Stop Loss в сигнале, то в вердикте укажи твою точку зрения по поводу этих уровней.
6.Основываясь на техническом анализе и кластеру ликвидности, укажи примерные значения входа в сделку (учитывай пробития ниже уровней)
Ответь  без markdown:
{"verdict":"ПОКУПАТЬ"|"ПРОДАВАТЬ"|"ЖДАТЬ"|"ИЗБЕГАТЬ","riskLevel":"LOW"|"MEDIUM"|"HIGH","reason":"по-русски, 1-5 предложения, опирайся в первую очередь на признаки и риск-профиль. при анализе cex выдай вердикт о примерных будущих прогнозах, основываясь на уровнях поддержки, сопротивления, объёмах, инсайдерах и исторических данных."}`;
    } else {
      prompt = `Ты профессиональный Web3-аналитик мемкоинов и новых DEX-пулов. Торговля НЕ автоматическая: нужен сигнал для ручного решения.

ПРИОРИТЕТ 1 — On-chain Wallet Intelligence (Признаки и Risk Level):
${onchainBlock}

ПРИОРИТЕТ 2 — CEX/DEX метрики токена:
${JSON.stringify({
        chain: input.chain,
        address: input.address,
        symbol: input.symbol,
        price: input.price,
        marketCap: input.marketCap,
        liquidityUsd: input.liquidityUsd,
        volume24h: input.volume24h,
        buys24h: input.buys24h,
        sells24h: input.sells24h,
        holders: input.holders,
        ageMinutes: input.ageMinutes,
        dex: input.dex,
        pairAddress: input.pairAddress,
        source: input.source,
      }, null, 2)}
      Технический анализ: ${JSON.stringify(input.technical_analysis || {}, null, 2)}

Свежий research context из Telegram-каналов:
${researchText}

ИНСТРУКЦИЯ ПО АНАЛИЗУ (СТРОГИЙ ПРИОРИТЕТ!):
1. **ВЫСШИЙ ПРИОРИТЕТ — ПРИЗНАКИ И РИСК**: В первую очередь опирайся на готовые интерпретированные признаки (features) и уровень риска (riskLevel). Каждая фича в массиве features (например developer_trust, holder_concentration, funding_cluster_score, sniper_probability, transfer_pattern_score) уже вычислена и содержит точность (confidence) и причину (reason). Не пересчитывай сырые данные вручную, верь готовым признакам и риску!
2. **ВТОРОСТЕПЕННЫЙ ПРИОРИТЕТ — СЫРЫЕ ДАННЫЕ**: Сырые метрики токена (ликвидность, объемы, buy/sell pressure, возраст пула) используй ВО ВТОРУЮ ОЧЕРЕДЬ как дополнительный контекст или если riskLevel = UNKNOWN / on-chain признаки отсутствуют.
3. Research context: учти свежие инсайты из Telegram-каналов.
4. Отвечай СТРОГО на русском языке. Вердикт должен быть строго одним из: "ПОКУПАТЬ", "ЖДАТЬ", "ИЗБЕГАТЬ".

Ответь СТРОГО одной строкой JSON без markdown: {"verdict":"ПОКУПАТЬ"|"ЖДАТЬ"|"ИЗБЕГАТЬ","riskLevel":"LOW"|"MEDIUM"|"HIGH","reason":"по-русски, 1-2 предложения, обязательно опирайся на признаки и риск-профиль"}`;
    }

    try {
      const data = await this.chatWithModelFallback({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 22000,
        temperature: 0.4,
      }, onStatusUpdate);
      const raw = data?.choices?.[0]?.message?.content?.trim() || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { verdict: 'ЖДАТЬ', riskLevel: riskLevel !== 'UNKNOWN' ? riskLevel : 'MEDIUM', reason: raw.slice(0, 500) || 'ИИ не вернул структурированный ответ.' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const verdictRaw = String(parsed.verdict || '').trim().toUpperCase();
      const riskRaw = String(parsed.riskLevel || riskLevel || '').toUpperCase();

      let verdict = 'ЖДАТЬ';
      if (['BUY', 'ПОКУПАТЬ', 'ПОКУПКА', 'LONG', 'ЛОНГ'].includes(verdictRaw)) verdict = 'ПОКУПАТЬ';
      else if (['SELL', 'ПРОДАВАТЬ', 'ПРОДАЖА', 'SHORT', 'ШОРТ'].includes(verdictRaw)) verdict = 'ПРОДАВАТЬ';
      else if (['AVOID', 'ИЗБЕГАТЬ', 'ОПАСНО'].includes(verdictRaw)) verdict = 'ИЗБЕГАТЬ';
      else if (['WAIT', 'ЖДАТЬ', 'ОЖИДАНИЕ'].includes(verdictRaw)) verdict = 'ЖДАТЬ';
      else verdict = verdictRaw || 'ЖДАТЬ';

      return {
        verdict,
        riskLevel: riskRaw === 'LOW' ? 'LOW' : riskRaw === 'HIGH' ? 'HIGH' : 'MEDIUM',
        reason: String(parsed.reason || '').slice(0, 1000),
      };
    } catch (err) {
      console.error('evaluateDiscoveredToken:', err);
      return { verdict: 'ЖДАТЬ', riskLevel: riskLevel !== 'UNKNOWN' ? riskLevel : 'MEDIUM', reason: 'Ошибка AI-анализа.' };
    }
  }



  /** Формирует краткое текстовое объяснение для уже рассчитанного детерминированного торгового сигнала. */
  async explainSignalAnalysisNarrative(ctx) {
    const prompt = `Ты крипто-аналитик. Вердикт и оценка уже рассчитаны детерминированно — их НЕЛЬЗЯ менять, только объясни почему так может выглядеть рынок.

Символ: ${ctx.symbol}, сторона: ${ctx.side}
Вердикт: ${ctx.verdict}, score: ${ctx.score}/100, риск: ${ctx.risk}
Статус цены относительно entry: ${ctx.entryStatus}
RSI 1h: ${ctx.rsi != null ? ctx.rsi.toFixed(1) : 'н/д'}
Funding: ${ctx.funding != null ? (ctx.funding >= 0 ? '+' : '') + ctx.funding.toFixed(4) + '%' : 'н/д'}
OI 1h: ${ctx.oi1h != null ? (ctx.oi1h >= 0 ? '+' : '') + ctx.oi1h.toFixed(2) + '%' : 'н/д'}
Спред: ${ctx.spreadPct != null ? ctx.spreadPct.toFixed(4) + '%' : 'н/д'}
RR TP1/TP2: ${ctx.rr?.tp1 != null ? ctx.rr.tp1.toFixed(2) : '—'} / ${ctx.rr?.tp2 != null ? ctx.rr.tp2.toFixed(2) : '—'}
SL в сигнале: ${ctx.hasSl ? 'да' : 'нет'}

Напиши 2–4 коротких предложения по-русски, без markdown, без списков. Не противоречь вердикту ${ctx.verdict}.`;

    try {
      const data = await this.chatWithModelFallback({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 20020,
        temperature: 0.45,
      });
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return text.slice(0, 900);
    } catch (err) {
      console.error('explainSignalAnalysisNarrative:', err);
    }
    return 'Краткий вывод сформирован по метрикам; нейросеть не смогла добавить пояснение.';
  }

  /** Генерирует черновик поста для автопостинга в Telegram и другие платформы на основе diff-изменений. */
  async createAutopostingDraft(context) {
  
    const { diffSummary, diffText, pastPosts = [], idea = '' } = context;
    const prompt = `Ты — девушка Катя - криптоаналитик, разработчик и автор инсайдерского Telegram-канала Trading AI.
Твоя задача: проанализировать изменения в коде (diff) и написать короткий, интригующий пост об обновлениях проекта.

Правила стиля для поста:
1. Краткость и динамика: Пиши емко, без воды. Используй короткие абзацы (1-3 предложения).
2. Интрига: Зацепи внимание с первого предложения. Делай акцент на том, какую пользу принесут эти изменения.
3. Эмодзи: Органично используй релевантные эмодзи.
4. Тон: Уверенный, аналитический, местами тонко-юморной, местами ироничный. Используй сленг разработчиков и криптанов.
5. Не обещай автотрейдинг, только AI-отчеты и сигналы для ручного принятия решений.

Интеграция (Soft Shill):
Сформируй отдельный текст для нативной, "холодной" интеграции нашего закрытого продукта.
Контекст: Проект \`tradingAI\` — приватный Telegram-бот для автоматизации (Bybit, TON), парсинга каналов и обработки сигналов с помощью ИИ.
Намекни, что благодаря боту анализ рынка и отдельных токенов стал более автоматизированным, но еще в некоторых местах недоработан.

Идея пользователя:
${String(idea || 'нет').slice(0, 2000)}

Сводка изменений:
${JSON.stringify(diffSummary, null, 2)}

Diff:
${String(diffText || '').slice(0, 14000)}

Прошлые посты для сохранения уникальности:
${pastPosts.map((post, index) => `${index + 1}. ${String(post).slice(0, 700)}`).join('\n\n') || 'нет'}

Верни ответ СТРОГО в JSON формате. Схема JSON:
{
  "title": "Заголовок для других платформ",
  "telegramText": "Основной текст поста для Telegram (интригующая выжимка с эмодзи)",
  "habrMarkdown": "Markdown draft для Habr",
  "dzenHtml": "HTML body для Dzen",
  "uniquenessNotes": "Заметки об уникальности (отличие от прошлых постов)",
  "soft_shill": "Текст холодной интеграции (1-2 предложения)"
}`;

    const data = await this.chatWithModelFallback({
      messages: [{ role: 'system', content: prompt }],
      max_tokens: 30000,
      temperature: 0.6,
      response_format: { type: 'json_object' }
    });
    
    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('ИИ не вернул структурированный JSON ответ для autoposting draft.');
    }
    
    return JSON.parse(jsonMatch[0]);
  }

  /** Суммаризирует свежие посты из Telegram-каналов, извлекая важные инсайты по токенам и рискам. */
  async summarizeResearchPosts({ posts = [], channels = [] } = {}) {
    const prompt = `Ты crypto research analyst для Trading AI Bot. Суммаризируй свежие посты из Telegram-каналов для short-term cache модуля анализа монет.

Задача:
- выделить важные токены/тикеры/контракты, launch/listing/airdrop/DEX/whale/rugpull insights;
- не делать авто-торговлю и не давать приказ покупать;
- вернуть только JSON без markdown.

Формат:
{"summary":"","signals":[],"tokens":[],"riskNotes":[]}

Каналы:
${channels.join(', ') || 'unknown'}

Посты:
${posts.map((post, index) => `${index + 1}. [${post.channel}] ${String(post.text || '').slice(0, 1200)}`).join('\n\n').slice(0, 18000)}`;

    const data = await this.chatWithModelFallback({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
      temperature: 0.35,
    });
    return data?.choices?.[0]?.message?.content?.trim() || '';
  }

  /**
   * Анализирует посты канала для формирования описания уникального стиля (тон, структура)
   * и общего контекста/мнения автора (opinion_text). Возвращает JSON-объект.
   *
   * @param {string[]} posts - Массив текстов постов для анализа
   * @returns {Promise<{ style_description: string, opinion_text: string }>} Результат анализа
   */
  async analyzePostsStyle(posts) {
    const prompt = `Проанализируй эти посты. Сформируй детальное описание стиля написания (тон, подача, структура) и добавь в поле style_description. Выдели общий контекст из постов, дай общее мнение по ним  в поле opinion_text.

Вывод LLM должен быть строго в формате JSON:
{
  "style_description": "...",
  "opinion_text": "..."
}

Посты:
${JSON.stringify(posts, null, 2)}`;

    const data = await this.chatWithModelFallback({
      messages: [{ role: 'system', content: prompt }],
      max_tokens: 15000,
      temperature: 0.5,
      response_format: { type: 'json_object' }
    });

    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('ИИ не вернул структурированный JSON ответ.');
    }

    return JSON.parse(jsonMatch[0]);
  }



  /** Блок AI: Анализ новостей и формирование поста с shill интеграцией */
  async generateCryptoNewsPost(newsArray, styleContext = null) {
    const prompt = `Ты — девушка Катя - криптоаналитик и автор инсайдерского Telegram-канала.
Твоя задача: проанализировать переданные новости и написать короткий, интригующий и цепляющий пост.

Правила стиля для поста:
1. Краткость и динамика: Пиши емко, без воды. Используй короткие абзацы (1-3 предложения).
2. Интрига: Зацепи внимание с первого предложения. Делай неочевидные выводы из новостей, заставляя читателя задуматься.
3. Эмодзи: Органично используй релевантные эмодзи.
4. Тон: Уверенный, аналитический, местами тонко-юморной, местами ироничный, но всегда актуальный. Имеет место быть, используй сленговые выражения.

Интеграция (Soft Shill):
Сформируй отдельный текст для нативной, "холодной" интеграции нашего закрытого продукта.
Контекст продукта: Проект \`tradingAI\` — приватный многофункциональный Telegram-бот для автоматизации трейдинга (Bybit, TON), парсинга каналов и обработки сигналов с помощью ИИ.
Как интегрировать: Не продавай в лоб. Упомяни бота вскользь. Например, намекни, что пока толпа читает новости, твой скрипт уже отторговал этот тренд, или что бот еще ночью прислал алерт по этой ситуации.

${styleContext ? `КОНТЕКСТ ТВОЕГО СТИЛЯ (используй для сохранения уникального тона):
Описания стиля: ${styleContext.styleDescriptions?.join(' | ') || 'нет'}
Примеры мнений: ${styleContext.opinionTexts?.slice(0, 3).join(' | ') || 'нет'}
` : ''}
Новости для анализа:
${JSON.stringify(newsArray, null, 2)}

Верни ответ СТРОГО в JSON формате. Схема JSON:
{
  "post_date": "YYYY-MM-DD",
  "content": "Основной текст поста (интригующая выжимка с эмодзи)",
  "soft_shill": "Текст холодной интеграции (1-2 предложения, органично продолжающие мысль поста)"
}`;

    const data = await this.chatWithModelFallback({
      messages: [{ role: 'system', content: prompt }],
      max_tokens: 3000,
      temperature: 0.7,
      response_format: { type: 'json_object' }
    });

    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('ИИ не вернул структурированный JSON ответ.');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Сохраняем во временное хранилище (In-Memory Cache)
    const dateKey = parsed.post_date || new Date().toISOString().split('T')[0];
    this.generatedPostsCache[dateKey] = {
      date: dateKey,
      text: parsed.content + '\n\n' + parsed.soft_shill
    };

    return parsed;
  }
}

