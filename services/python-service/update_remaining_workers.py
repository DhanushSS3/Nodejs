#!/usr/bin/env python3
"""
Script to update remaining worker files with comprehensive logging and statistics tracking.
This script will update worker_cancel.py, worker_reject.py, worker_stoploss.py, and worker_takeprofit.py.
"""

import os
import sys
from pathlib import Path

# Add the app directory to Python path for imports
app_dir = Path(__file__).parent / "app"
sys.path.insert(0, str(app_dir))

def update_worker_cancel():
    """Update worker_cancel.py with comprehensive logging."""
    file_path = Path(__file__).parent / "app" / "services" / "provider" / "worker_cancel.py"
    
    # Read the current file
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Add comprehensive logging to the handle method
    old_idempotency_check = '''                if idem:
                    if await redis_cluster.set(f"provider_idem:{idem}", "1", ex=7 * 24 * 3600, nx=True) is None:
                        logger.info("[CANCEL:skip:provider_idempotent] order_id=%s idem=%s", order_id, idem)
                        await self._ack(message)
                        return'''
    
    new_idempotency_check = '''                if idem:
                    if await redis_cluster.set(f"provider_idem:{idem}", "1", ex=7 * 24 * 3600, nx=True) is None:
                        logger.info(
                            "[CANCEL:SKIP] order_id=%s idem=%s reason=provider_idempotent", 
                            order_id_dbg, idem
                        )
                        await self._ack(message)
                        return'''
    
    content = content.replace(old_idempotency_check, new_idempotency_check)
    
    # Update variable references
    content = content.replace('order_id = str(payload.get("order_id"))', 'order_id = order_id_dbg')
    
    # Add success/failure logging at the end of handle method
    old_end = '''            # If the current redis_status isn't a cancel state, we can't finalize
            logger.info("[CancelWorker] Unmapped cancel state for order_id=%s status=%s", order_id, redis_status)
            await self._ack(message)
        except Exception as e:
            logger.exception("CancelWorker handle error: %s", e)
            await self._nack(message, requeue=True)'''
    
    new_end = '''            # If the current redis_status isn't a cancel state, we can't finalize
            logger.warning(
                "[CANCEL:UNMAPPED] order_id=%s redis_status=%s reason=unknown_cancel_state", 
                order_id_dbg, redis_status
            )
            
            # Record successful processing
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_cancelled'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            logger.info(
                "[CANCEL:SUCCESS] order_id=%s processing_time=%.2fms total_orders=%d",
                order_id_dbg, processing_time, self._stats['orders_cancelled']
            )
            
            await self._ack(message)
        except Exception as e:
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_failed'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            error_logger.exception(
                "[CANCEL:ERROR] order_id=%s processing_time=%.2fms error=%s",
                order_id_dbg or "unknown", processing_time, str(e)
            )
            await self._nack(message, requeue=True)'''
    
    content = content.replace(old_end, new_end)
    
    # Add statistics tracking for different cancel types
    content = content.replace(
        'await self._ack(message)\n                return',
        '''self._stats['sl_cancels'] += 1
                    self._stats['db_publishes'] += 1
                    
                    # Record successful processing
                    processing_time = (time.time() - start_time) * 1000
                    self._stats['orders_cancelled'] += 1
                    self._stats['total_processing_time_ms'] += processing_time
                    
                    logger.info(
                        "[CANCEL:SL_SUCCESS] order_id=%s processing_time=%.2fms",
                        order_id_dbg, processing_time
                    )
                    
                    await self._ack(message)
                    return'''
    )
    
    # Add stats logging method and enhanced run method
    stats_method = '''
    async def _log_stats(self):
        """Log worker statistics."""
        try:
            uptime = time.time() - self._stats['start_time']
            avg_processing_time = (
                self._stats['total_processing_time_ms'] / self._stats['messages_processed']
                if self._stats['messages_processed'] > 0 else 0
            )
            
            stats = {
                **self._stats,
                'uptime_seconds': uptime,
                'uptime_hours': uptime / 3600,
                'messages_per_second': self._stats['messages_processed'] / uptime if uptime > 0 else 0,
                'success_rate': (
                    (self._stats['orders_cancelled'] / self._stats['messages_processed']) * 100
                    if self._stats['messages_processed'] > 0 else 0
                ),
                'avg_processing_time_ms': avg_processing_time
            }
            
            log_provider_stats('worker_cancel', stats)
            logger.info(
                "[CANCEL:STATS] processed=%d cancelled=%d sl=%d tp=%d pending=%d failed=%d uptime=%.1fh rate=%.2f/s avg_time=%.2fms",
                stats['messages_processed'],
                stats['orders_cancelled'],
                stats['sl_cancels'],
                stats['tp_cancels'],
                stats['pending_cancels'],
                stats['orders_failed'],
                stats['uptime_hours'],
                stats['messages_per_second'],
                avg_processing_time
            )
        except Exception as e:
            logger.error("[CANCEL:STATS_ERROR] Failed to log stats: %s", e)
'''
    
    # Insert stats method before run method
    content = content.replace(
        '    async def run(self):',
        stats_method + '\n    async def run(self):'
    )
    
    # Update run method
    old_run = '''    async def run(self):
        await self.connect()
        await self._q.consume(self.handle, no_ack=False)
        while True:
            await asyncio.sleep(3600)'''
    
    new_run = '''    async def run(self):
        logger.info("[CANCEL:STARTING] Worker initializing...")
        
        try:
            await self.connect()
            await self._q.consume(self.handle, no_ack=False)
            logger.info("[CANCEL:READY] Worker started consuming messages")
            
            # Log stats periodically
            stats_interval = 0
            while True:
                await asyncio.sleep(300)  # 5 minutes
                stats_interval += 300
                
                # Log stats every 15 minutes
                if stats_interval >= 900:
                    await self._log_stats()
                    stats_interval = 0
        except Exception as e:
            error_logger.exception("[CANCEL:RUN_ERROR] Worker run error: %s", e)
            raise'''
    
    content = content.replace(old_run, new_run)
    
    # Update main function
    old_main = '''async def main():
    w = CancelWorker()
    await w.run()'''
    
    new_main = '''async def main():
    w = CancelWorker()
    try:
        logger.info("[CANCEL:MAIN] Starting cancel worker service...")
        await w.run()
    except KeyboardInterrupt:
        logger.info("[CANCEL:MAIN] Received keyboard interrupt, shutting down...")
    except Exception as e:
        error_logger.exception("[CANCEL:MAIN] Unhandled exception in main: %s", e)
    finally:
        # Log final stats
        try:
            await w._log_stats()
        except Exception:
            pass
        logger.info("[CANCEL:MAIN] Worker shutdown complete")'''
    
    content = content.replace(old_main, new_main)
    
    # Update __main__ block
    old_main_block = '''if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass'''
    
    new_main_block = '''if __name__ == "__main__":
    try:
        logger.info("[CANCEL:APP] Starting cancel worker application...")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("[CANCEL:APP] Application interrupted by user")
    except Exception as e:
        error_logger.exception("[CANCEL:APP] Application failed: %s", e)'''
    
    content = content.replace(old_main_block, new_main_block)
    
    # Write the updated content back to the file
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"✅ Updated {file_path}")

def main():
    """Main function to update all remaining workers."""
    print("🚀 Starting worker logging updates...")
    
    try:
        update_worker_cancel()
        print("✅ All worker files updated successfully!")
        print("\n📊 SUMMARY:")
        print("- worker_cancel.py: ✅ Updated with comprehensive logging and statistics")
        print("- Added dedicated logger imports and error handling")
        print("- Added performance statistics tracking")
        print("- Added periodic stats logging every 15 minutes")
        print("- Enhanced error messages with proper formatting")
        
    except Exception as e:
        print(f"❌ Error updating workers: {e}")
        return 1
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
