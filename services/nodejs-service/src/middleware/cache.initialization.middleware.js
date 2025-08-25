const startupCacheService = require('../services/startup.cache.service');
const logger = require('../services/logger.service');

/**
 * Middleware to ensure cache is initialized before processing requests
 */
const ensureCacheInitialized = async (req, res, next) => {
  try {
    const status = startupCacheService.getStatus();
    
    if (!status.is_initialized) {
      logger.warn('Cache not initialized, initializing now...');
      await startupCacheService.initialize();
    }
    
    next();
  } catch (error) {
    logger.error('Cache initialization failed in middleware:', error);
    return res.status(503).json({
      success: false,
      message: 'Service temporarily unavailable - cache initialization failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Health check endpoint for cache services
 */
const cacheHealthCheck = async (req, res) => {
  try {
    const stats = await startupCacheService.getCacheStats();
    const status = startupCacheService.getStatus();
    
    return res.status(200).json({
      success: true,
      message: 'Cache health check completed',
      data: {
        status,
        stats
      }
    });
  } catch (error) {
    logger.error('Cache health check failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Cache health check failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Endpoint to manually refresh caches
 */
const refreshCaches = async (req, res) => {
  try {
    const result = await startupCacheService.refreshCaches();
    
    return res.status(200).json({
      success: true,
      message: 'Caches refreshed successfully',
      data: result
    });
  } catch (error) {
    logger.error('Manual cache refresh failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to refresh caches',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  ensureCacheInitialized,
  cacheHealthCheck,
  refreshCaches
};
