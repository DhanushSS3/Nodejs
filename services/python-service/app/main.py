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
        print(f"✅ Loaded .env from: {os.path.abspath(env_path)}")
        loaded = True
        break

if not loaded:
    print("⚠️  No .env file found in expected locations")
    load_dotenv()  # Fallback to default behavior
from .api.market_api import router as market_router
from .api.orders_api import router as orders_router
from .api.admin_orders_api import router as admin_orders_router
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
    """Application lifespan manager"""
    # Startup
    logger.info("Starting Python Market Service...")
    
    # Start market listener as background task
    asyncio.create_task(start_market_listener())
    logger.info("Market listener started")
    
    # Start portfolio calculator listener as background task
    asyncio.create_task(start_portfolio_listener())
    logger.info("Portfolio calculator listener started")

    # Start provider persistent connection manager for send+receive
    provider_manager = get_provider_connection_manager()
    provider_task = asyncio.create_task(provider_manager.run())
    logger.info("Provider connection manager started")

    # Start provider pending monitor (continuous margin checks and cancel on insufficient margin)
    pending_monitor_task = None
    try:
        pending_monitor_task = asyncio.create_task(start_provider_pending_monitor())
        logger.info("Provider pending monitor started")
    except Exception as e:
        logger.error(f"Failed to start provider pending monitor: {e}")

    # Start AutoCutoff watcher (alerts + liquidation engine)
    try:
        asyncio.create_task(start_autocutoff_watcher())
        logger.info("AutoCutoff watcher started")
    except Exception as e:
        logger.error(f"Failed to start AutoCutoff watcher: {e}")

    
    yield
    
    # Shutdown
    logger.info("Shutting down Python Market Service...")
    try:
        await provider_manager.stop()
        provider_task.cancel()
        try:
            await provider_task
        except Exception:
            pass
        
        # Cancel pending monitor task
        if pending_monitor_task is not None:
            pending_monitor_task.cancel()
            try:
                await pending_monitor_task
            except Exception:
                pass
    except Exception:
        pass

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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )