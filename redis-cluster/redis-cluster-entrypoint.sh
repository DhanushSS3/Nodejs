# echo "Creating Redis Cluster..."yes yes | docker exec -i redis-node-1 redis-cli --cluster create \172.28.0.2:7001 172.28.0.3:7002 172.28.0.4:7003 \172.28.0.5:7004 172.28.0.6:7005 172.28.0.7:7006 \172.28.0.8:7007 172.28.0.9:7008 172.28.0.10:7009 \--cluster-replicas 2echo "Cluster created!"

#!/bin/sh
PORT=$1
echo "port $PORT" > /data/redis.conf
cat /usr/local/etc/redis/redis-cluster.tmpl.conf | sed "s/PORT/$PORT/g" >> /data/redis.conf
redis-server /data/redis.conf