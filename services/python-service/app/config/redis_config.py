

import os
from redis.asyncio.cluster import RedisCluster
from redis.asyncio.cluster import ClusterNode

class RedisConfig:
    """Redis Cluster configuration for market data storage"""
    
    def __init__(self):
        # Redis cluster nodes from environment
        redis_hosts = os.getenv(
            "REDIS_HOSTS", 
            "127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003"
        ).split(",")

        # Parse all hosts for startup nodes using ClusterNode objects
        startup_nodes = []
        for host in redis_hosts:
            host_ip, host_port = host.strip().split(":")
            startup_nodes.append(ClusterNode(host_ip, int(host_port)))

        # Address mapping function for local development
        # Maps Docker internal IPs to localhost ports
        def address_remap(address):
            host, port = address
            mapping = {
                "172.28.0.2": ("127.0.0.1", 7001),  # redis-node-1
                "172.28.0.3": ("127.0.0.1", 7002),  # redis-node-2  
                "172.28.0.4": ("127.0.0.1", 7003),  # redis-node-3
                "172.28.0.5": ("127.0.0.1", 7004),  # redis-node-4
                "172.28.0.6": ("127.0.0.1", 7005),  # redis-node-5
                "172.28.0.7": ("127.0.0.1", 7006),  # redis-node-6
                "172.28.0.8": ("127.0.0.1", 7007),  # redis-node-7
                "172.28.0.9": ("127.0.0.1", 7008),  # redis-node-8
                "172.28.0.10": ("127.0.0.1", 7009), # redis-node-9
            }
            return mapping.get(host, (host, port))

        self.cluster_config = {
            "startup_nodes": startup_nodes,
            "decode_responses": True,
            "health_check_interval": 30,
            "socket_connect_timeout": 2,       # Reduced for faster failure detection
            "socket_timeout": 2,               # Reduced for faster failure detection
            "max_connections": 50,
            "address_remap": address_remap,    # Map internal IPs to localhost
        }
    
    def get_cluster(self):
        """Get async Redis cluster connection"""
        return RedisCluster(**self.cluster_config)

# Global async Redis cluster instance
redis_cluster = RedisConfig().get_cluster()
