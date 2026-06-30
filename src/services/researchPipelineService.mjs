import { AIService } from './aiService.mjs';
import { ResearchCacheService } from './researchCacheService.mjs';
import { parseResearchChannels, TelegramScraperService } from './telegramScraperService.mjs';
import { supabase } from '../db/supabaseClient.mjs';

let researchWorkerTimer = null;

const EXTENDED_TRIGGERS = [
  "поддержка", "сопротивление", "tvl", "листинг", "объем", "ath","отскок","проторговка","откуп", 
  "пробой", "график", "лонг", "шорт", "long", "short", "buy", "sell",
  "анализ", "разлок", "pump", "dump", "кит", "ликвидность"
];

function hasTokenMention(text) {
  const regex = /\$[A-Za-z0-9]{2,12}\b|0x[a-fA-F0-9]{32,}|[1-9A-HJ-NP-Za-km-z]{32,44}/;
  return regex.test(text);
}

function filterResearchPosts(posts, channelsCache = []) {
  return posts
    .map(post => {
      const text = String(post.text || '').toLowerCase();
      
      const hasToken = hasTokenMention(text);
      const hasTrigger = EXTENDED_TRIGGERS.some(trigger => text.includes(trigger));
      
      if (hasToken || hasTrigger) {
        const channelInfo = channelsCache.find(c => c.name === post.channel || c.channel_name === post.channel || c.url?.includes(post.channel));
        const baseUrl = channelInfo ? channelInfo.url : `https://t.me/${post.channel.replace('@', '')}`;
        
        return {
          ...post,
          source_url: `${baseUrl}/${post.id}`
        };
      }
      return null;
    })
    .filter(Boolean);
}

function parseAiResearch(raw, fallbackSummary) {
  const jsonMatch = String(raw || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      summary: String(raw || fallbackSummary).slice(0, 1200),
      signals: [],
      tokens: [],
      riskNotes: [],
    };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: String(parsed.summary || fallbackSummary).slice(0, 1600),
      signals: Array.isArray(parsed.signals) ? parsed.signals.map(String).slice(0, 12) : [],
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens.map(String).slice(0, 20) : [],
      riskNotes: Array.isArray(parsed.riskNotes) ? parsed.riskNotes.map(String).slice(0, 12) : [],
    };
  } catch {
    return {
      summary: fallbackSummary,
      signals: [],
      tokens: [],
      riskNotes: [],
    };
  }
}

export class ResearchPipelineService {
  constructor({
    scraper = new TelegramScraperService(),
    ai = new AIService(),
    cache = new ResearchCacheService(),
  } = {}) {
    this.scraper = scraper;
    this.ai = ai;
    this.cache = cache;
  }

  /**
   * Запускает полный цикл (pipeline) сбора и анализа данных из Telegram-каналов:
   * 1. Синхронизирует и загружает список отслеживаемых каналов из базы данных (Supabase), если они не переданы.
   * 2. Получает последние сообщения (посты) из этих каналов с помощью MTProto клиента.
   * 3. Фильтрует посты на основе упоминания крипто-токенов или ключевых слов (триггеров).
   * 4. Передает отфильтрованные посты в AI (LLM) для генерации общего саммари, торговых сигналов и оценки рисков.
   * 5. Сохраняет результаты анализа в локальный кэш/БД и обновляет статус выполнения.
   *
   * @param {Object} [options] - Параметры выполнения пайплайна.
   * @param {Array<string>} [options.channelsList] - Явный список юзернеймов каналов для парсинга. Если не передан, берутся каналы из БД.
   * @param {Array<Object>} [options.channelsCache] - Кэшированный список объектов каналов с их URL и метаданными.
   * @param {number} [options.limit] - Максимальное количество последних постов для загрузки из каждого канала. По умолчанию берется из process.env.RESEARCH_POST_LIMIT или равен 10.
   * @param {Function} [options.onStatusUpdate] - Коллбэк для логирования текущего статуса выполнения пайплайна во внешние интерфейсы (например, в Telegram-чат админу).
   * @returns {Promise<Object>} Данные об успешном запуске и результатах анализа, сохраненные в БД.
   */
  async executeResearchPipeline({
    channelsList = null,
    channelsCache = null,
    limit = Number(process.env.RESEARCH_POST_LIMIT || 10),
    onStatusUpdate = null,
  } = {}) {
    // Получаем актуальный кэш каналов из БД, если он не был передан
    let currentCache = channelsCache;
    if (!currentCache || currentCache.length === 0) {
      currentCache = await this.cache.syncChannels();
    }

    // Если список каналов не передан явно (например, фоновый воркер), 
    // берем актуальный список из кэша БД
    const channels = Array.isArray(channelsList) && channelsList.length > 0
      ? channelsList.filter(Boolean)
      : currentCache.map(c => c.channel_name).filter(Boolean);

    this.cache.setStatus({
      running: true,
      lastRunAt: new Date().toISOString(),
      lastError: '',
      lastChannels: channels,
    });
    try {
      console.log('начинаю читать');
      
      if (onStatusUpdate) await onStatusUpdate(`📊 Research: читаю ${channels.length} канал(ов)…`);
      const posts = await this.scraper.fetchLatestPosts(channels, limit);
      
      const filteredPosts = filterResearchPosts(posts, currentCache);
      if (onStatusUpdate) await onStatusUpdate(`📊 Research: найдено ${posts.length}, после фильтра ${filteredPosts.length}.`);

      const fallbackSummary = filteredPosts.length
        ? `Собрано ${filteredPosts.length} релевантных постов из ${channels.length} каналов.`
        : `Нет релевантных постов из ${channels.length} каналов.`;
      const rawAi = filteredPosts.length
        ? await this.ai.summarizeResearchPosts({ posts: filteredPosts, channels })
        : '';
      const analysis = parseAiResearch(rawAi, fallbackSummary);

      // Сохраняем посты в таблицу crypto_news
      if (filteredPosts.length > 0) {
         
         console.log(filteredPosts);
        const newsData = filteredPosts.map(post => {
          const tickerMatch = post.text?.match(/\$[A-Za-z0-9]+/);
          const ticker = tickerMatch ? tickerMatch[0].replace('$', '') : null;
          const title = post.text ? post.text.split('\n')[0].slice(0, 100) : 'Без названия';
          return {
            title,
            content: post.text,
            source_url: `https://t.me/${post.channel.replace('@', '')}`,
            source_name: post.channel,
            ticker: ticker,
            published_at: post.date || new Date().toISOString()
          };
        });

        const { error: newsError } = await supabase.from('crypto_news').insert(newsData);
        if (newsError) {
          console.error('Ошибка сохранения в crypto_news:', newsError);
        }
      }

      // Сохраняем анализ в таблицу ai_summaries
      if (analysis && analysis.summary) {
        const dates = posts.map(p => new Date(p.date)).filter(d => !isNaN(d));
        const period_start = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : new Date().toISOString();
        const period_end = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : new Date().toISOString();

        const summaryData = {
          summary_type: 'research_pipeline',
          summary_text: analysis.summary,
          ticker: analysis.tokens && analysis.tokens.length > 0 ? analysis.tokens.join(',').slice(0, 255) : null,
          period_start,
          period_end
        };

        const { error: summaryError } = await supabase.from('ai_summaries').insert([summaryData]);
        if (summaryError) {
          console.error('Ошибка сохранения в ai_summaries:', summaryError);
        }
      }

      const row = this.cache.storeResearchData({
        channels,
        fetchedPosts: posts.length,
        usedPosts: filteredPosts.length,
        scraperErrors: this.scraper.lastErrors,
        ...analysis,
      });
      this.cache.setStatus({
        running: false,
        lastSuccessAt: row.createdAt,
        lastPostsFetched: posts.length,
        lastPostsUsed: filteredPosts.length,
        lastError: '',
      });
      return row;
    } catch (err) {
      this.cache.setStatus({
        running: false,
        lastError: err.message,
      });
      throw err;
    }
  }

  getStatus() {
    return this.cache.getStatus();
  }
}

/**
 * Вспомогательная функция-обертка для быстрого запуска пайплайна без явного создания экземпляра ResearchPipelineService.
 * Создает новый экземпляр класса и делегирует ему выполнение.
 *
 * @param {Object} [options] - Параметры выполнения пайплайна (см. описание метода в классе).
 * @returns {Promise<Object>} Данные анализа, сохраненные в кэш/БД.
 */
export async function executeResearchPipeline(options = {}) {
  return new ResearchPipelineService().executeResearchPipeline(options);
}

//
/**
 * Запускает фоновый периодический процесс (воркер) для регулярного сбора и анализа информации.
 * 
 * Особенности работы:
 * - Считывает параметры RESEARCH_BACKGROUND_ENABLED и RESEARCH_INTERVAL_MINUTES из переменных окружения.
 * - Если фоновый сбор отключен, возвращает null.
 * - Если воркер уже запущен, повторно не создает таймер и возвращает ссылку на существующий.
 * - Делает один запуск сразу при вызове, а затем повторяет его с заданным интервалом (по умолчанию каждые 30 минут).
 * - Ловит ошибки выполнения пайплайна и корректно записывает статус ошибки в кэш сервиса.
 *
 * @param {Object} [options] - Параметры воркера.
 * @param {Function} [options.onStatusUpdate] - Коллбэк для трансляции изменения статуса выполнения в процессе работы.
 * @returns {NodeJS.Timeout|null} Ссылка на интервал-таймер воркера или null, если воркер отключен.
 */
export function startResearchWorker({ onStatusUpdate = null } = {}) {
  const enabled = String(process.env.RESEARCH_BACKGROUND_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) return null;
  if (researchWorkerTimer) return researchWorkerTimer;
  const intervalMinutes = Number(process.env.RESEARCH_INTERVAL_MINUTES || 30);
  const intervalMs = Math.max(1, Number.isFinite(intervalMinutes) ? intervalMinutes : 30) * 60 * 1000;
  const run = async () => {
    try {
      await executeResearchPipeline({ onStatusUpdate });
    } catch (err) {
      new ResearchCacheService().setStatus({ lastError: err.message, running: false });
    }
  };
  researchWorkerTimer = setInterval(run, intervalMs);
  run();
  return researchWorkerTimer;
}

/**
 * Получает новости из БД за текущий и предыдущий календарные дни для автопостинга
 */
export async function fetchCryptoNewsForAutoposting() {
  const now = new Date();
  
  // Конец текущего дня
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  
  // Начало предыдущего дня
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  const { data, error } = await supabase
    .from('crypto_news')
    .select('published_at, content')
    .gte('published_at', yesterdayStart.toISOString())
    .lte('published_at', todayEnd.toISOString());

  if (error) {
    throw new Error(`Supabase error: ${error.message}`);
  }

  // Шаг обогащения: получаем данные стиля из post_analysis_vectors
  let styleContext = null;
  try {
    const { data: vectors } = await supabase
      .from('post_analysis_vectors')
      .select('raw_style_description, raw_opinion_text')
      .order('created_at', { ascending: false })
      .limit(5);
    
    if (vectors && vectors.length > 0) {
      styleContext = {
        styleDescriptions: vectors.map(v => v.raw_style_description).filter(Boolean),
        opinionTexts: vectors.map(v => v.raw_opinion_text).filter(Boolean),
      };
    }
  } catch (err) {
    console.error('Ошибка получения style vectors:', err.message);
  }

  return {
    news: (data || []).map(row => ({
      date: row.published_at ? row.published_at.split('T')[0] : null,
      text: row.content || ''
    })),
    styleContext,
  };
}

