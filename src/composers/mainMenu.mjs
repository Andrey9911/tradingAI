import { Composer, Keyboard } from 'grammy';
import { showAssets } from './assets.mjs';
import { showLimitOrders } from './orders.mjs';
import { runSignalSearch } from './signals.mjs';
import { showSettingsMenu } from './settings.mjs';
// import { runAiSignal } from './aiSignalComposer.mjs';

export const mainMenuComposer = new Composer();

export function buildMainMenuKeyboard() {
  return new Keyboard()
    .text('💰 Активы')
    .text('📊 Лимитные ордера').row()
    .text('🔍 Поиск сигналов')
    .text('⚙️ Настройки')
    .text('🤖 AI анализ мемок').row()
    .text('⚡ Позиции (фьючи)')
    .resized();
}

/** Отправить приветствие и reply-клавиатуру главного меню */
export async function sendMainMenu(ctx) {
  await ctx.reply('👋 Торговый ассистент Bybit\nВыберите действие:', {
    reply_markup: buildMainMenuKeyboard(),
  });
}

// Команда /start
mainMenuComposer.command('start', async (ctx) => {
  await sendMainMenu(ctx);
});



// Обработка нажатий на кнопки главного меню
mainMenuComposer.on('message:text', async (ctx, next) => {
  if (ctx.message.text === '💰 Активы') {
    await showAssets(ctx);
  }
  if (ctx.message.text === '📊 Лимитные ордера') {
    await showLimitOrders(ctx);
  }
  if (ctx.message.text === '🔍 Поиск сигналов') {
    await runSignalSearch(ctx);
  }
  if (ctx.message.text === '⚙️ Настройки') {
    await showSettingsMenu(ctx);
  }
  if (ctx.message.text === '⚡ Позиции (фьючи)') {
    await ctx.reply('⚡ Фьючерсные позиции — функционал в разработке (скоро).');
  }
  if (ctx.message.text === '🤖 AI анализ мемок') {
    // await runAiSignal(ctx);  //TODO: Добавить обработку мемок
    await ctx.reply('🤖 AI анализ мемок');
    
    return;
  }
  return next();
});
mainMenuComposer.callbackQuery(/^menu_/, async (ctx) => {
  // Важно: ответ на callback нужно отправлять быстро.
  // Иначе Telegram успевает "протухнуть" query и grammy кидает 400.
  await ctx.answerCallbackQuery().catch(() => {});

  const action = ctx.callbackQuery.data.split('_')[1];
  switch (action) {
    case 'assets':
        await ctx.reply('Загрузка активов...');
        await showAssets(ctx);
      // Передаём управление композеру assets, но вызываем функцию напрямую?
      // Удобнее вызвать метод, который уже есть в другом композере.
      // Для этого можно импортировать вспомогательную функцию или использовать контекст.
      // В данном случае мы просто отвечаем, что переход обрабатывается другим композером.
      // Однако чтобы не плодить лишние обработчики, можно сделать так:
      // await ctx.reply('Загрузка активов...');
      // и в assetsComposer будет обработчик на что-то другое.
      // Но проще: мы можем не обрабатывать здесь, а в assetsComposer сделать callback на 'menu_assets'.
      // Поэтому здесь оставим пустым, а реальную логику перенесём в assetsComposer.
      break;
    case 'orders':
      await showLimitOrders(ctx);
      break;
    case 'signals':
      await runSignalSearch(ctx);
      break;
    case 'settings':
      await showSettingsMenu(ctx);
      break;
    case 'ai':
      await ctx.reply('🤖 AI-аналитика в разработке. Скоро вы сможете получать прогнозы по выбранным монетам.');
      break;
    case 'positions':
      await ctx.reply('⚡ Фьючерсные позиции — функционал в разработке (скоро).');
      break;
  }
});