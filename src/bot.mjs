import { Bot, session } from 'grammy';
import {mainMenuComposer} from './composers/mainMenu.mjs'
import {assetsComposer} from './composers/assets.mjs'
import {ordersComposer} from './composers/orders.mjs'
import {authComposer} from './composers/auth.mjs'
import {settingsComposer} from './composers/settings.mjs'
import {autopostingComposer} from './composers/autoposting.mjs'
import { TelegramSessionService } from './services/telegramSessionService.mjs';
import { loadUserSettings } from './db/userSettingsService.mjs';

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

  // Загружаем настройки из БД при первом обращении в рамках сессии
  bot.use(async (ctx, next) => {
    if (ctx.from?.id && !ctx.session.settingsLoaded) {
      const settings = await loadUserSettings(ctx.from.id);
      if (settings) {
        ctx.session.isDisableFiltr = settings.is_disable_filtr;
        ctx.session.signalSettings = {
          sellSpreadPct: Number(settings.sell_spread_pct),
          maxEntryChg24Pct: Number(settings.max_entry_chg24_pct),
          holdSkipUsd: Number(settings.hold_skip_usd),
        };
        ctx.session.tokenDiscoveryFilters = {
          liquidityUsd: settings.filter_liquidity_usd.map(Number),
          holders: settings.filter_holders.map(Number),
          volume24h: settings.filter_volume24h.map(Number),
          ageMinutes: settings.filter_age_minutes.map(Number),
        };
      }
      ctx.session.settingsLoaded = true;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    if (ctx.message?.text === '/start') {
      ctx.session.telegramMtprotoReady = await new TelegramSessionService().hasSession(ctx.from?.id);
    }
    await next();
  });

  bot.use(mainMenuComposer);
  bot.use(assetsComposer);
  bot.use(ordersComposer);
  bot.use(settingsComposer);
  bot.use(autopostingComposer);
  bot.use(web3DiscoveryComposer);
  bot.use(authComposer);

  return bot;
}