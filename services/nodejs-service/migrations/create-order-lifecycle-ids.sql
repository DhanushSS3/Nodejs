-- Migration: Create order_lifecycle_ids table
-- Purpose: Store all lifecycle IDs for orders with complete history tracking
-- Date: 2025-01-23

-- Create the order_lifecycle_ids table
CREATE TABLE IF NOT EXISTS order_lifecycle_ids (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id VARCHAR(64) NOT NULL COMMENT 'Reference to the main order_id',
    id_type ENUM(
        'order_id',
        'close_id',
        'cancel_id',
        'modify_id',
        'stoploss_id',
        'takeprofit_id',
        'stoploss_cancel_id',
        'takeprofit_cancel_id'
    ) NOT NULL COMMENT 'Type of lifecycle ID',
    lifecycle_id VARCHAR(64) NOT NULL UNIQUE COMMENT 'The actual generated ID (e.g., SL123456789)',
    status ENUM('active', 'replaced', 'cancelled', 'executed') DEFAULT 'active' COMMENT 'Current status of this lifecycle ID',
    replaced_by VARCHAR(64) NULL COMMENT 'Points to the new lifecycle_id that replaced this one',
    notes TEXT NULL COMMENT 'Additional notes about this lifecycle ID',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Indexes for performance
    INDEX idx_order_id (order_id),
    INDEX idx_lifecycle_id (lifecycle_id),
    INDEX idx_id_type (id_type),
    INDEX idx_status (status),
    INDEX idx_order_type (order_id, id_type),
    INDEX idx_active_ids (order_id, id_type, status),
    INDEX idx_created_at (created_at),
    
    -- Foreign key constraints (optional - depends on your FK setup)
    -- FOREIGN KEY (order_id) REFERENCES live_user_orders(order_id) ON DELETE CASCADE,
    -- FOREIGN KEY (order_id) REFERENCES demo_user_orders(order_id) ON DELETE CASCADE
    
    COMMENT = 'Stores all lifecycle IDs for orders with complete history'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create indexes separately for better control
CREATE INDEX IF NOT EXISTS idx_order_lifecycle_compound ON order_lifecycle_ids (order_id, id_type, status, created_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_status ON order_lifecycle_ids (lifecycle_id, status);

-- Add comments to columns for documentation
ALTER TABLE order_lifecycle_ids 
MODIFY COLUMN order_id VARCHAR(64) NOT NULL COMMENT 'Main order identifier - links to live_user_orders.order_id or demo_user_orders.order_id',
MODIFY COLUMN id_type ENUM(
    'order_id',
    'close_id', 
    'cancel_id',
    'modify_id',
    'stoploss_id',
    'takeprofit_id',
    'stoploss_cancel_id',
    'takeprofit_cancel_id'
) NOT NULL COMMENT 'Type of lifecycle ID - determines what operation this ID represents',
MODIFY COLUMN lifecycle_id VARCHAR(64) NOT NULL UNIQUE COMMENT 'The actual generated ID from idGenerator service (e.g., SL123456789, TP987654321)',
MODIFY COLUMN status ENUM('active', 'replaced', 'cancelled', 'executed') DEFAULT 'active' COMMENT 'active=current, replaced=superseded by new ID, cancelled=user cancelled, executed=provider executed',
MODIFY COLUMN replaced_by VARCHAR(64) NULL COMMENT 'If status=replaced, this points to the lifecycle_id that replaced this one',
MODIFY COLUMN notes TEXT NULL COMMENT 'Human-readable notes about this ID (e.g., "Stoploss added - price: 1.1950")';

-- Verify table creation
SELECT 
    TABLE_NAME,
    TABLE_COMMENT,
    ENGINE,
    TABLE_COLLATION
FROM information_schema.TABLES 
WHERE TABLE_SCHEMA = DATABASE() 
AND TABLE_NAME = 'order_lifecycle_ids';

-- Show table structure
DESCRIBE order_lifecycle_ids;

-- Show indexes
SHOW INDEX FROM order_lifecycle_ids;
