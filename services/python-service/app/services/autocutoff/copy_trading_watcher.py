"""
Copy Trading Autocutoff Watcher Extension

This module extends the existing autocutoff system to handle copy trading accounts:
- Strategy Provider accounts (strategy_provider user type)
- Copy Follower accounts (copy_follower user type)

Key Features:
- Same autocutoff thresholds as live accounts
- Cascade liquidation: when strategy provider hits autocutoff, all followers are liquidated
- Independent follower monitoring: followers can hit autocutoff independently
- Inherits existing watcher functionality
"""

import asyncio
import logging
from typing import Dict, Any, Optional

from app.config.redis_config import redis_cluster, redis_pubsub_client
from app.services.autocutoff.liquidation import LiquidationEngine
from app.services.autocutoff.watcher import AutoCutoffWatcher

logger = logging.getLogger(__name__)


class CopyTradingAutoCutoffWatcher(AutoCutoffWatcher):
    """
    Extended AutoCutoff Watcher for Copy Trading
    Inherits all functionality from base watcher and adds copy trading specific logic
    """
    
    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(__name__)
        
    async def _handle_user(self, user_key: str):
        """
        Extended user handler that supports copy trading user types
        Handles: live, demo, strategy_provider, copy_follower
        """
        try:
            # Parse user_type and user_id from Redis key
            if ':' not in user_key:
                self.logger.warning(f"Invalid user_key format: {user_key}")
                return
                
            user_type, user_id = user_key.split(':', 1)
            
            # Handle all user types including copy trading
            if user_type not in ['live', 'demo', 'strategy_provider', 'copy_follower']:
                self.logger.debug(f"Unsupported user_type: {user_type}")
                return
                
            # Get margin level for the user
            margin_level = await self._get_margin_level(user_type, user_id)
            
            if margin_level is None:
                self.logger.warning(f"Could not get margin level for {user_key}")
                return
                
            self.logger.debug(f"Margin level for {user_key}: {margin_level}%")
            
            # Same thresholds for all account types (as requested)
            critical_threshold = 10.0  # Same as live accounts
            warning_threshold = 50.0   # Same as live accounts
            
            if margin_level < critical_threshold:
                # Critical: Initiate liquidation
                await self._initiate_liquidation(user_type, user_id)
                
                # Special cascade logic for strategy providers
                if user_type == 'strategy_provider':
                    await self._cascade_liquidation_to_followers(user_id)
                    
            elif margin_level < warning_threshold:
                # Warning: Send alert
                await self._send_margin_alert(user_type, user_id, margin_level)
                
        except Exception as e:
            self.logger.error(f"Error handling user {user_key}: {e}")
            
    async def _cascade_liquidation_to_followers(self, strategy_provider_id: str):
        """
        Liquidate all followers when strategy provider hits autocutoff
        This implements the cascade liquidation requirement
        """
        try:
            self.logger.info(f"Initiating cascade liquidation for strategy provider {strategy_provider_id}")
            
            # Get all active followers for this strategy provider
            # Using a Redis set to track active copy relationships
            followers_key = f"copy_master_followers:{strategy_provider_id}:active"
            follower_ids = await redis_cluster.smembers(followers_key)
            
            if not follower_ids:
                self.logger.info(f"No active followers found for strategy provider {strategy_provider_id}")
                return
                
            self.logger.info(f"Found {len(follower_ids)} followers to liquidate for strategy provider {strategy_provider_id}")
            
            # Liquidate each follower
            liquidation_results = []
            for follower_id in follower_ids:
                try:
                    result = await self._initiate_liquidation('copy_follower', follower_id)
                    liquidation_results.append({
                        'follower_id': follower_id,
                        'success': result,
                        'error': None
                    })
                    self.logger.info(f"Cascade liquidation initiated for follower {follower_id}")
                except Exception as e:
                    liquidation_results.append({
                        'follower_id': follower_id,
                        'success': False,
                        'error': str(e)
                    })
                    self.logger.error(f"Failed to liquidate follower {follower_id}: {e}")
                    
            # Log summary
            successful = len([r for r in liquidation_results if r['success']])
            failed = len([r for r in liquidation_results if not r['success']])
            
            self.logger.info(f"Cascade liquidation completed for strategy provider {strategy_provider_id}: "
                           f"{successful} successful, {failed} failed")
                           
            # Store cascade liquidation record for audit
            await self._record_cascade_liquidation(strategy_provider_id, liquidation_results)
            
        except Exception as e:
            self.logger.error(f"Cascade liquidation failed for strategy provider {strategy_provider_id}: {e}")
            
    async def _record_cascade_liquidation(self, strategy_provider_id: str, results: list):
        """
        Record cascade liquidation event for audit purposes
        """
        try:
            cascade_record = {
                'strategy_provider_id': strategy_provider_id,
                'timestamp': self._now_ms(),
                'total_followers': len(results),
                'successful_liquidations': len([r for r in results if r['success']]),
                'failed_liquidations': len([r for r in results if not r['success']]),
                'results': results
            }
            
            # Store in Redis for audit (with TTL)
            audit_key = f"cascade_liquidation_audit:{strategy_provider_id}:{self._now_ms()}"
            await redis_cluster.hset(audit_key, mapping={
                'data': str(cascade_record),
                'timestamp': cascade_record['timestamp']
            })
            await redis_cluster.expire(audit_key, 86400 * 30)  # Keep for 30 days
            
        except Exception as e:
            self.logger.error(f"Failed to record cascade liquidation audit: {e}")
            
    async def _get_margin_level(self, user_type: str, user_id: str) -> Optional[float]:
        """
        Get margin level for any user type (including copy trading accounts)
        Reuses the existing logic from parent class
        """
        try:
            # Use the existing portfolio structure
            portfolio_key = f"user_portfolio:{{{user_type}:{user_id}}}"
            portfolio_data = await redis_cluster.hgetall(portfolio_key)
            
            if not portfolio_data:
                self.logger.debug(f"No portfolio data found for {user_type}:{user_id}")
                return None
                
            # Extract margin level from portfolio
            margin_level_str = portfolio_data.get('margin_level')
            if margin_level_str is None:
                return None
                
            margin_level = float(margin_level_str)
            return margin_level
            
        except Exception as e:
            self.logger.error(f"Error getting margin level for {user_type}:{user_id}: {e}")
            return None
            
    async def _initiate_liquidation(self, user_type: str, user_id: str) -> bool:
        """
        Initiate liquidation for any user type
        Uses the existing liquidation engine with user type support
        """
        try:
            # Check if liquidation is already in progress
            liquidation_flag_key = f"liquidation_in_progress:{user_type}:{user_id}"
            is_in_progress = await redis_cluster.get(liquidation_flag_key)
            
            if is_in_progress:
                self.logger.info(f"Liquidation already in progress for {user_type}:{user_id}")
                return True
                
            # Set liquidation flag (with TTL to prevent stuck flags)
            await redis_cluster.setex(liquidation_flag_key, 300, "1")  # 5 minutes TTL
            
            try:
                # Use the existing liquidation engine
                liquidation_engine = LiquidationEngine()
                result = await liquidation_engine.run(user_type, user_id)
                
                self.logger.info(f"Liquidation completed for {user_type}:{user_id}: {result}")
                return True
                
            finally:
                # Clear liquidation flag
                await redis_cluster.delete(liquidation_flag_key)
                
        except Exception as e:
            self.logger.error(f"Failed to initiate liquidation for {user_type}:{user_id}: {e}")
            return False
            
    async def _send_margin_alert(self, user_type: str, user_id: str, margin_level: float):
        """
        Send margin alert for any user type
        Reuses existing alert logic with user type support
        """
        try:
            # Check rate limiting
            alert_key = f"margin_alert_sent:{user_type}:{user_id}"
            alert_sent = await redis_cluster.get(alert_key)
            
            if alert_sent:
                self.logger.debug(f"Margin alert already sent for {user_type}:{user_id}")
                return
                
            # Set rate limiting flag (1 hour)
            await redis_cluster.setex(alert_key, 3600, "1")
            
            # Log the alert (in production, this would send email/SMS)
            self.logger.warning(f"MARGIN ALERT: {user_type}:{user_id} margin level at {margin_level}%")
            
            # Store alert record
            alert_record_key = f"margin_alerts:{user_type}:{user_id}:{self._now_ms()}"
            await redis_cluster.hset(alert_record_key, mapping={
                'user_type': user_type,
                'user_id': user_id,
                'margin_level': str(margin_level),
                'timestamp': str(self._now_ms()),
                'alert_type': 'margin_warning'
            })
            await redis_cluster.expire(alert_record_key, 86400 * 7)  # Keep for 7 days
            
        except Exception as e:
            self.logger.error(f"Failed to send margin alert for {user_type}:{user_id}: {e}")
            
    def _now_ms(self) -> int:
        """Get current timestamp in milliseconds"""
        import time
        return int(time.time() * 1000)


# Global instance for copy trading autocutoff
copy_trading_autocutoff_watcher = CopyTradingAutoCutoffWatcher()


async def start_copy_trading_autocutoff_watcher():
    """Start the copy trading autocutoff watcher"""
    await copy_trading_autocutoff_watcher.start_autocutoff_watcher()


async def stop_copy_trading_autocutoff_watcher():
    """Stop the copy trading autocutoff watcher"""
    await copy_trading_autocutoff_watcher.stop_autocutoff_watcher()
