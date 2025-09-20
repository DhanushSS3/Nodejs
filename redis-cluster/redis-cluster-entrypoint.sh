#!/bin/sh
set -e
PORT=$1

# Paths
CONF_DIR="/usr/local/etc/redis"
CONF_FILE="/data/redis.conf"
TEMPLATE_FILE="$CONF_DIR/redis-cluster.tmpl.conf"

# Ensure directories exist
mkdir -p "$CONF_DIR" /data

# Build redis.conf: set port and data dir first, then append template
{
  echo "port $PORT"
  echo "dir /data"
} > "$CONF_FILE"

cat "$TEMPLATE_FILE" >> "$CONF_FILE"

# Start Redis with the explicit config file (unique per node)
exec redis-server "$CONF_FILE"