import { z } from 'zod';

/**
 * Бесплатные модели OpenRouter (порядок = приоритет).
 * Переопределение: OPENROUTER_FREE_MODELS="model/a:free,model/b:free"
 */
export const OPENROUTER_FREE_MODELS = [
  'stepfun/step-3.5-flash:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'google/gemma-2-9b-it:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'arcee-ai/trinity-large-preview:free',
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
  }

  /**
   * POST chat/completions с перебором моделей при 429 и др.
   * @param {{ messages: Array, max_tokens?: number, temperature?: number }} opts
   * @returns {Promise<{ choices?: unknown[], error?: unknown }>}
   */
  async chatWithModelFallback(opts,onStatusUpdate) {
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

  /**
   * Получить совет по лимитному ордеру
   */
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

  /**
   * @param {Array<{coin: string, spread: number, lastBuyPrice: number, currentPrice: number, usdValue?: number, change24h?: number}>} sellCandidates
   * @param {typeof sellCandidates} buyCandidates
   * @param {{ sellPct: number, buyPct: number }} thresholds
   */
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

  /**
   * Оценка точки входа по метрикам и ряду цен (1h).
   * @returns {Promise<{ verdict: 'BUY'|'WAIT'|'AVOID', reason: string }>}
   */
  async evaluateEntrySignal(metrics,onStatusUpdate = null) {
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
          max_tokens: 1000,
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

  /**
<<<<<<< HEAD
   * Парсинг текста поста в структурированный JSON сигнала (только извлечение полей).
   * @param {string} rawText
   */
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
=======
   * AI-анализ Web3 discovery token после первичных фильтров ликвидности/риска.
   * @returns {Promise<{ verdict: 'BUY'|'WAIT'|'AVOID', reason: string, riskLevel: 'LOW'|'MEDIUM'|'HIGH' }>}
   */
  async evaluateDiscoveredToken(token, onStatusUpdate = null) {
    const prompt = `Ты профессиональный Web3-аналитик мемкоинов и новых DEX-пулов. Торговля НЕ автоматическая: нужен сигнал для ручного решения.

Данные токена:
${JSON.stringify({
  chain: token.chain,
  address: token.address,
  symbol: token.symbol,
  price: token.price,
  marketCap: token.marketCap,
  liquidityUsd: token.liquidityUsd,
  volume24h: token.volume24h,
  buys24h: token.buys24h,
  sells24h: token.sells24h,
  holders: token.holders,
  ageMinutes: token.ageMinutes,
  dex: token.dex,
  pairAddress: token.pairAddress,
  source: token.source,
}, null, 2)}

Проанализируй smart money/whale/dev-wallet признаки по доступным метрикам, rugpull-риск, ликвидность, buy/sell pressure, возраст и социальный/launch контекст по источнику.
Ответь СТРОГО одной строкой JSON без markdown: {"verdict":"BUY"|"WAIT"|"AVOID","riskLevel":"LOW"|"MEDIUM"|"HIGH","reason":"кратко по-русски, 1-2 предложения"}`;
>>>>>>> b9c3bdc503f225c428ebf7b0b911ed93418efe3a

    try {
      const data = await this.chatWithModelFallback({
        messages: [{ role: 'user', content: prompt }],
<<<<<<< HEAD
        max_tokens: 500,
        temperature: 0.15,
      });
      const raw = data?.choices?.[0]?.message?.reasoning || '';
      const cleaned = raw
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      console.log(data.choices[0].message);
      
      if (!jsonMatch) throw new Error('Нет JSON в ответе модели');
      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.error('parseTelegramSignalPost:', err);
      throw err;
    }
  }

  /**
   * Краткое объяснение на русском (не менять вердикт — он уже вычислен правилами).
   */
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
        max_tokens: 220,
        temperature: 0.45,
      });
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return text.slice(0, 900);
    } catch (err) {
      console.error('explainSignalAnalysisNarrative:', err);
    }
    return 'Краткий вывод сформирован по метрикам; нейросеть не смогла добавить пояснение.';
  }
=======
        max_tokens: 700,
        temperature: 0.3,
      }, onStatusUpdate);

      const raw = data.choices?.[0]?.message?.content || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { verdict: 'WAIT', riskLevel: 'MEDIUM', reason: 'ИИ не вернул структурированный ответ.' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const verdictRaw = String(parsed.verdict || '').toUpperCase();
      const riskRaw = String(parsed.riskLevel || '').toUpperCase();
      return {
        verdict: verdictRaw === 'BUY' ? 'BUY' : verdictRaw === 'AVOID' ? 'AVOID' : 'WAIT',
        riskLevel: riskRaw === 'LOW' ? 'LOW' : riskRaw === 'HIGH' ? 'HIGH' : 'MEDIUM',
        reason: String(parsed.reason || '').slice(0, 500),
      };
    } catch (err) {
      console.error('evaluateDiscoveredToken:', err);
      return { verdict: 'WAIT', riskLevel: 'MEDIUM', reason: 'Ошибка AI-анализа discovery token.' };
    }
  }
>>>>>>> b9c3bdc503f225c428ebf7b0b911ed93418efe3a
}
