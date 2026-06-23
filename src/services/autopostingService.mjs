import { readFile, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import RSS from 'rss';
import { AIService } from './aiService.mjs';
import { TelegramSessionService } from './telegramSessionService.mjs';
import { TelegramClientManager } from './TelegramClientManager.mjs';
import { client } from 'telegram';



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..', '..');

const DEFAULT_CONFIG = {
  enabled: String(process.env.AUTOPOSTING_ENABLED || 'false').toLowerCase() === 'true',
  requireApproval: true,
  defaultPlatforms: (process.env.AUTOPOSTING_PLATFORMS || 'telegram,habr,dzen')
    .split(',')
    .map((platform) => platform.trim().toLowerCase())
    .filter(Boolean),
  telegram: {
    apiId: process.env.TELEGRAM_MTPROTO_API_ID,
    apiHash: process.env.TELEGRAM_MTPROTO_API_HASH,

    enabled: String(process.env.AUTOPOSTING_TELEGRAM_ENABLED || 'true').toLowerCase() === 'true',
    channel: process.env.RESEARCH_TELEGRAM_CHANNEL || '@myPublicGroupAI',
  },
  habr: {
    enabled: String(process.env.AUTOPOSTING_HABR_ENABLED || 'true').toLowerCase() === 'true',
    mode: 'draft',
    profileUrl: process.env.HABR_PROFILE_URL || '',
  },
  dzen: {
    enabled: String(process.env.AUTOPOSTING_DZEN_ENABLED || 'true').toLowerCase() === 'true',
    mode: 'rss',
    feedTitle: process.env.DZEN_RSS_TITLE || 'Trading AI autopost drafts',
    feedUrl: process.env.DZEN_RSS_FEED_URL || 'https://example.com/dzen.xml',
    siteUrl: process.env.DZEN_SITE_URL || 'https://example.com',
    outputPath: process.env.DZEN_RSS_OUTPUT_PATH || path.join(ROOT_DIR, 'data', 'autoposting-dzen.xml'),
  },
};

const PLATFORM_LABELS = {
  telegram: 'Telegram MTProto',
  habr: 'Habr draft',
  dzen: 'Dzen RSS',
};

function normalizeText(value, fallback = '') {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  return text || fallback;
}

function clampText(value, maxLength) {
  const text = normalizeText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function slugify(value) {
  const slug = String(value || 'autopost')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || `autopost-${Date.now()}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function uniqueLines(lines) {
  return [...new Set(lines.map((line) => normalizeText(line)).filter(Boolean))];
}

function summarizeDiff(rawDiff) {
  const lines = normalizeText(rawDiff).split('\n');
  const files = uniqueLines(
    lines
      .filter((line) => line.startsWith('diff --git '))
      .map((line) => line.replace(/^diff --git a\//, '').replace(/ b\/.*$/, '')),
  );
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  const headings = uniqueLines(
    lines
      .filter((line) => /^[+-]\s*(export |class |async function |function |const |let )/.test(line))
      .map((line) => line.replace(/^[+-]\s*/, '')),
  ).slice(0, 12);

  return {
    files,
    added,
    removed,
    highlights: headings,
    summary: `${files.length} file(s), +${added}/-${removed}`,
  };
}

function extractStyleSamples(samples) {
  return samples
    .map((sample, index) => `${index + 1}. ${clampText(sample, 500)}`)
    .join('\n\n');
}

function buildFallbackDraft({ diffSummary, pastPosts, idea }) {
  const files = diffSummary.files.slice(0, 6).join(', ') || 'project files';
  const styleHint = pastPosts.length
    ? 'Сохрани стиль прошлых постов: коротко, по делу, с понятным выводом.'
    : 'Пиши как короткое обновление для Telegram-канала.';
  const body = [
    '🧠 Trading AI update',
    '',
    idea ? `Фокус: ${idea}` : `Изменения в коде: ${files}`,
    `Объём изменений: ${diffSummary.summary}.`,
    diffSummary.highlights.length
      ? `Ключевые точки: ${diffSummary.highlights.slice(0, 3).join('; ')}.`
      : 'Ключевые изменения собраны в текущем push/diff.',
    '',
    `${styleHint} Публикация не отправляется без ручного подтверждения.`,
  ].join('\n');

  return {
    title: 'Trading AI: обновление по коду',
    telegramText: clampText(body, 3900),
    habrMarkdown: `# Trading AI: обновление по коду\n\n${body}\n\n## Что проверить\n\n- Запуск проекта\n- Ключевой сценарий после изменений\n- Отсутствие автотрейдинга без ручного решения\n`,
    dzenHtml: `<h1>Trading AI: обновление по коду</h1><p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`,
    uniquenessNotes: pastPosts.length
      ? 'Fallback draft used local style samples; OpenRouter was unavailable.'
      : 'Fallback draft generated without past post samples.',
  };
}

function normalizeAiDraft(raw, fallback) {
  const jsonMatch = String(raw || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallback;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      title: clampText(parsed.title, 120) || fallback.title,
      telegramText: clampText(parsed.telegramText, 3900) || fallback.telegramText,
      habrMarkdown: normalizeText(parsed.habrMarkdown, fallback.habrMarkdown),
      dzenHtml: normalizeText(parsed.dzenHtml, fallback.dzenHtml),
      uniquenessNotes: clampText(parsed.uniquenessNotes, 700) || fallback.uniquenessNotes,
    };
  } catch {
    return fallback;
  }
}

function createPendingId() {
  return `autopost_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getAutopostingConfig() {
  return structuredClone(DEFAULT_CONFIG);
}

export function getAutopostingEnvTemplate() {
  return {
    AUTOPOSTING_ENABLED: 'false',
    AUTOPOSTING_PLATFORMS: 'telegram,habr,dzen',
    OPENROUTER_API_KEY: '<already used by AIService>',
    TELEGRAM_MTPROTO_API_ID: '<my.telegram.org api_id>',
    TELEGRAM_MTPROTO_API_HASH: '<my.telegram.org api_hash>',
    TELEGRAM_MTPROTO_CONNECT_DELAY_MS: '1500',
    TELEGRAM_MTPROTO_METADATA_FILE: 'data/telegram-mtproto-session.enc.json',
    TELEGRAM_AUTOPOST_CHANNEL: '@channel_username_or_numeric_id',
    RESEARCH_TELEGRAM_CHANNELS: '@channel_one,@channel_two',
    RESEARCH_BACKGROUND_ENABLED: 'false',
    RESEARCH_INTERVAL_MINUTES: '30',
    RESEARCH_CACHE_TTL_MINUTES: '180',
    RESEARCH_KEYWORDS: 'token,токен,airdrop,listing,pump,dex,whale,кит,ликвидность',
    AUTOPOSTING_TELEGRAM_ENABLED: 'true',
    AUTOPOSTING_HABR_ENABLED: 'true',
    HABR_PROFILE_URL: 'https://habr.com/ru/users/<username>/',
    AUTOPOSTING_DZEN_ENABLED: 'true',
    DZEN_RSS_TITLE: 'Trading AI autopost drafts',
    DZEN_RSS_FEED_URL: 'https://example.com/dzen.xml',
    DZEN_SITE_URL: 'https://example.com',
    DZEN_RSS_OUTPUT_PATH: 'data/autoposting-dzen.xml',
    TRADING_METRICS_FILE: 'data/trading-metrics.json',
    TRADING_POST_BASKET_FILE: 'data/trading-post-basket.json',
  };
}

export class AutopostingService {
  constructor({ ai = new AIService(), config = getAutopostingConfig() } = {}) {
    this.ai = ai;
    this.config = config;
  }

  async collectCodeChanges({ diffText = '', changedFiles = [] } = {}) {
    const diffSummary = summarizeDiff(diffText);
    const files = uniqueLines([...changedFiles, ...diffSummary.files]);
    return {
      ...diffSummary,
      files,
      rawDiff: clampText(diffText, 18000),
    };
  }

  async createDraft({ diffText = '', changedFiles = [], pastPosts = [], idea = '' } = {}) {
    const cfg = { ...this.config.telegram };
    let client = await TelegramClientManager.runWithSession(cfg.session,{apiId: cfg.apiId, apiHash: cfg.apiHash});
    await client.connect();
    pastPosts = client.getMessages(cfg.channel,{ limit: 10 }).map(msg => ({
      id: msg.id,
      text: msg.message || '',
      date: msg.date,
      stats: {
        views: msg.views || 0,
        forwards: msg.forwards || 0,
        reactions: msg.reactions ? msg.reactions.results.reduce((acc, r) => acc + r.count, 0) : 0
      },
      hasMedia: !!msg.media,
      url: `https://t.me/${channelUsername.replace('@', '')}/${msg.id}`
    }));
    await client.disconnect();

    const diffSummary = await this.collectCodeChanges({ diffText, changedFiles });
    const fallback = buildFallbackDraft({ diffSummary, pastPosts, idea });
    const prompt = `Ты SMM-агент Trading AI. По изменениям в push/code diff подготовь посты, но НЕ публикуй их.

Требования:
- русский язык;
- стиль должен учитывать прошлые посты и не копировать их дословно;
- проверь уникальность новости: если изменение похоже на прошлые посты, укажи это в uniquenessNotes;
- Telegram: короткий пост для канала;
- Habr: markdown draft для ручной публикации, технический стиль;
- Dzen: HTML body для RSS;
- никаких обещаний автотрейдинга, только AI-отчеты/сигналы и ручное решение;
- верни только JSON: {"title":"","telegramText":"","habrMarkdown":"","dzenHtml":"","uniquenessNotes":""}

Идея/контекст пользователя:
${normalizeText(idea, 'нет')}

Изменения:
${JSON.stringify(diffSummary, null, 2)}

Фрагмент diff:
${diffSummary.rawDiff}

Прошлые посты для стиля:
${extractStyleSamples(pastPosts) || 'нет'}`;

    try {
      const raw = typeof this.ai.createAutopostingDraft === 'function'
        ? await this.ai.createAutopostingDraft({
            diffSummary,
            diffText: diffSummary.rawDiff,
            pastPosts,
            idea,
          })
        : (await this.ai.chatWithModelFallback({
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1800,
            temperature: 0.55,
          }))?.choices?.[0]?.message?.content || '';
      return {
        id: createPendingId(),
        status: 'pending_approval',
        createdAt: new Date().toISOString(),
        platforms: this.config.defaultPlatforms,
        diffSummary,
        draft: normalizeAiDraft(raw, fallback),
        approval: {
          required: true,
          approvedAt: null,
          approvedBy: null,
        },
      };
    } catch (err) {
      return {
        id: createPendingId(),
        status: 'pending_approval',
        createdAt: new Date().toISOString(),
        platforms: this.config.defaultPlatforms,
        diffSummary,
        draft: fallback,
        approval: {
          required: true,
          approvedAt: null,
          approvedBy: null,
        },
        warning: `AI draft fallback used: ${err.message}`,
      };
    }
  }

  async createTradingMetricsDraft({ metric, metricsSummary, pastPosts = [] } = {}) {
    const idea = `Пост о результате торгового бота после действия владельца.
Сделка:
${JSON.stringify(metric, null, 2)}

Сводка последних метрик:
${JSON.stringify(metricsSummary, null, 2)}

Сохрани approval-first: пост только в корзину, без автопубликации.`;
    return this.createDraft({
      diffText: `Trading metrics update\n${JSON.stringify({ metric, metricsSummary }, null, 2)}`,
      changedFiles: ['trading-metrics'],
      pastPosts,
      idea,
    });
  }

  async approveDraft(pendingDraft, approvedBy) {
    return {
      ...pendingDraft,
      status: 'approved',
      approval: {
        required: true,
        approvedAt: new Date().toISOString(),
        approvedBy: String(approvedBy || 'owner'),
      },
    };
  }

  async publishApproved(pendingDraft, platforms = pendingDraft.platforms) {
    if (pendingDraft.status !== 'approved') {
      throw new Error('Autoposting draft must be approved before publishing.');
    }

    const results = [];
    for (const platform of platforms) {
      if (platform === 'telegram') {
        results.push(await this.publishTelegram(pendingDraft));
      } else if (platform === 'habr') {
        results.push(await this.exportHabrDraft(pendingDraft));
      } else if (platform === 'dzen') {
        results.push(await this.exportDzenRss(pendingDraft));
      }
    }

    return results;
  }

  async publishTelegram(pendingDraft) {
    const cfg = { ...this.config.telegram };
  
    // 1. Попытка прочесть строку сессии из файла session.txt в корне проекта
    if (!cfg.session) {
      try {
        // Если этот файл лежит в подпапке (например, src/services/autoposting.js), 
        // то поднимаемся на два уровня вверх до корня:
        console.log('__dirname', __dirname);
        
        const sessionPath = path.resolve(__dirname, '..', '..', 'session.txt');

// Теперь можно смело читать
        const savedSession = await readFile(sessionPath, 'utf-8');
        cfg.session = savedSession.trim(); // Убираем лишние пробелы и переносы строк
      } catch (err) {
        // Если файла нет, просто логируем и идем дальше по старой логике
        console.log('Файл session.txt не найден или недоступен, проверяем базу данных...');
      }
    }
  
    // 2. Старая логика: если сессии всё ещё нет, ищем в БД
    if ((!cfg.session || !cfg.channel) && pendingDraft.ownerId) {
      const sessionConfig = await new TelegramSessionService().getSessionConfig(pendingDraft.ownerId);
      if (sessionConfig?.session) {
        cfg.apiId ||= sessionConfig.apiId;
        cfg.apiHash ||= sessionConfig.apiHash;
        cfg.session ||= sessionConfig.session;
        cfg.channel ||= sessionConfig.preferredChannel?.handle || sessionConfig.preferredChannel?.id;
      }
    }
  
    if (!cfg.enabled) {
      return { platform: 'telegram', status: 'skipped', reason: 'disabled' };
    }
  
    // 3. Проверка на наличие всех данных (теперь cfg.session заполнена из файла)
    if (!cfg.apiId || !cfg.apiHash) {
      return {
        platform: 'telegram',
        status: 'needs_credentials',
        reason: 'Set TELEGRAM_MTPROTO_API_ID, TELEGRAM_MTPROTO_API_HASH, TELEGRAM_MTPROTO_SESSION, TELEGRAM_AUTOPOST_CHANNEL.',
      };
    }
  
    // 4. Подключение и отправка через GramJS (TelegramClient)
    let client = await TelegramClientManager.runWithSession(cfg.session,{apiId: cfg.apiId, apiHash: cfg.apiHash});
    
    
    await client.connect();
    const result = await client.sendMessage(cfg.channel, {
      message: pendingDraft.draft.telegramText,
      linkPreview: false,
    });
    await client.disconnect();
    
    return {
      platform: 'telegram',
      status: 'published',
      channel: cfg.channel,
      messageId: result?.id ?? null,
    };
  }

  async exportHabrDraft(pendingDraft) {
    return {
      platform: 'habr',
      status: 'draft_only',
      reason: 'Official Habr docs state the Habr API is internal-only; auto-publish is not available through a public API.',
      profileUrl: this.config.habr.profileUrl,
      title: pendingDraft.draft.title,
      markdown: pendingDraft.draft.habrMarkdown,
    };
  }

  async exportDzenRss(pendingDraft) {
    const cfg = this.config.dzen;
    if (!cfg.enabled) {
      return { platform: 'dzen', status: 'skipped', reason: 'disabled' };
    }

    const guid = `${cfg.siteUrl.replace(/\/$/, '')}/autopost/${pendingDraft.id}/${slugify(pendingDraft.draft.title)}`;
    const feed = new RSS({
      title: cfg.feedTitle,
      description: 'Trading AI approved autopost drafts for Dzen RSS ingestion.',
      feed_url: cfg.feedUrl,
      site_url: cfg.siteUrl,
      language: 'ru',
    });
    feed.item({
      title: pendingDraft.draft.title,
      description: pendingDraft.draft.dzenHtml,
      url: guid,
      guid,
      date: pendingDraft.approval?.approvedAt || pendingDraft.createdAt,
      custom_elements: [
        { 'content:encoded': { _cdata: pendingDraft.draft.dzenHtml } },
      ],
    });

    const outputPath = path.isAbsolute(cfg.outputPath)
      ? cfg.outputPath
      : path.join(ROOT_DIR, cfg.outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, feed.xml({ indent: true }), 'utf8');

    return {
      platform: 'dzen',
      status: 'rss_exported',
      reason: 'Dzen official integration is RSS-based; publish by exposing this feed URL in Dzen Studio.',
      outputPath,
      feedUrl: cfg.feedUrl,
      guid,
    };
  }

  async loadPastPosts(filePath) {
    if (!filePath) return [];
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(ROOT_DIR, filePath);
    const text = await readFile(resolved, 'utf8');
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data.map((item) => item.text || item.content || item).filter(Boolean);
    if (Array.isArray(data.posts)) return data.posts.map((item) => item.text || item.content || item).filter(Boolean);
    return [];
  }
}

export function formatDraftForTelegram(pendingDraft) {
  const platforms = pendingDraft.platforms.map((platform) => PLATFORM_LABELS[platform] || platform).join(', ');
  return `<b>📝 Autopost draft</b>\n` +
    `<b>ID:</b> <code>${escapeHtml(pendingDraft.id)}</code>\n` +
    `<b>Status:</b> ${escapeHtml(pendingDraft.status)}\n` +
    `<b>Platforms:</b> ${escapeHtml(platforms)}\n` +
    `<b>Changes:</b> ${escapeHtml(pendingDraft.diffSummary.summary)}\n\n` +
    `<b>${escapeHtml(pendingDraft.draft.title)}</b>\n` +
    `${escapeHtml(clampText(pendingDraft.draft.telegramText, 1400))}\n\n` +
    `<i>${escapeHtml(pendingDraft.draft.uniquenessNotes)}</i>`;
}
