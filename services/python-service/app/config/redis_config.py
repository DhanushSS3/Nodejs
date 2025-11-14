import os
from pathlib import Path
from dotenv import load_dotenv
from redis.asyncio.cluster import RedisCluster
from redis.asyncio.cluster import ClusterNode
import redis.asyncio as redis

# Load environment variables from root .env file
# Path: services/python-service/app/config/redis_config.py -> root
# __file__ = .../services/python-service/app/config/redis_config.py
# .parent = .../services/python-service/app/config
# .parent.parent = .../services/python-service/app
# .parent.parent.parent = .../services/python-service
# .parent.parent.parent.parent = .../services
# We need one more .parent to get to root
root_dir = Path(__file__).parent.parent.parent.parent.parent
env_path = root_dir / '.env'
load_dotenv(env_path)

# Debug logging
import logging
logger = logging.getLogger(__name__)
logger.info("Redis config loading .env from: %s", env_path.resolve())
logger.info("Redis config .env file exists: %s", env_path.exists())
logger.info("REDIS_PASSWORD loaded: %s", "Yes" if os.getenv("REDIS_PASSWORD") else "No")

class RedisConfig:
    """Redis Cluster configuration for market data storage"""
    
    def __init__(self):
        # Redis cluster nodes from environment
        redis_hosts_env = os.getenv("REDIS_HOSTS") or "127.0.0.1:7001"
        redis_hosts = redis_hosts_env.split(",")
        
        # Get password from environment
        redis_password = os.getenv("REDIS_PASSWORD") or "admin@livefxhub@123"

        # Parse all hosts for startup nodes using ClusterNode objects
        startup_nodes = []
        for host in redis_hosts:
            host_ip, host_port = host.strip().split(":")
            startup_nodes.append(ClusterNode(host_ip, int(host_port)))

        # Address mapping function for local development
        def address_remap(address):
            host, port = address
            mapping = {
                "172.28.0.2": ("127.0.0.1", 7001),
                "172.28.0.3": ("127.0.0.1", 7002),  
                "172.28.0.4": ("127.0.0.1", 7003),
                "172.28.0.5": ("127.0.0.1", 7004),
                "172.28.0.6": ("127.0.0.1", 7005),
                "172.28.0.7": ("127.0.0.1", 7006),
                "172.28.0.8": ("127.0.0.1", 7007),
                "172.28.0.9": ("127.0.0.1", 7008),
                "172.28.0.10": ("127.0.0.1", 7009),
            }
            return mapping.get(host, (host, port))

        # Enhanced configuration for production with proper connection management
        # Increased connection pool since Redis has low resource usage
        self.cluster_config = {
            "startup_nodes": startup_nodes,
            "decode_responses": True,
            "password": redis_password,
            "health_check_interval": 30,
            "socket_connect_timeout": 10,   # Increased timeout for network stability
            "socket_timeout": 10,           # Increased timeout for slow operations
            "socket_keepalive": True,       # Enable TCP keepalive for persistent connections
            "socket_keepalive_options": {},
            "max_connections": 1000,        # Significantly increased since Redis has low resource usage
            "address_remap": address_remap,
        }
    
    def get_cluster(self):
        """Get async Redis cluster connection"""
        return RedisCluster(**self.cluster_config)

# Global async Redis cluster instance with connection monitoring
redis_cluster = RedisConfig().get_cluster()

# Connection health monitoring and logging
async def monitor_redis_health():
    """Monitor Redis cluster health and log connection statistics"""
    try:
        # Test cluster connectivity
        await redis_cluster.ping()
        
        # Get cluster info
        cluster_info = await redis_cluster.cluster_info()
        cluster_nodes = await redis_cluster.cluster_nodes()
        
        logger.info(
            f"✅ REDIS_HEALTH: Cluster healthy - "
            f"State: {cluster_info.get('cluster_state', 'unknown')}, "
            f"Nodes: {len(cluster_nodes.split('\\n')) - 1}, "
            f"Slots: {cluster_info.get('cluster_slots_assigned', 0)}"
        )
        
        return True
    except Exception as e:
        logger.error(
            f"❌ REDIS_HEALTH: Cluster health check failed - "
            f"ErrorType: {type(e).__name__}, "
            f"ErrorMsg: {str(e)}"
        )
        return False

# Connection pool statistics logging
def log_connection_stats():
    """Log Redis connection pool statistics for monitoring"""
    try:
        # Note: redis-py doesn't expose connection pool stats directly
        # This is a placeholder for future monitoring enhancements
        logger.debug("📊 REDIS_STATS: Connection pool monitoring active")
    except Exception as e:
        logger.debug(f"REDIS_STATS: Failed to get connection stats: {e}")

# Enhanced connection retry mechanism
async def redis_operation_with_retry(operation, max_retries=3, base_delay=0.1):
    """
    Execute Redis operation with exponential backoff retry mechanism
    
    Args:
        operation: Async function to execute
        max_retries: Maximum number of retry attempts
        base_delay: Base delay in seconds for exponential backoff
    
    Returns:
        Result of the operation
    
    Raises:
        Exception: If all retry attempts fail
    """
    import asyncio
    import traceback
    
    last_exception = None
    
    for attempt in range(max_retries + 1):
        try:
            return await operation()
        except (ConnectionError, TimeoutError, OSError) as e:
            last_exception = e
            if attempt < max_retries:
                delay = base_delay * (2 ** attempt)  # Exponential backoff
                logger.warning(
                    f"🔄 REDIS_RETRY: Connection error on attempt {attempt + 1}/{max_retries + 1} - "
                    f"ErrorType: {type(e).__name__}, "
                    f"ErrorMsg: {str(e)}, "
                    f"RetryDelay: {delay:.2f}s"
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    f"❌ REDIS_RETRY: All retry attempts failed - "
                    f"ErrorType: {type(e).__name__}, "
                    f"ErrorMsg: {str(e)}, "
                    f"Attempts: {max_retries + 1}"
                )
        except Exception as e:
            # Non-connection errors should not be retried
            logger.error(
                f"❌ REDIS_RETRY: Non-retryable error - "
                f"ErrorType: {type(e).__name__}, "
                f"ErrorMsg: {str(e)}"
            )
            logger.debug(f"Full traceback: {traceback.format_exc()}")
            raise
    
    # If we get here, all retries failed
    raise last_exception

# Enhanced Redis connection pool for pub/sub operations with increased capacity
redis_password = os.getenv("REDIS_PASSWORD") or "admin@livefxhub@123"
redis_pubsub_client = redis.Redis(
    host='127.0.0.1', 
    port=7001, 
    decode_responses=True,
    password=redis_password,
    max_connections=200,         # Significantly increased for high-frequency pub/sub operations
    socket_connect_timeout=10,   # Increased connection timeout for stability
    socket_timeout=None,         # Disable read timeout for long-lived pub/sub listen
    socket_keepalive=True,       # Enable TCP keepalive
    socket_keepalive_options={}, # TCP keepalive options
    health_check_interval=30     # Health check every 30s
)