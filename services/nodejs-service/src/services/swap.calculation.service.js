const { redisCluster } = require('../../config/redis');
const groupsCacheService = require('./groups.cache.service');
const logger = require('../utils/logger');
const { 
  logSwapCalculation, 
  logSwapError 
} = require('../utils/swap.logger');

// Import winston logger for swap-specific debug logs
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Create dedicated debug logger that writes to swap.log
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const swapDebugLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'swap-service' },
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'swap.log'),
      maxsize: 100 * 1024 * 1024, // 100MB
      maxFiles: 10,
      tailable: true
    })
  ]
});

class SwapCalculationService {
  constructor() {
    this.CACHE_PREFIX = 'swap_calc';
  }

  /**
   * Calculate swap charges for an order
   * @param {Object} order - Order object with symbol, order_type, order_quantity, group_name
   * @param {Date} calculationDate - Date for which swap is being calculated
   * @returns {Promise<number>} - Calculated swap charge
   */
  async calculateSwapCharge(order, calculationDate = new Date()) {
    const startTime = Date.now();
    
    try {
      // Get group configuration for the symbol
      const groupConfig = await groupsCacheService.getGroup(order.group_name, order.symbol);
      
      if (!groupConfig) {
        swapDebugLogger.warn(`[DEBUG] Group config not found for ${order.group_name}:${order.symbol}`);
        return 0;
      }

      // Check if swap should be applied
      const shouldApply = this.shouldApplySwap(groupConfig, calculationDate);
      
      if (!shouldApply) {
        swapDebugLogger.info(`[DEBUG] Swap not applicable for ${order.symbol} (${calculationDate.getDay() === 0 || calculationDate.getDay() === 6 ? 'weekend' : 'non-trading day'})`);
        return 0;
      }

      // Calculate base swap charge
      let swapCharge = 0;
      // Default to 'percentage' if swap_type is null or undefined
      let swapType = groupConfig.swap_type?.toLowerCase();
      if (!swapType || swapType === 'null' || swapType === 'undefined') {
        swapType = 'percentage'; // Default swap type
        swapDebugLogger.info(`[DEBUG] No swap_type defined for ${order.symbol}, defaulting to 'percentage'`);
      }
      
      const swapRate = order.order_type.toLowerCase() === 'buy' 
        ? parseFloat(groupConfig.swap_buy) 
        : parseFloat(groupConfig.swap_sell);
      const conversionRate = await this.getConversionRate(groupConfig);
      const tripleSwapMultiplier = this.getTripleSwapMultiplier(groupConfig, calculationDate);
      const isTripleSwap = tripleSwapMultiplier === 3;
      const isCrypto = parseInt(groupConfig.type) === 4;
      let formulaUsed = '';
      
      // Log key calculation parameters only if swap rate is non-zero
      if (swapRate !== 0) {
        swapDebugLogger.info(`[DEBUG] Calculating ${swapType} swap for ${order.symbol}: rate=${swapRate}, qty=${order.order_quantity}`);
      }

      switch (swapType) {
        case 'points':
          swapCharge = await this.calculatePointsSwap(order, groupConfig);
          formulaUsed = 'points: swap_points * point_value * lots';
          break;
        case 'percentage':
          swapCharge = await this.calculatePercentageSwap(order, groupConfig);
          formulaUsed = 'percentage: 100,000 × Lots × (SwapRate/100) × ConversionRate';
          break;
        case 'noswap':
          return 0;
        default:
          swapDebugLogger.warn(`[DEBUG] Unknown swap_type: ${swapType} for ${order.symbol}`);
          return 0;
      }

      // Apply triple swap on Wednesday for non-crypto
      const finalSwapCharge = swapCharge * tripleSwapMultiplier;
      const processingTime = Date.now() - startTime;
      
      // Log only if swap charge is calculated
      if (finalSwapCharge !== 0) {
        swapDebugLogger.info(`[DEBUG] Calculated swap: ${finalSwapCharge} for order ${order.order_id} (${swapType}${isTripleSwap ? ', triple swap' : ''})`);
      }

      // Log detailed calculation
      logSwapCalculation({
        order_id: order.order_id,
        symbol: order.symbol,
        group_name: order.group_name,
        order_type: order.order_type,
        order_quantity: parseFloat(order.order_quantity),
        user_id: order.order_user_id,
        user_type: order.user_type || 'unknown',
        calculation_date: calculationDate.toISOString(),
        swap_type: swapType,
        swap_rate: swapRate,
        calculated_amount: finalSwapCharge,
        previous_swap: parseFloat(order.swap || 0),
        new_total_swap: parseFloat(order.swap || 0) + finalSwapCharge,
        formula_used: formulaUsed,
        conversion_rate: conversionRate,
        is_triple_swap: isTripleSwap,
        is_crypto: isCrypto,
        processing_time_ms: processingTime
      });

      return finalSwapCharge;

    } catch (error) {
      logSwapError(error, {
        order_id: order.order_id,
        user_id: order.order_user_id,
        symbol: order.symbol,
        group_name: order.group_name,
        operation: 'calculateSwapCharge'
      });
      logger.error(`Error calculating swap for order ${order.order_id}:`, error);
      return 0;
    }
  }

  /**
   * Check if swap should be applied based on instrument type and date
   */
  shouldApplySwap(groupConfig, calculationDate) {
    const instrumentType = parseInt(groupConfig.type);
    const dayOfWeek = calculationDate.getDay(); // 0 = Sunday, 6 = Saturday
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // Check swap_type first
    if (groupConfig.swap_type?.toLowerCase() === 'noswap') {
      return false;
    }

    // Crypto (type = 4) - apply swap daily
    if (instrumentType === 4) {
      return true;
    }

    // Other instruments - apply only on weekdays (Monday=1 to Friday=5)
    return dayOfWeek >= 1 && dayOfWeek <= 5;
  }

  /**
   * Get triple swap multiplier for Wednesday
   */
  getTripleSwapMultiplier(groupConfig, calculationDate) {
    const instrumentType = parseInt(groupConfig.type);
    const dayOfWeek = calculationDate.getDay(); // 0 = Sunday, 6 = Saturday

    // Triple swap on Wednesday (3) for non-crypto instruments
    if (dayOfWeek === 3 && instrumentType !== 4) {
      return 3;
    }

    return 1;
  }

  /**
   * Calculate swap using points formula
   * swap_charge = swap_points * point_value * lots
   * point_value = contract_size * show_points * conversion_rate
   */
  async calculatePointsSwap(order, groupConfig) {
    try {
      // Get swap points based on order type
      const swapPoints = order.order_type.toLowerCase() === 'buy' 
        ? parseFloat(groupConfig.swap_buy) 
        : parseFloat(groupConfig.swap_sell);

      if (swapPoints === 0) {
        return 0;
      }

      const lots = parseFloat(order.order_quantity);
      const contractSize = parseFloat(groupConfig.contract_size || 100000);
      const showPointsRaw = parseInt(groupConfig.show_points || 5);
      const showPoints = this.convertShowPointsToDecimal(showPointsRaw);

      // Get conversion rate
      const conversionRate = await this.getConversionRate(groupConfig);

      // Calculate point value
      const pointValue = contractSize * showPoints * conversionRate;

      // Calculate swap charge
      const swapCharge = swapPoints * pointValue * lots;

      return swapCharge;

    } catch (error) {
      swapDebugLogger.error('[DEBUG] Error in calculatePointsSwap:', error);
      return 0;
    }
  }

  /**
   * Calculate swap using percentage formula
   * For forex pairs (type=1): 100,000 × Lots × (SwapRate (%)/100) × Conversion Rate
   * For now using same formula for all types as requested
   */
  async calculatePercentageSwap(order, groupConfig) {
    try {
      // Get swap rate based on order type
      const swapRate = order.order_type.toLowerCase() === 'buy' 
        ? parseFloat(groupConfig.swap_buy) 
        : parseFloat(groupConfig.swap_sell);

      if (swapRate === 0) {
        return 0;
      }

      const lots = parseFloat(order.order_quantity);
      const conversionRate = await this.getConversionRate(groupConfig);

      // Using same formula for all types as requested
      const swapCharge = 100000 * lots * (swapRate / 100) * conversionRate;

      return swapCharge;

    } catch (error) {
      swapDebugLogger.error('[DEBUG] Error in calculatePercentageSwap:', error);
      return 0;
    }
  }

  /**
   * Convert show_points to decimal format
   * e.g., 3 → 0.001, 5 → 0.00001
   */
  convertShowPointsToDecimal(showPoints) {
    if (!showPoints || showPoints <= 0) {
      return 0.00001; // Default to 5 decimal places
    }
    return Math.pow(10, -showPoints);
  }

  /**
   * Get conversion rate to USD
   */
  async getConversionRate(groupConfig) {
    try {
      const profitCurrency = groupConfig.profit?.toUpperCase();
      // If already in USD or USDT, no conversion needed
      if (!profitCurrency || profitCurrency === 'USD' || profitCurrency === 'USDT') {
        return 1.0;
      }

      // Get conversion rate from market data
      const rate = await this.fetchConversionRate(profitCurrency);
      return rate || 1.0; // Default to 1.0 if conversion fails

    } catch (error) {
      swapDebugLogger.error('[DEBUG] Error getting conversion rate:', error);
      return 1.0;
    }
  }

  /**
   * Fetch conversion rate from Redis market data
   */
  async fetchConversionRate(currency) {
    try {
      // Try direct USD pair first (e.g., USDJPY)
      let symbol = `USD${currency}`;
      let marketData = await this.getMarketPrice(symbol);
      
      if (marketData && marketData.bid > 0) {
        // For USD to currency pairs (e.g., USDJPY = 148.739)
        // To convert currency to USD, we need 1/rate
        // Example: 1 JPY = 1/148.739 USD = 0.00672 USD
        const conversionRate = 1 / marketData.bid;
        logger.info(`Conversion rate for ${currency} to USD: 1/${marketData.bid} = ${conversionRate}`);
        return conversionRate;
      }

      // Try inverse pair (e.g., JPYUSD)
      symbol = `${currency}USD`;
      marketData = await this.getMarketPrice(symbol);
      
      if (marketData && marketData.bid > 0) {
        // For currency to USD pairs, use direct rate
        logger.info(`Conversion rate for ${currency} to USD: ${marketData.bid}`);
        return marketData.bid;
      }

      // Try EUR pairs as intermediate conversion
      const eurToUsd = await this.getMarketPrice('EURUSD');
      const currencyToEur = await this.getMarketPrice(`${currency}EUR`);
      
      if (eurToUsd && currencyToEur && eurToUsd.bid > 0 && currencyToEur.bid > 0) {
        return currencyToEur.bid * eurToUsd.bid;
      }

      logger.warn(`No conversion rate found for ${currency} to USD`);
      return 1.0;

    } catch (error) {
      logger.error(`Error fetching conversion rate for ${currency}:`, error);
      return 1.0;
    }
  }

  /**
   * Get market price from Redis
   */
  async getMarketPrice(symbol) {
    try {
      const marketKey = `market:${symbol}`;
      const [bid, ask] = await redisCluster.hmget(marketKey, 'bid', 'ask');
      
      if (bid && ask) {
        return {
          bid: parseFloat(bid),
          ask: parseFloat(ask)
        };
      }
      
      return null;
    } catch (error) {
      logger.error(`Error getting market price for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * Batch calculate swap for multiple orders
   */
  async batchCalculateSwap(orders, calculationDate = new Date()) {
    const results = [];
    
    for (const order of orders) {
      try {
        const swapCharge = await this.calculateSwapCharge(order, calculationDate);
        results.push({
          order_id: order.order_id,
          swap_charge: swapCharge,
          success: true
        });
      } catch (error) {
        logger.error(`Error calculating swap for order ${order.order_id}:`, error);
        results.push({
          order_id: order.order_id,
          swap_charge: 0,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }
}

module.exports = new SwapCalculationService();
