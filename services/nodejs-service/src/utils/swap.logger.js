const winston = require('winston');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Create dedicated swap logger with separate files
const swapLogger = winston.createLogger({
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
    // Dedicated swap log file
    new winston.transports.File({
      filename: path.join(logsDir, 'swap.log'),
      maxsize: 100 * 1024 * 1024, // 100MB
      maxFiles: 10,
      tailable: true
    }),
    // Dedicated swap error log file
    new winston.transports.File({
      filename: path.join(logsDir, 'swap-error.log'),
      level: 'error',
      maxsize: 50 * 1024 * 1024, // 50MB
      maxFiles: 5,
      tailable: true
    })
  ]
});

/**
 * Log swap calculation details
 */
function logSwapCalculation(data) {
  const logData = {
    event_type: 'calculation',
    order_id: data.order_id,
    symbol: data.symbol,
    group_name: data.group_name,
    order_type: data.order_type,
    order_quantity: data.order_quantity,
    user_id: data.user_id,
    user_type: data.user_type,
    calculation_date: data.calculation_date,
    swap_type: data.swap_type,
    swap_rate: data.swap_rate,
    calculated_amount: data.calculated_amount,
    previous_swap: data.previous_swap,
    new_total_swap: data.new_total_swap,
    formula_used: data.formula_used,
    conversion_rate: data.conversion_rate,
    is_triple_swap: data.is_triple_swap,
    is_crypto: data.is_crypto,
    processing_time_ms: data.processing_time_ms
  };
  
  // Log to both application.log and dedicated swap.log
  logger.info('SWAP_CALCULATION', logData);
  swapLogger.info('SWAP_CALCULATION', logData);
}

/**
 * Log swap application to order
 */
function logSwapApplication(data) {
  const logData = {
    event_type: 'application',
    order_id: data.order_id,
    user_id: data.user_id,
    user_type: data.user_type,
    swap_amount: data.swap_amount,
    previous_swap: data.previous_swap,
    new_swap: data.new_swap,
    transaction_id: data.transaction_id,
    application_date: data.application_date,
    success: data.success
  };
  
  // Log to both application.log and dedicated swap.log
  logger.info('SWAP_APPLICATION', logData);
  swapLogger.info('SWAP_APPLICATION', logData);
}

/**
 * Log swap transaction creation
 */
function logSwapTransaction(data) {
  const logData = {
    event_type: 'transaction',
    transaction_id: data.transaction_id,
    user_id: data.user_id,
    user_type: data.user_type,
    order_id: data.order_id,
    amount: data.amount,
    balance_before: data.balance_before,
    balance_after: data.balance_after,
    created_at: data.created_at,
    metadata: data.metadata
  };
  
  // Log to both application.log and dedicated swap.log
  logger.info('SWAP_TRANSACTION', logData);
  swapLogger.info('SWAP_TRANSACTION', logData);
}

/**
 * Log daily swap processing summary
 */
function logDailyProcessingSummary(data) {
  const logData = {
    event_type: 'daily_summary',
    processing_date: data.processing_date,
    total_orders_processed: data.total_orders_processed,
    live_orders: data.live_orders,
    demo_orders: data.demo_orders,
    total_swap_amount: data.total_swap_amount,
    successful_updates: data.successful_updates,
    failed_updates: data.failed_updates,
    skipped_orders: data.skipped_orders,
    processing_time_ms: data.processing_time_ms,
    errors: data.errors
  };
  
  // Log to both application.log and dedicated swap.log
  logger.info('DAILY_PROCESSING_SUMMARY', logData);
  swapLogger.info('DAILY_PROCESSING_SUMMARY', logData);
}

/**
 * Log swap processing errors
 */
function logSwapError(error, context = {}) {
  const logData = {
    event_type: 'error',
    error_message: error.message,
    error_stack: error.stack,
    order_id: context.order_id,
    user_id: context.user_id,
    symbol: context.symbol,
    group_name: context.group_name,
    operation: context.operation,
    timestamp: new Date().toISOString(),
    additional_data: context.additional_data
  };
  
  // Log to both application.log and dedicated swap-error.log
  logger.error('SWAP_ERROR', logData);
  swapLogger.error('SWAP_ERROR', logData);
}

/**
 * Log order closure swap processing
 */
function logOrderClosureSwap(data) {
  const logData = {
    event_type: 'order_closure',
    order_id: data.order_id,
    user_id: data.user_id,
    user_type: data.user_type,
    symbol: data.symbol,
    group_name: data.group_name,
    order_type: data.order_type,
    order_quantity: data.order_quantity,
    order_duration_days: data.order_duration_days,
    total_swap_accumulated: data.total_swap_accumulated,
    final_swap_transaction_id: data.final_swap_transaction_id,
    closure_date: data.closure_date,
    net_profit_before_swap: data.net_profit_before_swap,
    net_profit_after_swap: data.net_profit_after_swap
  };
  
  // Log to both application.log and dedicated swap.log
  logger.info('ORDER_CLOSURE_SWAP', logData);
  swapLogger.info('ORDER_CLOSURE_SWAP', logData);
}

/**
 * Log manual swap processing
 */
function logManualSwapProcessing(data) {
  const logData = {
    event_type: 'manual_processing',
    admin_id: data.admin_id,
    target_date: data.target_date,
    orders_processed: data.orders_processed,
    total_swap_applied: data.total_swap_applied,
    processing_time_ms: data.processing_time_ms,
    trigger_reason: data.trigger_reason
  };
  
  // Log to both application.log and dedicated swap.log
  logger.info('MANUAL_SWAP_PROCESSING', logData);
  swapLogger.info('MANUAL_SWAP_PROCESSING', logData);
}

module.exports = {
  logSwapCalculation,
  logSwapApplication,
  logSwapTransaction,
  logDailyProcessingSummary,
  logSwapError,
  logOrderClosureSwap,
  logManualSwapProcessing
};
