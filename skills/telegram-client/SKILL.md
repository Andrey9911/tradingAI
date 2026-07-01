---
name: Telegram Client Management
description: Guidelines on how to correctly use TelegramClientManager in the project to interact with Telegram MTProto.
---

# Правила работы с TelegramClientManager

При использовании `TelegramClientManager` для вызова методов MTProto (через библиотеку gramjs) важно соблюдать следующий паттерн. 

Класс содержит методы `runWithSession` и `runAction`, которые автоматически управляют жизненным циклом сессии (устанавливают соединение и ОБЯЗАТЕЛЬНО закрывают его в блоке `finally`). Из-за этого нельзя пытаться извлечь инстанс `client` наружу и использовать его после завершения вызова. 

Вся работа с `client` должна происходить строго внутри передаваемой `actionCallback` функции.

## ❌ Как делать НЕЛЬЗЯ:
```javascript
// НЕВЕРНО! Метод runWithSession ожидает коллбэк вторым аргументом. 
// Попытка вернуть client приведет к ошибке после отключения, а неверные аргументы вызовут TypeError (actionCallback is not a function).
let client = await TelegramClientManager.runWithSession(sessionStr, {apiId, apiHash});
await client.connect();
const messages = await client.getMessages(channel);
await client.disconnect();
```

## ✅ Как нужно делать:
```javascript
// ПРАВИЛЬНО! Вся работа происходит внутри коллбэка. Метод сам сделает client.connect() и client.disconnect()
const messages = await TelegramClientManager.runWithSession(sessionStr, async (client) => {
    // Внутри коллбэка клиент гарантированно подключен
    return await client.getMessages(channel, { limit: 10 });
}, { apiId, apiHash });
```

Или, если сессия читается из файла автоматически через `runAction`:

```javascript
// ПРАВИЛЬНО! 
const results = await TelegramClientManager.runAction(async (client) => {
    await client.sendMessage(channel, { message: "Hello", linkPreview: false });
    return true;
});
```

Следование этому паттерну предотвратит утечки памяти и ошибки `actionCallback is not a function`.
