import { TonService } from './tonService.mjs';
import { AIService } from './aiService.mjs';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.WALLET_INTEL_TIMEOUT_MS || '8000', 10);
const DEFAULT_SOLANA_RPC_URL = `${process.env.SOLANA_RPC_URL}?api-key=${process.env.SOLANA_RPC_KEY}` || 'https://api.mainnet-beta.solana.com';
const DEFAULT_MAX_HOLDER_WALLETS = parseInt(process.env.WALLET_INTEL_MAX_HOLDER_WALLETS || '6', 10);
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

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', body = null } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'tradingai-wallet-intel/1.0',
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
      analyzed.push({ ...token, walletIntel });
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

    //создание графов зависимостей
    const graphNodes = [];
    if (devWalletIntel) {
      graphNodes.push({
        address: devWalletIntel.wallet,
        shortAddress: shortAddress(devWalletIntel.wallet),
        pct: devWalletIntel.pct || 0,
        fundingSource: devWalletIntel.fundingSource ? shortAddress(devWalletIntel.fundingSource) : '',
        role: 'developer',
      });
    }
    
    for (const hw of holderWallets) {
      if (devWalletIntel && hw.wallet === devWalletIntel.wallet) continue;
      graphNodes.push({
        address: hw.wallet,
        shortAddress: shortAddress(hw.wallet),
        pct: hw.pct || 0,
        fundingSource: hw.fundingSource ? shortAddress(hw.fundingSource) : '',
        role: hw.enteredTokenAtSec && tokenCreatedAtSec && (hw.enteredTokenAtSec - tokenCreatedAtSec <= 180) ? 'sniper' : 'holder',
      });
    }

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
      graphNodes,
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
