import { TonService } from './tonService.mjs';
import { AIService } from './aiService.mjs';
import { getLiquidityLine } from './bybitService.mjs';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.WALLET_INTEL_TIMEOUT_MS || '8000', 10);
const DEFAULT_SOLANA_RPC_URL = `${process.env.SOLANA_RPC_URL}?api-key=${process.env.SOLANA_RPC_KEY}` || 'https://api.mainnet-beta.solana.com';
const DEFAULT_MAX_HOLDER_WALLETS = parseInt(process.env.WALLET_INTEL_MAX_HOLDER_WALLETS || '9', 10);
const CLUSTER_TIME_WINDOW_MINUTES = parseFloat(process.env.WALLET_INTEL_CLUSTER_WINDOW_MINUTES || '3');
const HIGH_SUPPLY_SHARE = parseFloat(process.env.WALLET_INTEL_HIGH_SUPPLY_SHARE || '5');
const REALIZED_PROFIT_UNAVAILABLE = 'needs-indexer';

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function shortAddress(address) {
  if (!address) return '—';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function compactAddress(address) {
  return address ? String(address).trim() : '';
}

function minutesBetween(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(a - b) / 60;
}

function daysSince(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  return Math.max(0, Math.round((Date.now() / 1000 - unixSeconds) / 86400));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function tokenAmount(row) {
  return toNumber(row.uiAmount ?? row.uiAmountString ?? row.amount, 0);
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', body = null, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'tradingai-wallet-intel/1.0',
        ...headers,
      },
      body: body ? JSON.stringify(body) : null,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseSystemFunding(tx, wallet) {
  const target = compactAddress(wallet);
  const instructions = tx?.transaction?.message?.instructions || [];
  for (const instruction of instructions) {
    const parsed = instruction?.parsed;
    const info = parsed?.info || {};
    const type = String(parsed?.type || '').toLowerCase();
    if ((type === 'transfer' || type === 'transferchecked') && compactAddress(info.destination) === target) {
      return firstString(info.source, info.authority, info.multisigAuthority);
    }
    if (type === 'createaccount' && compactAddress(info.newAccount) === target) {
      return firstString(info.source, info.funder);
    }
  }

  const balancesBefore = tx?.meta?.preBalances || [];
  const balancesAfter = tx?.meta?.postBalances || [];
  const accountKeys = tx?.transaction?.message?.accountKeys || [];
  const targetIndex = accountKeys.findIndex(key => {
    const pubkey = typeof key === 'string' ? key : (key.pubkey?.toString?.() || String(key.pubkey || key));
    return compactAddress(pubkey) === target;
  });
  if (targetIndex < 0 || !Number.isFinite(balancesBefore[targetIndex]) || !Number.isFinite(balancesAfter[targetIndex])) return '';
  if (balancesAfter[targetIndex] <= balancesBefore[targetIndex]) return '';

  let source = '';
  let largestDebit = 0;
  accountKeys.forEach((key, index) => {
    const pubkey = typeof key === 'string' ? key : (key.pubkey?.toString?.() || String(key.pubkey || key));
    const before = balancesBefore[index];
    const after = balancesAfter[index];
    if (!Number.isFinite(before) || !Number.isFinite(after)) return;
    const debit = before - after;
    if (debit > largestDebit) {
      largestDebit = debit;
      source = compactAddress(pubkey);
    }
  });
  return source === target ? '' : source;
}

function decimalToNumber(rawValue, decimals = 18) {
  try {
    if (!rawValue) return 0;
    const raw = BigInt(rawValue);
    const scale = 10n ** BigInt(Math.max(0, decimals));
    const integer = raw / scale;
    const fraction = raw % scale;
    return Number(integer) + Number(fraction) / Number(scale);
  } catch {
    return Number(rawValue || 0) / (10 ** decimals);
  }
}

async function getContractDeployer(contractAddress, explorerApiUrl, apiKey = '') {
  if (!contractAddress || !explorerApiUrl) return '';
  try {
    const apiKeyParam = apiKey ? `&apikey=${apiKey}` : '';
    const url = `${explorerApiUrl}?module=account&action=txlist&address=${contractAddress}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc${apiKeyParam}`;
    const data = await fetchJson(url);
    if (data?.status === '1' && Array.isArray(data?.result) && data?.result.length > 0) {
      return data.result[0].from || '';
    }
  } catch (err) {
    console.warn(`⚠️ Error getting contract deployer for ${contractAddress}:`, err.message);
  }
  return '';
}

async function getFundingSource(wallet, explorerApiUrl, apiKey = '') {
  if (!wallet || !explorerApiUrl) {
    return { fundingSource: '', fundedAtSec: null, walletAgeDays: null };
  }
  try {
    const apiKeyParam = apiKey ? `&apikey=${apiKey}` : '';
    const url = `${explorerApiUrl}?module=account&action=txlist&address=${wallet}&startblock=0&endblock=99999999&page=1&offset=10&sort=asc${apiKeyParam}`;
    const data = await fetchJson(url);
    if (data?.status === '1' && Array.isArray(data?.result)) {
      const firstTx = data.result.find(tx => 
        tx.to && tx.to.toLowerCase() === wallet.toLowerCase() && 
        tx.from && tx.from.toLowerCase() !== wallet.toLowerCase() &&
        tx.isError !== '1'
      );
      if (firstTx) {
        const timeStamp = parseInt(firstTx.timeStamp, 10);
        return {
          fundingSource: firstTx.from,
          fundedAtSec: timeStamp,
          walletAgeDays: daysSince(timeStamp)
        };
      }
    }
  } catch (err) {
    console.warn(`⚠️ Error getting funding source for wallet ${wallet}:`, err.message);
  }
  return { fundingSource: '', fundedAtSec: null, walletAgeDays: null };
}

function classifyTokenBehavior(token) {
  const buys = toNumber(token.buys24h, 0);
  const sells = toNumber(token.sells24h, 0);
  if (sells >= Math.max(3, buys * 1.25)) return 'sell_pressure';
  if (buys >= Math.max(3, sells * 1.5)) return 'buy_pressure';
  return 'balanced_flow';
}

function classifyTransferPattern({ highSupplyWallets, holderDistribution, behavior }) {
  const clustered = highSupplyWallets.filter(wallet => wallet.fundingSource).length >= 2;
  if (clustered && behavior === 'sell_pressure') return 'clustered_sells';
  if (holderDistribution.topHolderPct >= 20 || holderDistribution.top5Pct >= 45) return 'whale_concentrated';
  if (behavior === 'sell_pressure') return 'sell_pressure';
  if (behavior === 'buy_pressure') return 'accumulation';
  return 'balanced';
}

function detectSniperBehavior({ token, holderWallets, tokenCreatedAtSec }) {
  const earlyEntries = holderWallets
    .map(wallet => wallet.enteredTokenAtSec)
    .filter(Number.isFinite)
    .filter(entry => Number.isFinite(tokenCreatedAtSec) && entry >= tokenCreatedAtSec && entry - tokenCreatedAtSec <= 180);
  if (earlyEntries.length >= 2) return 'STRONG';
  if (earlyEntries.length === 1 || toNumber(token.ageMinutes, 0) <= 15 && toNumber(token.buys24h, 0) > 50) return 'POSSIBLE';
  return 'NONE';
}

function detectFundingCluster({ highSupplyWallets, behavior, token }) {
  const groups = new Map();
  for (const wallet of highSupplyWallets) {
    if (!wallet.fundingSource || !Number.isFinite(wallet.fundedAtSec)) continue;
    const key = `${wallet.fundingSource}:${behavior}`;
    const group = groups.get(key) || [];
    group.push(wallet);
    groups.set(key, group);
  }

  const coordinatedSells = toNumber(token.sells24h, 0) >= Math.max(5, toNumber(token.buys24h, 0) * 0.8);
  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;
    const sorted = group.sort((a, b) => a.fundedAtSec - b.fundedAtSec);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (minutesBetween(a.fundedAtSec, b.fundedAtSec) <= CLUSTER_TIME_WINDOW_MINUTES && coordinatedSells) {
        const [source] = key.split(':');
        return {
          isClustered: true,
          source,
          wallets: unique(group.map(wallet => wallet.wallet)).slice(0, 5),
          reason: `same funding ±${CLUSTER_TIME_WINDOW_MINUTES}m + coordinated sells`,
        };
      }
    }
  }

  return {
    isClustered: false,
    source: '',
    wallets: [],
    reason: coordinatedSells ? 'sell pressure without matched funding cluster' : 'no coordinated funding/sell cluster',
  };
}

function fallbackIntel(reason) {
  return {
    walletAgeDays: null,
    firstFundingSource: 'unknown',
    connectedWallets: 0,
    previousTokens: 0,
    previousRugpulls: 0,
    realizedProfit: REALIZED_PROFIT_UNAVAILABLE,
    sniperBehavior: 'NONE',
    transferPattern: 'unknown',
    fundingCluster: { isClustered: false, source: '', wallets: [], reason },
    holderDistribution: {
      topHolderPct: 0,
      top5Pct: 0,
      highSupplyWallets: 0,
      analyzedWallets: 0,
    },
    devWallet: '',
    riskLevel: 'UNKNOWN',
    summary: reason,
  };
}

/**
 * @typedef {Object} GraphNode
 * @property {string} address - Полный адрес (ID узла)
 * @property {string} shortAddress - Сокращенный адрес для UI
 * @property {string[]} roles - Массив ролей (например: ['developer', 'sniper', 'cluster', 'high_holder'])
 * @property {number} pct - Процент владения (0 если нет)
 * @property {string} [fundingSource] - Полный адрес источника финансирования (опционально)
 * @property {number} [enteredTokenAtSec] - Время входа (Unix timestamp)
 * @property {number} [walletAgeDays] - Возраст кошелька
 */

/**
 * @typedef {Object} GraphEdge
 * @property {string} source - Полный адрес отправителя / инициатора связи
 * @property {string} target - Полный адрес получателя
 * @property {string} type - Тип связи (строгий enum)
 * @property {Object} [metadata] - Дополнительные данные (например, разница во времени)
 */

/**
 * @typedef {Object} KnowledgeGraph
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 */

/**
 * Чистая функция для построения Knowledge Graph на основе данных кошельков.
 * Выявляет кластеры, сети финансирования и снайперские паттерны.
 * 
 * @param {Object} params
 * @param {Array} params.holderWallets
 * @param {Object} [params.devWalletIntel]
 * @param {number} [params.tokenCreatedAtSec]
 * @returns {KnowledgeGraph}
 */
export function buildKnowledgeGraph({ holderWallets = [], devWalletIntel = null, tokenCreatedAtSec = null }) {
  const nodesMap = new Map();

  const addNode = (walletInfo, isDev = false) => {
    if (!walletInfo || !walletInfo.wallet) return;
    const address = walletInfo.wallet;

    const existing = nodesMap.get(address) || {
      address,
      shortAddress: shortAddress(address),
      roles: [],
      pct: walletInfo.pct || 0,
      fundingSource: walletInfo.fundingSource || undefined,
      enteredTokenAtSec: walletInfo.enteredTokenAtSec,
      walletAgeDays: walletInfo.walletAgeDays
    };

    if (isDev && !existing.roles.includes('developer')) {
      existing.roles.push('developer');
    }

    if (walletInfo.enteredTokenAtSec && tokenCreatedAtSec && (walletInfo.enteredTokenAtSec - tokenCreatedAtSec <= 180)) {
      if (!existing.roles.includes('sniper')) existing.roles.push('sniper');
    }

    if (existing.roles.length === 0) {
      existing.roles.push('holder');
    }

    nodesMap.set(address, existing);
  };

  if (devWalletIntel) {
    addNode(devWalletIntel, true);
  }

  for (const hw of holderWallets) {
    addNode(hw, devWalletIntel && hw.wallet === devWalletIntel.wallet);
  }

  const nodes = Array.from(nodesMap.values());
  const edges = [];

  // Оптимизация: группировка по fundingSource
  const fundingGroups = new Map();
  for (const node of nodes) {
    if (node.fundingSource) {
      const group = fundingGroups.get(node.fundingSource) || [];
      group.push(node);
      fundingGroups.set(node.fundingSource, group);
    }
  }

  // Генерация ребер (shared_funding_source, dev_transfer)
  for (const [sourceAddr, targets] of fundingGroups.entries()) {
    for (const targetNode of targets) {
      // Связь от devWallet
      if (devWalletIntel && sourceAddr === devWalletIntel.wallet && targetNode.address !== devWalletIntel.wallet) {
        edges.push({
          source: sourceAddr,
          target: targetNode.address,
          type: 'dev_transfer'
        });
      }
      
      // Общий источник финансирования
      if (targetNode.address !== sourceAddr) {
        edges.push({
          source: sourceAddr,
          target: targetNode.address,
          type: 'shared_funding_source'
        });
      }
    }
  }

  // Генерация ребер (synchronous_entry)
  const timedNodes = nodes.filter(n => typeof n.enteredTokenAtSec === 'number')
                          .sort((a, b) => a.enteredTokenAtSec - b.enteredTokenAtSec);

  for (let i = 0; i < timedNodes.length; i++) {
    for (let j = i + 1; j < timedNodes.length; j++) {
      const diff = Math.abs(timedNodes[j].enteredTokenAtSec - timedNodes[i].enteredTokenAtSec);
      if (diff <= 15) {
        edges.push({
          source: timedNodes[i].address,
          target: timedNodes[j].address,
          type: 'synchronous_entry',
          metadata: { timeDifferenceSec: diff }
        });
      } else {
        break; // Так как массив отсортирован, дальше разница будет только расти
      }
    }
  }

  return { nodes, edges };
}

export class WalletIntelService {
  constructor({
    timeoutMs = DEFAULT_TIMEOUT_MS,
    solanaRpcUrl = DEFAULT_SOLANA_RPC_URL,
    maxHolderWallets = DEFAULT_MAX_HOLDER_WALLETS,
    tonService = new TonService({ timeoutMs }),
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.solanaRpcUrl = solanaRpcUrl;
    this.maxHolderWallets = maxHolderWallets;
    this.tonService = tonService;
  }

  //глубокий анализ отфильтрованных токенов 
  //#1 перебор токенов для анализа
  async analyzeTopTokens(tokens, onStatusUpdate = null) {
    const analyzed = [];
    for (const token of tokens) {
      if (onStatusUpdate) await onStatusUpdate(`🕵️ Wallet Intel: ${token.symbol || shortAddress(token.address)}…`);
      const walletIntel = await this.analyzeToken(token, onStatusUpdate);
      
      // Определение "линии лежачей ликвидности" через книгу ордеров CEX
      let liquidityClusters = null;
      try {
        if (token.symbol) {
          liquidityClusters = await getLiquidityLine(token.symbol);
        }
      } catch (err) {
        console.warn(`⚠️ LiquidityLine for ${token.symbol}: ${err.message}`);
      }

      analyzed.push({ ...token, walletIntel, liquidityClusters });
      console.log('walletIntel', walletIntel);
    }


    return analyzed;
  }
  //#2 анализ конкретного токена
  async analyzeToken(token, onStatusUpdate = null) {
    const chain = String(token.chain || '').toLowerCase().trim();
    try {
      if (chain === 'ton') {
        return await this.tonService.analyzeTonToken(token, onStatusUpdate);
      }
      if (chain === 'robinhood' || chain === 'robinhood-chain' || chain === 'rh-evm') {
        return await this.analyzeRobinhoodEvmToken(token, onStatusUpdate);
      }
      if (chain !== 'solana' && chain !== 'sol') {
        return this.analyzeUnsupportedChain(token);
      }
      return await this.analyzeSolanaToken(token, onStatusUpdate);
    } catch (err) {
      console.error(`⛔ analyzeToken error for ${token.symbol || shortAddress(token.address)}:`, err.message);
      if (onStatusUpdate) await onStatusUpdate(`⚠️ Wallet Intel ${token.symbol || shortAddress(token.address)}: ${err.message}`);
      return fallbackIntel(`wallet intelligence unavailable: ${err.message}`);
    }
  }

  analyzeUnsupportedChain(token) {
    const behavior = classifyTokenBehavior(token);
    const transferPattern = classifyTransferPattern({
      highSupplyWallets: [],
      holderDistribution: { topHolderPct: 0, top5Pct: 0 },
      behavior,
    });
    return {
      ...fallbackIntel(`chain ${token.chain || 'unknown'} needs holder/deployer indexer`),
      sniperBehavior: toNumber(token.ageMinutes, 0) <= 15 ? 'POSSIBLE' : 'NONE',
      transferPattern,
      riskLevel: behavior === 'sell_pressure' ? 'MEDIUM' : 'UNKNOWN',
    };
  }

  /**
   * Анализирует ERC-20 токен на Robinhood Chain (EVM / WETH пулы).
   * Собирает метрики из трех источников (DexScreener/Gecko, Bitquery, Moralis & Explorer) в параллельном режиме.
   * 
   * @param {Object} token
   * @param {Function} [onStatusUpdate]
   * @returns {Promise<Object>}
   * 
  
   */
  async analyzeRobinhoodEvmToken(token, onStatusUpdate = null) {
    const tokenAddress = compactAddress(token.address || token.tokenAddress);
    if (!tokenAddress) return fallbackIntel('EVM token address missing');

    const explorerApiUrl = process.env.EXPLORER_API_URL || 'https://robinhoodchain.blockscout.com/api';
    const explorerApiKey = process.env.EXPLORER_API_KEY || process.env.ARBISCAN_API_KEY || ''; // [SECURE_VARIABLE]
    const moralisApiKey = process.env.MORALIS_API_KEY || process.env.MORALIS_KEY || ''; // [SECURE_VARIABLE]
    const bitqueryApiKey = process.env.BITQUERY_API_KEY || process.env.BITQUERY_KEY || ''; // [SECURE_VARIABLE]

    if (onStatusUpdate) await onStatusUpdate(`🕵️ Robinhood Intel: Начало анализа токена ${shortAddress(tokenAddress)}...`);

    // Параллельный сбор данных из 3 блоков
    const [block1Res, block2Res, block3Res] = await Promise.all([
      // Блок 1: Базовая информация о пуле (DexScreener + Moralis Metadata)
      (async () => {
        try {
          if (onStatusUpdate) await onStatusUpdate('🕵️ Robinhood Intel [1/3]: Получение информации о пуле (DexScreener)...');
          const dexscreenerUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
          const dexscreenerData = await fetchJson(dexscreenerUrl, { timeoutMs: this.timeoutMs });
          const pairs = dexscreenerData?.pairs || [];
          
          // Ищем пулы на базе Arbitrum/Robinhood, где quoteToken.symbol = 'WETH'
          const pair = pairs.find(p => 
            (String(p.chainId).toLowerCase() === 'arbitrum' || String(p.chainId).toLowerCase() === 'robinhood') && 
            p.quoteToken?.symbol === 'WETH'
          ) || pairs[0];

          if (!pair) {
            throw new Error('No pairs found on DexScreener');
          }

          const liquidityUsd = toNumber(pair.liquidity?.usd, 0);
          if (liquidityUsd < 1000) {
            throw new Error(`Low liquidity ($${liquidityUsd.toFixed(0)} < $1,000)`);
          }

          let decimals = 18;
          let totalSupply = 0;

          if (moralisApiKey) {
            try {
              const metadataUrl = `https://deep-index.moralis.io/api/v2.2/erc20/metadata?addresses%5B%5D=${tokenAddress}&chain=robinhood`;
              const metadataResponse = await fetchJson(metadataUrl, {
                timeoutMs: this.timeoutMs,
                headers: { 'X-API-Key': moralisApiKey }
              });
              const metadata = metadataResponse?.[0] || {};
              decimals = parseInt(metadata.decimals || '18', 10);
              totalSupply = toNumber(metadata.total_supply_formatted || (metadata.total_supply ? decimalToNumber(metadata.total_supply, decimals) : 0), 0);
            } catch (err) {
              console.warn(`⚠️ Error fetching Moralis metadata: ${err.message}`);
            }
          }

          // Fallback to Blockscout v2 REST API for token decimals/supply
          if (totalSupply === 0) {
            try {
              const blockscoutTokenUrl = `https://robinhoodchain.blockscout.com/api/v2/tokens/${tokenAddress}`;
              const blockscoutTokenResponse = await fetchJson(blockscoutTokenUrl, { timeoutMs: this.timeoutMs });
              if (blockscoutTokenResponse) {
                decimals = parseInt(blockscoutTokenResponse.decimals || '18', 10);
                totalSupply = toNumber(blockscoutTokenResponse.total_supply, 0) / (10 ** decimals);
              }
            } catch (err) {
              console.warn(`⚠️ Error fetching Blockscout token metadata: ${err.message}`);
            }
          }

          return {
            pair,
            decimals,
            totalSupply,
            priceUsd: toNumber(pair.priceUsd, 0),
            volume24h: toNumber(pair.volume?.h24, 0),
            priceChange24h: toNumber(pair.priceChange?.h24, 0),
            buys24h: toNumber(pair.txns?.h24?.buys, 0),
            sells24h: toNumber(pair.txns?.h24?.sells, 0),
            poolCreatedAtSec: pair.pairCreatedAt ? Math.round(pair.pairCreatedAt / 1000) : null
          };
        } catch (err) {
          console.warn(`⚠️ Robinhood Block 1 Error: ${err.message}`);
          throw err; // Блок 1 критичен, если пулов нет или ликвидность низкая
        }
      })(),

      // Блок 2: История сделок и снайперы (GeckoTerminal API -> Fallback to Blockscout tokentx)
      (async () => {
        const earliestBuyTimeByWallet = new Map();
        try {
          if (onStatusUpdate) await onStatusUpdate('🕵️ Robinhood Intel [2/3]: Запрос истории торгов (GeckoTerminal)...');
          const geckoUrl = `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${tokenAddress}/trades`;
          
          try {
            const response = await fetchJson(geckoUrl, { timeoutMs: this.timeoutMs });
            const trades = response?.data || [];
            for (let i = trades.length - 1; i >= 0; i -= 1) {
              const trade = trades[i];
              const attributes = trade?.attributes || {};
              const kind = attributes.kind;
              const wallet = compactAddress(attributes.tx_from_address);
              const timestampStr = attributes.block_timestamp;
              if (kind === 'buy' && wallet && timestampStr) {
                const timeSec = Math.round(new Date(timestampStr).getTime() / 1000);
                const walletLower = wallet.toLowerCase();
                if (!earliestBuyTimeByWallet.has(walletLower)) {
                  earliestBuyTimeByWallet.set(walletLower, timeSec);
                }
              }
            }
          } catch (geckoErr) {
            console.warn(`⚠️ GeckoTerminal trades failed (${geckoErr.message}), falling back to Blockscout tokentx...`);
            
            const tokentxUrl = `${explorerApiUrl}?module=account&action=tokentx&contractaddress=${tokenAddress}&page=1&offset=100&sort=asc`;
            const tokentxResponse = await fetchJson(tokentxUrl, { timeoutMs: this.timeoutMs });
            const transfers = tokentxResponse?.result || [];
            for (const tx of transfers) {
              const toAddress = compactAddress(tx.to);
              const timeSec = parseInt(tx.timeStamp, 10);
              if (toAddress && Number.isFinite(timeSec)) {
                const walletLower = toAddress.toLowerCase();
                if (!earliestBuyTimeByWallet.has(walletLower)) {
                  earliestBuyTimeByWallet.set(walletLower, timeSec);
                }
              }
            }
          }
        } catch (err) {
          console.warn(`⚠️ Robinhood Block 2 Error: ${err.message}`);
        }
        return { earliestBuyTimeByWallet };
      })(),

      // Блок 3: Холдеры и графы связей (Moralis API / Explorer API)
      (async () => {
        try {
          if (onStatusUpdate) await onStatusUpdate('🕵️ Robinhood Intel [3/3]: Получение холдеров (Moralis)...');
          let owners = [];
          
          if (moralisApiKey) {
            try {
              const url = `https://deep-index.moralis.io/api/v2.2/erc20/${tokenAddress}/owners?chain=robinhood&limit=20`;
              const data = await fetchJson(url, {
                timeoutMs: this.timeoutMs,
                headers: { 'X-API-Key': moralisApiKey }
              });
              owners = data?.result || [];
            } catch (err) {
              console.warn(`⚠️ Moralis holders fetch failed: ${err.message}`);
            }
          }

          // Fallback to Blockscout v2 Holders REST API
          if (owners.length === 0) {
            try {
              const blockscoutHoldersUrl = `https://robinhoodchain.blockscout.com/api/v2/tokens/${tokenAddress}/holders`;
              const data = await fetchJson(blockscoutHoldersUrl, { timeoutMs: this.timeoutMs });
              const items = data?.items || [];
              owners = items.map(item => ({
                owner_address: item.address?.hash,
                balance: item.value
              })).filter(o => o.owner_address);
            } catch (err) {
              console.warn(`⚠️ Blockscout holders fetch failed: ${err.message}`);
            }
          }

          return { owners };
        } catch (err) {
          console.warn(`⚠️ Robinhood Block 3 Error (Holders): ${err.message}`);
          return { owners: [] };
        }
      })()
    ]).catch(err => {
      console.error(`⛔ Robinhood parallel analysis failed:`, err.message);
      return [null, { earliestBuyTimeByWallet: new Map() }, { owners: [] }];
    });

    const poolRes = block1Res;
    const earliestBuyTimeByWallet = block2Res?.earliestBuyTimeByWallet || new Map();
    const rawOwners = block3Res?.owners || [];

    if (!poolRes) {
      return fallbackIntel('failed to retrieve Robinhood pool info or low liquidity');
    }

    const { pair, decimals, totalSupply, poolCreatedAtSec } = poolRes;

    // Нормализуем холдеров
    const parsedOwners = rawOwners.map(owner => {
      const amount = decimalToNumber(owner.balance, decimals);
      const pct = totalSupply > 0 ? (amount / totalSupply) * 100 : 0;
      return {
        wallet: compactAddress(owner.owner_address),
        amount,
        pct
      };
    }).filter(o => o.wallet && o.amount > 0);

    const holderDistribution = {
      topHolderPct: toNumber(parsedOwners[0]?.pct, 0),
      top5Pct: parsedOwners.slice(0, 5).reduce((sum, o) => sum + o.pct, 0),
      highSupplyWallets: parsedOwners.filter(o => o.pct >= HIGH_SUPPLY_SHARE).length,
      analyzedWallets: Math.min(parsedOwners.length, this.maxHolderWallets)
    };

    // Запрос deployer и его пополнения (explorer)
    let devWallet = '';
    let devWalletIntel = null;
    if (onStatusUpdate) await onStatusUpdate('🕵️ Robinhood Intel: Определение кошелька разработчика...');
    devWallet = await getContractDeployer(tokenAddress, explorerApiUrl, explorerApiKey);
    if (devWallet) {
      const devFunding = await getFundingSource(devWallet, explorerApiUrl, explorerApiKey);
      devWalletIntel = {
        wallet: devWallet,
        pct: 0,
        fundingSource: devFunding.fundingSource,
        fundedAtSec: devFunding.fundedAtSec,
        walletAgeDays: devFunding.walletAgeDays
      };
    }

    // Запрос пополнений для холдеров
    if (onStatusUpdate && parsedOwners.length > 0) {
      await onStatusUpdate('🕵️ Robinhood Intel: Проверка истории пополнений холдеров...');
    }

    const holderWalletsData = await Promise.all(
      parsedOwners.slice(0, this.maxHolderWallets).map(async (owner) => {
        const funding = await getFundingSource(owner.wallet, explorerApiUrl, explorerApiKey);
        const enteredTokenAtSec = earliestBuyTimeByWallet.get(owner.wallet.toLowerCase()) || null;
        return {
          ...owner,
          ...funding,
          enteredTokenAtSec
        };
      })
    );
    const holderWallets = holderWalletsData.filter(Boolean);

    // Классификация и аналитика
    const behavior = classifyTokenBehavior({ buys24h: poolRes.buys24h, sells24h: poolRes.sells24h });
    const highSupplyWallets = holderWallets.filter(w => w.pct >= HIGH_SUPPLY_SHARE);
    const fundingCluster = detectFundingCluster({ highSupplyWallets, behavior, token: { buys24h: poolRes.buys24h, sells24h: poolRes.sells24h } });
    const transferPattern = classifyTransferPattern({ highSupplyWallets, holderDistribution, behavior });
    const finalCreatedAtSec = poolCreatedAtSec || (Date.now() / 1000 - toNumber(token.ageMinutes, 0) * 60);
    const sniperBehavior = detectSniperBehavior({ token: { buys24h: poolRes.buys24h, ageMinutes: token.ageMinutes }, holderWallets, tokenCreatedAtSec: finalCreatedAtSec });

    const walletAgeDays = median([
      devWalletIntel?.walletAgeDays,
      ...highSupplyWallets.map(w => w.walletAgeDays)
    ]);
    const firstFundingSource = firstString(devWalletIntel?.fundingSource, highSupplyWallets[0]?.fundingSource, 'unknown');
    const connectedWallets = this.countConnectedWallets(highSupplyWallets);

    const riskLevel = this.classifyRisk({
      fundingCluster,
      previousRugpulls: 0,
      holderDistribution,
      sniperBehavior,
      behavior,
      walletAgeDays,
      connectedWallets,
      transferPattern
    });

    const knowledgeGraph = buildKnowledgeGraph({
      holderWallets,
      devWalletIntel,
      tokenCreatedAtSec: finalCreatedAtSec
    });

    return {
      walletAgeDays,
      firstFundingSource: firstFundingSource === 'unknown' ? 'unknown' : shortAddress(firstFundingSource),
      connectedWallets,
      previousTokens: 0,
      previousRugpulls: 0,
      realizedProfit: REALIZED_PROFIT_UNAVAILABLE,
      sniperBehavior,
      transferPattern,
      fundingCluster: {
        ...fundingCluster,
        source: fundingCluster.source ? shortAddress(fundingCluster.source) : '',
        wallets: fundingCluster.wallets.map(shortAddress)
      },
      holderDistribution,
      devWallet: devWallet ? shortAddress(devWallet) : '',
      riskLevel,
      summary: this.buildSummary({
        fundingCluster,
        previousRugpulls: 0,
        holderDistribution,
        sniperBehavior,
        transferPattern
      }),
      knowledgeGraph
    };
  }

  //Анализ solana токенов
  async analyzeSolanaToken(token, onStatusUpdate = null) {
    const mint = token.address;
    if (!mint) return fallbackIntel('token mint address missing');

    const [largestAccounts, supply] = await Promise.all([
      this.getTokenLargestAccounts(mint),
      this.getTokenSupply(mint),
    ]);

    const holderRows = largestAccounts
      .map(row => ({
        tokenAccount: row.address,
        amount: tokenAmount(row),
        pct: supply > 0 ? tokenAmount(row) / supply * 100 : 0,
      }))
      .filter(row => row.tokenAccount && row.amount > 0);

    const holderDistribution = {
      topHolderPct: toNumber(holderRows[0]?.pct, 0),
      top5Pct: holderRows.slice(0, 5).reduce((sum, row) => sum + row.pct, 0),
      highSupplyWallets: holderRows.filter(row => row.pct >= HIGH_SUPPLY_SHARE).length,
      analyzedWallets: Math.min(holderRows.length, this.maxHolderWallets),
    };

    const holderWalletsData = await Promise.all(
      holderRows.slice(0, this.maxHolderWallets).map(async (row) => {
        try {
          const owner = await this.getTokenAccountOwner(row.tokenAccount);
          if (!owner) return null;
          const walletIntel = await this.analyzeSolanaWallet(owner, row.tokenAccount);
          console.log('walletIntel', walletIntel);
          console.log('owner', owner);

          return { ...row, ...walletIntel, wallet: owner };
        } catch (err) {
          console.warn(`⚠️ Error analyzing holder ${shortAddress(row.tokenAccount)}:`, err.message);
          return null;
        }
      })
    );
    const holderWallets = holderWalletsData.filter(Boolean);

    //классификация
    const behavior = classifyTokenBehavior(token);
    const highSupplyWallets = holderWallets.filter(wallet => wallet.pct >= HIGH_SUPPLY_SHARE);
    const devWallet = firstString(token.devWallet, holderWallets[0]?.wallet);
    const relatedWallets = unique([devWallet, ...highSupplyWallets.map(wallet => wallet.wallet)]);
    let devWalletIntel = null;
    if (devWallet) {
      const existingHolder = holderWallets.find(w => w.wallet === devWallet);
      if (existingHolder) {
        devWalletIntel = existingHolder;
      } else {
        devWalletIntel = await this.analyzeSolanaWallet(devWallet);
      }
    }
    const relatedHistories = await Promise.all(relatedWallets.map(wallet => this.fetchDevWalletHistory(wallet)));
    const fundingCluster = detectFundingCluster({ highSupplyWallets, behavior, token });
    const transferPattern = classifyTransferPattern({ highSupplyWallets, holderDistribution, behavior });
    const tokenCreatedAtSec = Date.now() / 1000 - toNumber(token.ageMinutes, 0) * 60;
    const sniperBehavior = detectSniperBehavior({ token, holderWallets, tokenCreatedAtSec });
    const walletAgeDays = median([
      devWalletIntel?.walletAgeDays,
      ...highSupplyWallets.map(wallet => wallet.walletAgeDays),
    ]);
    const firstFundingSource = firstString(devWalletIntel?.fundingSource, highSupplyWallets[0]?.fundingSource, 'unknown');
    const connectedWallets = this.countConnectedWallets(highSupplyWallets);
    const previousTokens = relatedHistories.reduce((sum, history) => sum + history.previousTokens, 0);
    const previousRugpulls = relatedHistories.reduce((sum, history) => sum + history.previousRugpulls, 0);
    const riskLevel = this.classifyRisk({
      fundingCluster,
      previousRugpulls,
      holderDistribution,
      sniperBehavior,
      behavior,
      walletAgeDays,
      connectedWallets,
      transferPattern,
    });

    let aiPattern = null;
    try {
      if (devWallet || highSupplyWallets.length > 0) {
        const targetWallet = devWallet || highSupplyWallets[0].wallet;
        const recentSigs = await this.getSignatures(targetWallet, 5);
        const rawTxns = await Promise.all(recentSigs.map(sig => this.getParsedTransaction(sig.signature)));
        const aiSvc = new AIService();
        aiPattern = await aiSvc.analyzeRawTransactions(rawTxns, { symbol: token.symbol, address: token.address, targetWallet }, onStatusUpdate);
      }
    } catch (err) {
      console.error('AI Raw Txn error:', err.message);
    }

    //создание графов
    const knowledgeGraph = buildKnowledgeGraph({
      holderWallets,
      devWalletIntel,
      tokenCreatedAtSec
    });

    return {
      walletAgeDays,
      firstFundingSource: firstFundingSource === 'unknown' ? 'unknown' : shortAddress(firstFundingSource),
      connectedWallets,
      previousTokens,
      previousRugpulls,
      realizedProfit: REALIZED_PROFIT_UNAVAILABLE,
      sniperBehavior,
      transferPattern,
      fundingCluster: {
        ...fundingCluster,
        source: fundingCluster.source ? shortAddress(fundingCluster.source) : '',
        wallets: fundingCluster.wallets.map(shortAddress),
      },
      holderDistribution,
      devWallet: devWallet ? shortAddress(devWallet) : '',
      riskLevel,
      summary: this.buildSummary({
        fundingCluster,
        previousRugpulls,
        holderDistribution,
        sniperBehavior,
        transferPattern,
      }),
      aiPattern,
      knowledgeGraph,
    };
  }

  async solanaRpc(method, params = []) {
    const data = await fetchJson(this.solanaRpcUrl, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      body: {
        jsonrpc: '2.0',
        id: `${Date.now()}-${Math.random()}`,
        method,
        params,
      },
    });
    if (data.error) throw new Error(data.error.message || `Solana RPC ${method} failed`);
    return data.result;
  }

  async getTokenSupply(mint) {
    const result = await this.solanaRpc('getTokenSupply', [mint]);
    return toNumber(result?.value?.uiAmount ?? result?.value?.uiAmountString ?? result?.value?.amount, 0);
  }

  async getTokenLargestAccounts(mint) {
    const result = await this.solanaRpc('getTokenLargestAccounts', [mint]);
    return Array.isArray(result?.value) ? result.value : [];
  }

  async getTokenAccountOwner(tokenAccount) {
    const result = await this.solanaRpc('getAccountInfo', [
      tokenAccount,
      { commitment: 'confirmed', encoding: 'jsonParsed' },
    ]);
    return firstString(result?.value?.data?.parsed?.info?.owner);
  }

  async getSignatures(address, limit = 1000) {
    const result = await this.solanaRpc('getSignaturesForAddress', [
      address,
      { limit },
    ]);
    return Array.isArray(result) ? result : [];
  }

  async getParsedTransaction(signature) {
    return await this.solanaRpc('getTransaction', [
      signature,
      {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
        encoding: 'jsonParsed',
      },
    ]);
  }

  async analyzeSolanaWallet(wallet, tokenAccount = '') {
    const signatures = await this.getSignatures(wallet, 1000);
    const oldest = signatures.at(-1);
    const walletAgeDays = daysSince(oldest?.blockTime);
    let fundingSource = '';
    let fundedAtSec = oldest?.blockTime || null;

    if (oldest?.signature) {
      const tx = await this.getParsedTransaction(oldest.signature);
      fundingSource = parseSystemFunding(tx, wallet);
      fundedAtSec = tx?.blockTime || fundedAtSec;
    }

    let enteredTokenAtSec = null;
    if (tokenAccount) {
      const tokenAccountSignatures = await this.getSignatures(tokenAccount, 1000);
      enteredTokenAtSec = tokenAccountSignatures.at(-1)?.blockTime || null;
    }

    return {
      walletAgeDays,
      fundingSource,
      fundedAtSec,
      enteredTokenAtSec,
      txCountSample: signatures.length,
    };
  }

  async fetchDevWalletHistory(devWallet) {
    if (!devWallet) return { previousTokens: 0, previousRugpulls: 0 };
    const urls = [
      `https://frontend-api-v3.pump.fun/coins/user-created-coins/${encodeURIComponent(devWallet)}?offset=0&limit=50&includeNsfw=false`,
      `https://frontend-api.pump.fun/coins/user-created-coins/${encodeURIComponent(devWallet)}?offset=0&limit=50&includeNsfw=false`,
    ];

    for (const url of urls) {
      try {
        const data = await fetchJson(url, { timeoutMs: this.timeoutMs });
        const rows = Array.isArray(data) ? data : data?.coins || data?.data || [];
        return {
          previousTokens: rows.length,
          previousRugpulls: rows.filter(row => this.looksRugpulled(row)).length,
        };
      } catch { }
    }
    return { previousTokens: 0, previousRugpulls: 0 };
  }

  looksRugpulled(row) {
    const flattened = JSON.stringify(row).toLowerCase();
    const liquidityUsd = toNumber(row.liquidityUsd ?? row.liquidity_usd, 0);
    const marketCap = toNumber(row.usd_market_cap ?? row.marketCap ?? row.market_cap, 0);
    const replies = toNumber(row.reply_count, 0);
    return (
      flattened.includes('rug') ||
      flattened.includes('scam') ||
      flattened.includes('honeypot') ||
      marketCap > 0 && marketCap < 1000 ||
      liquidityUsd > 0 && liquidityUsd < 500 ||
      replies === 0 && toNumber(row.complete, 0) === 0
    );
  }

  countConnectedWallets(wallets) {
    const byFundingSource = new Map();
    for (const wallet of wallets) {
      if (!wallet.fundingSource) continue;
      const group = byFundingSource.get(wallet.fundingSource) || [];
      group.push(wallet.wallet);
      byFundingSource.set(wallet.fundingSource, group);
    }
    return [...byFundingSource.values()]
      .filter(group => group.length > 1)
      .reduce((sum, group) => sum + group.length, 0);
  }

  classifyRisk({ fundingCluster, previousRugpulls, holderDistribution, sniperBehavior, behavior, walletAgeDays, connectedWallets, transferPattern }) {
    let score = 0;
    if (fundingCluster.isClustered) score += 3;
    if (previousRugpulls > 0) score += Math.min(previousRugpulls, 3);
    if (holderDistribution.topHolderPct >= 20) score += 2;
    if (holderDistribution.top5Pct >= 45) score += 2;
    if (sniperBehavior === 'STRONG') score += 2;
    if (behavior === 'sell_pressure') score += 1;
    
    if (walletAgeDays !== null && walletAgeDays <= 7) score += 1;
    if (connectedWallets >= 3) score += 1;
    if (transferPattern === 'whale_concentrated') score += 1;
    if (transferPattern === 'clustered_sells') score += 2;

    if (score >= 5) return 'HIGH';
    if (score >= 2) return 'MEDIUM';
    return 'LOW';
  }

  buildSummary({ fundingCluster, previousRugpulls, holderDistribution, sniperBehavior, transferPattern }) {
    const parts = [];
    if (fundingCluster.isClustered) parts.push('обнаружен funding cluster');
    if (previousRugpulls > 0) parts.push(`rugpull-history: ${previousRugpulls}`);
    if (holderDistribution.top5Pct >= 45) parts.push(`top-5 держат ${holderDistribution.top5Pct.toFixed(1)}%`);
    if (sniperBehavior !== 'NONE') parts.push(`sniper ${sniperBehavior.toLowerCase()}`);
    if (!parts.length) parts.push(`pattern: ${transferPattern}`);
    return parts.join('; ');
  }
}
