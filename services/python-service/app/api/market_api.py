from fastapi import APIRouter, HTTPException, BackgroundTasks
from typing import Dict, Any, List, Optional
from ..services.market_data_service import MarketDataService
from ..market_listener import market_listener
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/market", tags=["Market Data"])

# Initialize market data service
market_service = MarketDataService()

@router.get("/prices", response_model=Dict[str, Any])
async def get_all_prices():
    """
    Get complete market price snapshot for monitoring/dashboards
    
    Returns:
        Dict containing timestamp, total_symbols, and all current prices
    """
    try:
        snapshot = await market_service.get_all_prices_snapshot()
        return {
            "success": True,
            "message": "Market prices retrieved successfully",
            "data": snapshot
        }
    except Exception as e:
        logger.error(f"Failed to get market prices: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve market prices")

@router.get("/prices/{symbol}", response_model=Dict[str, Any])
async def get_symbol_price(symbol: str):
    """
    Get current price for a specific symbol
    
    Args:
        symbol: Trading symbol (e.g., EURUSD)
        
    Returns:
        Dict containing bid, ask, and timestamp
    """
    try:
        price_data = await market_service.get_symbol_price(symbol.upper())
        
        if not price_data:
            raise HTTPException(
                status_code=404, 
                detail=f"Price data not found or stale for symbol: {symbol}"
            )
        
        return {
            "success": True,
            "message": f"Price retrieved successfully for {symbol}",
            "data": {
                "symbol": symbol.upper(),
                **price_data
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get price for {symbol}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to retrieve price for {symbol}")

@router.post("/prices/bulk", response_model=Dict[str, Any])
async def get_multiple_prices(symbols: List[str]):
    """
    Get prices for multiple symbols efficiently
    
    Args:
        symbols: List of trading symbols
        
    Returns:
        Dict containing prices for all valid symbols
    """
    try:
        if not symbols:
            raise HTTPException(status_code=400, detail="Symbols list cannot be empty")
        
        # Convert to uppercase for consistency
        symbols_upper = [symbol.upper() for symbol in symbols]
        
        prices = await market_service.get_multiple_prices(symbols_upper)
        
        return {
            "success": True,
            "message": f"Prices retrieved for {len(prices)} symbols",
            "data": {
                "requested_symbols": len(symbols_upper),
                "found_symbols": len(prices),
                "prices": prices
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get multiple prices: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve multiple prices")

@router.get("/listener/status", response_model=Dict[str, Any])
async def get_listener_status():
    """
    Get market listener connection status
    
    Returns:
        Dict containing listener status information
    """
    try:
        status = await market_listener.get_connection_status()
        return {
            "success": True,
            "message": "Listener status retrieved successfully",
            "data": status
        }
    except Exception as e:
        logger.error(f"Failed to get listener status: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve listener status")

@router.post("/listener/start")
async def start_listener(background_tasks: BackgroundTasks):
    """
    Start the market data listener
    
    Returns:
        Success message
    """
    try:
        if market_listener.is_running:
            return {
                "success": True,
                "message": "Market listener is already running"
            }
        
        # Start listener as background task
        background_tasks.add_task(market_listener.start)
        
        return {
            "success": True,
            "message": "Market listener started successfully"
        }
    except Exception as e:
        logger.error(f"Failed to start listener: {e}")
        raise HTTPException(status_code=500, detail="Failed to start market listener")

@router.post("/listener/stop")
async def stop_listener():
    """
    Stop the market data listener
    
    Returns:
        Success message
    """
    try:
        await market_listener.stop()
        return {
            "success": True,
            "message": "Market listener stopped successfully"
        }
    except Exception as e:
        logger.error(f"Failed to stop listener: {e}")
        raise HTTPException(status_code=500, detail="Failed to stop market listener")
