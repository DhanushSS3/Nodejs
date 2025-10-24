from fastapi import APIRouter, HTTPException
from typing import Dict, Any
import time
import asyncio
from ..services.market_data_service import MarketDataService
from ..protobuf_market_listener import binary_market_listener

router = APIRouter()

@router.get("/health/")
async def get_health_status() -> Dict[str, Any]:
    """Get comprehensive Python service health status"""
    try:
        # Get market data service instance
        market_service = MarketDataService()
        
        # Get listener status
        listener_status = await binary_market_listener.get_connection_status()
        
        # Check Redis connectivity
        redis_healthy = True
        try:
            await market_service.redis_cluster.ping()
        except Exception:
            redis_healthy = False
        
        # Determine overall status
        overall_status = "healthy"
        issues = []
        
        if not listener_status["is_running"]:
            overall_status = "unhealthy"
            issues.append("WebSocket listener not running")
        
        if not redis_healthy:
            overall_status = "unhealthy"
            issues.append("Redis cluster not accessible")
        
        if listener_status["performance"]["parse_errors"] > 10:
            overall_status = "degraded"
            issues.append("High parse error rate")
        
        return {
            "status": overall_status,
            "timestamp": int(time.time()),
            "components": {
                "redis_cluster": {
                    "status": "healthy" if redis_healthy else "unhealthy",
                    "connected": redis_healthy
                },
                "websocket_listener": {
                    "status": "healthy" if listener_status["is_running"] else "unhealthy",
                    "is_running": listener_status["is_running"],
                    "protocol": listener_status.get("protocol", "unknown"),
                    "ws_url": listener_status.get("ws_url", "unknown")
                },
                "market_data": {
                    "status": "healthy" if redis_healthy and listener_status["is_running"] else "degraded"
                }
            },
            "issues": issues,
            "performance": listener_status["performance"]
        }
        
    except Exception as e:
        return {
            "status": "unhealthy",
            "timestamp": int(time.time()),
            "error": str(e),
            "issues": ["Failed to retrieve health status"]
        }

@router.get("/health/market-data")
async def get_market_data_health() -> Dict[str, Any]:
    """Get detailed market data health check"""
    try:
        market_service = MarketDataService()
        
        # Get symbols that are actually being sent by the WebSocket
        test_symbols = ["GBPSEK", "USDSEK", "EURSEK", "EURUSD", "GBPUSD"]
        stale_symbols = []
        missing_symbols = []
        inconsistent_symbols = []
        
        staleness_threshold_ms = 10000  # 10 seconds
        current_time = int(time.time() * 1000)
        
        for symbol in test_symbols:
            try:
                # Get price data from Redis using the correct method
                price_data = await market_service.get_symbol_price(symbol)
                
                if not price_data:
                    missing_symbols.append(symbol)
                    continue
                
                # Check staleness
                timestamp = price_data.get('ts', 0)
                if current_time - timestamp > staleness_threshold_ms:
                    stale_symbols.append({
                        "symbol": symbol,
                        "age_ms": current_time - timestamp
                    })
                
                # Check price consistency
                ask = float(price_data.get('ask', 0))  # buy price
                bid = float(price_data.get('bid', 0))  # sell price
                
                if ask > 0 and bid > 0 and bid > ask:
                    inconsistent_symbols.append({
                        "symbol": symbol,
                        "ask": ask,
                        "bid": bid,
                        "issue": "bid > ask (should be bid < ask)"
                    })
                    
            except Exception as e:
                missing_symbols.append(f"{symbol} (error: {str(e)})")
        
        status = "healthy"
        if len(stale_symbols) > 2:
            status = "degraded"
        if len(missing_symbols) > 1 or len(inconsistent_symbols) > 0:
            status = "unhealthy"
        
        return {
            "status": status,
            "timestamp": int(time.time()),
            "total_symbols": len(test_symbols),
            "stale_symbols_count": len(stale_symbols),
            "stale_symbols": stale_symbols,
            "inconsistent_symbols_count": len(inconsistent_symbols),
            "inconsistent_symbols": inconsistent_symbols,
            "missing_data_symbols_count": len(missing_symbols),
            "missing_data_symbols": missing_symbols,
            "staleness_threshold_ms": staleness_threshold_ms
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Market data health check failed: {str(e)}")

@router.get("/health/execution-prices")
async def get_execution_price_health() -> Dict[str, Any]:
    """Get execution price calculation health check"""
    try:
        market_service = MarketDataService()
        
        # Test execution price calculation for different user types
        test_cases = [
            {"symbol": "EURUSD", "user_type": "rock", "group_id": 1},
            {"symbol": "GBPUSD", "user_type": "demo", "group_id": 2},
            {"symbol": "USDJPY", "user_type": "live", "group_id": 1}
        ]
        
        successful_tests = 0
        failed_symbols = []
        
        for test_case in test_cases:
            try:
                # Test execution price calculation
                execution_price = await market_service.get_execution_price(
                    test_case["symbol"],
                    "buy",
                    test_case["user_type"],
                    test_case["group_id"]
                )
                
                if execution_price and float(execution_price) > 0:
                    successful_tests += 1
                else:
                    failed_symbols.append({
                        "symbol": test_case["symbol"],
                        "user_type": test_case["user_type"],
                        "issue": "No valid execution price returned"
                    })
                    
            except Exception as e:
                failed_symbols.append({
                    "symbol": test_case["symbol"],
                    "user_type": test_case["user_type"],
                    "error": str(e)
                })
        
        success_rate = (successful_tests / len(test_cases)) * 100
        status = "healthy" if success_rate >= 90 else "degraded" if success_rate >= 70 else "unhealthy"
        
        return {
            "status": status,
            "timestamp": int(time.time()),
            "tested_symbols": len(set(tc["symbol"] for tc in test_cases)),
            "tested_groups": len(set(tc["group_id"] for tc in test_cases)),
            "successful_tests": successful_tests,
            "total_tests": len(test_cases),
            "success_rate_percent": success_rate,
            "failed_symbols": failed_symbols
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Execution price health check failed: {str(e)}")

@router.get("/market/listener/status")
async def get_listener_status() -> Dict[str, Any]:
    """Get WebSocket listener status"""
    try:
        status = await binary_market_listener.get_connection_status()
        return {
            "success": True,
            "message": "Listener status retrieved successfully",
            "data": status
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get listener status: {str(e)}")
