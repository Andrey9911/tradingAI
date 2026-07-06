import { Composer, InlineKeyboard } from 'grammy';
import { AIService } from '../services/aiService.mjs';
import {
  TokenDiscoveryService,
  getTokenDiscoveryFilters,
} from '../services/tokenDiscoveryService.mjs';
import { WalletIntelService } from '../services/walletIntelService.mjs';
import { getRecentResearchData } from '../services/researchCacheService.mjs';

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

function walletRiskTag(riskLevel) {
  if (riskLevel === 'LOW') return 'LOW';
  if (riskLevel === 'HIGH') return 'HIGH';
  if (riskLevel === 'UNKNOWN') return 'UNKNOWN';
  return 'MEDIUM';
}

function formatOptionalNumber(value, suffix = '') {
  if (!Number.isFinite(value)) return '—';
  return `${value}${suffix}`;
}

function formatWalletIntel(walletIntel) {
  if (!walletIntel) return 'WalletIntel: —\n';
  const distribution = walletIntel.holderDistribution || {};
  const cluster = walletIntel.fundingCluster || {};
  const clusterText = cluster.isClustered
    ? `cluster YES (${escapeHtml(cluster.source || 'same funding')})`
    : 'cluster no';

  return (
    `WalletIntel ${walletRiskTag(walletIntel.riskLevel)} | ${clusterText}\n` +
    `Age ${formatOptionalNumber(walletIntel.walletAgeDays, 'd')} | fund ${escapeHtml(walletIntel.firstFundingSource || 'unknown')} | connected ${walletIntel.connectedWallets || 0} | rugpulls ${walletIntel.previousRugpulls || 0}/${walletIntel.previousTokens || 0}\n` +
    `Dev ${escapeHtml(walletIntel.devWallet || '—')} | top holder ${toFixedSafe(distribution.topHolderPct)}% | high supply ${distribution.highSupplyWallets || 0}\n` +
    `Sniper ${escapeHtml(walletIntel.sniperBehavior || 'NONE')} | ${escapeHtml(walletIntel.transferPattern || 'unknown')} | PnL ${escapeHtml(walletIntel.realizedProfit || '—')} | top5 ${toFixedSafe(distribution.top5Pct)}%\n` +
    `<i>${escapeHtml(walletIntel.summary || 'wallet intelligence unavailable')}</i>\n`
  );
}

function toFixedSafe(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '0.0';
}

function compactReason(reason) {
  const value = String(reason || '').trim();
  // if (value.length <= 120) return value;
  // return `${value.slice(0, 117)}…`;
  return value;
}

export async function runWeb3Discovery(ctx) {
  const filters = getTokenDiscoveryFilters(ctx);
  const discovery = new TokenDiscoveryService();
  const ai = new AIService();
  const walletIntel = new WalletIntelService();
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
    const tokens = await discovery.discoverTopTokens(filters, updateStatus, ctx.session.isDisableFiltr);
    if (!tokens.length) {
      await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => { });
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

    await updateStatus(`✅ Top-${tokens.length} найден. Запускаю Wallet Intelligence…`);
    const onchainTokens = await walletIntel.analyzeTopTokens(tokens, updateStatus);

    const enriched = [];
    const researchContext = getRecentResearchData({ hours: 3, limit: 5 });
    if (researchContext.length) {
      await updateStatus(`📊 Подключаю short-term research context: ${researchContext.length} item(s).`);
    }

    for (const token of onchainTokens) {
      await updateStatus(`🤖 AI анализирует ${token.symbol || shortAddress(token.address)}…`);
      const relevantResearch = researchContext.filter((item) => {
        const haystack = `${item.summary || ''} ${(item.signals || []).join(' ')} ${(item.tokens || []).join(' ')}`.toLowerCase();
        const symbol = String(token.symbol || '').toLowerCase();
        const address = String(token.address || '').toLowerCase();
        return !symbol && !address ? true : haystack.includes(symbol) || haystack.includes(address) || researchContext.length <= 2;
      });
      const aiResult = await ai.evaluateDiscoveredToken(token, updateStatus, relevantResearch.length ? relevantResearch : researchContext.slice(0, 2));
      console.log(aiResult);

      enriched.push({ ...token, ai: aiResult });
    }

    let text = `<b>🧠 Web3 Intelligence: top-${enriched.length}</b>\n`;
    text += `<i>Источники: Pump.fun, DexScreener, GeckoTerminal. Это AI-отчёт для ручного решения, не авто-торговля.</i>\n\n`;
    if (researchContext.length) {
      text += `<b>Research context:</b> ${researchContext.length} fresh item(s), last ${escapeHtml(researchContext[0].createdAt)}\n\n`;
    }
    text += `<b>Фильтры</b>: liquidityUsd &gt; ${filters.liquidityUsd}, holders &gt; ${filters.holders}, volume24h &gt; ${filters.volume24h}, ageMinutes &gt; ${filters.ageMinutes}\n\n`;

    let chunks = [];
    let currentChunkText = text;
    let currentKeyboard = new InlineKeyboard();

    enriched.forEach((token, index) => {
      const url = tokenUrl(token);
      const name = escapeHtml(token.symbol || shortAddress(token.address));
      
      let tokenText = `🔹 <b>${index + 1}. ${name}</b> | <code>${escapeHtml(token.chain)}</code>\n`;
      tokenText += `<b>Verdict:</b> ${verdictTag(token.ai.verdict)} | <b>Risk:</b> ${riskTag(token.ai.riskLevel)}\n`;
      tokenText += `🔗 <code>${escapeHtml(shortAddress(token.address))}</code>\n`;
      tokenText += `💰 <b>MC:</b> ${formatUsd(token.marketCap)} | 💧 <b>Liq:</b> ${formatUsd(token.liquidityUsd)} | 📊 <b>Vol:</b> ${formatUsd(token.volume24h)}\n`;
      tokenText += `👥 <b>Holders:</b> ${token.holders} | 📈 <b>B/S:</b> ${token.buys24h}/${token.sells24h} | ⏱ <b>Age:</b> ${Math.round(token.ageMinutes)}m\n`;
      tokenText += `🧠 <i>${escapeHtml(compactReason(token.ai.reason))}</i>\n`;
      tokenText += `<blockquote>${formatWalletIntel(token.walletIntel).trim()}</blockquote>\n\n`;

      if (currentChunkText.length + tokenText.length > 3900) {
        chunks.push({ text: currentChunkText, keyboard: currentKeyboard });
        currentChunkText = '';
        currentKeyboard = new InlineKeyboard();
      }

      currentChunkText += tokenText;
      
      const knowledgeGraph = token.walletIntel?.knowledgeGraph || { nodes: [], edges: [] };
      const payload = Buffer.from(JSON.stringify(knowledgeGraph)).toString('base64');
      const webAppUrl = `https://bottelegram-poll.amvera.io/index.html?data=${encodeURIComponent(payload)}&symbol=${encodeURIComponent(token.symbol || 'Token')}`;

      currentKeyboard.webApp(`📊 Анализ кошельков ${name}`, webAppUrl);
      if (url) {
        currentKeyboard.url(`🔗 Торговать ${name}`, url);
      }
      currentKeyboard.row();
    });

    currentKeyboard.text('🔄 Обновить Web3 top-10', 'web3_refresh');
    chunks.push({ text: currentChunkText, keyboard: currentKeyboard });

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await ctx.api.editMessageText(loading.chat.id, loading.message_id, chunks[i].text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: chunks[i].keyboard,
        });
      } else {
        await ctx.reply(chunks[i].text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: chunks[i].keyboard,
        });
      }
    }
  } catch (err) {
    console.error('runWeb3Discovery', err);
    await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => { });
    await ctx.reply(`❌ Ошибка Web3 discovery: ${escapeHtml(err.message)}`, {
      parse_mode: 'HTML',
    });
  }
}

web3DiscoveryComposer.callbackQuery('web3_refresh', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => { });
  await runWeb3Discovery(ctx);
});
