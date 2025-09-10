import math
from typing import Optional


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
    try:
        if commission_rate is None or commission_type is None or commission_value_type is None:
            return 0.0
        if commission_type not in (0, 1):
            return 0.0
        if commission_value_type == 0:
            return _round2(float(quantity) * float(commission_rate))
        elif commission_value_type == 1:
            if contract_size is None:
                return 0.0
            base = float(commission_rate) / 100.0
            return _round2(base * float(contract_size) * float(quantity) * float(order_price))
        return 0.0
    except Exception:
        return 0.0


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
