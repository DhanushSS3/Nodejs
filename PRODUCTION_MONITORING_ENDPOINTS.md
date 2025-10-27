# 🔍 Production Monitoring Endpoints

## 🚀 **Connection Pool & Performance Monitoring**

### **Enhanced Connection Pool Diagnostics**

The Redis connection pool monitoring now includes:

**Key Metrics:**
- `active_connections` - Number of active Redis connections
- `utilization_percent` - Connection pool utilization (should be < 80%)
- `connection_success_rate` - Success rate of connection tests (should be > 95%)
- `avg_response_time_ms` - Average Redis response time (should be < 50ms)

**Connection Pool Health Indicators:**
```json
{
  "connection_pool": {
    "active_connections": 12,
    "utilization_percent": 24.0,
    "connection_success_rate": 100.0,
    "avg_response_time_ms": 3.2,
    "connection_tests": [
      {
        "symbol": "EURUSD",
        "success": true,
        "response_time_ms": 2.1,
        "data_found": true
      }
    ]
  }
}
```

**🚨 Alert Thresholds:**
- **Connection Pool Exhaustion**: `utilization_percent > 80%`
- **Slow Response**: `avg_response_time_ms > 100ms`
- **Connection Failures**: `connection_success_rate < 95%`

---

## 🔗 **Production Access via Node.js (Admin Auth Required)**

### **New Debug Endpoints:**

**1. Comprehensive Debug Information**
```bash
GET /api/python-health/debug/comprehensive
Authorization: Bearer <admin_token>
```

**2. Redis Cluster Diagnostics**
```bash
GET /api/python-health/debug/redis-cluster
Authorization: Bearer <admin_token>
```

**3. WebSocket to Redis Flow Analysis**
```bash
GET /api/python-health/debug/websocket-to-redis
Authorization: Bearer <admin_token>
```

### **Authentication Requirements:**
- **Admin Authentication**: Required for all endpoints
- **Superadmin Role**: Required for debug endpoints
- **Production Access**: Via Node.js service (port 3000) not Python service (port 8000)

---

## 📊 **Connection Pool Monitoring Script**

```bash
#!/bin/bash
# production_monitor.sh

# Function to check connection pool health
check_connection_pool() {
    echo "🔴 Checking Redis Connection Pool..."
    
    RESPONSE=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
        "http://localhost:3000/api/python-health/debug/redis-cluster")
    
    UTILIZATION=$(echo $RESPONSE | jq -r '.data.connection_pool.utilization_percent // 0')
    SUCCESS_RATE=$(echo $RESPONSE | jq -r '.data.connection_pool.connection_success_rate // 0')
    RESPONSE_TIME=$(echo $RESPONSE | jq -r '.data.connection_pool.avg_response_time_ms // 0')
    
    echo "   Utilization: ${UTILIZATION}%"
    echo "   Success Rate: ${SUCCESS_RATE}%"
    echo "   Avg Response: ${RESPONSE_TIME}ms"
    
    # Alert conditions
    if (( $(echo "$UTILIZATION > 80" | bc -l) )); then
        echo "🚨 ALERT: High connection pool utilization!"
    fi
    
    if (( $(echo "$SUCCESS_RATE < 95" | bc -l) )); then
        echo "🚨 ALERT: Low connection success rate!"
    fi
    
    if (( $(echo "$RESPONSE_TIME > 100" | bc -l) )); then
        echo "🚨 ALERT: Slow Redis response times!"
    fi
}

# Function to check market data freshness
check_market_data() {
    echo "📊 Checking Market Data Freshness..."
    
    RESPONSE=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
        "http://localhost:3000/api/python-health/debug/comprehensive")
    
    FRESHNESS=$(echo $RESPONSE | jq -r '.data.market_data_diagnostics.data_freshness.freshness_rate // 0')
    FRESH_SYMBOLS=$(echo $RESPONSE | jq -r '.data.market_data_diagnostics.data_freshness.fresh_symbols // 0')
    
    echo "   Freshness Rate: ${FRESHNESS}%"
    echo "   Fresh Symbols: ${FRESH_SYMBOLS}"
    
    if (( $(echo "$FRESHNESS < 80" | bc -l) )); then
        echo "🚨 ALERT: Low market data freshness!"
    fi
}

# Function to check WebSocket health
check_websocket() {
    echo "📡 Checking WebSocket Health..."
    
    RESPONSE=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
        "http://localhost:3000/api/python-health/debug/websocket-to-redis")
    
    WS_RUNNING=$(echo $RESPONSE | jq -r '.data.websocket_status.is_running // false')
    MESSAGES=$(echo $RESPONSE | jq -r '.data.websocket_status.messages_processed // 0')
    
    echo "   WebSocket Running: $WS_RUNNING"
    echo "   Messages Processed: $MESSAGES"
    
    if [ "$WS_RUNNING" != "true" ]; then
        echo "🚨 ALERT: WebSocket listener is down!"
    fi
}

# Main monitoring loop
main() {
    echo "=== Production Health Monitor ==="
    echo "Timestamp: $(date)"
    echo
    
    check_connection_pool
    echo
    check_market_data
    echo
    check_websocket
    echo
    echo "================================="
}

# Set your admin token
export ADMIN_TOKEN="your_admin_token_here"

# Run monitoring
main
```

---

## 🎯 **Key Production Metrics to Monitor**

### **Critical Metrics:**
1. **Connection Pool Utilization** < 80%
2. **Market Data Freshness** > 95%
3. **WebSocket Uptime** > 99%
4. **Redis Response Time** < 50ms
5. **Connection Success Rate** > 95%

### **Warning Metrics:**
1. **Memory Usage** < 512MB
2. **CPU Usage** < 70%
3. **Active Connections** < 40
4. **Parse Error Rate** < 1%

### **System Health Indicators:**
```json
{
  "system_health": "healthy",
  "connection_pool_utilization": "24%",
  "market_data_freshness": "100%",
  "websocket_uptime": "99.9%",
  "redis_response_time": "3.2ms",
  "last_updated": "2025-10-27T12:00:00Z"
}
```

---

## 🚨 **Alert Configuration**

### **Critical Alerts (Immediate Action Required):**
- Connection pool utilization > 90%
- Market data freshness < 50%
- WebSocket listener down
- Redis cluster unreachable

### **Warning Alerts (Monitor Closely):**
- Connection pool utilization > 80%
- Market data freshness < 80%
- Redis response time > 100ms
- Connection success rate < 95%

### **Monitoring Frequency:**
- **Connection Pool**: Every 30 seconds
- **Market Data**: Every 60 seconds  
- **WebSocket Health**: Every 30 seconds
- **System Resources**: Every 5 minutes

---

**With these enhanced monitoring capabilities, you can proactively detect and resolve connection pool exhaustion and other performance issues before they impact users!** 🎯
