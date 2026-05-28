import { Bot, session } from 'grammy';
import {mainMenuComposer} from './composers/mainMenu.mjs'
import {assetsComposer} from './composers/assets.mjs'
import {ordersComposer} from './composers/orders.mjs'
import {authComposer} from './composers/auth.mjs'
import {settingsComposer} from './composers/settings.mjs'
import {autopostingComposer} from './composers/autoposting.mjs'

// import {aiSignalComposer} from './composers/aiSignalComposer.mjs'

import {web3DiscoveryComposer} from './composers/web3Discovery.mjs'


// ... ваши импорты композеров

export function createBot(token) {
  const bot = new Bot(token);

  // 1. Проверка на владельца (Middleware)
  bot.use(async (ctx, next) => {
    const ownerId = Number(process.env.OWNER_ID);
    
    // Если это не сообщение от пользователя (например, системное) 
    // или ID не совпадает — прерываем выполнение
    if (ctx.from?.id !== ownerId) {
      // Опционально: можно отправить сообщение "Доступ запрещен"
      if (ctx.chat?.type === 'private') {
        await ctx.reply('⚠️ Этот бот доступен только его владельцу.');
      }
      return; // НЕ вызываем next(), поэтому другие обработчики не сработают
    }

    // Если всё ок, идем дальше к сессиям и композерам
    await next(); 
  });

  // 2. Дальше ваша стандартная настройка (сессия, композеры)
  bot.use(session({
    initial: () => ({ /* ... ваши поля */ }),
  }));

  bot.use(mainMenuComposer);
  bot.use(assetsComposer);
  bot.use(ordersComposer);
  bot.use(settingsComposer);
  bot.use(autopostingComposer);
  bot.use(web3DiscoveryComposer);
  bot.use(authComposer);

  return bot;
}