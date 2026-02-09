const logger = require('../utils/logger');
const currencyConfigService = require('../services/currencyConfig.service');

class CurrencyConfigController {
  async getSupportedCurrencies(req, res) {
    try {
      const includeDisabled = (req.query && req.query.include_disabled) === 'true';
      const rows = await currencyConfigService.listCurrencies({ enabledOnly: !includeDisabled });

      const data = rows.map((row) => ({
        id: row.id,
        currency: row.currency,
        minor_unit: row.minor_unit,
        enabled: !!row.enabled,
        min_amount: row.min_amount,
        max_amount: row.max_amount,
        settlement_currency: row.settlement_currency,
      }));

      return res.status(200).json({
        status: true,
        message: 'Supported currencies fetched successfully',
        data,
      });
    } catch (error) {
      logger.error('Error fetching supported currencies', {
        error: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        status: false,
        message: 'Failed to fetch supported currencies',
      });
    }
  }
}

module.exports = new CurrencyConfigController();
