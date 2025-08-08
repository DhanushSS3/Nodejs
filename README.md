# Redis Cluster (3 Masters + 2 Slaves Each)

## Requirements

- Docker
- Docker Compose
- Git

## Steps to Run

### 1. Clone the Repository

```bash
git clone https://your-repo-link.git
cd redis-cluster

2. Start All Redis Nodes

docker-compose up -d

3. Create Redis Cluster
bash redis-cluster-entrypoint.sh


4. Verify Cluster
docker exec -it redis-node-1 redis-cli -p 7001 cluster nodes


Try commands like:

> set key1 value1
> get key1
