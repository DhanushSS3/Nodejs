# 🚀 Production Health Monitoring Access Guide

## 🔗 **All Health Endpoints via Node.js (Admin Auth Required)**

### **🎯 Core Health Endpoints:**

**1. Comprehensive System Health**
```bash
GET /api/python-health/debug/comprehensive
Authorization: Bearer <admin_token>
```
- Complete system diagnostics
- Redis cluster health
- WebSocket performance
- Market data freshness
- System resources

**2. Redis Cluster Diagnostics**
```bash
GET /api/python-health/debug/redis-cluster  
Authorization: Bearer <admin_token>
```
- Connection pool utilization
- Cluster node health
- Performance metrics
- Connection details

**3. WebSocket to Redis Flow Analysis**
```bash
GET /api/python-health/debug/websocket-to-redis
Authorization: Bearer <admin_token>
```
- Data flow verification
- Processing statistics
- Bottleneck identification

**4. WebSocket Listener Configuration** ⭐ **NEW**
```bash
GET /api/python-health/listener-status
Authorization: Bearer <admin_token>
```
- Current listener type (binary/json)
- Performance comparison
- Bottleneck analysis
- Configuration recommendations

---

## 🔐 **Authentication Requirements**

### **Access Levels:**
- **Admin Authentication**: Required for all endpoints
- **Superadmin Role**: Required for debug endpoints
- **Production Server**: Node.js port 3000 (not Python port 8000)

### **Example Authentication:**
```bash
# Get admin token first
curl -X POST "http://localhost:3000/api/auth/admin/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your_password"}'

# Use token in subsequent requests
export ADMIN_TOKEN="your_jwt_token_here"

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/debug/comprehensive"
```

---

## 📊 **Production Monitoring Commands**

### **Quick Health Check:**
```bash
# Check overall system health
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/status" | jq '.data.status'

# Check connection pool utilization
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/debug/redis-cluster" | \
  jq '.data.connection_pool.utilization_percent'

# Check WebSocket listener type
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/listener-status" | \
  jq '.data.current_listener'
```

### **Market Data Freshness:**
```bash
# Check market data freshness rate
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/market-data" | \
  jq '.data.freshness_rate'

# Check individual symbol freshness
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/debug/comprehensive" | \
  jq '.data.market_data_diagnostics.symbol_analysis'
```

### **Performance Monitoring:**
```bash
# Check system resources
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/debug/comprehensive" | \
  jq '.data.system_info'

# Check WebSocket performance
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/websocket/status" | \
  jq '.data.performance'
```

---

## 🚨 **Production Alert Thresholds**

### **Critical Alerts (Immediate Action):**
```bash
# Connection pool exhaustion (> 80%)
UTILIZATION=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/debug/redis-cluster" | \
  jq -r '.data.connection_pool.utilization_percent')

if (( $(echo "$UTILIZATION > 80" | bc -l) )); then
  echo "🚨 CRITICAL: Connection pool utilization: ${UTILIZATION}%"
fi

# Market data staleness (< 80%)
FRESHNESS=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/market-data" | \
  jq -r '.data.freshness_rate')

if (( $(echo "$FRESHNESS < 80" | bc -l) )); then
  echo "🚨 CRITICAL: Market data freshness: ${FRESHNESS}%"
fi
```

### **Warning Alerts (Monitor Closely):**
```bash
# High response times (> 50ms)
RESPONSE_TIME=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/python-health/debug/redis-cluster" | \
  jq -r '.data.connection_pool.avg_response_time_ms')

if (( $(echo "$RESPONSE_TIME > 50" | bc -l) )); then
  echo "⚠️ WARNING: High Redis response time: ${RESPONSE_TIME}ms"
fi
```

---

## 🔄 **Production Monitoring Script**

```bash
#!/bin/bash
# production_health_monitor.sh

# Configuration
NODEJS_URL="http://localhost:3000"
ADMIN_TOKEN="your_admin_token_here"

# Function to make authenticated requests
api_call() {
    curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$NODEJS_URL$1"
}

# Function to check critical metrics
check_critical_metrics() {
    echo "🔍 Checking Critical Production Metrics..."
    echo "============================================"
    
    # Connection Pool Health
    POOL_DATA=$(api_call "/api/python-health/debug/redis-cluster")
    UTILIZATION=$(echo $POOL_DATA | jq -r '.data.connection_pool.utilization_percent // 0')
    RESPONSE_TIME=$(echo $POOL_DATA | jq -r '.data.connection_pool.avg_response_time_ms // 0')
    
    echo "📊 Connection Pool:"
    echo "   Utilization: ${UTILIZATION}%"
    echo "   Response Time: ${RESPONSE_TIME}ms"
    
    # Market Data Health
    MARKET_DATA=$(api_call "/api/python-health/market-data")
    FRESHNESS=$(echo $MARKET_DATA | jq -r '.data.freshness_rate // 0')
    
    echo "📈 Market Data:"
    echo "   Freshness Rate: ${FRESHNESS}%"
    
    # WebSocket Listener
    LISTENER_DATA=$(api_call "/api/python-health/listener-status")
    LISTENER_TYPE=$(echo $LISTENER_DATA | jq -r '.data.current_listener // "unknown"')
    
    echo "📡 WebSocket Listener:"
    echo "   Type: ${LISTENER_TYPE}"
    
    # System Health
    SYSTEM_DATA=$(api_call "/api/python-health/debug/comprehensive")
    CPU_USAGE=$(echo $SYSTEM_DATA | jq -r '.data.system_info.cpu_percent // 0')
    MEMORY_USAGE=$(echo $SYSTEM_DATA | jq -r '.data.system_info.memory_info.percent // 0')
    
    echo "💻 System Resources:"
    echo "   CPU Usage: ${CPU_USAGE}%"
    echo "   Memory Usage: ${MEMORY_USAGE}%"
    
    echo "============================================"
    
    # Alert Logic
    if (( $(echo "$UTILIZATION > 80" | bc -l) )); then
        echo "🚨 ALERT: High connection pool utilization!"
    fi
    
    if (( $(echo "$FRESHNESS < 80" | bc -l) )); then
        echo "🚨 ALERT: Low market data freshness!"
    fi
    
    if [ "$LISTENER_TYPE" != "binary" ]; then
        echo "⚠️ WARNING: Not using optimal binary listener!"
    fi
    
    if (( $(echo "$RESPONSE_TIME > 50" | bc -l) )); then
        echo "⚠️ WARNING: High Redis response times!"
    fi
}

# Main execution
echo "🚀 Production Health Monitor - $(date)"
check_critical_metrics
echo
```

---

## 📋 **Complete Endpoint Reference**

| **Endpoint** | **Purpose** | **Auth Level** |
|-------------|-------------|----------------|
| `/api/python-health/status` | Overall health | Admin |
| `/api/python-health/market-data` | Market data health | Admin |
| `/api/python-health/websocket/status` | WebSocket performance | Admin |
| `/api/python-health/debug/comprehensive` | Complete diagnostics | Superadmin |
| `/api/python-health/debug/redis-cluster` | Connection pool analysis | Superadmin |
| `/api/python-health/debug/websocket-to-redis` | Data flow debugging | Superadmin |
| `/api/python-health/listener-status` | Listener configuration | Superadmin |

---

## 🎯 **Production Deployment Checklist**

### **Before Deployment:**
- [ ] Set `USE_BINARY_LISTENER=true` in environment
- [ ] Configure admin authentication tokens
- [ ] Test all health endpoints via Node.js
- [ ] Set up monitoring script with proper tokens

### **After Deployment:**
- [ ] Verify single WebSocket listener running
- [ ] Check connection pool utilization < 40%
- [ ] Confirm market data freshness > 95%
- [ ] Test all health endpoints accessibility
- [ ] Set up automated monitoring alerts

### **Ongoing Monitoring:**
- [ ] Connection pool utilization trends
- [ ] Market data freshness rates
- [ ] WebSocket listener performance
- [ ] System resource usage patterns

---

**All health monitoring is now accessible via Node.js with proper admin authentication for production deployment!** 🎉
