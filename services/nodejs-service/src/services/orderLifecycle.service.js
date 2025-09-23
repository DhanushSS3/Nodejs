const OrderLifecycleId = require('../models/orderLifecycleId.model');
const { redisCluster } = require('../../config/redis');
const logger = require('./logger.service');

class OrderLifecycleService {
  /**
   * Add a new lifecycle ID for an order
   * @param {string} order_id - The main order ID
   * @param {string} id_type - Type of ID (stoploss_id, takeprofit_id, etc.)
   * @param {string} lifecycle_id - The generated lifecycle ID
   * @param {string} notes - Optional notes
   * @returns {Object} Created record
   */
  async addLifecycleId(order_id, id_type, lifecycle_id, notes = null) {
    try {
      // Mark any existing active ID of this type as replaced
      const existingActive = await OrderLifecycleId.findOne({
        where: { order_id, id_type, status: 'active' }
      });
      
      if (existingActive) {
        await existingActive.update({ 
          status: 'replaced', 
          replaced_by: lifecycle_id,
          notes: notes ? `${existingActive.notes || ''}\nReplaced: ${notes}` : existingActive.notes
        });
        
        logger.info(`Lifecycle ID replaced: ${existingActive.lifecycle_id} -> ${lifecycle_id}`, {
          order_id, id_type, old_id: existingActive.lifecycle_id, new_id: lifecycle_id
        });
      }
      
      // Create new active ID
      const newId = await OrderLifecycleId.create({
        order_id,
        id_type,
        lifecycle_id,
        status: 'active',
        notes
      });
      
      // Update Redis global lookup
      try {
        await redisCluster.set(`global_order_lookup:${lifecycle_id}`, order_id);
      } catch (redisError) {
        logger.warn('Failed to update Redis global lookup', { 
          lifecycle_id, order_id, error: redisError.message 
        });
      }
      
      logger.info(`Lifecycle ID added: ${lifecycle_id}`, {
        order_id, id_type, lifecycle_id, status: 'active'
      });
      
      return newId;
    } catch (error) {
      logger.error('Failed to add lifecycle ID', { 
        order_id, id_type, lifecycle_id, error: error.message 
      });
      throw error;
    }
  }
  
  /**
   * Get active lifecycle ID for order and type
   * @param {string} order_id - The main order ID
   * @param {string} id_type - Type of ID to get
   * @returns {string|null} Active lifecycle ID or null
   */
  async getActiveLifecycleId(order_id, id_type) {
    try {
      const record = await OrderLifecycleId.findOne({
        where: { order_id, id_type, status: 'active' }
      });
      return record?.lifecycle_id || null;
    } catch (error) {
      logger.error('Failed to get active lifecycle ID', { 
        order_id, id_type, error: error.message 
      });
      return null;
    }
  }
  
  /**
   * Get all lifecycle IDs for an order (with history)
   * @param {string} order_id - The main order ID
   * @returns {Array} All lifecycle IDs for the order
   */
  async getAllLifecycleIds(order_id) {
    try {
      return await OrderLifecycleId.findAll({
        where: { order_id },
        order: [['created_at', 'ASC']]
      });
    } catch (error) {
      logger.error('Failed to get all lifecycle IDs', { 
        order_id, error: error.message 
      });
      return [];
    }
  }
  
  /**
   * Find order_id by any lifecycle_id
   * @param {string} lifecycle_id - Any lifecycle ID
   * @returns {string|null} Order ID or null
   */
  async findOrderByLifecycleId(lifecycle_id) {
    try {
      const record = await OrderLifecycleId.findOne({
        where: { lifecycle_id }
      });
      return record?.order_id || null;
    } catch (error) {
      logger.error('Failed to find order by lifecycle ID', { 
        lifecycle_id, error: error.message 
      });
      return null;
    }
  }
  
  /**
   * Mark lifecycle ID as executed/cancelled/replaced
   * @param {string} lifecycle_id - The lifecycle ID to update
   * @param {string} status - New status (executed, cancelled, replaced)
   * @param {string} notes - Optional notes
   * @returns {Object|null} Updated record or null
   */
  async updateLifecycleStatus(lifecycle_id, status, notes = null) {
    try {
      const record = await OrderLifecycleId.findOne({
        where: { lifecycle_id }
      });
      
      if (record) {
        const updateData = { status };
        if (notes) {
          updateData.notes = notes;
        }
        
        await record.update(updateData);
        
        logger.info(`Lifecycle ID status updated: ${lifecycle_id}`, {
          lifecycle_id, old_status: record.status, new_status: status, notes
        });
      }
      
      return record;
    } catch (error) {
      logger.error('Failed to update lifecycle status', { 
        lifecycle_id, status, error: error.message 
      });
      return null;
    }
  }
  
  /**
   * Get complete lifecycle history for an order
   * @param {string} order_id - The main order ID
   * @returns {Object} Complete history with records and grouped data
   */
  async getLifecycleHistory(order_id) {
    try {
      const records = await OrderLifecycleId.findAll({
        where: { order_id },
        order: [['created_at', 'ASC']]
      });
      
      // Group by id_type for easier analysis
      const grouped = {};
      records.forEach(record => {
        if (!grouped[record.id_type]) {
          grouped[record.id_type] = [];
        }
        grouped[record.id_type].push(record);
      });
      
      return { records, grouped };
    } catch (error) {
      logger.error('Failed to get lifecycle history', { 
        order_id, error: error.message 
      });
      return { records: [], grouped: {} };
    }
  }
  
  /**
   * Get lifecycle ID type by lifecycle_id
   * @param {string} lifecycle_id - The lifecycle ID
   * @returns {string|null} ID type or null
   */
  async getLifecycleIdType(lifecycle_id) {
    try {
      const record = await OrderLifecycleId.findOne({
        where: { lifecycle_id },
        attributes: ['id_type']
      });
      return record?.id_type || null;
    } catch (error) {
      logger.error('Failed to get lifecycle ID type', { 
        lifecycle_id, error: error.message 
      });
      return null;
    }
  }
  
  /**
   * Batch add multiple lifecycle IDs for an order
   * @param {string} order_id - The main order ID
   * @param {Array} idMappings - Array of {id_type, lifecycle_id, notes}
   * @returns {Array} Created records
   */
  async batchAddLifecycleIds(order_id, idMappings) {
    const results = [];
    
    for (const mapping of idMappings) {
      try {
        const result = await this.addLifecycleId(
          order_id, 
          mapping.id_type, 
          mapping.lifecycle_id, 
          mapping.notes
        );
        results.push(result);
      } catch (error) {
        logger.error('Failed to add lifecycle ID in batch', { 
          order_id, mapping, error: error.message 
        });
        results.push(null);
      }
    }
    
    return results;
  }
  
  /**
   * Clean up old replaced/cancelled IDs (for maintenance)
   * @param {number} daysOld - Remove records older than this many days
   * @returns {number} Number of records deleted
   */
  async cleanupOldIds(daysOld = 90) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      
      const { count } = await OrderLifecycleId.destroy({
        where: {
          status: ['replaced', 'cancelled', 'executed'],
          updated_at: {
            [require('sequelize').Op.lt]: cutoffDate
          }
        }
      });
      
      logger.info(`Cleaned up ${count} old lifecycle IDs`, { daysOld, cutoffDate });
      return count;
    } catch (error) {
      logger.error('Failed to cleanup old lifecycle IDs', { 
        daysOld, error: error.message 
      });
      return 0;
    }
  }
}

module.exports = new OrderLifecycleService();
