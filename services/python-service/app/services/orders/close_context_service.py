import time
import logging
from typing import Optional, Dict
from app.config.redis_config import redis_cluster

logger = logging.getLogger(__name__)

# TTL for close context (5 minutes - enough for provider processing)
CLOSE_CONTEXT_TTL = 300


class CloseContextService:
    """Service to manage close operation context for proper close_message attribution."""
    
    @staticmethod
    async def set_close_context(order_id: str, context: str, initiator: str = None) -> bool:
        """
        Set close context for an order.
        
        Args:
            order_id: Canonical order ID
            context: Close context (AUTOCUTOFF, ADMIN_CLOSED, USER_CLOSED)
            initiator: Optional initiator info (admin_id, user_id, etc.)
        
        Returns:
            bool: True if successfully set
        """
        try:
            key = f"close_context:{order_id}"
            value = {
                "context": context,
                "initiator": initiator or "system",
                "timestamp": str(int(time.time()))
            }
            
            await redis_cluster.hset(key, mapping=value)
            await redis_cluster.expire(key, CLOSE_CONTEXT_TTL)
            
            logger.info(
                "[CLOSE_CONTEXT:SET] order_id=%s context=%s initiator=%s ttl=%ds",
                order_id, context, initiator, CLOSE_CONTEXT_TTL
            )
            return True
            
        except Exception as e:
            logger.error(
                "[CLOSE_CONTEXT:SET_FAILED] order_id=%s context=%s error=%s",
                order_id, context, str(e)
            )
            return False
    
    @staticmethod
    async def get_close_context(order_id: str) -> Optional[Dict[str, str]]:
        """
        Get close context for an order.
        
        Args:
            order_id: Canonical order ID
            
        Returns:
            dict: Context info or None if not found/expired
        """
        try:
            key = f"close_context:{order_id}"
            context_data = await redis_cluster.hgetall(key)
            
            if context_data:
                logger.info(
                    "[CLOSE_CONTEXT:GET] order_id=%s context=%s initiator=%s",
                    order_id, context_data.get("context"), context_data.get("initiator")
                )
                return context_data
            else:
                logger.debug("[CLOSE_CONTEXT:NOT_FOUND] order_id=%s", order_id)
                return None
                
        except Exception as e:
            logger.error(
                "[CLOSE_CONTEXT:GET_FAILED] order_id=%s error=%s",
                order_id, str(e)
            )
            return None
    
    @staticmethod
    async def clear_close_context(order_id: str) -> bool:
        """Clear close context after processing."""
        try:
            key = f"close_context:{order_id}"
            deleted = await redis_cluster.delete(key)
            if deleted:
                logger.debug("[CLOSE_CONTEXT:CLEARED] order_id=%s", order_id)
            else:
                logger.debug("[CLOSE_CONTEXT:ALREADY_EXPIRED] order_id=%s", order_id)
            return True
        except Exception as e:
            logger.error(
                "[CLOSE_CONTEXT:CLEAR_FAILED] order_id=%s error=%s",
                order_id, str(e)
            )
            return False


# Convenience functions for common contexts
async def set_autocutoff_context(order_id: str, user_type: str, user_id: str) -> bool:
    """Set context for autocutoff liquidation."""
    return await CloseContextService.set_close_context(
        order_id, 
        "AUTOCUTOFF", 
        f"liquidation_engine:{user_type}:{user_id}"
    )


async def set_admin_close_context(order_id: str, admin_id: str, admin_email: str) -> bool:
    """Set context for admin-initiated close."""
    return await CloseContextService.set_close_context(
        order_id, 
        "ADMIN_CLOSED", 
        f"admin:{admin_id}:{admin_email}"
    )


async def set_user_close_context(order_id: str, user_id: str, user_type: str) -> bool:
    """Set context for user-initiated close."""
    return await CloseContextService.set_close_context(
        order_id, 
        "USER_CLOSED", 
        f"user:{user_type}:{user_id}"
    )
