import math
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def _round2(x: float) -> float:
    return float(f"{x:.2f}")


def compute_entry_commission(
    *,
    commission_rate: Optional[float],
    commission_type: Optional[int],
    commission_value_type: Optional[int],
    quantity: float,
    order_price: float,
    contract_size: Optional[float],
) -> float:
    """
    Entry commission applies when commission_type in [0 (every trade), 1 (in)].
    - If commission_value_type == 0 (Per lot): commission = quantity * commission_rate
    - If commission_value_type == 1 (Percent): commission = (commission_rate/100) * contract_size * quantity * order_price
    Returns 0.0 if not applicable or missing config.
    """
    reason = None
    try:
        if commission_rate is None or commission_type is None or commission_value_type is None:
            reason = "missing_config"
            return 0.0
        if commission_type not in (0, 1):
            reason = "type_not_entry"
            return 0.0
        if commission_value_type == 0:
            result = _round2(float(quantity) * float(commission_rate))
            # Log only if computation still yields zero to aid debugging
            if result == 0.0:
                try:
                    logger.info(
                        {
                            "type": "COMMISSION_DEBUG_ENTRY",
                            "mode": "per_lot",
                            "commission_rate": commission_rate,
                            "commision": commission_rate,  # alias for legacy spelling
                            "commission_type": commission_type,
                            "commission_value_type": commission_value_type,
                            "quantity": quantity,
                            "order_price": order_price,
                            "contract_size": contract_size,
                            "result": result,
                            "reason": "computed_zero",
                        }
                    )
                except Exception:
                    pass
            return result
        elif commission_value_type == 1:
            if contract_size is None:
                reason = "missing_contract_size"
                return 0.0
            base = float(commission_rate) / 100.0
            result = _round2(base * float(contract_size) * float(quantity) * float(order_price))
            if result == 0.0:
                try:
                    logger.info(
                        {
                            "type": "COMMISSION_DEBUG_ENTRY",
                            "mode": "percent",
                            "commission_rate": commission_rate,
                            "commision": commission_rate,  # alias for legacy spelling
                            "commission_type": commission_type,
                            "commission_value_type": commission_value_type,
                            "quantity": quantity,
                            "order_price": order_price,
                            "contract_size": contract_size,
                            "result": result,
                            "reason": "computed_zero",
                        }
                    )
                except Exception:
                    pass
            return result
        reason = "unknown_value_type"
        return 0.0
    except Exception:
        reason = "exception"
        return 0.0
    finally:
        # When we return zero due to an early reason, emit a one-shot debug log
        if reason is not None:
            try:
                logger.info(
                    {
                        "type": "COMMISSION_DEBUG_ENTRY",
                        "mode": "n/a",
                        "commission_rate": commission_rate,
                        "commision": commission_rate,  # alias for legacy spelling
                        "commission_type": commission_type,
                        "commission_value_type": commission_value_type,
                        "quantity": quantity,
                        "order_price": order_price,
                        "contract_size": contract_size,
                        "result": 0.0,
                        "reason": reason,
                    }
                )
            except Exception:
                pass


def compute_exit_commission(
    *,
    commission_rate: Optional[float],
    commission_type: Optional[int],
    commission_value_type: Optional[int],
    quantity: float,
    close_price: float,
    contract_size: Optional[float],
) -> float:
    """
    Exit commission applies when commission_type in [0 (every trade), 2 (out)].
    - If commission_value_type == 0 (Per lot): commission = quantity * commission_rate
    - If commission_value_type == 1 (Percent): commission = (commission_rate/100) * contract_size * quantity * close_price
    Returns 0.0 if not applicable or missing config.
    """
    try:
        if commission_rate is None or commission_type is None or commission_value_type is None:
            return 0.0
        if commission_type not in (0, 2):
            return 0.0
        if commission_value_type == 0:
            return _round2(float(quantity) * float(commission_rate))
        elif commission_value_type == 1:
            if contract_size is None:
                return 0.0
            base = float(commission_rate) / 100.0
            return _round2(base * float(contract_size) * float(quantity) * float(close_price))
        return 0.0
    except Exception:
        return 0.0
