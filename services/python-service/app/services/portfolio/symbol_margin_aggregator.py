from typing import List, Dict, Any


def compute_symbol_margin(orders_for_symbol: List[Dict[str, Any]]) -> float:
    """
    Compute hedged margin per symbol.

    Input order dict must contain:
      - order_type: 'BUY' | 'SELL'
      - order_quantity: float
      - order_margin_usd: float (per-order margin already converted to USD)

    Algorithm:
      total_buy_qty = sum(qty for BUY)
      total_sell_qty = sum(qty for SELL)
      net_qty = max(total_buy_qty, total_sell_qty)
      per_lot_margins = [order_margin_usd / order_quantity for each order if order_quantity > 0]
      highest_margin_per_lot = max(per_lot_margins)
      symbol_total_margin = highest_margin_per_lot * net_qty

    Returns float (USD)
    """
    if not orders_for_symbol:
        return 0.0

    total_buy_qty = 0.0
    total_sell_qty = 0.0
    per_lot_margins: List[float] = []

    for od in orders_for_symbol:
        try:
            qty = float(od.get("order_quantity") or 0)
            margin = od.get("order_margin_usd")
            order_type = (od.get("order_type") or "").upper()

            if order_type == "BUY":
                total_buy_qty += qty
            elif order_type == "SELL":
                total_sell_qty += qty

            if qty > 0 and margin is not None:
                per_lot = float(margin) / qty
                if per_lot >= 0:
                    per_lot_margins.append(per_lot)
        except Exception:
            continue

    if not per_lot_margins:
        return 0.0

    net_qty = max(total_buy_qty, total_sell_qty)
    if net_qty <= 0:
        return 0.0

    highest_margin_per_lot = max(per_lot_margins)
    return highest_margin_per_lot * net_qty
