import { Composer, InlineKeyboard, Keyboard } from 'grammy';
import { showAssets } from './assets.mjs';
import { showLimitOrders } from './orders.mjs';
import { runSignalSearch } from './signals.mjs';
import { showSettingsMenu } from './settings.mjs';
import { runWeb3Discovery } from './web3Discovery.mjs';

export const mainMenuComposer = new Composer();

// Команда /start
mainMenuComposer.command('start', async (ctx) => {
  const keyboard = new Keyboard()
    .text('💰 Активы')
    .text('📊 Лимитные ордера').row()
    .text('🔍 Поиск сигналов')
    .text('⚙️ Настройки')
    .text('🧠 AI-аналитика').row()
    .text('🧬 Web3 top-10')
    .text('⚡ Позиции (фьючи)');

  await ctx.reply(
    '👋 Торговый ассистент Bybit\nВыберите действие:',
    { reply_markup: keyboard }
  );
});



// Обработка нажатий на кнопки главного меню
mainMenuComposer.on('message', async (ctx, next) => {
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
  if (ctx.message.text === '🧠 AI-аналитика') {
    await ctx.reply('🤖 AI-аналитика в разработке. Скоро вы сможете получать прогнозы по выбранным монетам.');
  }
  if (ctx.message.text === '🧬 Web3 top-10') {
    await runWeb3Discovery(ctx);
  }
  if (ctx.message.text === '⚡ Позиции (фьючи)') {
    await ctx.reply('⚡ Фьючерсные позиции — функционал в разработке (скоро).');
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
    case 'web3':
      await runWeb3Discovery(ctx);
      break;
    case 'positions':
      await ctx.reply('⚡ Фьючерсные позиции — функционал в разработке (скоро).');
      break;
  }
});