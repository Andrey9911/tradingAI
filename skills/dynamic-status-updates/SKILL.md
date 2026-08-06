---
name: Dynamic Status Updates
description: Стандартный паттерн для динамического обновления сообщений в Telegram боте с применением метода updateStatus во время долгих асинхронных операций.
---

# SKILL: Динамическое изменение сообщений в боте (метод `updateStatus`)

Настоящий скилл описывает единый стандарт архитектуры и реализации протокола динамического статус-информирования пользователей (`updateStatus` / `onStatusUpdate`) в Telegram-боте.

---

## 1. АРХИТЕКТУРНЫЕ ПРИНЦИПЫ И ИЗОЛЯЦИЯ

1. **Разделение ответственности**:
   - **Composer (`src/composers/`)**: Отвечает за взаимодействие с Telegram API (`ctx.api.editMessageText`), инициализацию статусного сообщения, буферизацию логов, экранирование HTML и подавление специфических ошибок Telegram API.
   - **Services (`src/services/`)**: Выполняют длительные асинхронные задачи (поиск токенов, расчет ТА, on-chain аналитика, вызовы ИИ). Не знают про `ctx` и `grammy`. Принимают коллбэк `updateStatus` (или `onStatusUpdate`) и вызывают его для информирования о ходе этапов.

2. **Запрет прямой зависимости**:
   - **ЗАПРЕЩЕНО** передавать объект `ctx` или импортировать `grammy` в слое `src/services/`.
   - Единственным средством связи сервиса с интерфейсом Telegram является сигнатура: `onStatusUpdate?: (message: string) => Promise<void>`.

---

## 2. ЭТАЛОННАЯ РЕАЛИЗАЦИЯ НА УРОВНЕ COMPOSER

При выполнении долгих операций composer отправляет первоначальное сообщение-заглушку и создает обертку `updateStatus`.

```javascript
import { escapeHtml } from '../utils/formatters.mjs'; // или локальная утилита

export async function handleLongTask(ctx) {
  // 1. Отправляем стартовое сообщение-заглушку
  const loadingMsg = await ctx.reply('⏳ Запуск анализа рынка...');
  
  let statusText = '🔍 <b>Прогресс выполнения задачи</b>\n';

  // 2. Создаем переиспользуемый метод updateStatus
  const updateStatus = async (newLine) => {
    try {
      // Добавляем новую строку и буферизируем (ограничиваем последние N строк)
      const lines = statusText.split('\n');
      lines.push(escapeHtml(newLine));
      statusText = lines.slice(-10).join('\n'); // Держим макс. 10 строк

      // Обновляем сообщение в Telegram
      await ctx.api.editMessageText(
        loadingMsg.chat.id,
        loadingMsg.message_id,
        statusText,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      // Игнорируем ошибки Telegram (например: "message is not modified", если текст не изменился)
    }
  };

  try {
    // 3. Передаем updateStatus в сервисы
    await updateStatus('📊 Запрашиваю рыночные данные...');
    const marketData = await marketService.fetchData(updateStatus);

    await updateStatus('🤖 Формирую отчет с помощью нейросети...');
    const result = await aiService.evaluate(marketData, updateStatus);

    // 4. По завершении — заменяем статусное сообщение на финальный результат
    await ctx.api.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      result.finalHtmlReport,
      { parse_mode: 'HTML', reply_markup: result.keyboard }
    );
  } catch (err) {
    console.error('Ошибка в handleLongTask:', err);
    await ctx.api.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id).catch(() => {});
    await ctx.reply(`❌ Ошибка выполнения: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}
```

---

## 3. ИСПОЛЬЗОВАНИЕ ВНУТРИ СЕРВИСОВ (`src/services/`)

В любом асинхронном сервисе метод объявляется с поддержкой опционального коллбэка статуса:

```javascript
export class AIService {
  /**
   * Оценка токена с помощью ИИ
   * @param {Object} tokenData - Данные токена
   * @param {Function} [onStatusUpdate] - Коллбэк статуса (async (msg: string) => void)
   */
  async evaluateToken(tokenData, onStatusUpdate = null) {
    if (onStatusUpdate) {
      await onStatusUpdate(`🤖 Нейросеть генерирует гипотезу по ${tokenData.symbol}...`);
    }

    const response = await this.callLlmApi(tokenData);

    if (onStatusUpdate) {
      await onStatusUpdate(`✅ Гипотеза для ${tokenData.symbol} получена.`);
    }

    return response;
  }
}
```

---

## 4. КРИТИЧЕСКИЕ ПРАВИЛА И ЗАЩИТА

### 4.1 Буферизация и лимит длины сообщения
Telegram API имеет ограничение **4096 символов** на одно текстовое сообщение.
- **Правило**: Всегда ограничивайте число строк вызовом `lines.slice(-10)` (или `-5`), чтобы статусное окно не переполнялось и не вызывало ошибку `Bad Request: message is too long`.

### 4.2 Подавление ошибок Telegram API
При частых вызовах `editMessageText` Telegram может возвращать ошибку:
`400 Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message`.
- **Правило**: Функция `updateStatus` **ОБЯЗАНА** оборачивать `editMessageText` в `try ... catch` без проброса этой ошибки наружу.

### 4.3 Rate-Limiting (Троттлинг)
Telegram Bot API накладывает ограничения на количество вызовов `editMessageText` в один и тот же чат (не более ~1 запроса в секунду).
- **Правило**: Не вызывайте `updateStatus` внутри плотных циклов (`for` по 100 элементам на каждой итерации). Вызывайте статус только на ключевых шагах пайплайна или реализуйте простейший троттлинг по времени:

```javascript
let lastUpdate = 0;
const updateStatusThrottled = async (newLine) => {
  const now = Date.now();
  if (now - lastUpdate < 1000) return; // Пропускаем, если прошло менее 1 сек
  lastUpdate = now;
  await updateStatus(newLine);
};
```

---

## 5. ЧЕКЛИСТ ПРОВЕРКИ КОДА

1. [ ] Сообщение-заглушка создается через `const loading = await ctx.reply(...)`.
2. [ ] Функция `updateStatus` оборачивает вызов `editMessageText` в `try { ... } catch (e) {}`.
3. [ ] Длина лога ограничивается через `.slice(-N)`.
4. [ ] Новые строки экранируются через `escapeHtml(newLine)` во избежание поломки HTML-тегов.
5. [ ] В сервисах `src/services/` нет импортов `grammy` и вызовов `ctx`.
6. [ ] По завершении работы статусное сообщение либо удаляется (`ctx.api.deleteMessage`), либо обновляется на итоговый результат.

---

## 6. ЧТО ДЕЛАТЬ НЕЛЬЗЯ (Антипаттерны)

| ❌ Антипаттерн | ✅ Правильный подход |
|---|---|
| Передавать `ctx` в метод сервиса `service.doWork(ctx)` | Передавать атомарный callback `service.doWork(updateStatus)` |
| Накапливать статус без ограничения `statusText += line` | Ограничивать историю логов: `lines.slice(-10).join('\n')` |
| Пробрасывать ошибки Telegram из `updateStatus` | Игнорировать ошибки `message is not modified` в `try...catch` |
| Вызывать `updateStatus` 50 раз в секунду в цикле | Вызывать на ключевых шагах или с троттлингом (>= 1 сек) |
