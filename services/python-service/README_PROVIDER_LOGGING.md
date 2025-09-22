# Provider Logging System

A comprehensive logging solution for the Python provider services with dedicated log files, automatic rotation, and detailed statistics tracking.

## 🎯 Overview

This logging system provides:
- **Separate log files** for each component (dispatcher, workers, errors, etc.)
- **Automatic log rotation** when files reach size limits
- **Comprehensive statistics** tracking and logging
- **Centralized configuration** for easy maintenance
- **Performance monitoring** with timing instrumentation
- **Error isolation** for better debugging

## 📁 Log File Structure

```
services/python-service/logs/provider/
├── dispatcher.log              # Dispatcher routing decisions and stats
├── worker_open.log            # Open worker order processing
├── worker_close.log           # Close worker order processing
├── worker_pending.log         # Pending worker order processing
├── worker_cancel.log          # Cancel worker order processing
├── worker_reject.log          # Reject worker order processing
├── orders_calculated.log      # JSON logs of order calculations
├── provider_errors.log        # Critical errors across all components
├── provider_stats.log         # Component statistics and metrics
├── cleanup.log               # Log cleanup operations
└── *.log.1, *.log.2, etc.   # Rotated backup files
```

## 🔧 Configuration

### Log Rotation Settings

| Component | Max File Size | Backup Count | Total Storage |
|-----------|---------------|--------------|---------------|
| Dispatcher | 100 MB | 15 files | ~1.5 GB |
| Worker Open | 75 MB | 12 files | ~900 MB |
| Worker Close | 75 MB | 12 files | ~900 MB |
| Worker Pending | 50 MB | 10 files | ~500 MB |
| Worker Cancel | 50 MB | 10 files | ~500 MB |
| Worker Reject | 50 MB | 10 files | ~500 MB |
| Orders Calculated | 200 MB | 20 files | ~4 GB |
| Provider Errors | 100 MB | 15 files | ~1.5 GB |

### Environment Variables

```bash
# Log level (DEBUG, INFO, WARNING, ERROR)
LOG_LEVEL=INFO

# Automatic log cleanup (default: false)
AUTO_CLEANUP_LOGS=true

# Log retention period in days (default: 30)
LOG_RETENTION_DAYS=30
```

## 🚀 Usage

### Basic Logging

```python
from app.services.logging.provider_logger import (
    get_dispatcher_logger,
    get_worker_open_logger,
    get_provider_errors_logger
)

# Get dedicated loggers
dispatcher_logger = get_dispatcher_logger()
open_logger = get_worker_open_logger()
error_logger = get_provider_errors_logger()

# Log messages
dispatcher_logger.info("[DISPATCH:SUCCESS] order_id=12345 target_queue=open_queue")
open_logger.info("[OPEN:SUCCESS] order_id=12345 processing_time=125.5ms")
error_logger.error("[OPEN:ERROR] order_id=12345 error=Redis timeout")
```

### Statistics Logging

```python
from app.services.logging.provider_logger import log_provider_stats

# Log component statistics
stats = {
    'messages_processed': 1500,
    'messages_routed': 1485,
    'error_rate': 0.67,
    'uptime_hours': 2.5
}
log_provider_stats('dispatcher', stats)
```

### Calculated Orders Logging

```python
from app.services.logging.provider_logger import get_orders_calculated_logger
import orjson

calc_logger = get_orders_calculated_logger()

order_calc = {
    "type": "ORDER_OPEN_CALC",
    "order_id": "12345",
    "symbol": "EURUSD",
    "final_exec_price": 1.0950,
    "single_margin_usd": 100.0,
    "commission_entry": 2.5
}
calc_logger.info(orjson.dumps(order_calc).decode())
```

## 📊 Log Formats

### Standard Log Format
```
2024-01-15 14:30:25 [INFO] [provider.dispatcher] [DISPATCH:SUCCESS] order_id=12345 redis_status=OPEN ord_status=EXECUTED target_queue=open_queue processing_time=45.25ms
```

### JSON Calculated Orders Format
```json
2024-01-15 14:30:25 {"type":"ORDER_OPEN_CALC","order_id":"12345","user_type":"live","user_id":"67890","symbol":"EURUSD","side":"BUY","final_exec_price":1.095,"single_margin_usd":100.0,"commission_entry":2.5}
```

### Statistics Log Format
```json
2024-01-15 14:30:25 [STATS] {"component":"dispatcher","timestamp":1705329025,"messages_processed":1500,"routing_success_rate":99.0,"uptime_hours":2.5}
```

## 🔍 Log Analysis

### Useful grep Commands

```bash
# Find all errors for a specific order
grep "order_id=12345" logs/provider/provider_errors.log

# Find dispatcher routing decisions
grep "DISPATCH:SUCCESS" logs/provider/dispatcher.log

# Find high processing times (>200ms)
grep -E "processing_time=[2-9][0-9][0-9]\.[0-9]+ms" logs/provider/

# Extract order calculations for analysis
grep "ORDER_OPEN_CALC" logs/provider/orders_calculated.log | jq .

# Monitor error rates
grep "ERROR" logs/provider/provider_errors.log | tail -100
```

### Log Rotation Monitoring

```bash
# Check current log file sizes
ls -lh logs/provider/*.log

# Count rotated files
ls logs/provider/*.log.* | wc -l

# Monitor disk usage
du -sh logs/provider/
```

## 📈 Performance Monitoring

### Key Metrics Logged

**Dispatcher:**
- Messages processed per second
- Routing success rate
- DLQ (Dead Letter Queue) rate
- Average processing time
- Redis error rate

**Workers:**
- Order processing success rate
- Average processing time
- Margin calculation time
- Commission calculation time
- Database publish time

**System:**
- Memory usage
- Uptime
- Error rates
- Queue depths

### Statistics Collection

Statistics are automatically logged every 5-15 minutes depending on the component:

```python
# Example dispatcher stats
{
    "component": "dispatcher",
    "messages_processed": 15000,
    "messages_routed": 14850,
    "messages_dlq": 50,
    "routing_errors": 100,
    "uptime_hours": 24.5,
    "messages_per_second": 0.42,
    "routing_success_rate": 99.0,
    "error_rate": 0.67
}
```

## 🛠 Maintenance

### Log Cleanup

Automatic cleanup can be enabled via environment variables:

```python
from app.services.logging.provider_logger import cleanup_old_logs

# Manual cleanup (removes logs older than 30 days)
cleanup_old_logs(days_to_keep=30)
```

### Health Monitoring

```python
from app.services.logging.provider_logger import get_all_provider_loggers

# Check all logger health
loggers = get_all_provider_loggers()
for name, logger in loggers.items():
    print(f"{name}: {len(logger.handlers)} handlers")
```

### Disk Space Management

Monitor disk usage regularly:

```bash
# Check total log directory size
du -sh logs/provider/

# Find largest log files
find logs/provider/ -name "*.log*" -exec ls -lh {} \; | sort -k5 -hr

# Clean up old rotated files manually if needed
find logs/provider/ -name "*.log.*" -mtime +30 -delete
```

## 🧪 Testing

Run the comprehensive test suite:

```bash
cd services/python-service
python test_provider_logging.py
```

This will test:
- ✅ Basic logging functionality
- ✅ JSON calculated orders logging
- ✅ Error logging
- ✅ Statistics logging
- ✅ High volume logging (rotation)
- ✅ Log directory structure
- ✅ Logger health check
- ✅ Log cleanup functionality

## 🚨 Troubleshooting

### Common Issues

**1. Log files not created:**
```bash
# Check permissions
ls -la logs/provider/
# Ensure directory exists
mkdir -p logs/provider/
```

**2. Rotation not working:**
```python
# Check file sizes
import os
for file in os.listdir('logs/provider/'):
    if file.endswith('.log'):
        size = os.path.getsize(f'logs/provider/{file}')
        print(f"{file}: {size / 1024 / 1024:.2f} MB")
```

**3. High disk usage:**
```bash
# Check for runaway logs
find logs/provider/ -name "*.log" -size +500M

# Reduce retention or file sizes in provider_logger.py
```

### Debug Mode

Enable debug logging for troubleshooting:

```bash
export LOG_LEVEL=DEBUG
```

## 📋 Integration Checklist

When integrating with existing services:

- [ ] Import provider logger functions
- [ ] Replace existing logger instances
- [ ] Add statistics tracking
- [ ] Update error handling to use error logger
- [ ] Add timing instrumentation
- [ ] Configure log rotation settings
- [ ] Set up monitoring alerts
- [ ] Test log rotation
- [ ] Verify disk space requirements
- [ ] Document component-specific log patterns

## 🔗 Related Files

- `app/services/logging/provider_logger.py` - Main logging configuration
- `app/services/provider/dispatcher.py` - Dispatcher with logging
- `app/services/provider/worker_open.py` - Open worker with logging
- `app/services/provider/worker_close.py` - Close worker with logging
- `test_provider_logging.py` - Test suite

## 📞 Support

For issues or questions about the logging system:
1. Check the test output for health status
2. Review log file permissions and disk space
3. Verify environment variable configuration
4. Check for any import errors in the application logs
