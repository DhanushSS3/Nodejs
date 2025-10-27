from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging
import asyncio
import os
from dotenv import load_dotenv
# Load environment variables from .env early
# Try multiple possible .env locations
env_paths = [
    ".env",  # Current directory
    "../.env",  # Parent directory
    "../../.env",  # Root directory
    os.path.join(os.path.dirname(__file__), ".env"),  # Same as main.py
    os.path.join(os.path.dirname(__file__), "../.env"),  # Parent of app/
    os.path.join(os.path.dirname(__file__), "../../.env"),  # Root
]

loaded = False
for env_path in env_paths:
    if os.path.exists(env_path):
        load_dotenv(env_path)
        print(f"[OK] Loaded .env from: {os.path.abspath(env_path)}")
        loaded = True
        break 

if not loaded:
    print("[WARNING] No .env file found in expected locations")
    load_dotenv()  # Fallback to default behavior
from .api.market_api import router as market_router
from .api.orders_api import router as orders_router
from .api.admin_orders_api import router as admin_orders_router
from .api.health_api import router as health_router
from .protobuf_market_listener import start_binary_market_listener
from .market_listener import start_market_listener
from .services.portfolio_calculator import start_portfolio_listener
from .services.autocutoff.watcher import start_autocutoff_watcher
from .services.orders.provider_connection import get_provider_connection_manager
from .services.pending.provider_pending_monitor import start_provider_pending_monitor

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Enhanced application lifespan manager with comprehensive error handling"""
    # Startup
    logger.info("🚀 Starting Python Market Service...")
    
    # Track all background tasks for proper cleanup
    background_tasks = []
    
    # Step 1: Validate prerequisites
    startup_success = await _validate_startup_prerequisites()
    if not startup_success:
        logger.error("❌ Startup prerequisites validation failed")
        # Continue anyway but log the issues
    
    # Step 2: Start critical services with error handling
    try:
        # Start binary market listener (critical for price data)
        binary_listener_task = asyncio.create_task(start_binary_market_listener())
        background_tasks.append(("binary_market_listener", binary_listener_task))
        logger.info("✅ Binary market listener started")
        
        # Start JSON market listener (backup for price data)
        json_listener_task = asyncio.create_task(start_market_listener())
        background_tasks.append(("json_market_listener", json_listener_task))
        logger.info("✅ JSON market listener started")
        
    except Exception as e:
        logger.error(f"❌ Critical error starting market listeners: {e}")
        # This is critical - market data is essential
        
    # Step 3: Start supporting services
    try:
        # Start portfolio calculator listener
        portfolio_task = asyncio.create_task(start_portfolio_listener())
        background_tasks.append(("portfolio_listener", portfolio_task))
        logger.info("✅ Portfolio calculator listener started")
    except Exception as e:
        logger.error(f"⚠️ Failed to start portfolio listener: {e}")

    # Step 4: Start provider services
    provider_manager = None
    provider_task = None
    try:
        provider_manager = get_provider_connection_manager()
        provider_task = asyncio.create_task(provider_manager.run())
        background_tasks.append(("provider_manager", provider_task))
        logger.info("✅ Provider connection manager started")
    except Exception as e:
        logger.error(f"⚠️ Failed to start provider connection manager: {e}")

    # Step 5: Start monitoring services
    pending_monitor_task = None
    try:
        pending_monitor_task = asyncio.create_task(start_provider_pending_monitor())
        background_tasks.append(("pending_monitor", pending_monitor_task))
        logger.info("✅ Provider pending monitor started")
    except Exception as e:
        logger.error(f"⚠️ Failed to start provider pending monitor: {e}")

    # Step 6: Start AutoCutoff watcher
    try:
        autocutoff_task = asyncio.create_task(start_autocutoff_watcher())
        background_tasks.append(("autocutoff_watcher", autocutoff_task))
        logger.info("✅ AutoCutoff watcher started")
    except Exception as e:
        logger.error(f"⚠️ Failed to start AutoCutoff watcher: {e}")
    
    # Step 7: Start health monitoring
    try:
        health_monitor_task = asyncio.create_task(_health_monitor_loop())
        background_tasks.append(("health_monitor", health_monitor_task))
        logger.info("✅ Health monitor started")
    except Exception as e:
        logger.error(f"⚠️ Failed to start health monitor: {e}")
    
    # Log startup summary
    logger.info(f"🎯 Startup complete! Running {len(background_tasks)} background services")
    for service_name, task in background_tasks:
        status = "✅ Running" if not task.done() else "❌ Failed"
        logger.info(f"   - {service_name}: {status}")

    
    yield
    
    # Enhanced shutdown process
    logger.info("⏹️ Shutting down Python Market Service...")
    
    # Graceful shutdown of all background tasks
    for service_name, task in background_tasks:
        try:
            logger.info(f"⏹️ Stopping {service_name}...")
            task.cancel()
            try:
                await asyncio.wait_for(task, timeout=10.0)  # 10 second timeout
            except asyncio.TimeoutError:
                logger.warning(f"⚠️ {service_name} did not stop within timeout")
            except asyncio.CancelledError:
                logger.info(f"✅ {service_name} stopped gracefully")
            except Exception as e:
                logger.error(f"❌ Error stopping {service_name}: {e}")
        except Exception as e:
            logger.error(f"❌ Error during {service_name} shutdown: {e}")
    
    # Special handling for provider manager
    if provider_manager:
        try:
            await provider_manager.stop()
            logger.info("✅ Provider manager stopped")
        except Exception as e:
            logger.error(f"❌ Error stopping provider manager: {e}")
    
    logger.info("✅ Shutdown complete")

# Create FastAPI app
app = FastAPI(
    title="LiveFX Market Data Service",
    description="Real-time market price processing and Redis storage",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,  # Disable /docs for production
    redoc_url=None  # Disable /redoc for production
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure as needed
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routes
app.include_router(market_router, prefix="/api")
app.include_router(orders_router, prefix="/api")
app.include_router(admin_orders_router)
app.include_router(health_router, prefix="/api")

@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "service": "LiveFX Market Data Service",
        "status": "running",
        "version": "1.0.0"
    }

@app.get("/health")
async def health_check():
    """Detailed health check"""
    try:
        from .config.redis_config import redis_cluster
        
        # Test Redis connection
        redis_status = "connected"
        try:
            await redis_cluster.ping()
        except Exception as e:
            redis_status = f"error: {str(e)}"
        
        import time
        return {
            "status": "healthy",
            "redis": redis_status,
            "timestamp": int(time.time() * 1000)
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return {
            "status": "unhealthy",
            "error": str(e),
            "timestamp": int(time.time() * 1000)
        }

async def _validate_startup_prerequisites() -> bool:
    """Validate that all prerequisites are met before starting services"""
    logger.info("🔍 Validating startup prerequisites...")
    
    validation_results = []
    
    # Check Redis connectivity
    try:
        from .config.redis_config import redis_cluster
        await redis_cluster.ping()
        logger.info("✅ Redis cluster connectivity: OK")
        validation_results.append(True)
    except Exception as e:
        logger.error(f"❌ Redis cluster connectivity: FAILED - {e}")
        validation_results.append(False)
    
    # Check environment variables
    required_env_vars = ['REDIS_PASSWORD', 'REDIS_HOSTS']
    env_check = True
    for var in required_env_vars:
        if not os.getenv(var):
            logger.warning(f"⚠️ Environment variable {var} not set")
            env_check = False
    
    if env_check:
        logger.info("✅ Environment variables: OK")
    else:
        logger.warning("⚠️ Some environment variables missing")
    
    validation_results.append(env_check)
    
    # Check system resources
    try:
        import psutil
        memory_percent = psutil.virtual_memory().percent
        if memory_percent > 90:
            logger.warning(f"⚠️ High memory usage: {memory_percent}%")
        else:
            logger.info(f"✅ Memory usage: {memory_percent}%")
        validation_results.append(memory_percent < 95)
    except Exception as e:
        logger.warning(f"⚠️ Could not check system resources: {e}")
        validation_results.append(True)  # Don't fail startup for this
    
    success_rate = sum(validation_results) / len(validation_results)
    logger.info(f"📊 Prerequisites validation: {success_rate*100:.1f}% passed")
    
    return success_rate >= 0.5  # At least 50% of checks should pass

async def _health_monitor_loop():
    """Background health monitoring loop"""
    logger.info("💊 Starting health monitor loop...")
    
    while True:
        try:
            await asyncio.sleep(300)  # Check every 5 minutes
            
            # Quick health check
            from .config.redis_config import redis_cluster
            
            # Test Redis
            redis_ok = False
            try:
                await redis_cluster.ping()
                redis_ok = True
            except Exception:
                pass
            
            # Test market data freshness
            fresh_data_count = 0
            symbols = ["EURUSD", "GBPUSD", "USDSEK"]
            
            for symbol in symbols:
                try:
                    import json
                    import time
                    
                    key = f"market_data:{symbol}"
                    raw_data = await redis_cluster.get(key)
                    
                    if raw_data:
                        data = json.loads(raw_data)
                        age = time.time() - data.get("timestamp", 0)
                        if age < 120:  # Fresh if less than 2 minutes old
                            fresh_data_count += 1
                except Exception:
                    pass
            
            # Log health summary
            redis_status = "✅" if redis_ok else "❌"
            data_status = "✅" if fresh_data_count >= 2 else "⚠️" if fresh_data_count >= 1 else "❌"
            
            logger.info(f"💊 Health Check - Redis: {redis_status} | Fresh Data: {data_status} ({fresh_data_count}/{len(symbols)})")
            
            # Alert on critical issues
            if not redis_ok:
                logger.error("🚨 CRITICAL: Redis cluster is not responding!")
            
            if fresh_data_count == 0:
                logger.error("🚨 CRITICAL: No fresh market data available!")
            
        except Exception as e:
            logger.error(f"❌ Health monitor error: {e}")
            await asyncio.sleep(60)  # Shorter retry on error

if __name__ == "__main__":
    import uvicorn
    
    # Production-ready configuration
    config = {
        "host": "0.0.0.0",
        "port": 8000,
        "log_level": "info",
        "access_log": True,
        "reload": False,  # Disable reload in production
        "workers": 1,  # Single worker for WebSocket connections
    }
    
    # Enable reload only in development
    if os.getenv("ENVIRONMENT") == "development":
        config["reload"] = True
        logger.info("🔧 Development mode: reload enabled")
    else:
        logger.info("🚀 Production mode: optimized for stability")
    
    uvicorn.run("main:app", **config)