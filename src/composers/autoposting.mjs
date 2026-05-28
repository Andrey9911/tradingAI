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

export async function showAutopostingMenu(ctx) {
  const state = ensureAutopostingSession(ctx);
  const config = getAutopostingConfig();
  const text = `<b>📣 Autoposting Center</b>\n\n` +
    `SMM-агент собирает изменения в push/code, сверяет стиль с прошлыми постами и готовит публикации. ` +
    `Отправка возможна только после вашего ручного одобрения.\n\n` +
    `<b>Платформы</b>\n${platformStatus(config)}\n\n` +
    `<b>Pending draft:</b> ${state.pendingDraft ? escapeHtml(state.pendingDraft.id) : 'нет'}\n` +
    `<b>Past post samples:</b> ${state.pastPosts.length}`;

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

autopostingComposer.on('message:text', async (ctx, next) => {
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
