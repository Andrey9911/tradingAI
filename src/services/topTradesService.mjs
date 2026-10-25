/**
 * Сервис получения и анализа топ недавних транзакций (Whale Trades)
 * Поддерживает Robinhood (Blockscout API) и DEX сети (GeckoTerminal Trades API)
 */

/**
 * Получение топ-5 крупных сделок по токену
 * 
 * @param {Object} tokenData - Объект данных токена (содержит chain, address, pairAddress, etc.)
 * @param {number} [priceUsd] - Цена токена в USD
 * @param {number} [timeoutMs] - Таймаут запроса в миллисекундах
 * @returns {Promise<Array<{ kind: 'buy'|'sell', volumeUsd: number, amount: number }>>}
 */
export async function getTopTrades(tokenData, priceUsd, timeoutMs = 8000) {
  if (!tokenData || !tokenData.address) return [];
  const chain = String(tokenData.chain || '').toLowerCase().trim();
  const tokenAddress = tokenData.address;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (chain === 'robinhood' || chain === 'robinhood-chain' || chain === 'rh-evm') {
      const explorerApiUrl = process.env.EXPLORER_API_URL || 'https://robinhoodchain.blockscout.com/api';
      const url = `${explorerApiUrl}?module=account&action=tokentx&contractaddress=${tokenAddress}&page=1&offset=100&sort=desc`;
      
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const json = await res.json();
      const transfers = json?.result || [];

      const pairAddr = String(tokenData.pairAddress || '').toLowerCase();
      const decimals = parseInt(tokenData.decimals || '18', 10);

      const mapped = transfers.map(tx => {
        const toAddr = String(tx.to || '').toLowerCase();
        const kind = (toAddr === pairAddr) ? 'sell' : 'buy';
        const rawAmount = parseFloat(tx.value || '0');
        const amount = rawAmount / (10 ** (parseInt(tx.tokenDecimal, 10) || decimals || 18));
        const volumeUsd = amount * (priceUsd || parseFloat(tokenData.price) || 0);

        return {
          kind,
          volumeUsd,
          amount,
        };
      });

      return mapped
        .filter(t => t.volumeUsd > 0)
        .sort((a, b) => b.volumeUsd - a.volumeUsd)
        .slice(0, 5);
    } else {
      const network = (chain === 'sol' || chain === 'solana') ? 'solana' : chain;
      const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}/trades`;
      
      const res = await fetch(url, {
        headers: {
          accept: 'application/json;version=20230203',
          'user-agent': 'tradingai-top-trades/1.0',
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      const trades = json?.data || [];

      const mapped = trades.map(t => {
        const attrs = t.attributes || {};
        const volumeUsd = parseFloat(attrs.volume_in_usd || '0');
        const amount = parseFloat(attrs.from_token_amount || attrs.to_token_amount || '0');
        const kind = attrs.kind || 'buy';
        return {
          kind,
          volumeUsd,
          amount,
        };
      });

      return mapped
        .filter(t => t.volumeUsd > 0)
        .sort((a, b) => b.volumeUsd - a.volumeUsd)
        .slice(0, 5);
    }
  } catch (err) {
    console.warn(`⚠️ Error fetching top trades for ${tokenAddress}: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
