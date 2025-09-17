import os
from datetime import datetime
from typing import Optional

from app.config.redis_config import redis_cluster


async def _incr_with_ttl(key: str, ttl_seconds: int = 3 * 24 * 60 * 60) -> int:
    seq = await redis_cluster.incr(key)
    if seq == 1:
        try:
            await redis_cluster.expire(key, ttl_seconds)
        except Exception:
            pass
    return int(seq)


def _yyyymmdd(dt: Optional[datetime] = None) -> str:
    d = dt or datetime.utcnow()
    return f"{d.year:04d}{d.month:02d}{d.day:02d}"


def _pad(num: int, size: int) -> str:
    s = str(int(num))
    return s.zfill(size)


async def generate_close_id() -> str:
    date_str = _yyyymmdd()
    seq = await _incr_with_ttl(f"cls_seq:{date_str}")
    return f"CLS{date_str}{_pad(seq, 6)}"


async def generate_stoploss_cancel_id() -> str:
    date_str = _yyyymmdd()
    seq = await _incr_with_ttl(f"slc_seq:{date_str}")
    return f"SLC{date_str}{_pad(seq, 6)}"


async def generate_takeprofit_cancel_id() -> str:
    date_str = _yyyymmdd()
    seq = await _incr_with_ttl(f"tpc_seq:{date_str}")
    return f"TPC{date_str}{_pad(seq, 6)}"
