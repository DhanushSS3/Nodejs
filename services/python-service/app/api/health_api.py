from fastapi import APIRouter, HTTPException
from typing import Dict, Any, List
import time
import asyncio
import json
import psutil
import os
from ..services.market_data_service import MarketDataService
from ..protobuf_market_listener import binary_market_listener
from ..config.redis_config import redis_cluster

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

@router.get("/debug/comprehensive")
async def get_comprehensive_debug_info() -> Dict[str, Any]:
    """Get comprehensive debug information for production troubleshooting"""
    debug_info = {
        "timestamp": int(time.time()),
        "system_info": {},
        "redis_diagnostics": {},
        "websocket_diagnostics": {},
        "market_data_diagnostics": {},
        "performance_metrics": {},
        "recent_errors": []
    }
    
    try:
        # Add timeouts to prevent hanging
        debug_info["system_info"] = await asyncio.wait_for(_get_system_info(), timeout=5.0)
    except asyncio.TimeoutError:
        debug_info["system_info"] = {"error": "timeout"}
    except Exception as e:
        debug_info["system_info"] = {"error": str(e)}
    
    try:
        debug_info["redis_diagnostics"] = await asyncio.wait_for(_get_redis_diagnostics(), timeout=10.0)
    except asyncio.TimeoutError:
        debug_info["redis_diagnostics"] = {"error": "timeout"}
    except Exception as e:
        debug_info["redis_diagnostics"] = {"error": str(e)}
    
    try:
        debug_info["websocket_diagnostics"] = await asyncio.wait_for(_get_websocket_diagnostics(), timeout=5.0)
    except asyncio.TimeoutError:
        debug_info["websocket_diagnostics"] = {"error": "timeout"}
    except Exception as e:
        debug_info["websocket_diagnostics"] = {"error": str(e)}
    
    try:
        debug_info["market_data_diagnostics"] = await asyncio.wait_for(_get_market_data_diagnostics(), timeout=10.0)
    except asyncio.TimeoutError:
        debug_info["market_data_diagnostics"] = {"error": "timeout"}
    except Exception as e:
        debug_info["market_data_diagnostics"] = {"error": str(e)}
    
    try:
        debug_info["performance_metrics"] = await asyncio.wait_for(_get_performance_metrics(), timeout=5.0)
    except asyncio.TimeoutError:
        debug_info["performance_metrics"] = {"error": "timeout"}
    except Exception as e:
        debug_info["performance_metrics"] = {"error": str(e)}
    
    try:
        debug_info["recent_errors"] = await asyncio.wait_for(_get_recent_errors(), timeout=2.0)
    except asyncio.TimeoutError:
        debug_info["recent_errors"] = [{"error": "timeout"}]
    except Exception as e:
        debug_info["recent_errors"] = [{"error": str(e)}]
    
    return debug_info

@router.get("/debug/redis-cluster")
async def get_redis_cluster_debug() -> Dict[str, Any]:
    """Detailed Redis cluster diagnostics"""
    try:
        return await asyncio.wait_for(_get_redis_diagnostics(), timeout=15.0)
    except asyncio.TimeoutError:
        return {"error": "Redis diagnostics timed out after 15 seconds"}
    except Exception as e:
        return {"error": str(e)}

@router.get("/debug/websocket")
async def get_websocket_debug() -> Dict[str, Any]:
    """Detailed WebSocket connection diagnostics"""
    return await _get_websocket_diagnostics()

@router.get("/debug/market-data")
async def get_market_data_debug() -> Dict[str, Any]:
    """Detailed market data diagnostics"""
    return await _get_market_data_diagnostics()

@router.get("/debug/websocket-to-redis")
async def get_websocket_to_redis_debug() -> Dict[str, Any]:
    """Debug why WebSocket data isn't reaching Redis"""
    debug_info = {
        "timestamp": time.time(),
        "websocket_status": {},
        "redis_write_test": {},
        "market_service_status": {},
        "data_flow_analysis": {},
        "potential_issues": []
    }
    
    try:
        # Check WebSocket listener status
        listener_status = await binary_market_listener.get_connection_status()
        debug_info["websocket_status"] = {
            "is_running": listener_status.get("is_running", False),
            "messages_processed": listener_status.get("performance", {}).get("messages_processed", 0),
            "successful_decodes": listener_status.get("performance", {}).get("successful_decodes", 0),
            "parse_errors": listener_status.get("performance", {}).get("parse_errors", 0),
            "last_message_time": listener_status.get("performance", {}).get("last_message_time")
        }
        
        # Test Redis write capability
        try:
            test_key = f"debug_test:{int(time.time())}"
            test_value = {"test": "data", "timestamp": time.time()}
            
            await redis_cluster.set(test_key, json.dumps(test_value), ex=60)
            retrieved_value = await redis_cluster.get(test_key)
            await redis_cluster.delete(test_key)
            
            debug_info["redis_write_test"] = {
                "write_success": True,
                "read_success": retrieved_value is not None,
                "data_integrity": json.loads(retrieved_value) == test_value if retrieved_value else False
            }
        except Exception as e:
            debug_info["redis_write_test"] = {
                "write_success": False,
                "error": str(e)
            }
        
        # Check market service status
        try:
            from ..services.market_data_service import MarketDataService
            market_service = MarketDataService()
            
            debug_info["market_service_status"] = {
                "service_available": True,
                "redis_cluster_accessible": hasattr(market_service, 'redis_cluster')
            }
            
            # Test market service write
            test_data = {
                "market_prices": {
                    "TESTPAIR": {
                        "buy": 1.23456,
                        "sell": 1.23454
                    }
                }
            }
            
            write_result = await market_service.process_market_feed(test_data)
            debug_info["market_service_status"]["write_test_success"] = write_result
            
        except Exception as e:
            debug_info["market_service_status"] = {
                "service_available": False,
                "error": str(e)
            }
        
        # Analyze data flow
        ws_processing = debug_info["websocket_status"]["messages_processed"] > 0
        ws_decoding = debug_info["websocket_status"]["successful_decodes"] > 0
        redis_writable = debug_info["redis_write_test"]["write_success"]
        market_service_ok = debug_info["market_service_status"].get("service_available", False)
        
        debug_info["data_flow_analysis"] = {
            "websocket_receiving": ws_processing,
            "websocket_decoding": ws_decoding,
            "redis_writable": redis_writable,
            "market_service_functional": market_service_ok,
            "data_flow_broken": ws_processing and ws_decoding and redis_writable and market_service_ok
        }
        
        # Identify potential issues
        if not ws_processing:
            debug_info["potential_issues"].append("WebSocket not receiving messages")
        elif not ws_decoding:
            debug_info["potential_issues"].append("WebSocket receiving but not decoding messages")
        elif not redis_writable:
            debug_info["potential_issues"].append("Redis cluster not writable")
        elif not market_service_ok:
            debug_info["potential_issues"].append("Market data service not functional")
        elif ws_processing and ws_decoding and redis_writable and market_service_ok:
            debug_info["potential_issues"].append("Data flow appears functional - check message processing logic")
        
        # Check for connection pool exhaustion
        redis_diag = await _get_redis_diagnostics()
        pool_info = redis_diag.get("connection_pool", {})
        utilization = pool_info.get("utilization_percent", 0)
        
        if utilization > 80:
            debug_info["potential_issues"].append(f"High Redis connection pool utilization: {utilization:.1f}%")
        
        if pool_info.get("connection_errors"):
            debug_info["potential_issues"].append("Redis connection pool errors detected")
        
    except Exception as e:
        debug_info["error"] = str(e)
    
    return debug_info

@router.get("/listener-status")
async def get_websocket_listener_status() -> Dict[str, Any]:
    """Get current WebSocket listener configuration and performance comparison"""
    try:
        current_binary = os.getenv("USE_BINARY_LISTENER", "true").lower() == "true"
        
        return {
            "success": True,
            "message": "WebSocket listener status retrieved",
            "current_listener": "binary" if current_binary else "json",
            "recommendation": "Use binary listener for better performance",
            "configuration": {
                "environment_variable": "USE_BINARY_LISTENER",
                "current_value": os.getenv("USE_BINARY_LISTENER", "true"),
                "restart_required": True
            },
            "performance_comparison": {
                "binary_listener": {
                    "efficiency": "High",
                    "cpu_usage": "Lower",
                    "memory_usage": "Lower", 
                    "message_size": "Smaller (protobuf)",
                    "recommended": True
                },
                "json_listener": {
                    "efficiency": "Medium",
                    "cpu_usage": "Higher",
                    "memory_usage": "Higher",
                    "message_size": "Larger (JSON text)",
                    "recommended": False
                }
            },
            "bottleneck_analysis": {
                "running_both_listeners": "Causes 2x resource usage and processing overhead",
                "solution": "Run only one listener type",
                "current_status": "Single listener mode configured"
            }
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "timestamp": time.time()
        }

async def _get_system_info() -> Dict[str, Any]:
    """Get system resource information"""
    try:
        process = psutil.Process()
        return {
            "cpu_percent": psutil.cpu_percent(interval=1),
            "memory_info": {
                "rss_mb": process.memory_info().rss / 1024 / 1024,
                "vms_mb": process.memory_info().vms / 1024 / 1024,
                "percent": process.memory_percent()
            },
            "process_info": {
                "pid": os.getpid(),
                "threads": process.num_threads(),
                "connections": len(process.connections()),
                "uptime_seconds": time.time() - process.create_time()
            },
            "system_load": os.getloadavg() if hasattr(os, 'getloadavg') else "N/A"
        }
    except Exception as e:
        return {"error": str(e)}

async def _get_redis_diagnostics() -> Dict[str, Any]:
    """Comprehensive Redis cluster diagnostics"""
    diagnostics = {
        "cluster_health": {},
        "individual_nodes": {},
        "connection_pool": {},
        "performance_stats": {},
        "errors": []
    }
    
    try:
        # Test cluster connectivity
        start_time = time.time()
        await redis_cluster.ping()
        ping_time = (time.time() - start_time) * 1000
        
        diagnostics["cluster_health"]["ping_success"] = True
        diagnostics["cluster_health"]["ping_time_ms"] = ping_time
        
        # Get cluster info
        cluster_info = await redis_cluster.cluster_info()
        diagnostics["cluster_health"]["cluster_state"] = cluster_info.get("cluster_state")
        diagnostics["cluster_health"]["cluster_slots_assigned"] = cluster_info.get("cluster_slots_assigned")
        diagnostics["cluster_health"]["cluster_known_nodes"] = cluster_info.get("cluster_known_nodes")
        
        # Test individual nodes
        nodes = await redis_cluster.cluster_nodes()
        for node_id, node_info in nodes.items():
            diagnostics["individual_nodes"][node_id] = {
                "host": node_info.get("host"),
                "port": node_info.get("port"),
                "flags": node_info.get("flags", []),
                "slots": len(node_info.get("slots", [])),
                "health": "master" in node_info.get("flags", []) or "slave" in node_info.get("flags", [])
            }
        
        # Enhanced connection pool monitoring for Redis Cluster
        try:
            pool_info = {
                "type": "redis_cluster",
                "nodes_info": {},
                "total_connections": 0,
                "total_in_use": 0,
                "total_available": 0,
                "connection_errors": [],
                "active_connections": 0,
                "max_connections_configured": 50
            }
            
            # Test actual connection usage by performing operations
            connection_test_results = []
            test_symbols = ["EURUSD", "GBPUSD", "USDSEK"]
            
            for symbol in test_symbols:
                try:
                    start_time = time.time()
                    key = f"market:{symbol}"
                    result = await redis_cluster.hmget(key, ["bid", "ask", "ts"])
                    response_time = (time.time() - start_time) * 1000
                    
                    connection_test_results.append({
                        "symbol": symbol,
                        "success": True,
                        "response_time_ms": response_time,
                        "data_found": all(result) if result else False
                    })
                except Exception as e:
                    connection_test_results.append({
                        "symbol": symbol,
                        "success": False,
                        "error": str(e),
                        "response_time_ms": None
                    })
            
            pool_info["connection_tests"] = connection_test_results
            
            # Calculate connection health metrics
            successful_tests = sum(1 for test in connection_test_results if test["success"])
            pool_info["connection_success_rate"] = (successful_tests / len(connection_test_results)) * 100
            
            avg_response_time = sum(
                test["response_time_ms"] for test in connection_test_results 
                if test["success"] and test["response_time_ms"] is not None
            ) / max(successful_tests, 1)
            
            pool_info["avg_response_time_ms"] = avg_response_time
            
            # Connection pool health indicators
            if avg_response_time > 100:
                pool_info["connection_errors"].append({
                    "type": "slow_response",
                    "message": f"Average response time {avg_response_time:.1f}ms indicates potential connection issues"
                })
            
            if successful_tests < len(connection_test_results):
                pool_info["connection_errors"].append({
                    "type": "connection_failures",
                    "message": f"{len(connection_test_results) - successful_tests} connection tests failed"
                })
            
            # Estimate active connections based on system info
            try:
                import psutil
                process = psutil.Process()
                connections = process.connections()
                
                # Count Redis connections (both local and remote)
                redis_connections = []
                for conn in connections:
                    if conn.raddr:  # Remote address exists
                        remote_port = conn.raddr.port
                        if remote_port in range(7001, 7010):  # Redis cluster ports
                            redis_connections.append(conn)
                    elif conn.laddr:  # Local address
                        local_port = conn.laddr.port
                        if local_port in range(7001, 7010):
                            redis_connections.append(conn)
                
                pool_info["active_connections"] = len(redis_connections)
                pool_info["system_connections"] = len(connections)
                
                # Add connection details for debugging
                pool_info["redis_connection_details"] = [
                    {
                        "local": f"{conn.laddr.ip}:{conn.laddr.port}" if conn.laddr else None,
                        "remote": f"{conn.raddr.ip}:{conn.raddr.port}" if conn.raddr else None,
                        "status": conn.status
                    } for conn in redis_connections[:5]  # Show first 5 connections
                ]
                
            except Exception as e:
                pool_info["active_connections"] = "unknown"
                pool_info["connection_error"] = str(e)
            
            # Connection pool utilization estimate
            if pool_info["active_connections"] != "unknown":
                pool_info["utilization_percent"] = (pool_info["active_connections"] / pool_info["max_connections_configured"]) * 100
            else:
                pool_info["utilization_percent"] = 0
                
            diagnostics["connection_pool"] = pool_info
            
        except Exception as e:
            diagnostics["connection_pool"] = {
                "error": str(e),
                "type": "redis_cluster",
                "note": "Could not retrieve detailed connection pool info"
            }
        
    except Exception as e:
        diagnostics["errors"].append({
            "type": "redis_connection_error",
            "message": str(e),
            "timestamp": time.time()
        })
        diagnostics["cluster_health"]["ping_success"] = False
    
    return diagnostics

async def _get_websocket_diagnostics() -> Dict[str, Any]:
    """Comprehensive WebSocket diagnostics"""
    diagnostics = {
        "connection_status": {},
        "connection_history": {},
        "performance_metrics": {},
        "errors": []
    }
    
    try:
        # Get listener status
        listener_status = await binary_market_listener.get_connection_status()
        diagnostics["connection_status"] = listener_status
        
        # Add connection history analysis
        diagnostics["connection_history"] = {
            "total_connections": listener_status.get("stats", {}).get("total_connections", 0),
            "connection_failures": listener_status.get("stats", {}).get("connection_failures", 0),
            "disconnections": listener_status.get("stats", {}).get("disconnections", 0),
            "success_rate": _calculate_connection_success_rate(listener_status)
        }
        
        # Performance analysis
        performance = listener_status.get("performance", {})
        diagnostics["performance_metrics"] = {
            "messages_per_second": _calculate_message_rate(performance),
            "parse_error_rate": _calculate_error_rate(performance),
            "uptime_seconds": performance.get("uptime_seconds", 0),
            "last_message_age": _calculate_last_message_age(performance)
        }
        
    except Exception as e:
        diagnostics["errors"].append({
            "type": "websocket_diagnostic_error",
            "message": str(e),
            "timestamp": time.time()
        })
    
    return diagnostics

async def _get_market_data_diagnostics() -> Dict[str, Any]:
    """Comprehensive market data diagnostics"""
    diagnostics = {
        "symbol_analysis": {},
        "data_freshness": {},
        "price_consistency": {},
        "redis_keys": {},
        "errors": []
    }
    
    try:
        market_service = MarketDataService()
        symbols = ["EURUSD", "GBPUSD", "USDSEK", "EURSEK", "GBPSEK"]
        
        current_time = time.time()
        fresh_count = 0
        stale_count = 0
        missing_count = 0
        
        # Check individual symbols - use correct Redis key format
        for symbol in symbols:
            try:
                # Check new format first (market:SYMBOL - hash format)
                key_new = f"market:{symbol}"
                hash_data = await redis_cluster.hmget(key_new, ["bid", "ask", "ts"])
                
                if all(hash_data) and hash_data[2]:  # bid, ask, ts all exist
                    bid, ask, ts = hash_data
                    timestamp_ms = int(ts)
                    timestamp_s = timestamp_ms / 1000.0
                    age = current_time - timestamp_s
                    
                    diagnostics["symbol_analysis"][symbol] = {
                        "exists": True,
                        "age_seconds": age,
                        "buy_price": float(ask),  # ask = buy price for users
                        "sell_price": float(bid), # bid = sell price for users
                        "source": "websocket_live",
                        "is_fresh": age < 60
                    }
                    
                    if age < 60:
                        fresh_count += 1
                    else:
                        stale_count += 1
                        
                else:
                    # Check old format (market_data:SYMBOL - JSON format)
                    key_old = f"market_data:{symbol}"
                    json_data = await redis_cluster.get(key_old)
                    
                    if json_data:
                        data = json.loads(json_data)
                        timestamp = data.get("timestamp", 0)
                        age = current_time - timestamp
                        
                        diagnostics["symbol_analysis"][symbol] = {
                            "exists": True,
                            "age_seconds": age,
                            "buy_price": data.get("buy_price"),
                            "sell_price": data.get("sell_price"),
                            "source": "warmup_fallback",
                            "is_fresh": age < 60
                        }
                        
                        if age < 60:
                            fresh_count += 1
                        else:
                            stale_count += 1
                    else:
                        diagnostics["symbol_analysis"][symbol] = {
                            "exists": False,
                            "age_seconds": None,
                            "is_fresh": False
                        }
                        missing_count += 1
                    
            except Exception as e:
                diagnostics["errors"].append({
                    "type": "symbol_analysis_error",
                    "symbol": symbol,
                    "message": str(e),
                    "timestamp": time.time()
                })
        
        diagnostics["data_freshness"] = {
            "total_symbols": len(symbols),
            "fresh_symbols": fresh_count,
            "stale_symbols": stale_count,
            "missing_symbols": missing_count,
            "freshness_rate": (fresh_count / len(symbols)) * 100
        }
        
        # Check Redis key patterns - scan both formats
        try:
            # Use SCAN instead of KEYS for better performance in production
            market_keys_new = []
            market_keys_old = []
            
            # Scan for new format (market:*)
            async for key in redis_cluster.scan_iter(match="market:*", count=100):
                market_keys_new.append(key)
                if len(market_keys_new) >= 25:  # Limit to avoid performance issues
                    break
            
            # Scan for old format (market_data:*)
            async for key in redis_cluster.scan_iter(match="market_data:*", count=100):
                market_keys_old.append(key)
                if len(market_keys_old) >= 25:  # Limit to avoid performance issues
                    break
            
            all_keys = market_keys_new + market_keys_old
            
            diagnostics["redis_keys"] = {
                "total_market_keys": len(all_keys),
                "new_format_keys": len(market_keys_new),
                "old_format_keys": len(market_keys_old),
                "sample_keys": all_keys[:10],  # Show sample keys
                "key_patterns": ["market", "market_data"] if all_keys else []
            }
        except Exception as e:
            diagnostics["errors"].append({
                "type": "redis_keys_error",
                "message": str(e),
                "timestamp": time.time()
            })
            
    except Exception as e:
        diagnostics["errors"].append({
            "type": "market_data_diagnostic_error",
            "message": str(e),
            "timestamp": time.time()
        })
    
    return diagnostics

async def _get_performance_metrics() -> Dict[str, Any]:
    """Get performance metrics"""
    try:
        listener_status = await binary_market_listener.get_connection_status()
        performance = listener_status.get("performance", {})
        
        return {
            "message_processing": {
                "total_messages": performance.get("total_messages", 0),
                "successful_decodes": performance.get("successful_decodes", 0),
                "parse_errors": performance.get("parse_errors", 0),
                "decode_success_rate": _calculate_decode_success_rate(performance)
            },
            "connection_metrics": {
                "uptime_seconds": performance.get("uptime_seconds", 0),
                "reconnection_count": performance.get("reconnection_count", 0),
                "last_reconnection": performance.get("last_reconnection")
            },
            "throughput": {
                "messages_per_minute": _calculate_message_rate(performance) * 60,
                "bytes_per_second": performance.get("bytes_per_second", 0)
            }
        }
    except Exception as e:
        return {"error": str(e)}

async def _get_recent_errors() -> List[Dict[str, Any]]:
    """Get recent error logs (placeholder - implement based on your logging system)"""
    # This would typically read from your log files or error tracking system
    return [
        {
            "timestamp": time.time() - 300,
            "type": "example_error",
            "message": "This is a placeholder for recent errors",
            "severity": "info"
        }
    ]

def _calculate_connection_success_rate(listener_status: Dict) -> float:
    """Calculate connection success rate"""
    stats = listener_status.get("stats", {})
    total = stats.get("total_connections", 0)
    failures = stats.get("connection_failures", 0)
    
    if total == 0:
        return 0.0
    return ((total - failures) / total) * 100

def _calculate_message_rate(performance: Dict) -> float:
    """Calculate messages per second"""
    total_messages = performance.get("total_messages", 0)
    uptime = performance.get("uptime_seconds", 1)
    
    if uptime == 0:
        return 0.0
    return total_messages / uptime

def _calculate_error_rate(performance: Dict) -> float:
    """Calculate parse error rate"""
    total_messages = performance.get("total_messages", 0)
    parse_errors = performance.get("parse_errors", 0)
    
    if total_messages == 0:
        return 0.0
    return (parse_errors / total_messages) * 100

def _calculate_last_message_age(performance: Dict) -> float:
    """Calculate age of last received message"""
    last_message_time = performance.get("last_message_time")
    if last_message_time:
        return time.time() - last_message_time
    return 0.0

def _calculate_decode_success_rate(performance: Dict) -> float:
    """Calculate decode success rate"""
    total = performance.get("total_messages", 0)
    successful = performance.get("successful_decodes", 0)
    
    # Handle case where successful_decodes might be higher than total_messages
    # (can happen with different counting methods)
    if total == 0 and successful > 0:
        return 100.0  # All processed messages were successful
    elif total == 0:
        return 0.0
    
    # Ensure we don't exceed 100%
    rate = min((successful / total) * 100, 100.0)
    return rate
