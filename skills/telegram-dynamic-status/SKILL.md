---
name: Dynamic Status Updates (Telegram Bot)
description: Инструкция и эталонный скилл по динамическому обновлению статусного сообщения в Telegram-боте (метод updateStatus) во время длинных асинхронных операций.
---

# SKILL: Динамическое изменение сообщений в Telegram-боте (`updateStatus`)

Данный скилл описывает архитектурный стандарт и готовые шаблоны кода для динамического информирования пользователя о ходе выполнения долгих асинхронных процессов (анализ рынка, работу с DEX, вызовы AI и т.д.) через редактирование одного статусного сообщения в Telegram.

---

## 1. Основная идея и Архитектура

При выполнении длинного пайплайна (3–30 секунд) пользователь должен видеть "живой" прогресс-бар / лог действий. 

```
[ Пользователь отправил команду ]
              │
              ▼
[ Composer: Создает сообщение-заглушку "⏳ Запуск..." ] ──┐
              │                                           │ (хранит chatId & msgId)
              ▼                                           │
[ Composer: Создает обертку updateStatus(line) ] <───────┘
              │
              ├──────► [ Service 1: fetchMarketData(updateStatus) ]
              │         └─► await updateStatus("📊 Загружаю стакан...")
              │
              ├──────► [ Service 2: walletIntel(updateStatus) ]
              │         └─► await updateStatus("🧠 On-chain анализ...")
              │
              ├──────► [ Service 3: aiEvaluate(updateStatus) ]
              │         └─► await updateStatus("🤖 Нейросеть генерирует отчет...")
              │
              ▼
[ Composer: Удаляет статус или заменяет его на финальный результат ]
```

### Главные правила изоляции:
1. **Слой Telegram (Composer / Bot)**: Инициализирует сообщение, держит в замыкании `loading.chat.id` и `loading.message_id`, формирует безопасный HTML, буферизует строки и подавляет ошибки API Telegram.
2. **Слой Бизнес-логики (Services)**: Принимает коллбэк `onStatusUpdate?: (msg: string) => Promise<void>`. Сервисы **НЕ** импортируют Telegram SDK и **НЕ** знают про `ctx`.

---

## 2. Готовый переиспользуемый класс/хелпер `StatusUpdater`

Для исключения дублирования кода рекомендуется использовать универсальный хелпер:

```javascript
// src/utils/statusUpdater.mjs

/**
 * Вспомогательный класс для безопасного обновления статусного сообщения в Telegram
 */
export class StatusUpdater {
  /**
   * @param {Object} ctx - Контекст grammY / Telegraf
   * @param {Object} loadingMsg - Объект отправленного сообщения-заглушки
   * @param {Object} [options]
   * @param {number} [options.maxLines=10] - Максимальное количество строк в логе
   * @param {string} [options.header] - Заголовок статусного сообщения
   * @param {number} [options.throttleMs=800] - Минимальный интервал между вызовами API (мс)
   */
  constructor(ctx, loadingMsg, options = {}) {
    this.ctx = ctx;
    this.chatId = loadingMsg.chat.id;
    this.messageId = loadingMsg.message_id;
    this.maxLines = options.maxLines || 10;
    this.header = options.header || '🔍 <b>Выполнение операции...</b>\n\n';
    this.throttleMs = options.throttleMs || 800;
    
    this.lines = [];
    this.lastUpdate = 0;
  }

  /**
   * Добавить новую строку в статус и обновить сообщение в Telegram
   * @param {string} newLine - Текст нового этапа
   * @param {boolean} [force=false] - Игнорировать троттлинг и обновить немедленно
   */
  async update(newLine, force = false) {
    this.lines.push(newLine);
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(-this.maxLines);
    }

    const now = Date.now();
    if (!force && (now - this.lastUpdate < this.throttleMs)) {
      return; // Пропускаем частые обновления для защиты от Rate Limit (429)
    }
    this.lastUpdate = now;

    const fullText = `${this.header}${this.lines.join('\n')}`;

    try {
      await this.ctx.api.editMessageText(this.chatId, this.messageId, fullText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (err) {
      // Игнорируем штатные ошибки Telegram API:
      // "message is not modified" (текст не изменился)
      // "message to edit not found" (сообщение было удалено пользователем)
    }
  }

  /**
   * Завершить работу: удалить статусное сообщение
   */
  async cleanup() {
    try {
      await this.ctx.api.deleteMessage(this.chatId, this.messageId);
    } catch (e) {
      // Игнорируем, если уже удалено
    }
  }
}
```

---

## 3. Эталонный пример использования в Composer (`src/composers/`)

```javascript
import { StatusUpdater } from '../utils/statusUpdater.mjs';
import { runAnalysisPipeline } from '../services/analysisService.mjs';

export async function handleAnalysisCommand(ctx) {
  // 1. Отправляем первоначальное сообщение-заглушку
  const loading = await ctx.reply('⏳ Запуск анализа рынка...', { parse_mode: 'HTML' });

  // 2. Инициализируем статус-апдейтер
  const updater = new StatusUpdater(ctx, loading, {
    header: '🔍 <b>Анализирую сигнал по тикеру...</b>\n\n',
    maxLines: 8,
    throttleMs: 1000
  });

  // Создаем функцию updateStatus для передачи в сервисы
  const updateStatus = async (line) => await updater.update(line);

  try {
    // 3. Запускаем конвейер задач с передачей коллбэка
    await updateStatus('📊 Запрашиваю рыночные данные и свечи...');
    const result = await runAnalysisPipeline(ctx.match, updateStatus);

    // 4. Завершение: удаляем временный статус и выводим итоговый результат
    await updater.cleanup();

    await ctx.reply(result.reportHtml, {
      parse_mode: 'HTML',
      reply_markup: result.keyboard
    });

  } catch (err) {
    console.error('Ошибка в handleAnalysisCommand:', err);
    await updater.cleanup();
    await ctx.reply(`❌ <b>Произошла ошибка:</b> ${escapeHtml(err.message)}`, {
      parse_mode: 'HTML'
    });
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

---

## 4. Эталонный пример в Сервисах (`src/services/`)

Сервисы принимают `onStatusUpdate` как опциональный асинхронный аргумент:

```javascript
// src/services/tokenDiscoveryService.mjs

export class TokenDiscoveryService {
  /**
   * Поиск токена на DEX
   * @param {string} query 
   * @param {Function} [onStatusUpdate] - Async callback (line: string) => Promise<void>
   */
  async searchToken(query, onStatusUpdate = null) {
    if (onStatusUpdate) {
      await onStatusUpdate(`🕵️ Поиск пары для ${query} на DexScreener...`);
    }

    const response = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${query}`);
    const data = await response.json();

    if (onStatusUpdate) {
      await onStatusUpdate(`✅ Найдено пар: ${data.pairs?.length || 0}`);
    }

    return data.pairs;
  }
}
```

---

## 5. Защита и Безопасность (Критический чек-лист)

### 🚨 1. Ограничение длины сообщения (Max 4096 символов)
- **Проблема**: В Telegram нельзя отправить или отредактировать сообщение длиннее 4096 символов.
- **Решение**: Всегда используйте окно логов `lines.slice(-N)` (где N = 5..10).

### 🚨 2. Ошибки `message is not modified`
- **Проблема**: Если текст сообщения не изменился, Telegram API возвращает HTTP 400 `Bad Request: message is not modified`.
- **Решение**: Всегда оборачивайте вызов `editMessageText` в `try { ... } catch (err) {}`.

### 🚨 3. Rate Limits (429 Too Many Requests)
- **Проблема**: Telegram лимитирует редактирование сообщений (не более ~1 запроса в секунду в один чат).
- **Решение**: Используйте троттлинг по времени (`throttleMs = 800..1000`) или вызывайте `updateStatus` только на ключевых контрольных точках.

### 🚨 4. Экранирование HTML
- **Проблема**: Если переменные (например, тикеры `$ETH` или имена токенов `<COIN>`) содержат символы `<` или `>`, Telegram выдаст ошибку парсинга HTML.
- **Решение**: Экранируйте пользовательские динамические строки через `escapeHtml()`.

---

## 6. Таблица Сравнения: Антипаттерны vs Рекомендуемый подход

| ❌ Антипаттерн | ✅ Рекомендуемый подход |
|---|---|
| Передавать `ctx` напрямую в сервис: `service.doWork(ctx)` | Передавать чистый коллбэк: `service.doWork(updateStatus)` |
| `statusText += newLine` без лимита длины | Фиксированный массив логов: `lines.slice(-10).join('\n')` |
| Вызывать `editMessageText` на каждой итерации быстрого цикла | Использовать троттлинг по времени (`>= 800ms`) |
| Падение всей команды из-за ошибки Telegram при редактировании | Перехватывать ошибки `editMessageText` в `try...catch` |
| Оставлять висящее сообщение "Загрузка..." после ответа | Удалять (`deleteMessage`) или подменять финальным текстом |
