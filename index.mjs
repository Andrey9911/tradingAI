import 'dotenv/config'; // Подключаем .env в самом начале (современный синтаксис)
import express from 'express';
import { webhookCallback } from 'grammy';
import { createBot } from './src/bot.mjs';
import { createTelegramAuthMiniAppRouter } from './src/composers/telegramAuthMiniApp.mjs';

// Получаем переменные окружения
const PORT = process.env.PORT || 3333;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const TOKEN = process.env.API_KEY;

if (!TOKEN) {
  throw new Error('API_KEY не задан в .env файле!');
}

// Создаем бота и приложение
const bot = createBot(TOKEN);
const app = express();

app.use(express.json());
app.use(createTelegramAuthMiniAppRouter());

// Логика запуска в зависимости от наличия WEBHOOK_URL
if (WEBHOOK_URL) {
  // --- РЕЖИМ ВЕБХУКОВ ---
  
  // Используем встроенный в grammy адаптер для express
  app.use('/webhook', webhookCallback(bot, 'express'));

  app.listen(PORT, async () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    try {
      // Устанавливаем вебхук в Telegram
      await bot.api.setWebhook(`${WEBHOOK_URL}/webhook`);
      console.log(`Вебхук успешно установлен на ${WEBHOOK_URL}/webhook`);
    } catch (err) {
      console.error('Ошибка установки вебхука:', err);
    }
  });

} else {
  // --- РЕЖИМ LONG POLLING ---
  
  // Опционально: запускаем сервер просто чтобы занять порт 
  // (полезно, если вы хоститесь на сервисах вроде Render/Heroku)
  app.listen(PORT, () => {
    console.log(`Сервер (Express) запущен на порту ${PORT}`);
  });

  console.log('WEBHOOK_URL не задан. Запуск бота в режиме long polling...');
  // Запускаем самого бота
  // bot.start({
  //   onStart: (botInfo) => {
  //     console.log(`Бот @${botInfo.username} успешно запущен!`);
  //   }
  // });
  bot.start();
}