import { RestClientV5 } from 'bybit-api';

export class BybitService {
  constructor(apiKey, apiSecret, testnet = false) {
    this.client = new RestClientV5({
      key: apiKey,
      secret: apiSecret,
      testnet: testnet,
      recv_window: 10000,           // увеличиваем окно до 10 секунд
      enable_time_sync: true,       // автосинхронизация времени
      sync_interval_ms: 60000,      // синхронизация каждые 60 секунд
    });
  }

  /**
   * Получить балансы всех монет с USD-эквивалентом и изменением за 24ч
   * @returns {Promise<Array<{coin: string, walletBalance: number, usdValue: number, change24h: number}>>}
   */
  async getSpotBalances() {
    // Получаем баланс аккаунта (унифицированный)
    const balanceResp = await this.client.getWalletBalance({
      accountType: 'UNIFIED',
    });
    if (balanceResp.retCode !== 0) {
      throw new Error(balanceResp.retMsg);
    }

    const coins = balanceResp.result.list[0].coin;
    const balances = [];

    // Для каждого актива получаем текущую цену и 24h изменение
    for (const coinData of coins) {
      const coin = coinData.coin;
      const walletBalance = parseFloat(coinData.walletBalance);
      if (walletBalance === 0) continue;

      let usdValue = 0;
      let change24h = 0;

      if (coin === 'USDT') {
        usdValue = walletBalance;
      } else {
        try {
          const tickerResp = await this.client.getTickers({
            category: 'spot',
            symbol: `${coin}USDT`,
          });
          if (tickerResp.retCode === 0 && tickerResp.result.list.length) {
            const ticker = tickerResp.result.list[0];
            const price = parseFloat(ticker.lastPrice);
            usdValue = walletBalance * price;
            change24h = parseFloat(ticker.price24hPcnt) * 100; // процент
          }
        } catch (err) {
          console.warn(`Не удалось получить цену для ${coin}:`, err.message);
        }
      }

      balances.push({
        coin,
        walletBalance,
        usdValue,
        change24h,
      });
    }

    return balances;
  }

  /**
   * Получить баланс конкретной монеты (упрощённо, только количество)
   * @param {string} coin - код монеты (например, 'USDT')
   * @returns {Promise<string>} баланс
   */
  async getBalanceByCoin(coin = 'USDT') {
    const balances = await this.getSpotBalances();
    const found = balances.find(b => b.coin === coin);
    return found ? found.walletBalance.toString() : '0';
  }

  /**
   * Получить открытые лимитные ордера (спот)
   * @returns {Promise<Array>} массив ордеров
   */
  async getOpenLimitOrders() {
    const resp = await this.client.getOpenOrders({
      category: 'spot',
      openOnly: 0, // все открытые
      limit: 50,
    });
    if (resp.retCode !== 0) throw new Error(resp.retMsg);
    // Возвращаем только лимитные ордера (orderType == 'Limit')
    return resp.result.list.filter(order => order.orderType === 'Limit');
  }

  /**
   * Получить ордер по ID
   * @param {string} orderId
   * @returns {Promise<Object|null>}
   */
  async getOrderById(orderId) {
    const resp = await this.client.getOrderDetails({
      category: 'spot',
      orderId: orderId,
    });
    if (resp.retCode !== 0) return null;
    return resp.result.list[0];
  }

  /**
   * Получить текущую цену монеты (безопасная версия)
   */
  async getCurrentPrice(symbol) {
    try {
      const resp = await this.client.getTickers({
        category: 'spot',
        symbol: symbol,
      });
      if (resp.retCode === 0 && resp.result.list.length > 0) {
        return parseFloat(resp.result.list[0].lastPrice);
      }
      return null;
    } catch (err) {
      console.warn(`Не удалось получить цену для ${symbol}`);
      return null;
    }
  }

  /**
   * Инструмент спота (или linear) по символу.
   * @param {string} symbol
   * @param {'spot'|'linear'} category
   * @returns {Promise<object|null>}
   */
  async getInstrumentInfo(symbol, category = 'spot') {
    const resp = await this.client.getInstrumentsInfo({
      category,
      symbol,
    });
    if (resp.retCode !== 0 || !resp.result?.list?.length) return null;
    const row = resp.result.list[0];
    if (row.status && row.status !== 'Trading') return null;
    return row;
  }

  /**
   * Тикер одной пары.
   * @param {string} symbol
   * @param {'spot'|'linear'} category
   */
  async getTicker(symbol, category = 'spot') {
    const resp = await this.client.getTickers({ category, symbol });
    if (resp.retCode !== 0 || !resp.result?.list?.length) return null;
    const t = resp.result.list[0];
    return {
      lastPrice: parseFloat(t.lastPrice),
      volume24h: parseFloat(t.volume24h),
      turnover24h: parseFloat(t.turnover24h),
      price24hPcnt: parseFloat(t.price24hPcnt) * 100,
      fundingRate: t.fundingRate != null ? parseFloat(t.fundingRate) * 100 : null,
    };
  }

  /** История funding (perp), % */
  async getFundingRateHistory(symbol, limit = 10) {
    const resp = await this.client.getFundingRateHistory({
      category: 'linear',
      symbol,
      limit,
    });
    if (resp.retCode !== 0 || !resp.result?.list?.length) return [];
    return resp.result.list.map(x => ({
      fundingRatePct: x.fundingRate != null ? parseFloat(x.fundingRate) * 100 : null,
      fundingRateTs: x.fundingRateTimestamp ? Number(x.fundingRateTimestamp) : null,
    }));
  }

  /** Последние трейды (лента) */
  async getRecentTrades(symbol, category = 'spot', limit = 50) {
    const resp = await this.client.getPublicTradingHistory({
      category,
      symbol,
      limit,
    });
    if (resp.retCode !== 0 || !resp.result?.list?.length) return [];
    return resp.result.list;
  }

  /**
   * Свечи (от старых к новым).
   * @param {string} symbol
   * @param {string} interval Bybit interval, напр. '60'
   * @param {number} limit
   * @returns {Promise<Array<{ t: number, o: number, h: number, l: number, c: number, v: number }>>}
   */
  async getKlines(symbol, interval = '60', limit = 100) {
    const resp = await this.client.getKline({
      category: 'spot',
      symbol,
      interval,
      limit,
    });
    if (resp.retCode !== 0 || !resp.result?.list?.length) return [];
    return resp.result.list
      .map(row => ({
        t: Number(row[0]),
        o: parseFloat(row[1]),
        h: parseFloat(row[2]),
        l: parseFloat(row[3]),
        c: parseFloat(row[4]),
        v: parseFloat(row[5]),
      }))
      .filter(k => Number.isFinite(k.c))
      .sort((a, b) => a.t - b.t);
  }

  /** Глубина стакана (лучшие уровни) */
  async getOrderbookDepth(symbol, limit = 25) {
    const resp = await this.client.getOrderbook({
      category: 'spot',
      symbol,
      limit,
    });
    if (resp.retCode !== 0) return null;
    return {
      bids: resp.result?.b ?? [],
      asks: resp.result?.a ?? [],
    };
  }

  /**
   * Фьючерсный контекст: funding, OI 1h/4h/24h, long/short.
   * @param {string} symbol — тот же USDT-символ, что и на споте
   */
  async getExtendedDerivativesContext(symbol) {
    try {
      const tickerResp = await this.client.getTickers({ category: 'linear', symbol });
      const oiResp = await this.client.getOpenInterest({
        category: 'linear',
        symbol,
        intervalTime: '1h',
        limit: 30,
      });
      const lsResp = await this.client.getLongShortRatio({
        category: 'linear',
        symbol,
        period: '1h',
        limit: 1,
      });

      let fundingRate = null;
      if (tickerResp.retCode === 0 && tickerResp.result?.list?.length) {
        const fr = tickerResp.result.list[0].fundingRate;
        fundingRate = fr != null ? parseFloat(fr) * 100 : null;
      }

      const oiListRaw = oiResp.retCode === 0 && oiResp.result?.list ? oiResp.result.list : [];
      const oiList = [...oiListRaw].sort(
        (a, b) => Number(b.timestamp || b[0] || 0) - Number(a.timestamp || a[0] || 0),
      );
      const oiVals = oiList.map(x => parseFloat(x.openInterest)).filter(Number.isFinite);

      const pctChange = (idx) => {
        if (oiVals.length <= idx || oiVals[0] <= 0) return null;
        const cur = oiVals[0];
        const prev = oiVals[idx];
        if (prev == null || prev <= 0) return null;
        return ((cur - prev) / prev) * 100;
      };

      const oiChange1h = oiVals.length >= 2 ? pctChange(1) : null;
      const oiChange4h = oiVals.length >= 5 ? pctChange(4) : null;
      const oiChange24h = oiVals.length >= 25 ? pctChange(24) : null;

      let longShortRatio = null;
      if (lsResp.retCode === 0 && lsResp.result?.list?.length) {
        const buyRatio = parseFloat(lsResp.result.list[0].buyRatio);
        const sellRatio = parseFloat(lsResp.result.list[0].sellRatio);
        longShortRatio = sellRatio > 0 ? buyRatio / sellRatio : null;
      }

      return {
        fundingRate,
        oiChange1h,
        oiChange4h,
        oiChange24h,
        longShortRatio,
      };
    } catch {
      return {
        fundingRate: null,
        oiChange1h: null,
        oiChange4h: null,
        oiChange24h: null,
        longShortRatio: null,
      };
    }
  }

  /**
   * Лимитная покупка на споте (базовый объём из USDT).
   * Этап 2 UI — вызов только после подтверждения пользователя.
   */
  async placeLimitBuyOrder(symbol, amountUsdt, price) {
    const info = await this.getInstrumentInfo(symbol, 'spot');
    if (!info) throw new Error('Инструмент не найден');

    const tick = parseFloat(info.priceFilter?.tickSize || '0.00000001');
    const step = parseFloat(info.lotSizeFilter?.qtyStep || info.lotSizeFilter?.basePrecision || '0.00000001');
    const minQty = parseFloat(info.lotSizeFilter?.minOrderQty || '0');
    const minAmt = parseFloat(info.lotSizeFilter?.minOrderAmt || '0');

    const roundDown = (v, stepVal) => {
      if (!stepVal || stepVal <= 0) return v;
      return Math.floor(v / stepVal) * stepVal;
    };

    let px = Number(price);
    if (tick > 0) px = roundDown(px, tick);
    let qty = amountUsdt / px;
    if (step > 0) qty = roundDown(qty, step);
    if (minQty > 0 && qty < minQty) {
      throw new Error(`Количество ${qty} ниже minOrderQty ${minQty}`);
    }
    const notional = qty * px;
    if (minAmt > 0 && notional < minAmt) {
      throw new Error(`Сумма сделки ${notional.toFixed(2)} USDT ниже minOrderAmt ${minAmt}`);
    }

    const resp = await this.client.submitOrder({
      category: 'spot',
      symbol,
      side: 'Buy',
      orderType: 'Limit',
      qty: String(qty),
      price: String(px),
    });
    if (resp.retCode !== 0) throw new Error(resp.retMsg);
    return resp.result;
  }

  /**
   * Последняя цена исполненной покупки по спот-паре (по истории сделок)
   * @param {string} coin — код монеты, например 'BTC' (не 'BTCUSDT')
   */
  async getLastBuyPrice(coin) {
    const symbol = coin.toUpperCase().includes('USDT') 
        ? coin.toUpperCase() 
        : `${coin.toUpperCase()}USDT`;
  
    try {
      // 1. Указываем интервал за последние 30 дней
      const startTime = Date.now() - (30 * 24 * 60 * 60 * 1000);
  
      const resp = await this.client.getExecutionList({
        category: 'spot',
        symbol: symbol,
        startTime: startTime,
        limit: 100 // Увеличиваем лимит, чтобы захватить больше сделок для усреднения
      });
  
      if (resp.retCode !== 0 || !resp.result?.list?.length) return null;
  
      // 2. Фильтруем только покупки
      const buyExecutions = resp.result.list.filter(ex => ex.side === 'Buy');
  
      if (buyExecutions.length === 0) return null;
  
      // 3. Считаем средневзвешенную цену: (Сумма qty * price) / Общая сумма qty
      // Это точнее, чем просто среднее арифметическое цен
      let totalValue = 0;
      let totalQty = 0;
  
      buyExecutions.forEach(ex => {
        const price = parseFloat(ex.execPrice);
        const qty = parseFloat(ex.execQty);
        totalValue += price * qty;
        totalQty += qty;
      });
  
      return totalQty > 0 ? totalValue / totalQty : null;
  
    } catch (err) {
      console.error(`Ошибка при расчете средней цены для ${coin}:`, err);
      return null;
    }
  }

  /**
   * Исполнения покупок по спот-паре (новые первыми)
   * @param {string} coin — 'BTC', не 'BTCUSDT'
   */
  async getBuyExecutions(coin, limit = 50) {
    const symbol = `${coin}USDT`;
    try {
      const resp = await this.client.getExecutionList({
        category: 'spot',
        symbol: symbol,
        limit,
      });
      if (resp.retCode !== 0 || !resp.result?.list?.length) return [];
      return resp.result.list
        .filter(ex => ex.side === 'Buy')
        .sort((a, b) => Number(b.execTime) - Number(a.execTime));
    } catch {
      return [];
    }
  }

  /** Все спот-тикеры USDT (для отбора по объёму) */
  async getSpotUsdtTickers() {
    const resp = await this.client.getTickers({ category: 'spot' });
    if (resp.retCode !== 0 || !resp.result?.list) {
      throw new Error(resp.retMsg || 'tickers');
    }
    return resp.result.list.filter(t => t.symbol?.endsWith('USDT'));
  }

  /**
   * Закрытия свечей 1h (от старых к новым), последние `limit` баров
   */
  async getKlineHourlyCloses(symbol, limit = 30) {
    const resp = await this.client.getKline({
      category: 'spot',
      symbol,
      interval: '60',
      limit,
    });
    if (resp.retCode !== 0 || !resp.result?.list?.length) return [];
    const rows = resp.result.list;
    const withTime = rows
      .map(row => ({ t: Number(row[0]), c: parseFloat(row[4]) }))
      .filter(x => Number.isFinite(x.c))
      .sort((a, b) => a.t - b.t);
    return withTime.map(x => x.c);
  }

  /** Спред best bid/ask в % от mid */
  async getBidAskSpreadPct(symbol) {
    try {
      const resp = await this.client.getOrderbook({
        category: 'spot',
        symbol,
        limit: 1,
      });
      if (resp.retCode !== 0 || !resp.result?.b?.[0] || !resp.result?.a?.[0]) {
        return null;
      }
      const bid = parseFloat(resp.result.b[0][0]);
      const ask = parseFloat(resp.result.a[0][0]);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
        return null;
      }
      const mid = (bid + ask) / 2;
      return ((ask - bid) / mid) * 100;
    } catch {
      return null;
    }
  }

  /**
   * Получить объём за 24ч
   * @param {string} symbol
   * @returns {Promise<number>}
   */
  async get24hVolume(symbol) {
    try {
      const resp = await this.client.getTickers({
        category: 'spot',
        symbol: symbol,
      });
      if (resp.retCode !== 0 || !resp.result.list.length) {
        return 0; // Возвращаем 0 вместо критической ошибки
      }
      return parseFloat(resp.result.list[0].volume24h);
    } catch (err) {
      console.warn(`Не удалось получить объём для ${symbol}:`, err.message);
      return 0;
    }
  }

  /**
   * Получить изменение цены за 24ч в процентах
   * @param {string} symbol
   * @returns {Promise<number>}
   */
  async get24hChange(symbol) {
    try {
      const resp = await this.client.getTickers({
        category: 'spot',
        symbol: symbol,
      });
      if (resp.retCode !== 0 || !resp.result.list.length) {
        return 0; // Возвращаем 0 вместо критической ошибки
      }
      return parseFloat(resp.result.list[0].price24hPcnt) * 100;
    } catch (err) {
      console.warn(`Не удалось получить изменение цены для ${symbol}:`, err.message);
      return 0;
    }
  }

  /**
   * Получить фьючерсные позиции (для unrealized PnL)
   * @param {string} coin - например 'BTC'
   * @returns {Promise<Array>} массив позиций
   */
  async getPositions(coin) {
    const resp = await this.client.getPositionInfo({
      category: 'linear',
      symbol: `${coin}USDT`,
    });
    if (resp.retCode !== 0) return [];
    return resp.result.list.filter(p => parseFloat(p.size) !== 0);
  }

  /**
   * Получить реализованный PnL за последние N дней (суммарно)
   * @param {string} coin
   * @param {number} days
   * @returns {Promise<number>}
   */
  async getRealizedPnL(coin, days) {
    const endTime = Date.now();
    const startTime = endTime - days * 24 * 60 * 60 * 1000;

    let allPnl = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const params = {
        category: 'linear',
        symbol: `${coin}USDT`,
        startTime: startTime,
        endTime: endTime,
        limit: 100,
      };
      if (cursor) params.cursor = cursor;

      const resp = await this.client.getClosedPnL(params);
      if (resp.retCode !== 0) break;

      const list = resp.result.list;
      allPnl = allPnl.concat(list);
      cursor = resp.result.nextPageCursor;
      hasMore = !!cursor && list.length > 0;
    }

    const totalPnl = allPnl.reduce((sum, item) => sum + parseFloat(item.closedPnl), 0);
    return totalPnl;
  }
  /**
   * Получить фьючерсные метрики (Funding, L/S Ratio, OI Change) для оценки спота
   */
  async getDerivativesContext(symbol) {
    try {
      // 1. Получаем Funding Rate из тикера
      const tickerResp = await this.client.getTickers({ category: 'linear', symbol });
      
      // 2. Получаем историю Open Interest (за 2 последних часа для динамики)
      const oiResp = await this.client.getOpenInterest({ category: 'linear', symbol, intervalTime: '1h', limit: 2 });
      
      // 3. Получаем Long/Short Ratio аккаунтов
      const lsResp = await this.client.getLongShortRatio({ category: 'linear', symbol, period: '1h', limit: 1 });

      let fundingRate = null;
      let oiChangePct = null;
      let lsRatio = null;

      if (tickerResp.retCode === 0 && tickerResp.result?.list?.length) {
        fundingRate = parseFloat(tickerResp.result.list[0].fundingRate) * 100; // в %
      }

      if (oiResp.retCode === 0 && oiResp.result?.list?.length >= 2) {
        const currentOi = parseFloat(oiResp.result.list[0].openInterest);
        const prevOi = parseFloat(oiResp.result.list[1].openInterest);
        oiChangePct = ((currentOi - prevOi) / prevOi) * 100;
      }

      if (lsResp.retCode === 0 && lsResp.result?.list?.length) {
        const buyRatio = parseFloat(lsResp.result.list[0].buyRatio);
        const sellRatio = parseFloat(lsResp.result.list[0].sellRatio);
        lsRatio = sellRatio > 0 ? (buyRatio / sellRatio) : null;
      }

      return { fundingRate, oiChangePct, lsRatio };
    } catch (err) {
      // Монета может не торговаться на фьючерсах
      return { fundingRate: null, oiChangePct: null, lsRatio: null };
    }
  }

  /**
   * Закрытия свечей 1h + Объемы для расчета Volume Spike
   */
  async getKlineHourlyData(symbol, limit = 30) {
    const resp = await this.client.getKline({
      category: 'spot',
      symbol,
      interval: '60',
      limit,
    });
    
    if (resp.retCode !== 0 || !resp.result?.list?.length) {
      return { closes: [], volumeSpike: null };
    }

    const rows = resp.result.list;
    const sorted = rows
      .map(row => ({ 
        t: Number(row[0]), 
        c: parseFloat(row[4]), // Close
        v: parseFloat(row[5])  // Volume
      }))
      .filter(x => Number.isFinite(x.c) && Number.isFinite(x.v))
      .sort((a, b) => a.t - b.t);

    const closes = sorted.map(x => x.c);
    const volumes = sorted.map(x => x.v);

    // Расчет Volume Spike: текущий объем / средний объем за предыдущие часы
    let volumeSpike = null;
    if (volumes.length > 5) {
      const currentVol = volumes[volumes.length - 1];
      const prevVols = volumes.slice(0, -1);
      const avgVol = prevVols.reduce((s, v) => s + v, 0) / prevVols.length;
      volumeSpike = avgVol > 0 ? (currentVol / avgVol) : null;
    }

    return { closes, volumeSpike };
  }
  /**
   * Получить доступный баланс USDT на спотовом аккаунте
   */
  async getFreeUSDT() {
    const resp = await this.client.getWalletBalance({
      accountType: 'UNIFIED',
      coin: 'USDT'
    });
    if (resp.retCode !== 0) throw new Error(resp.retMsg);
    const usdtData = resp.result.list[0].coin.find(c => c.coin === 'USDT');
    return usdtData ? parseFloat(usdtData.availableToWithdraw) : 0;
  }

  /**
   * Исполнение рыночного ордера на покупку на сумму в USDT (quote unit)
   */
  async placeMarketBuyOrder(symbol, amountUsdt) {
    const resp = await this.client.submitOrder({
      category: 'spot',
      symbol: symbol,
      side: 'Buy',
      orderType: 'Market',
      qty: amountUsdt.toString(),
      marketUnit: 'quote' // Важно: покупаем именно на сумму USDT, а не на кол-во монет
    });

    if (resp.retCode !== 0) throw new Error(resp.retMsg);
    return resp.result;
  }
  /**
   * Получить комплексные метрики по сделкам за 30 дней (Покупки + Продажи)
   */
  async get30dTradeMetrics(coin) {
    const symbol = coin.toUpperCase().includes('USDT') ? coin.toUpperCase() : `${coin.toUpperCase()}USDT`;
    
    try {
      const startTime = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const resp = await this.client.getExecutionList({
        category: 'spot',
        symbol: symbol,
        startTime: startTime,
        limit: 100 // Захватываем больше истории
      });

      if (resp.retCode !== 0 || !resp.result?.list?.length) return null;

      let totalInvested = 0; // Вложено USDT (сумма покупок)
      let totalBoughtQty = 0; // Куплено монет
      let totalRealized = 0; // Получено USDT (сумма продаж)
      let totalSoldQty = 0; // Продано монет

      resp.result.list.forEach(ex => {
        const price = parseFloat(ex.execPrice);
        const qty = parseFloat(ex.execQty);
        
        if (ex.side === 'Buy') {
          totalInvested += price * qty;
          totalBoughtQty += qty;
        } else if (ex.side === 'Sell') {
          totalRealized += price * qty;
          totalSoldQty += qty;
        }
      });

      // Средние цены по исполненным сделкам (VWAP)
      const avgBuyPrice = totalBoughtQty > 0 ? totalInvested / totalBoughtQty : null;
      const avgSellPrice = totalSoldQty > 0 ? totalRealized / totalSoldQty : null;

      /**
       * Остаток позиции "внутри 30d" (если в периоде были чистые продажи больше покупок,
       * значит продавали старую позицию и этот остаток/себестоимость определить нельзя).
       */
      const netQty = totalBoughtQty - totalSoldQty;
      const soldFromOlderPosition = netQty < 0;
      const remainingQty30d = soldFromOlderPosition ? null : netQty;

      /**
       * Себестоимость остатка при учёте "average cost" внутри периода.
       * costSold = avgBuyPrice * soldQty, remainingCost = totalInvested - costSold.
       */
      let remainingCost30d = null;
      let avgCostRemaining30d = null;
      let realizedPnl30d = null;

      if (!soldFromOlderPosition && avgBuyPrice != null) {
        const costSold = avgBuyPrice * totalSoldQty;
        remainingCost30d = totalInvested - costSold;
        avgCostRemaining30d = remainingQty30d > 0 ? remainingCost30d / remainingQty30d : null;
        realizedPnl30d = totalRealized - costSold;
      }

      return {
        totalInvested,
        totalBoughtQty,
        totalRealized,
        totalSoldQty,
        avgBuyPrice,
        avgSellPrice,
        remainingQty30d,
        remainingCost30d,
        avgCostRemaining30d,
        realizedPnl30d,
        soldFromOlderPosition,
      };
    } catch (err) {
      console.error(`Ошибка при получении метрик для ${coin}:`, err);
      return null;
    }
  }

  /**
   * Исполнение рыночного ордера на продажу
   */
  async placeMarketSellOrder(symbol, qty) {
    const resp = await this.client.submitOrder({
      category: 'spot',
      symbol: symbol,
      side: 'Sell',
      orderType: 'Market',
      qty: qty.toString(),
      // Для продажи маркет ордером на споте baseCoin означает количество самой монеты
    });

    if (resp.retCode !== 0) throw new Error(resp.retMsg);
    return resp.result;
  }
}

