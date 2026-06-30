import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Composer, InlineKeyboard } from 'grammy';
import {
  AutopostingService,
  formatDraftForTelegram,
  getAutopostingConfig,
  getAutopostingEnvTemplate,
} from '../services/autopostingService.mjs';
import { TelegramSessionService } from '../services/telegramSessionService.mjs';
import { TradingMetricsService } from '../services/tradingMetricsService.mjs';
import { ResearchCacheService } from '../services/researchCacheService.mjs';
import { executeResearchPipeline, fetchCryptoNewsForAutoposting } from '../services/researchPipelineService.mjs';
import { parseResearchChannels } from '../services/telegramScraperService.mjs';
import { AIService } from '../services/aiService.mjs';
import { TelegramClientManager } from '../services/TelegramClientManager.mjs';
import { supabase } from '../db/supabaseClient.mjs';


const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..', '..');

export const autopostingComposer = new Composer();

function ensureAutopostingSession(ctx) {
  ctx.session ??= {};
  ctx.session.autoposting ??= {
    pendingDraft: null,
    pastPosts: [],
    idea: '',
  };
  return ctx.session.autoposting;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildAutopostingKeyboard(pendingDraft) {
  const keyboard = new InlineKeyboard()
    .text('🧠 Собрать draft из push/code', 'autoposting_generate')
    .row()
    .text('Собрать пост: Крипто-новости', 'buildPostCrypto_news')
    .row()
    .text('Собрать пост: Разработка', 'buildPostDev')
    .row()
    .text('🧺 Корзина постов', 'autoposting_basket')
    .row()
    .text('🔐 Авторизация MiniApp/MTProto', 'autoposting_auth')
    .row()
    .text('📚 Добавить прошлые посты/стиль', 'autoposting_add_samples')
    .row()
    .text('🔑 Показать env ключи', 'autoposting_env');

  if (pendingDraft) {
    keyboard
      .row()
      .text('✅ Одобрить и опубликовать', 'autoposting_approve_publish')
      .text('❌ Отклонить draft', 'autoposting_reject');
  }

  keyboard.row().text('◀️ Назад в хаб', 'autoposting_hub');
  return keyboard;
}

function buildHubKeyboard() {
  return new InlineKeyboard()
    .text('📊 Управление Ресерчем', 'research_manage')
    .row()
    .text('📝 Управление Автопостингом', 'autoposting_manage')
    .row()
    .text('◀️ Назад в меню', 'autoposting_back_main');
}

//
function buildResearchKeyboard() {
  return new InlineKeyboard()
    .text('🚀 Вызвать ресерч сейчас', 'research_run')
    .row()
    .text('📈 Статус фонового ресерча', 'research_status')
    .row()
    .text('➕ Добавить канал', 'research_add_channel')
    .row()
    .text('◀️ Назад', 'autoposting_hub');
}

function platformStatus(config) {
  const rows = [
    `Telegram MTProto: ${config.telegram.channel ? 'configured' : 'needs TELEGRAM_AUTOPOST_CHANNEL'}`,
    'Habr: draft/export only (official public publish API is unavailable)',
    `Dzen: RSS export (${config.dzen.feedUrl})`,
  ];
  return rows.map((row) => `• ${escapeHtml(row)}`).join('\n');
}

async function storedMtprotoStatus(ctx) {
  const hasSession = await new TelegramSessionService().hasSession(ctx.from?.id);
  return hasSession ? 'session.txt stored' : 'needs MiniApp/MTProto auth';
}

function authInstructions(ctx) {
  void ctx;
  const webAppUrl = process.env.TELEGRAM_AUTH_MINIAPP_URL || '';
  const keyboard = new InlineKeyboard();
  if (webAppUrl) keyboard.webApp('Открыть MiniApp auth', webAppUrl).row();
  keyboard.text('Ввести телефон в чате', 'autoposting_auth_chat').row()
    .text('◀️ Назад', 'autoposting_back');
  return {
    text: `<b>🔐 MTProto authorization</b>\n\n` +
      `MiniApp/web flow принимает ID_TELEGRAM и phone. ` +
      `После отправки Telegram пришлёт временный code; бот попросит его отдельным шагом.\n\n` +
      `<b>Chat fallback format:</b>\n` +
      `<pre>PHONE=+79990000000</pre>\n` +
      `API_ID/API_HASH берутся строго из <code>.env</code>. StringSession сохраняется в <code>session.txt</code> в корне проекта.`,
    keyboard,
  };
}

export async function showAutopostingMenu(ctx) {
  const cacheStatus = new ResearchCacheService().getStatus();
  await ctx.reply(
    `<b>📣 Ресерч и Автопостинг</b>\n\n` +
      `Выберите направление:\n` +
      `• <b>Ресерч</b> — сбор постов из Telegram-каналов, AI-суммаризация и short-term cache для анализа монет.\n` +
      `• <b>Автопостинг</b> — старая approval-first генерация draft-постов и публикация после одобрения.\n\n` +
      `<b>Research cache:</b> ${cacheStatus.freshItems} fresh / ${cacheStatus.cacheSize} total`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: buildHubKeyboard(),
    },
  );
}

async function showAutopostingManagementMenu(ctx) {
  const state = ensureAutopostingSession(ctx);
  const config = getAutopostingConfig();
  const mtprotoStatus = await storedMtprotoStatus(ctx);
  const cacheService = new ResearchCacheService();
  const basket = cacheService.getAllDrafts();
  const text = `<b>📣 Autoposting Center</b>\n\n` +
    `SMM-агент собирает изменения в push/code, сверяет стиль с прошлыми постами и готовит публикации. ` +
    `Отправка возможна только после вашего ручного одобрения.\n\n` +
    `<b>Платформы</b>\n${platformStatus(config)}\n\n` +
    `<b>MTProto:</b> ${escapeHtml(mtprotoStatus)}\n` +
    `<b>Pending draft:</b> ${state.pendingDraft ? escapeHtml(state.pendingDraft.id) : 'нет'}\n` +
    `<b>Past post samples:</b> ${state.pastPosts.length}\n` +
    `<b>Basket drafts:</b> ${basket.length}`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: buildAutopostingKeyboard(state.pendingDraft),
  });
}

async function showResearchMenu(ctx) {
  const channels = parseResearchChannels();
  const status = new ResearchCacheService().getStatus();
  await ctx.reply(
    `<b>📊 Управление Ресерчем</b>\n\n` +
      `<b>Каналы:</b> ${channels.length ? escapeHtml(channels.join(', ')) : 'не заданы в RESEARCH_TELEGRAM_CHANNELS'}\n` +
      `<b>Фоновый режим:</b> ${String(process.env.RESEARCH_BACKGROUND_ENABLED || 'false')}\n` +
      `<b>Интервал:</b> ${process.env.RESEARCH_INTERVAL_MINUTES || 30} мин\n` +
      `<b>TTL cache:</b> ${status.ttlMinutes} мин\n` +
      `<b>Fresh items:</b> ${status.freshItems}\n` +
      `<b>Last success:</b> ${status.lastSuccessAt || '—'}\n` +
      `<b>Last error:</b> ${escapeHtml(status.lastError || '—')}`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: buildResearchKeyboard(),
    },
  );
}

async function collectGitDiff() {
  const { stdout } = await execFileAsync('git', [
    '-C',
    ROOT_DIR,
    'diff',
    '--merge-base',
    'origin/main',
    '--',
    '.',
    ':(exclude)package-lock.json',
  ], { maxBuffer: 1024 * 1024 * 8 });
  if (stdout.trim()) return stdout;

  const staged = await execFileAsync('git', [
    '-C',
    ROOT_DIR,
    'diff',
    '--cached',
    '--',
    '.',
    ':(exclude)package-lock.json',
  ], { maxBuffer: 1024 * 1024 * 8 });
  return staged.stdout;
}

function envTemplateText() {
  const template = getAutopostingEnvTemplate();
  return Object.entries(template)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

autopostingComposer.callbackQuery('autoposting_generate', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const state = ensureAutopostingSession(ctx);
  const loading = await ctx.reply('⏳ SMM-агент собирает diff и готовит draft…');

  try {
    const diffText = await collectGitDiff();
    const service = new AutopostingService();
    state.pendingDraft = await service.createDraft({
      diffText,
      pastPosts: state.pastPosts,
      idea: state.idea,
    });

    await ctx.api.editMessageText(
      loading.chat.id,
      loading.message_id,
      formatDraftForTelegram(state.pendingDraft),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buildAutopostingKeyboard(state.pendingDraft),
      },
    );
  } catch (err) {
    await ctx.api.editMessageText(
      loading.chat.id,
      loading.message_id,
      `❌ Autoposting draft error: ${escapeHtml(err.message)}`,
      { parse_mode: 'HTML' },
    );
  }
});

autopostingComposer.callbackQuery('buildPostCrypto_news', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const loading = await ctx.reply('⏳ Собираю пост по крипто-новостям...');
  try {
    const result = await fetchCryptoNewsForAutoposting();
    const news = result.news;
    if (!news || news.length === 0) {
      await ctx.api.editMessageText(loading.chat.id, loading.message_id, '❌ Нет новостей за последние 2 дня.');
      return;
    }
    
    const aiService = new AIService();
    const generatedPost = await aiService.generateCryptoNewsPost(news, result.styleContext);
    
    const fullText = `${generatedPost.content}\n\n${generatedPost.soft_shill}`;
    const draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    ctx.session ??= {};
    ctx.session.autoposting ??= {};
    ctx.session.autoposting.lastGeneratedPost = { id: draftId, text: fullText };
    
    await ctx.api.editMessageText(
      loading.chat.id,
      loading.message_id,
      `<b>Сгенерированный пост (Крипто-новости):</b>\n\n${escapeHtml(fullText)}`,
      { 
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('📥 Добавить в черновики', `draft_add:${draftId}`)
      }
    );
  } catch (err) {
    await ctx.api.editMessageText(
      loading.chat.id,
      loading.message_id,
      `❌ Ошибка генерации: ${escapeHtml(err.message)}`,
      { parse_mode: 'HTML' }
    );
  }
});

autopostingComposer.callbackQuery(/^draft_add:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const draftId = ctx.match[1];
  const post = ctx.session?.autoposting?.lastGeneratedPost;
  
  if (!post || post.id !== draftId) {
    await ctx.reply('❌ Черновик устарел или не найден.');
    return;
  }
  
  const cacheService = new ResearchCacheService();
  cacheService.addDraft(post.id, post.text);
  
  await ctx.api.editMessageReplyMarkup(ctx.chat.id, ctx.msg.message_id, { reply_markup: new InlineKeyboard() }).catch(() => {});
  await ctx.reply(`✅ Пост добавлен в корзину (ID: ${post.id}). Перейдите в "🧺 Корзина постов".`);
});

autopostingComposer.callbackQuery('buildPostDev', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.reply('В разработке (Собрать пост: Разработка)');
});

autopostingComposer.callbackQuery('autoposting_hub', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await showAutopostingMenu(ctx);
});

autopostingComposer.callbackQuery('autoposting_manage', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await showAutopostingManagementMenu(ctx);
});

autopostingComposer.callbackQuery('research_manage', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await showResearchMenu(ctx);
});

autopostingComposer.callbackQuery('research_status', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await showResearchMenu(ctx);
});

autopostingComposer.callbackQuery('research_run', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const loading = await ctx.reply('⏳ Синхронизирую каналы и запускаю research pipeline…');
  const updateStatus = async (line) => {
    await ctx.api.editMessageText(loading.chat.id, loading.message_id, escapeHtml(line), {
      parse_mode: 'HTML',
    }).catch(() => {});
  };
  try {
    const cacheService = new ResearchCacheService();
    await updateStatus('⏳ Синхронизация каналов из БД...');
    const channelsCache = await cacheService.syncChannels();
    
    if (!channelsCache.length) {
      throw new Error("Список каналов для парсинга в БД пуст.");
    }

    const channelNames = channelsCache.map(c => c.channel_name);

    const row = await executeResearchPipeline({ 
      channelsList: channelNames,
      channelsCache: channelsCache,
      limit: 10,
      onStatusUpdate: updateStatus 
    });

    await ctx.api.editMessageText(
      loading.chat.id,
      loading.message_id,
      `<b>📊 Research готов</b>\n\n` +
        `<b>Каналы:</b> ${escapeHtml(row.channels.join(', ') || '—')}\n` +
        `<b>Постов:</b> ${row.usedPosts}/${row.fetchedPosts}\n` +
        `<b>Summary:</b> ${escapeHtml(row.summary)}\n` +
        `<b>Signals:</b> ${escapeHtml((row.signals || []).join(', ') || '—')}`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buildResearchKeyboard(),
      },
    );
  } catch (err) {
    await ctx.api.editMessageText(
      loading.chat.id,
      loading.message_id,
      `❌ Research error: ${escapeHtml(err.message)}`,
      {
        parse_mode: 'HTML',
        reply_markup: buildResearchKeyboard(),
      },
    ).catch(() => {});
  }
});

// Добавление канала в research
autopostingComposer.callbackQuery('research_add_channel', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const state = ensureAutopostingSession(ctx);
  ctx.session.autopostingStep = 'researchAddChannel';
  await ctx.reply(
    `<b>Добавление канала</b>\nОтправьте название (или @username) и ссылку на канал через пробел или на новых строках.\nПример:\n<code>durov https://t.me/durov</code>`,
    { parse_mode: 'HTML' }
  );
});

autopostingComposer.callbackQuery('autoposting_add_samples', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const state = ensureAutopostingSession(ctx);
  const loading = await ctx.reply('⏳ Парсинг последних постов из канала...');

  try {
    const channel = process.env.TELEGRAM_AUTOPOST_CHANNEL; // [SECURE_VARIABLE]
    if (!channel) {
      await ctx.api.editMessageText(loading.chat.id, loading.message_id,
        '❌ TELEGRAM_AUTOPOST_CHANNEL не задан в .env');
      return;
    }

    const limit = Number(process.env.AUTOPOST_SAMPLES_LIMIT || 10);
    
    const posts = await TelegramClientManager.runAction(async (client) => {
      const messages = await client.getMessages(channel, { limit });
      return messages
        .map(msg => (msg.message || '').trim())
        .filter(Boolean);
    });

    state.pastPosts = posts;
    
    await ctx.api.editMessageText(
      loading.chat.id, 
      loading.message_id,
      `✅ Собрано ${posts.length} постов из ${channel} для анализа стиля. Ожидайте анализ...`, {
        reply_markup: buildAutopostingKeyboard(state.pendingDraft),
      }
    );

    // AI Анализ стиля
    const aiService = new AIService();
    const styleAnalysis = await aiService.analyzePostsStyle(posts);

    // Сохранение в Supabase
    try {
      const { error } = await supabase.from('post_analysis_vectors').insert([{
        raw_style_description: styleAnalysis.style_description,
        raw_opinion_text: styleAnalysis.opinion_text,
      }]);
      
      if (error) {
        console.error('Ошибка сохранения стиля в БД:', error.message);
      } else {
        await ctx.reply('✅ Стиль успешно проанализирован и сохранен в БД.');
      }
    } catch (dbErr) {
      console.error('Непредвиденная ошибка при работе с БД:', dbErr.message);
    }
  } catch (err) {
    await ctx.api.editMessageText(
      loading.chat.id, 
      loading.message_id,
      `❌ Ошибка парсинга: ${escapeHtml(err.message)}`,
      { parse_mode: 'HTML' }
    );
  }
});

autopostingComposer.callbackQuery('autoposting_env', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.reply(`<b>Autoposting env keys</b>\n\n<pre>${escapeHtml(envTemplateText())}</pre>`, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
});

autopostingComposer.callbackQuery('autoposting_auth', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const { text, keyboard } = authInstructions(ctx);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
});

autopostingComposer.callbackQuery('autoposting_auth_chat', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.autopostingStep = 'mtprotoAuth';
  await ctx.reply('Отправьте телефон для MTProto login. API_ID/API_HASH берутся строго из .env:\nPHONE=+79990000000');
});

autopostingComposer.callbackQuery('autoposting_basket', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const cacheService = new ResearchCacheService();
  const drafts = cacheService.getAllDrafts();
  
  if (!drafts.length) {
    await ctx.reply('🧺 Корзина постов пуста.', {
      reply_markup: new InlineKeyboard().text('◀️ Назад', 'autoposting_back'),
    });
    return;
  }

  const text = drafts.map(d => `ID: ${d.id}\n${escapeHtml(d.text)}`).join('\n\n────────────\n\n');
  
  const keyboard = new InlineKeyboard()
    .text('🚀 Опубликовать все', 'basket_publish_all').row();
  drafts.forEach((d, index) => {
    keyboard.text(`Опубликовать #${index + 1}`, `basket_publish:${d.id}`)
            .text(`Удалить #${index + 1}`, `basket_delete:${d.id}`).row();
  });
  keyboard.text('◀️ Назад', 'autoposting_back');
  
  await ctx.reply(`<b>🧺 Корзина черновиков:</b>\n\n${text}`, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
});

autopostingComposer.callbackQuery(/^basket_publish:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const draftId = ctx.match[1];
  const cacheService = new ResearchCacheService();
  const draft = cacheService.getDraft(draftId);
  
  if (!draft) {
    await ctx.reply('❌ Черновик не найден.');
    return;
  }
  
  const channel = process.env.TELEGRAM_AUTOPOST_CHANNEL; // [SECURE_VARIABLE]
  if (!channel) {
    await ctx.reply('❌ TELEGRAM_AUTOPOST_CHANNEL не задан в .env');
    return;
  }
  
  try {
    await TelegramClientManager.runAction(async (client) => {
      await client.sendMessage(channel, { message: draft.text, linkPreview: false });
    });
    cacheService.removeDraft(draftId);
    await ctx.reply(`✅ Пост (ID: ${draftId}) успешно опубликован!`);
  } catch (err) {
    await ctx.reply(`❌ Ошибка публикации: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

autopostingComposer.callbackQuery('basket_publish_all', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const cacheService = new ResearchCacheService();
  const drafts = cacheService.getAllDrafts();
  
  if (!drafts.length) {
    await ctx.reply('🧺 Корзина постов пуста.');
    return;
  }
  
  const channel = process.env.TELEGRAM_AUTOPOST_CHANNEL; // [SECURE_VARIABLE]
  if (!channel) {
    await ctx.reply('❌ TELEGRAM_AUTOPOST_CHANNEL не задан в .env');
    return;
  }
  
  const loading = await ctx.reply('⏳ Публикация постов...');
  try {
    await TelegramClientManager.runAction(async (client) => {
      for (const draft of drafts) {
        await client.sendMessage(channel, { message: draft.text, linkPreview: false });
        cacheService.removeDraft(draft.id);
        await new Promise(r => setTimeout(r, 1000)); // небольшая задержка
      }
    });
    await ctx.api.editMessageText(loading.chat.id, loading.message_id, `✅ Все посты (${drafts.length}) успешно опубликованы!`);
  } catch (err) {
    await ctx.api.editMessageText(loading.chat.id, loading.message_id, `❌ Ошибка публикации: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

autopostingComposer.callbackQuery(/^basket_delete:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const cacheService = new ResearchCacheService();
  cacheService.removeDraft(ctx.match[1]);
  await ctx.reply('✅ Черновик удален из корзины.');
});

autopostingComposer.callbackQuery('autoposting_back', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await showAutopostingManagementMenu(ctx);
});

autopostingComposer.callbackQuery('autoposting_reject', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const state = ensureAutopostingSession(ctx);
  state.pendingDraft = null;
  await ctx.reply('Draft отклонён. Ничего не опубликовано.', {
    reply_markup: buildAutopostingKeyboard(null),
  });
});

autopostingComposer.callbackQuery('autoposting_approve_publish', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const state = ensureAutopostingSession(ctx);
  if (!state.pendingDraft) {
    await ctx.reply('Нет pending draft для публикации.');
    return;
  }

  const service = new AutopostingService();
  const approved = await service.approveDraft(state.pendingDraft, ctx.from?.id);
  const results = await service.publishApproved(approved);
  state.pendingDraft = null;

  const resultText = results
    .map((result) => `• ${result.platform}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`)
    .join('\n');
  await ctx.reply(`<b>Autoposting result</b>\n${escapeHtml(resultText)}`, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
});

autopostingComposer.callbackQuery('autoposting_back_main', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const { sendMainMenu } = await import('./mainMenu.mjs');
  await sendMainMenu(ctx);
});

function parseKeyValueText(text) {
  return Object.fromEntries(String(text).split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/))
    .filter(Boolean)
    .map((match) => [match[1].toUpperCase(), match[2].trim()]));
}

// Добавление канала в research
autopostingComposer.on('message:text', async (ctx, next) => {
  if (ctx.session?.autopostingStep === 'researchAddChannel') {
    const text = ctx.message.text.trim();
    const parts = text.split(/[\s\n]+/).filter(Boolean);
    if (parts.length < 2) {
      await ctx.reply('❌ Ошибка: отправьте название и ссылку. Пример:\ndurov https://t.me/durov');
      return;
    }
    const [name, url] = parts;
    try {
      const cacheService = new ResearchCacheService();
      await cacheService.addChannel(name, url);
      ctx.session.autopostingStep = null;
      await ctx.reply(`✅ Канал <b>${escapeHtml(name)}</b> успешно добавлен и сохранен в БД.`, {
        parse_mode: 'HTML',
        reply_markup: buildResearchKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`❌ Ошибка добавления: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
    return;
  }
  if (ctx.session?.autopostingStep === 'mtprotoAuth') {
    const values = parseKeyValueText(ctx.message.text);
    try {
      const result = await new TelegramSessionService().startLogin({
        telegramId: ctx.from?.id,
        phoneNumber: values.PHONE || values.PHONE_NUMBER || values.TELEGRAM_PHONE,
      });
      ctx.session.autopostingStep = 'mtprotoCode';
      await ctx.reply(
        `${result.isCodeViaApp ? 'Код отправлен в Telegram app.' : 'Код отправлен по SMS/Telegram.'}\n` +
          `Введите временный код. Если включён 2FA password, отправьте: CODE=12345 PASSWORD=your_password`,
      );
    } catch (err) {
      ctx.session.autopostingStep = null;
      await ctx.reply(`❌ MTProto auth start error: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
    return;
  }

  if (ctx.session?.autopostingStep === 'mtprotoCode') {
    const values = parseKeyValueText(ctx.message.text);
    const code = values.CODE || ctx.message.text.trim();
    try {
      const result = await new TelegramSessionService().verifyLogin({
        telegramId: ctx.from?.id,
        code,
        password: values.PASSWORD || '',
      });
      if (result.status === 'password_required') {
        await ctx.reply('Telegram запросил 2FA password. Отправьте: CODE=12345 PASSWORD=your_password');
        return;
      }
      ctx.session.autopostingStep = null;
      const preferred = result.preferredChannel?.handle || 'не найден';
      await ctx.reply(
        `✅ MTProto session сохранена в session.txt.\n` +
          `Каналов найдено: ${result.channels.length}\n` +
          `Целевой канал: ${preferred}`,
      );
    } catch (err) {
      ctx.session.autopostingStep = null;
      await ctx.reply(`❌ MTProto verification error: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
    return;
  }

  return next();
});
