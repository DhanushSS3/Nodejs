# import os
# from redis import asyncio as aioredis

# class RedisConfig:
#     """Redis Cluster configuration for market data storage"""
    
#     def __init__(self):
#         # Redis cluster nodes from environment
#         redis_hosts = os.getenv('REDIS_HOSTS', '127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003')
        
#         # Parse hosts into startup_nodes format
#         self.startup_nodes = []
#         for host in redis_hosts.split(','):
#             if ':' in host:
#                 ip, port = host.strip().split(':')
#                 self.startup_nodes.append({
#                     'host': ip,
#                     'port': int(port)
#                 })
        
#         # Redis cluster configuration
#         self.cluster_config = {
#             'startup_nodes': self.startup_nodes,
#             'decode_responses': True,
#             'skip_full_coverage_check': True,
#             'health_check_interval': 30,
#             'socket_connect_timeout': 5,
#             'socket_timeout': 5,
#             'retry_on_timeout': True,
#             'max_connections': 50
#         }
    
#     def get_cluster(self):
#         """Get async Redis cluster connection"""
#         return aioredis.RedisCluster(**self.cluster_config)

# # Global async Redis cluster instance
# redis_cluster = RedisConfig().get_cluster()

import os
from redis.asyncio.cluster import RedisCluster

class RedisConfig:
    """Redis Cluster configuration for market data storage"""
    
    def __init__(self):
        # Redis cluster nodes from environment
        redis_hosts = os.getenv(
            "REDIS_HOSTS", 
            "127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003"
        ).split(",")

        # For redis-py >= 5, we only pass one startup node (others discovered automatically)
        first_host, first_port = redis_hosts[0].split(":")

        self.cluster_config = {
            "host": first_host.strip(),
            "port": int(first_port),
            "decode_responses": True,
            "health_check_interval": 30,
            "socket_connect_timeout": 5,
            "socket_timeout": 5,
            "max_connections": 50,
        }
    
    def get_cluster(self):
        """Get async Redis cluster connection"""
        return RedisCluster(**self.cluster_config)

# Global async Redis cluster instance
redis_cluster = RedisConfig().get_cluster()
