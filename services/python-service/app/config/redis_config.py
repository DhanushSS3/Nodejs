import os
from redis.asyncio.cluster import RedisCluster
from redis.asyncio.cluster import ClusterNode
import redis.asyncio as redis

class RedisConfig:
    """Redis Cluster configuration for market data storage"""
    
    def __init__(self):
        # Redis cluster nodes from environment
        redis_hosts_env = os.getenv("REDIS_HOSTS") or "127.0.0.1:7001"
        redis_hosts = redis_hosts_env.split(",")
        
        # Get password from environment
        redis_password = os.getenv("REDIS_PASSWORD") or None

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

        self.cluster_config = {
            "startup_nodes": startup_nodes,
            "decode_responses": True,
            "password": redis_password,
            "health_check_interval": 30,
            "socket_connect_timeout": 2,
            "socket_timeout": 2,
            "max_connections": 50,
            "address_remap": address_remap,
        }
    
    def get_cluster(self):
        """Get async Redis cluster connection"""
        return RedisCluster(**self.cluster_config)

# Global async Redis cluster instance
redis_cluster = RedisConfig().get_cluster()

# Single Redis connection for pub/sub operations
redis_password = os.getenv("REDIS_PASSWORD") or None
redis_pubsub_client = redis.Redis(
    host='127.0.0.1', 
    port=7001, 
    decode_responses=True,
    password=redis_password
)