const DEFAULT_SETTINGS = { apiBaseUrl: 'http://localhost:3333', extensionToken: '', telegramUserId: '' };

async function settings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Не найдена активная вкладка.');
  return tab;
}

async function api(path, options = {}) {
  const config = await settings();
  if (!config.extensionToken) throw new Error('Укажите токен расширения в настройках.');
  let response;
  try {
    response = await fetch(`${config.apiBaseUrl.replace(/\/$/, '')}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': config.extensionToken, ...(options.headers || {}) },
    });
  } catch {
    throw new Error(`Нет соединения с сервером: ${config.apiBaseUrl}. Запустите bot-сервер и проверьте адрес в настройках.`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || 'Сервер вернул ошибку.');
  return payload;
}

async function getDomTree(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
    const { root } = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: 4, pierce: true });
    const described = await chrome.debugger.sendCommand({ tabId }, 'DOM.describeNode', { nodeId: root.nodeId, depth: 2, pierce: true });
    return { root, describedNode: described.node };
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function ensureContentScript(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'PING' }); }
  catch { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/selector.js'] }); }
}

function parseInvestingPrice(html) {
  const match = html.match(/data-test="instrument-header-details"[\s\S]{0,300}?>([\d,.]+)/i) || html.match(/last_last[^>]*>\s*([\d,.]+)/i);
  return match ? match[1].replace(/,/g, '') : null;
}

async function macroData() {
  const { macroCache } = await chrome.storage.local.get('macroCache');
  if (macroCache?.updatedAt && Date.now() - macroCache.updatedAt < 15 * 60 * 1000) return macroCache.data;
  const pages = { oil: 'https://www.investing.com/commodities/brent-oil', gold: 'https://www.investing.com/commodities/gold' };
  const entries = await Promise.all(Object.entries(pages).map(async ([key, url]) => {
    try { const html = await (await fetch(url, { headers: { 'Accept-Language': 'en-US,en;q=0.9' }, credentials: 'omit' })).text(); return [key, { price: parseInvestingPrice(html), source: 'Investing.com' }]; }
    catch { return [key, { price: null, source: 'Investing.com' }]; }
  }));
  const data = Object.fromEntries(entries);
  await chrome.storage.local.set({ macroCache: { data, updatedAt: Date.now() } });
  return data;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'GET_SETTINGS': sendResponse({ ok: true, settings: await settings() }); break;
      case 'SAVE_SETTINGS':
        await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...message.settings } });
        sendResponse({ ok: true }); break;
      case 'ANALYZE_SIGNAL': {
        const result = await api('/api/extension/analyze', { method: 'POST', body: JSON.stringify(message.payload) });
        sendResponse({ ok: true, result }); break;
      }
      case 'DETECT_CURRENT_TOKEN': {
        const tab = await activeTab();
        if (!/^https?:/.test(tab.url || '')) throw new Error('Откройте сайт с графиком в соседней вкладке.');
        await ensureContentScript(tab.id);
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'DETECT_TOKEN' });
        sendResponse({ ok: true, token: result.token }); break;
      }
      case 'CAPTURE_TAB': {
        const tab = await activeTab();
        const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
        sendResponse({ ok: true, image }); break;
      }
      case 'ANALYZE_SCREENSHOT': {
        const result = await api('/api/extension/vision', { method: 'POST', body: JSON.stringify(message.payload) });
        sendResponse({ ok: true, verdict: result.verdict }); break;
      }
      case 'GET_MACRO': sendResponse({ ok: true, data: await macroData() }); break;
      case 'GET_ARCHIVE': {
        const config = await settings();
        const query = new URLSearchParams({ telegramUserId: config.telegramUserId, query: message.query || '' });
        sendResponse({ ok: true, archive: await api(`/api/extension/signals?${query}`) }); break;
      }
      case 'GET_DOM_TREE': {
        const tab = await activeTab();
        if (!/^https?:/.test(tab.url || '')) throw new Error('Откройте обычную веб-страницу (http/https).');
        sendResponse({ ok: true, tree: await getDomTree(tab.id), title: tab.title, url: tab.url }); break;
      }
      case 'START_PICKER': {
        const tab = await activeTab();
        await ensureContentScript(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: 'START_PICKER' });
        sendResponse({ ok: true }); break;
      }
      case 'STOP_PICKER': {
        const tab = await activeTab();
        await chrome.tabs.sendMessage(tab.id, { type: 'STOP_PICKER' });
        sendResponse({ ok: true }); break;
      }
      case 'ELEMENT_PICKED':
        await chrome.storage.session.set({ selectedElement: message.payload });
        sendResponse({ ok: true }); break;
      default: throw new Error('Неизвестная команда.');
    }
  })().catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
