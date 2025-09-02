from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging
import asyncio
from .api.market_api import router as market_router
from .market_listener import start_market_listener

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
    
    yield
    
    # Shutdown
    logger.info("Shutting down Python Market Service...")

# Create FastAPI app
app = FastAPI(
    title="LiveFX Market Data Service",
    description="Real-time market price processing and Redis storage",
    version="1.0.0",
    lifespan=lifespan
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
            redis_cluster.ping()
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