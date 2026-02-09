const { CurrencyConfig } = require('../models');

class CurrencyConfigService {
  normalizeCurrency(currency) {
    return (currency || '').toString().trim().toUpperCase();
  }

  async getCurrencyConfig(currency, { requireEnabled = true } = {}) {
    const normalized = this.normalizeCurrency(currency);
    if (!normalized || normalized.length !== 3) {
      throw new Error('currency must be a valid ISO-4217 code');
    }

    const config = await CurrencyConfig.findOne({ where: { currency: normalized } });
    if (!config) {
      throw new Error(`Unsupported currency: ${normalized}`);
    }

    if (requireEnabled && !config.enabled) {
      throw new Error(`Currency is currently disabled: ${normalized}`);
    }

    return config;
  }

  async listCurrencies({ enabledOnly = true } = {}) {
    const where = enabledOnly ? { enabled: true } : undefined;
    const rows = await CurrencyConfig.findAll({
      where,
      order: [['currency', 'ASC']],
    });

    return rows;
  }

  validateAmountBounds(amount, config) {
    const numericAmount = typeof amount === 'string' ? parseFloat(amount) : Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new Error('amount must be a positive number');
    }

    const minAmount = config.min_amount != null ? parseFloat(config.min_amount) : null;
    const maxAmount = config.max_amount != null ? parseFloat(config.max_amount) : null;

    if (Number.isFinite(minAmount) && minAmount > 0 && numericAmount < minAmount) {
      throw new Error(`amount must be at least ${minAmount} ${config.currency}`);
    }

    if (Number.isFinite(maxAmount) && maxAmount > 0 && numericAmount > maxAmount) {
      throw new Error(`amount must not exceed ${maxAmount} ${config.currency}`);
    }
  }
}

module.exports = new CurrencyConfigService();
