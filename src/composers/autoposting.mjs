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

  keyboard.row().text('◀️ Назад в меню', 'autoposting_back_main');
  return keyboard;
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
  return hasSession ? 'encrypted session stored' : 'needs MiniApp/MTProto auth';
}

function authInstructions(ctx) {
  void ctx;
  const webAppUrl = process.env.TELEGRAM_AUTH_MINIAPP_URL || '';
  const keyboard = new InlineKeyboard();
  if (webAppUrl) keyboard.webApp('Открыть MiniApp auth', webAppUrl).row();
  keyboard.text('Ввести API_ID/API_HASH/телефон в чате', 'autoposting_auth_chat').row()
    .text('◀️ Назад', 'autoposting_back');
  return {
    text: `<b>🔐 MTProto authorization</b>\n\n` +
      `MiniApp/web flow принимает ID_TELEGRAM, API_ID, API_HASH и phone. ` +
      `После отправки Telegram пришлёт временный code; бот попросит его отдельным шагом.\n\n` +
      `<b>Chat fallback format:</b>\n` +
      `<pre>API_ID=12345\nAPI_HASH=abcdef\nPHONE=+79990000000</pre>\n` +
      `Сессия сохраняется в encrypted file <code>data/telegram-mtproto-session.enc.json</code>.`,
    keyboard,
  };
}

export async function showAutopostingMenu(ctx) {
  const state = ensureAutopostingSession(ctx);
  const config = getAutopostingConfig();
  const mtprotoStatus = await storedMtprotoStatus(ctx);
  const basket = await new TradingMetricsService().listDrafts({ limit: 5 });
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

autopostingComposer.callbackQuery('autoposting_add_samples', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const state = ensureAutopostingSession(ctx);
  ctx.session.autopostingStep = 'pastPosts';
  await ctx.reply(
    `Пришлите 1–5 прошлых постов одним сообщением. Я сохраню их только в текущей session для анализа стиля.\n\n` +
      `Сейчас samples: ${state.pastPosts.length}`,
  );
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
  await ctx.reply('Отправьте API_ID/API_HASH/PHONE в формате:\nAPI_ID=12345\nAPI_HASH=abcdef\nPHONE=+79990000000');
});

autopostingComposer.callbackQuery('autoposting_basket', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const drafts = await new TradingMetricsService().listDrafts({ limit: 5 });
  if (!drafts.length) {
    await ctx.reply('🧺 Корзина постов пуста.', {
      reply_markup: new InlineKeyboard().text('◀️ Назад', 'autoposting_back'),
    });
    return;
  }
  const keyboard = new InlineKeyboard();
  const text = drafts.map((draft, index) => {
    keyboard.text(`✅ #${index + 1}`, `autoposting_basket_approve_${draft.id}`)
      .text(`❌ #${index + 1}`, `autoposting_basket_reject_${draft.id}`)
      .row();
    return `<b>#${index + 1} ${escapeHtml(draft.title)}</b>\n${escapeHtml(draft.preview)}`;
  }).join('\n\n────────────\n\n');
  keyboard.text('◀️ Назад', 'autoposting_back');
  await ctx.reply(`<b>🧺 Корзина draft-постов</b>\n\n${text}`, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
});

autopostingComposer.callbackQuery(/^autoposting_basket_reject_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await new TradingMetricsService().updateDraftStatus(ctx.match[1], 'rejected');
  await ctx.reply('Draft из корзины отклонён. Ничего не опубликовано.');
});

autopostingComposer.callbackQuery(/^autoposting_basket_approve_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const metrics = new TradingMetricsService();
  const draft = (await metrics.listDrafts({ status: null, limit: 100 })).find((item) => item.id === ctx.match[1]);
  if (!draft?.pendingDraft) {
    await ctx.reply('Draft не найден в корзине.');
    return;
  }
  const service = new AutopostingService();
  const approved = await service.approveDraft({ ...draft.pendingDraft, ownerId: ctx.from?.id }, ctx.from?.id);
  const results = await service.publishApproved(approved);
  await metrics.updateDraftStatus(draft.id, 'published', { publishedAt: new Date().toISOString(), results });
  const resultText = results
    .map((result) => `• ${result.platform}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`)
    .join('\n');
  await ctx.reply(`<b>Basket autoposting result</b>\n${escapeHtml(resultText)}`, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
});

autopostingComposer.callbackQuery('autoposting_back', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await showAutopostingMenu(ctx);
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

autopostingComposer.on('message:text', async (ctx, next) => {
  if (ctx.session?.autopostingStep === 'mtprotoAuth') {
    const values = parseKeyValueText(ctx.message.text);
    try {
      const result = await new TelegramSessionService().startLogin({
        telegramId: ctx.from?.id,
        apiId: values.API_ID || values.ID_TELEGRAM || values.TELEGRAM_MTPROTO_API_ID,
        apiHash: values.API_HASH || values.TELEGRAM_MTPROTO_API_HASH,
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
        `✅ MTProto session сохранена encrypted.\n` +
          `Каналов найдено: ${result.channels.length}\n` +
          `Целевой канал: ${preferred}`,
      );
    } catch (err) {
      ctx.session.autopostingStep = null;
      await ctx.reply(`❌ MTProto verification error: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
    return;
  }

  if (ctx.session?.autopostingStep !== 'pastPosts') return next();
  const state = ensureAutopostingSession(ctx);
  const parts = ctx.message.text
    .split(/\n-{3,}\n|\n\n(?=#|\d+\.|•|-)/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 5);

  state.pastPosts = parts.length ? parts : [ctx.message.text.trim()];
  ctx.session.autopostingStep = null;
  await ctx.reply(`Сохранил samples прошлых постов: ${state.pastPosts.length}.`, {
    reply_markup: buildAutopostingKeyboard(state.pendingDraft),
  });
});
