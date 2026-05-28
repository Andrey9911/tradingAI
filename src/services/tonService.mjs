import { Address } from '@ton/core';

const DEFAULT_TONAPI_BASE_URL = process.env.TONAPI_BASE_URL || 'https://tonapi.io/v2';
const DEFAULT_TONAPI_TIMEOUT_MS = parseInt(process.env.TONAPI_TIMEOUT_MS || '8000', 10);
const DEFAULT_TONAPI_RETRY_DELAY_MS = parseInt(process.env.TONAPI_RETRY_DELAY_MS || '1500', 10);
const DEFAULT_TONAPI_MAX_RETRIES = parseInt(process.env.TONAPI_MAX_RETRIES || '2', 10);
const HIGH_SUPPLY_SHARE = parseFloat(process.env.WALLET_INTEL_HIGH_SUPPLY_SHARE || '5');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

export function shortTonAddress(address) {
  const value = firstString(address);
  if (!value) return '';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function normalizeTonAddress(address) {
  const value = firstString(address);
  if (!value) return '';
  try {
    return Address.parse(value).toRawString();
  } catch {
    return value.trim().toLowerCase();
  }
}

function tonDisplayAddress(address) {
  const value = firstString(address);
  if (!value) return '';
  try {
    return Address.parse(value).toString({
      bounceable: true,
      urlSafe: true,
    });
  } catch {
    return value;
  }
}

function bigintFrom(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim();
    if (/^\d+$/.test(normalized)) return BigInt(normalized);
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return BigInt(Math.trunc(parsed));
  }
  return 0n;
}

function decimalToNumber(rawValue, decimals = 0) {
  const raw = bigintFrom(rawValue);
  const scale = 10n ** BigInt(Math.max(0, decimals));
  if (scale === 1n) return Number(raw);
  const integer = raw / scale;
  const fraction = raw % scale;
  return Number(integer) + Number(fraction) / Number(scale);
}

function percentOfSupply(balanceRaw, totalSupplyRaw) {
  const balance = bigintFrom(balanceRaw);
  const total = bigintFrom(totalSupplyRaw);
  if (total <= 0n || balance <= 0n) return 0;
  return Number(balance * 1_000_000n / total) / 10_000;
}

function extractDecimals(jettonInfo) {
  return toNumber(
    jettonInfo?.metadata?.decimals ??
      jettonInfo?.jetton_content?.metadata?.decimals ??
      jettonInfo?.jetton_content?.decimals,
    0,
  );
}

function extractAdminAddress(jettonInfo) {
  return firstString(
    jettonInfo?.admin_address?.address,
    jettonInfo?.admin_address,
    jettonInfo?.admin?.address,
    jettonInfo?.admin,
  );
}

function extractHolderRows(holdersResponse) {
  if (Array.isArray(holdersResponse?.addresses)) return holdersResponse.addresses;
  if (Array.isArray(holdersResponse?.holders)) return holdersResponse.holders;
  if (Array.isArray(holdersResponse)) return holdersResponse;
  return [];
}

function holderOwnerAddress(row) {
  return firstString(
    row?.owner?.address,
    row?.owner,
    row?.address?.owner?.address,
    row?.wallet?.owner?.address,
    row?.account?.address,
  );
}

function holderBalance(row) {
  return firstString(row?.balance, row?.amount, row?.wallet?.balance, row?.quantity);
}

function calculateTonRisk({ top5Pct, hasActiveAdmin }) {
  if (top5Pct > 50) return 'HIGH';
  if (hasActiveAdmin && top5Pct >= 20) return 'HIGH';
  if (hasActiveAdmin) return 'MEDIUM';
  if (!hasActiveAdmin && top5Pct < 20) return 'LOW';
  return top5Pct >= 35 ? 'MEDIUM' : 'LOW';
}

function unknownTonIntel(reason) {
  return {
    walletAgeDays: null,
    firstFundingSource: 'unknown',
    connectedWallets: 0,
    previousTokens: 0,
    previousRugpulls: 0,
    realizedProfit: 'needs-indexer',
    sniperBehavior: 'NONE',
    transferPattern: 'unknown',
    fundingCluster: { isClustered: false, source: '', wallets: [], reason: 'Not supported on TON' },
    holderDistribution: {
      topHolderPct: 0,
      top5Pct: 0,
      highSupplyWallets: 0,
      analyzedWallets: 0,
    },
    devWallet: 'UNKNOWN',
    riskLevel: 'UNKNOWN',
    summary: reason,
  };
}

export class TonService {
  constructor({
    apiKey = process.env.TONAPI_KEY || '',
    baseUrl = DEFAULT_TONAPI_BASE_URL,
    timeoutMs = DEFAULT_TONAPI_TIMEOUT_MS,
    retryDelayMs = DEFAULT_TONAPI_RETRY_DELAY_MS,
    maxRetries = DEFAULT_TONAPI_MAX_RETRIES,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.maxRetries = maxRetries;
    this.fetchImpl = fetchImpl;
  }

  async fetchJson(pathname) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch unavailable for TonAPI');
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': 'tradingai-ton-intel/1.0',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          signal: controller.signal,
        });

        if (response.status === 429 && attempt < this.maxRetries) {
          await sleep(this.retryDelayMs * (attempt + 1));
          continue;
        }
        if (response.status === 404) {
          const err = new Error('TON Jetton not found or not Jetton standard');
          err.status = 404;
          throw err;
        }
        if (!response.ok) {
          const err = new Error(`TonAPI ${response.status} ${response.statusText}`);
          err.status = response.status;
          throw err;
        }
        return await response.json();
      } catch (err) {
        lastError = err;
        if (err?.status === 404 || attempt >= this.maxRetries) break;
        await sleep(this.retryDelayMs * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error('TonAPI request failed');
  }

  async getJettonInfo(address) {
    return await this.fetchJson(`/jettons/${encodeURIComponent(address)}`);
  }

  async getJettonHolders(address, limit = 10) {
    return await this.fetchJson(`/jettons/${encodeURIComponent(address)}/holders?limit=${limit}`);
  }

  async analyzeTonToken(token, onStatusUpdate = null) {
    const accountId = firstString(token?.address, token?.tokenAddress);
    if (!accountId) return unknownTonIntel('TON token address missing');

    try {
      if (onStatusUpdate) await onStatusUpdate('🕵️ TON Intel: Запрашиваю контракт...');
      const jettonInfo = await this.getJettonInfo(accountId);
      const totalSupplyRaw = firstString(jettonInfo?.total_supply, jettonInfo?.totalSupply, jettonInfo?.supply);
      const decimals = extractDecimals(jettonInfo);
      const adminAddress = extractAdminAddress(jettonInfo);
      const normalizedAdmin = normalizeTonAddress(adminAddress);

      if (onStatusUpdate) await onStatusUpdate('🕵️ TON Intel: Анализирую топ-холдеров...');
      const holdersResponse = await this.getJettonHolders(accountId, 10);
      const holderRows = extractHolderRows(holdersResponse)
        .map(row => {
          const owner = holderOwnerAddress(row);
          const balance = holderBalance(row);
          const pct = percentOfSupply(balance, totalSupplyRaw);
          return {
            owner,
            normalizedOwner: normalizeTonAddress(owner),
            balance,
            amount: decimalToNumber(balance, decimals),
            pct,
          };
        })
        .filter(row => row.owner && bigintFrom(row.balance) > 0n);

      const topHolderPct = toNumber(holderRows[0]?.pct, 0);
      const top5Pct = holderRows.slice(0, 5).reduce((sum, row) => sum + row.pct, 0);
      const highSupplyWallets = holderRows.filter(row => row.pct >= HIGH_SUPPLY_SHARE).length;
      const hasActiveAdmin = Boolean(normalizedAdmin);
      const adminTopHolder = hasActiveAdmin
        ? holderRows.find(row => row.normalizedOwner === normalizedAdmin)
        : null;
      const riskLevel = calculateTonRisk({ top5Pct, hasActiveAdmin });
      const adminStatus = hasActiveAdmin ? 'Active' : 'Renounced';
      const devWallet = hasActiveAdmin ? shortTonAddress(tonDisplayAddress(adminAddress)) : 'RENOUNCED';

      return {
        walletAgeDays: null,
        firstFundingSource: 'unknown',
        connectedWallets: 0,
        previousTokens: 0,
        previousRugpulls: 0,
        realizedProfit: 'needs-indexer',
        sniperBehavior: 'NONE',
        transferPattern: 'analyzed',
        fundingCluster: { isClustered: false, source: '', wallets: [], reason: 'Not supported on TON' },
        holderDistribution: {
          topHolderPct: Number(topHolderPct.toFixed(2)),
          top5Pct: Number(top5Pct.toFixed(2)),
          highSupplyWallets,
          analyzedWallets: Math.min(holderRows.length, 10),
        },
        devWallet,
        devSupplyPct: adminTopHolder ? Number(adminTopHolder.pct.toFixed(2)) : 0,
        renouncedOwnership: !hasActiveAdmin,
        riskLevel,
        summary: `Top-5: ${top5Pct.toFixed(2)}%; Admin: ${adminStatus}`,
      };
    } catch (err) {
      if (err?.status === 404) {
        return unknownTonIntel('TON Jetton not found or not Jetton standard');
      }
      if (onStatusUpdate) await onStatusUpdate(`⚠️ TON Intel: ${err.message}`);
      return unknownTonIntel(`TON intel unavailable: ${err.message}`);
    }
  }
}

export async function analyzeTonToken(token, onStatusUpdate = null, options = {}) {
  return await new TonService(options).analyzeTonToken(token, onStatusUpdate);
}
