# Comprehensive Order Rejection Handling System

## Overview

This implementation provides a complete rejection handling system that tracks and manages all types of order operation rejections from the provider. The system differentiates between various rejection types and handles them appropriately based on the Redis status when the rejection occurred.

## Architecture Components

### 1. Database Schema (Node.js)

**Migration**: `services/nodejs-service/src/migrations/20250923-create-order-rejections.js`
**Model**: `services/nodejs-service/src/models/orderRejection.model.js`

**Table**: `order_rejections`
- Stores comprehensive rejection records for all order operation types
- Tracks provider rejection details, reasons, and context
- Supports 9 different rejection types based on Redis status

**Rejection Types**:
- `ORDER_PLACEMENT`: Order placement rejected (status=OPEN)
- `ORDER_CLOSE`: Order close rejected (status=CLOSED)
- `PENDING_PLACEMENT`: Pending order placement rejected (status=PENDING)
- `PENDING_MODIFY`: Pending order modify rejected (status=MODIFY)
- `PENDING_CANCEL`: Pending order cancel rejected (status=CANCELLED)
- `STOPLOSS_ADD`: Stop loss adding rejected (status=STOPLOSS)
- `STOPLOSS_REMOVE`: Stop loss removal rejected (status=STOPLOSS-CANCEL)
- `TAKEPROFIT_ADD`: Take profit adding rejected (status=TAKEPROFIT)
- `TAKEPROFIT_REMOVE`: Take profit removal rejected (status=TAKEPROFIT-CANCEL)

### 2. Enhanced Dispatcher (Python)

**File**: `services/python-service/app/services/provider/dispatcher.py`

**Key Changes**:
- Routes ALL orders with `ord_status == "REJECTED"` to the reject worker
- Simplified routing logic - no longer needs to check Redis status for rejections
- Comprehensive logging for rejection routing decisions

### 3. Enhanced Reject Worker (Python)

**File**: `services/python-service/app/services/provider/worker_reject.py`

**Key Features**:
- **Intelligent Rejection Type Detection**: Determines rejection type based on Redis status
- **Differential Handling**: 
  - Order placement rejections: Update Redis, release margin, emit DB updates
  - Non-placement rejections: Log only, no Redis updates needed
- **Comprehensive Logging**: Detailed logging with performance statistics
- **Rejection Record Creation**: Creates detailed rejection records for database storage
- **WebSocket Notifications**: Emits events for real-time UI updates

**Processing Logic**:
1. Determine rejection type from Redis status
2. Handle placement rejections (update Redis, release margin)
3. Handle non-placement rejections (log only)
4. Create comprehensive rejection record
5. Emit appropriate database update messages
6. Send WebSocket notifications

### 4. Enhanced DB Consumer (Node.js)

**File**: `services/nodejs-service/src/services/rabbitmq/orders.db.consumer.js`

**Key Features**:
- **Message Routing**: Routes `ORDER_REJECTION_RECORD` messages to dedicated handler
- **Rejection Record Creation**: Inserts rejection records into `order_rejections` table
- **WebSocket Events**: Emits `order_rejection_created` events for real-time notifications
- **Error Handling**: Comprehensive error handling and logging

### 5. Enhanced Portfolio WebSocket (Node.js)

**File**: `services/nodejs-service/src/services/ws/portfolio.ws.js`

**Key Features**:
- **Real-time Rejection Notifications**: Handles `order_rejection_created` events
- **Forced DB Refresh**: Refreshes rejected orders immediately when rejection events occur
- **Backward Compatibility**: Maintains existing rejected orders support

## Data Flow

### Order Placement Rejection Flow
```
Provider → Dispatcher → Reject Worker → DB Consumer → WebSocket
                    ↓
                Redis Updates (status=REJECTED, release margin)
                    ↓
                Rejection Record Creation
                    ↓
                ORDER_REJECTED + ORDER_REJECTION_RECORD messages
```

### Non-Placement Rejection Flow
```
Provider → Dispatcher → Reject Worker → DB Consumer → WebSocket
                    ↓
                Log Only (no Redis updates)
                    ↓
                Rejection Record Creation
                    ↓
                ORDER_REJECTION_RECORD message only
```

## Message Types

### ORDER_REJECTION_RECORD
```json
{
  "type": "ORDER_REJECTION_RECORD",
  "canonical_order_id": "order_123",
  "provider_order_id": "provider_456",
  "user_id": 12345,
  "user_type": "live",
  "symbol": "EURUSD",
  "rejection_type": "ORDER_PLACEMENT",
  "redis_status": "OPEN",
  "provider_ord_status": "REJECTED",
  "reason": "Insufficient margin",
  "provider_exec_id": "exec_789",
  "provider_raw_data": {...},
  "order_type": "BUY",
  "order_price": 1.1234,
  "order_quantity": 1.0,
  "margin_released": 100.00
}
```

### ORDER_REJECTED (for placement rejections only)
```json
{
  "type": "ORDER_REJECTED",
  "order_id": "order_123",
  "user_id": "12345",
  "user_type": "live",
  "order_status": "REJECTED",
  "provider": {
    "exec_id": "exec_789",
    "reason": "Insufficient margin",
    "ord_status": "REJECTED"
  }
}
```

## WebSocket Events

### order_rejection_created
```json
{
  "type": "order_rejection_created",
  "canonical_order_id": "order_123",
  "rejection_type": "ORDER_PLACEMENT",
  "reason": "Insufficient margin",
  "symbol": "EURUSD"
}
```

## Performance Characteristics

### Statistics Tracking
- **Processed Count**: Total rejections processed
- **Success Count**: Successfully handled rejections
- **Failure Count**: Failed rejection processing
- **Placement Rejects**: Order placement rejections (require margin updates)
- **Non-Placement Rejects**: Other rejection types (no margin updates)
- **Margin Updates**: Number of margin recalculations performed

### Logging
- **Dedicated Log File**: `logs/provider/worker_reject.log`
- **Performance Statistics**: Logged every 100 orders or 5 minutes
- **Comprehensive Error Logging**: Full stack traces and context
- **Processing Time Tracking**: End-to-end timing instrumentation

## Error Handling

### Idempotency
- **Provider Idempotency**: Prevents duplicate processing of same provider rejection
- **Database Idempotency**: Prevents duplicate rejection records

### Concurrency Control
- **User-Level Locking**: Only for placement rejections requiring margin updates
- **Non-blocking**: Non-placement rejections don't require locks
- **Redis Connection Pool**: 200 connections support high concurrency

### Fallback Mechanisms
- **Redis Fallback**: Falls back to user holdings if order_data missing
- **Default Status**: Uses "OPEN" as fallback if Redis status unavailable
- **Error Recovery**: Comprehensive retry logic with exponential backoff

## Integration Points

### Existing Systems
- **Portfolio WebSocket**: Real-time rejection notifications
- **Margin Calculation**: Automatic margin recalculation for placement rejections
- **Symbol Holders**: Cleanup when no remaining orders for symbol
- **Audit Logging**: Comprehensive audit trail for all rejections

### Future Extensibility
- **New Rejection Types**: Easy to add new rejection types by updating enum
- **Custom Handling**: Rejection type-specific processing logic
- **Enhanced Notifications**: Rich notification payloads with full context

## Deployment Considerations

### Database Migration
```bash
# Run the migration to create order_rejections table
npx sequelize-cli db:migrate
```

### Environment Variables
- All existing environment variables remain unchanged
- Uses existing RabbitMQ and Redis configurations

### Monitoring
- **Log Analysis**: Use rejection logs for operational insights
- **Performance Metrics**: Track rejection rates and processing times
- **Error Alerting**: Monitor failure rates and error patterns

## Benefits

### Operational Visibility
- **Complete Rejection Tracking**: All rejection types tracked and stored
- **Real-time Notifications**: Immediate WebSocket updates for rejections
- **Comprehensive Audit Trail**: Full provider rejection history

### System Reliability
- **Proper Margin Management**: Automatic margin release for placement rejections
- **Consistent State**: Redis and database state consistency maintained
- **Error Recovery**: Robust error handling and retry mechanisms

### User Experience
- **Real-time Updates**: Users see rejection notifications immediately
- **Detailed Information**: Rich rejection context including reasons and types
- **Historical Tracking**: Complete rejection history available

## Testing Strategy

### Unit Tests
- Test rejection type determination logic
- Test margin calculation and release
- Test message routing and handling

### Integration Tests
- Test end-to-end rejection flow
- Test WebSocket notification delivery
- Test database record creation

### Performance Tests
- Test high-volume rejection processing
- Test concurrent rejection handling
- Test memory and CPU usage under load

This comprehensive rejection handling system provides enterprise-grade tracking and management of all order operation rejections, ensuring complete operational visibility and proper system state management.
