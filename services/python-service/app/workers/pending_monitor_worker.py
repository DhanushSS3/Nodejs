import asyncio
import logging
import signal
import sys

from app.services.pending.pending_monitor import start_pending_monitor

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def _run_forever():
    # Start the pending monitor (subscribes to Redis pub/sub and triggers on price updates)
    await start_pending_monitor()

    # Keep the process alive until a shutdown signal is received
    stop_event = asyncio.Event()

    def _handle_signal():
        try:
            stop_event.set()
        except Exception:
            pass

    loop = asyncio.get_running_loop()
    for sig in (getattr(signal, 'SIGINT', None), getattr(signal, 'SIGTERM', None)):
        if sig is not None:
            try:
                loop.add_signal_handler(sig, _handle_signal)
            except NotImplementedError:
                # Windows may not support add_signal_handler for SIGTERM
                pass

    logger.info("Pending monitor worker started (standalone)")
    await stop_event.wait()
    logger.info("Pending monitor worker stopping...")


def main():
    try:
        asyncio.run(_run_forever())
    except KeyboardInterrupt:
        logger.info("Pending monitor worker interrupted by user")
        sys.exit(0)


if __name__ == "__main__":
    main()
