import { Composer, InlineKeyboard } from 'grammy';
import { AIService } from '../services/aiService.mjs';
import {
  TokenDiscoveryService,
  getTokenDiscoveryFilters,
} from '../services/tokenDiscoveryService.mjs';

export const web3DiscoveryComposer = new Composer();

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function shortAddress(address) {
  if (!address) return '—';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return '$0';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function tokenUrl(token) {
  if (token.pairAddress) {
    return `https://dexscreener.com/${encodeURIComponent(token.chain)}/${encodeURIComponent(token.pairAddress)}`;
  }
  if (token.address && token.chain === 'solana') {
    return `https://pump.fun/${encodeURIComponent(token.address)}`;
  }
  return null;
}

function verdictTag(verdict) {
  if (verdict === 'BUY') return '🟢 BUY';
  if (verdict === 'AVOID') return '🔴 AVOID';
  return '🟡 WAIT';
}

function riskTag(riskLevel) {
  if (riskLevel === 'LOW') return 'LOW';
  if (riskLevel === 'HIGH') return 'HIGH';
  return 'MEDIUM';
}

export async function runWeb3Discovery(ctx) {
  const filters = getTokenDiscoveryFilters(ctx);
  const discovery = new TokenDiscoveryService();
  const ai = new AIService();
  const loading = await ctx.reply('⏳ Сканирую Pump.fun, DexScreener и GeckoTerminal…');
  let statusText = '🔎 <b>Web3 discovery scanner</b>\n';

  const updateStatus = async (line) => {
    try {
      statusText = `${statusText}\n${escapeHtml(line)}`.split('\n').slice(-10).join('\n');
      await ctx.api.editMessageText(loading.chat.id, loading.message_id, statusText, {
        parse_mode: 'HTML',
      });
    } catch {
      // Telegram может вернуть "message is not modified".
    }
  };

  try {
    const tokens = await discovery.discoverTopTokens(filters, updateStatus);
    if (!tokens.length) {
      await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
      await ctx.reply(
        `<b>🧠 Web3 Intelligence</b>\n\nНет токенов после фильтров:\n` +
          `• liquidityUsd &gt; ${filters.liquidityUsd}\n` +
          `• holders &gt; ${filters.holders}\n` +
          `• volume24h &gt; ${filters.volume24h}\n` +
          `• ageMinutes &gt; ${filters.ageMinutes}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    await updateStatus(`✅ Top-${tokens.length} найден. Запускаю AI-анализ…`);
    const analyzed = [];

    for (const token of tokens) {
      await updateStatus(`🤖 AI анализирует ${token.symbol || shortAddress(token.address)}…`);
      const aiResult = await ai.evaluateDiscoveredToken(token, updateStatus);
      analyzed.push({ ...token, ai: aiResult });
    }

    const keyboard = new InlineKeyboard();
    let text = `<b>🧠 Web3 Intelligence: top-${analyzed.length}</b>\n`;
    text += `<i>Источники: Pump.fun, DexScreener, GeckoTerminal. Это AI-отчёт для ручного решения, не авто-торговля.</i>\n\n`;
    text += `<b>Фильтры</b>: liquidityUsd &gt; ${filters.liquidityUsd}, holders &gt; ${filters.holders}, volume24h &gt; ${filters.volume24h}, ageMinutes &gt; ${filters.ageMinutes}\n\n`;

    analyzed.forEach((token, index) => {
      const url = tokenUrl(token);
      const name = escapeHtml(token.symbol || shortAddress(token.address));
      text += `<b>${index + 1}. ${name}</b> ${verdictTag(token.ai.verdict)} | risk ${riskTag(token.ai.riskLevel)}\n`;
      text += `<code>${escapeHtml(token.chain)}</code> ${escapeHtml(shortAddress(token.address))} | ${escapeHtml(token.dex)}\n`;
      text += `MC ${formatUsd(token.marketCap)} | Liq ${formatUsd(token.liquidityUsd)} | Vol24 ${formatUsd(token.volume24h)} | Holders/tx ${token.holders}/${token.buys24h + token.sells24h}\n`;
      text += `Buys/Sells 24h: ${token.buys24h}/${token.sells24h} | Age: ${Math.round(token.ageMinutes)}m\n`;
      text += `<i>${escapeHtml(token.ai.reason)}</i>\n`;
      if (url) text += `<a href="${escapeHtml(url)}">Открыть график/пул</a>\n`;
      text += '\n';

      if (url) {
        keyboard.url(`${index + 1}. ${token.symbol || shortAddress(token.address)}`, url).row();
      }
    });
    keyboard.text('🔄 Обновить Web3 top-10', 'web3_refresh');

    await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
    await ctx.reply(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error('runWeb3Discovery', err);
    await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
    await ctx.reply(`❌ Ошибка Web3 discovery: ${escapeHtml(err.message)}`, {
      parse_mode: 'HTML',
    });
  }
}

web3DiscoveryComposer.callbackQuery('web3_refresh', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await runWeb3Discovery(ctx);
});
