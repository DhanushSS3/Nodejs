#!/usr/bin/env python3
"""
Market Data Service Runner
Starts the FastAPI application with uvicorn
"""

import uvicorn
import os
import sys

# Add app directory to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'app'))

if __name__ == "__main__":
    # Load environment variables
    port = int(os.getenv('PYTHON_SERVICE_PORT', 8000))
    host = os.getenv('PYTHON_SERVICE_HOST', '0.0.0.0')
    
    print(f"Starting LiveFX Market Data Service on {host}:{port}")
    
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        reload=True,
        log_level="info",
        access_log=True
    )
