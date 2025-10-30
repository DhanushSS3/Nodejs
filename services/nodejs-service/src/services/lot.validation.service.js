const groupsCache = require('./groups.cache.service');
const logger = require('./logger.service');

/**
 * Lot Validation Service
 * Validates order lot sizes against group-specific min/max constraints
 */
class LotValidationService {
  
  /**
   * Validate lot size against group constraints for a specific symbol
   * @param {string} userGroup - User's group name
   * @param {string} symbol - Trading symbol
   * @param {number} lotSize - Lot size to validate
   * @returns {Object} Validation result with success flag and details
   */
  async validateLotSize(userGroup, symbol, lotSize) {
    try {
      // Get group constraints for the symbol
      const groupFields = await groupsCache.getGroupFields(userGroup, symbol, ['min_lot', 'max_lot']);
      
      if (!groupFields) {
        logger.warn('Group configuration not found, using default constraints', {
          userGroup,
          symbol,
          lotSize
        });
        // Use default constraints if group config not found
        return {
          valid: true,
          lotSize: parseFloat(lotSize),
          minLot: 0.01,
          maxLot: 100.0,
          message: 'Using default lot constraints (group config not found)'
        };
      }

      const minLot = parseFloat(groupFields.min_lot || 0.01);
      const maxLot = parseFloat(groupFields.max_lot || 100.0);
      const parsedLotSize = parseFloat(lotSize);

      // Validate lot size
      if (isNaN(parsedLotSize) || parsedLotSize <= 0) {
        return {
          valid: false,
          lotSize: parsedLotSize,
          minLot,
          maxLot,
          message: 'Lot size must be a positive number'
        };
      }

      if (parsedLotSize < minLot) {
        return {
          valid: false,
          lotSize: parsedLotSize,
          minLot,
          maxLot,
          message: `Lot size ${parsedLotSize} is below minimum allowed ${minLot} for ${userGroup}:${symbol}`
        };
      }

      if (parsedLotSize > maxLot) {
        return {
          valid: false,
          lotSize: parsedLotSize,
          minLot,
          maxLot,
          message: `Lot size ${parsedLotSize} exceeds maximum allowed ${maxLot} for ${userGroup}:${symbol}`
        };
      }

      return {
        valid: true,
        lotSize: parsedLotSize,
        minLot,
        maxLot,
        message: 'Lot size validation passed'
      };

    } catch (error) {
      logger.error('Failed to validate lot size', {
        error: error.message,
        userGroup,
        symbol,
        lotSize
      });
      
      // Return validation failure on error
      return {
        valid: false,
        lotSize: parseFloat(lotSize),
        minLot: null,
        maxLot: null,
        message: `Lot validation failed: ${error.message}`
      };
    }
  }

  /**
   * Get lot constraints for a group and symbol
   * @param {string} userGroup - User's group name
   * @param {string} symbol - Trading symbol
   * @returns {Object} Min/max lot constraints
   */
  async getLotConstraints(userGroup, symbol) {
    try {
      const groupFields = await groupsCache.getGroupFields(userGroup, symbol, ['min_lot', 'max_lot']);
      
      return {
        minLot: parseFloat(groupFields?.min_lot || 0.01),
        maxLot: parseFloat(groupFields?.max_lot || 100.0),
        hasConfig: !!groupFields
      };
    } catch (error) {
      logger.error('Failed to get lot constraints', {
        error: error.message,
        userGroup,
        symbol
      });
      
      return {
        minLot: 0.01,
        maxLot: 100.0,
        hasConfig: false
      };
    }
  }
}

module.exports = new LotValidationService();
