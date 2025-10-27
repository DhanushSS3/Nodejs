# 🔍 Production Debugging Guide - Price Mismatch Issues

## 🚨 **When Price Mismatch Happens Again**

### **Step 1: Immediate Diagnosis (2 minutes)**

**Check health endpoints:**
```bash
# Quick health check
curl -X GET http://localhost:3000/api/debug/python-health

# Comprehensive diagnostics
curl -X GET http://localhost:8000/api/debug/comprehensive
```

**Key indicators to look for:**
- ❌ `"connected": false` → Redis cluster issue
- ❌ `"is_running": false` → WebSocket listener down
- ❌ `"missing_data_symbols": [...]` → Stale market data
- ❌ `"freshness_rate": < 50` → Data staleness issue

### **Step 2: Detailed Analysis (5 minutes)**

**Redis Cluster Diagnostics:**
```bash
curl -X GET http://localhost:8000/api/debug/redis-cluster
```

**WebSocket Diagnostics:**
```bash
curl -X GET http://localhost:8000/api/debug/websocket
```

**Market Data Analysis:**
```bash
curl -X GET http://localhost:8000/api/debug/market-data
```

### **Step 3: Root Cause Identification**

| **Symptom** | **Root Cause** | **Action** |
|-------------|----------------|------------|
| `"ping_success": false` | Redis cluster unreachable | Check Redis containers |
| `"connection_failures" > 5` | WebSocket server issues | Check network/DNS |
| `"parse_error_rate" > 10%` | Message format changed | Check WebSocket protocol |
| `"fresh_symbols": 0` | No recent market data | Check both listeners |
| `"success_rate" < 80%` | Frequent disconnections | Check ping/network |

## 📊 **Enhanced Health Endpoints**

### **New Diagnostic Endpoints:**

1. **`GET /api/debug/comprehensive`**
   - Complete system overview
   - All diagnostics in one call
   - Perfect for emergency debugging

2. **`GET /api/debug/redis-cluster`**
   - Redis cluster state
   - Individual node health
   - Connection pool stats
   - Performance metrics

3. **`GET /api/debug/websocket`**
   - Connection status & history
   - Success rates & failure analysis
   - Performance metrics
   - Error categorization

4. **`GET /api/debug/market-data`**
   - Symbol-by-symbol analysis
   - Data freshness rates
   - Price consistency checks
   - Redis key patterns

### **Production Monitoring Queries:**

**Monitor Redis Health:**
```bash
# Every 30 seconds
curl -s http://localhost:8000/api/debug/redis-cluster | jq '.cluster_health.cluster_state'
```

**Monitor WebSocket Stability:**
```bash
# Every minute
curl -s http://localhost:8000/api/debug/websocket | jq '.connection_history.success_rate'
```

**Monitor Market Data Freshness:**
```bash
# Every 2 minutes
curl -s http://localhost:8000/api/debug/market-data | jq '.data_freshness.freshness_rate'
```

## 🔧 **Production-Ready Startup Process**

### **Enhanced Python Service Startup:**

**Features Added:**
- ✅ **Prerequisites validation** before startup
- ✅ **Comprehensive error handling** for each service
- ✅ **Background health monitoring** every 5 minutes
- ✅ **Graceful shutdown** with 10-second timeouts
- ✅ **Service status tracking** and restart capabilities

**Startup Logs to Watch:**
```bash
# Successful startup should show:
🚀 Starting Python Market Service...
🔍 Validating startup prerequisites...
✅ Redis cluster connectivity: OK
✅ Environment variables: OK
✅ Memory usage: 45.2%
📊 Prerequisites validation: 100.0% passed
✅ Binary market listener started
✅ JSON market listener started
✅ Portfolio calculator listener started
✅ Provider connection manager started
✅ Provider pending monitor started
✅ AutoCutoff watcher started
✅ Health monitor started
🎯 Startup complete! Running 7 background services
```

**Error Indicators:**
```bash
# Watch for these error patterns:
❌ Redis cluster connectivity: FAILED
❌ Critical error starting market listeners
🚨 CRITICAL: Redis cluster is not responding!
🚨 CRITICAL: No fresh market data available!
```

### **Enhanced Node.js Service:**

**Current Status:** ✅ Already production-ready
- Comprehensive error handling
- Request logging and monitoring
- Health endpoints for Python service integration
- Timeout handling (30 seconds)

## 🚨 **Emergency Response Procedures**

### **Scenario 1: Redis Cluster Down**
```bash
# 1. Check container status
docker ps --filter name=redis-node

# 2. Check logs
docker logs redis-node-1

# 3. Restart if needed
docker-compose restart redis-node-1 redis-node-2 redis-node-3

# 4. Verify cluster state
curl -s http://localhost:8000/api/debug/redis-cluster | jq '.cluster_health'
```

### **Scenario 2: WebSocket Listeners Down**
```bash
# 1. Check listener status
curl -s http://localhost:8000/api/debug/websocket | jq '.connection_status.is_running'

# 2. Check connection history
curl -s http://localhost:8000/api/debug/websocket | jq '.connection_history'

# 3. If needed, restart Python service
# (Service will auto-restart listeners)
```

### **Scenario 3: Stale Market Data**
```bash
# 1. Check data freshness
curl -s http://localhost:8000/api/debug/market-data | jq '.data_freshness'

# 2. Check individual symbols
curl -s http://localhost:8000/api/debug/market-data | jq '.symbol_analysis'

# 3. Trigger warmup if available
python -c "
import asyncio
from services.python-service.app.market_data_warmup import warmup_after_reconnection
asyncio.run(warmup_after_reconnection())
"
```

## 📈 **Monitoring & Alerting Setup**

### **Key Metrics to Monitor:**

1. **Redis Cluster Health**
   - `cluster_state` should be "ok"
   - `ping_time_ms` should be < 100ms
   - `ping_success` should be true

2. **WebSocket Connection Stability**
   - `success_rate` should be > 95%
   - `connection_failures` should be < 5/hour
   - `last_message_age` should be < 30 seconds

3. **Market Data Freshness**
   - `freshness_rate` should be > 80%
   - `missing_symbols` should be 0
   - `stale_symbols` should be < 2

4. **System Resources**
   - Memory usage < 80%
   - CPU usage < 70%
   - Connection count reasonable

### **Automated Monitoring Script:**

```bash
#!/bin/bash
# monitor_production.sh

while true; do
    echo "=== $(date) ==="
    
    # Check Redis
    REDIS_STATE=$(curl -s http://localhost:8000/api/debug/redis-cluster | jq -r '.cluster_health.cluster_state // "error"')
    echo "Redis: $REDIS_STATE"
    
    # Check WebSocket
    WS_RUNNING=$(curl -s http://localhost:8000/api/debug/websocket | jq -r '.connection_status.is_running // false')
    echo "WebSocket: $WS_RUNNING"
    
    # Check Market Data
    FRESHNESS=$(curl -s http://localhost:8000/api/debug/market-data | jq -r '.data_freshness.freshness_rate // 0')
    echo "Data Freshness: ${FRESHNESS}%"
    
    # Alert on issues
    if [[ "$REDIS_STATE" != "ok" ]]; then
        echo "🚨 ALERT: Redis cluster unhealthy!"
    fi
    
    if [[ "$WS_RUNNING" != "true" ]]; then
        echo "🚨 ALERT: WebSocket listener down!"
    fi
    
    if (( $(echo "$FRESHNESS < 50" | bc -l) )); then
        echo "🚨 ALERT: Stale market data!"
    fi
    
    sleep 60  # Check every minute
done
```

## 🔍 **Log Analysis**

### **Important Log Patterns:**

**Success Patterns:**
```bash
# WebSocket connection stability
grep "📈 Received.*messages, connection stable" logs/

# Health monitor success
grep "💊 Health Check - Redis: ✅" logs/

# Market data warmup
grep "✅ Market data warmup successful" logs/
```

**Error Patterns:**
```bash
# Connection issues
grep "🔌 WebSocket connection closed" logs/

# Redis issues
grep "🚨 CRITICAL: Redis cluster" logs/

# Parse errors
grep "❌ Message processing error" logs/
```

### **Log Retention:**
- Keep detailed logs for 7 days
- Archive summary logs for 30 days
- Monitor log file sizes

## 🎯 **Performance Benchmarks**

### **Expected Performance:**
- **WebSocket Connection Uptime**: > 99%
- **Redis Response Time**: < 10ms
- **Market Data Freshness**: > 95%
- **Message Processing Rate**: > 100 msg/sec
- **Memory Usage**: < 512MB per service

### **Performance Degradation Indicators:**
- Connection success rate < 95%
- Redis ping time > 50ms
- Parse error rate > 5%
- Memory usage > 1GB
- CPU usage > 80%

---

**This comprehensive debugging guide ensures you can quickly identify and resolve price mismatch issues in production!** 🎯
