# Copy Follower SL/TP Settings API

## Overview
This API allows copy followers to modify their default stop loss (SL) and take profit (TP) settings that will be automatically applied to future orders. These settings do not affect existing open orders.

## Endpoints

### 1. Get SL/TP Settings
**GET** `/api/copy-trading/accounts/{id}/sl-tp-settings`

Retrieve the current SL/TP settings for a copy follower account.

#### Parameters
- `id` (path, required): Copy follower account ID (positive integer)

#### Headers
- `Authorization: Bearer {jwt_token}` (required)

#### Response (200 OK)
```json
{
  "success": true,
  "message": "SL/TP settings retrieved successfully",
  "data": {
    "account_info": {
      "id": 123,
      "account_name": "My EURUSD Strategy Copy",
      "account_number": "CF1730890123456",
      "investment_amount": 5000.00,
      "strategy_provider": {
        "id": 456,
        "strategy_name": "Conservative Growth Strategy",
        "account_number": "SP1730890123456"
      }
    },
    "stop_loss_settings": {
      "mode": "percentage",
      "percentage": 2.5,
      "amount": null
    },
    "take_profit_settings": {
      "mode": "amount",
      "percentage": null,
      "amount": 100.00
    }
  }
}
```

### 2. Update SL/TP Settings
**PUT** `/api/copy-trading/accounts/{id}/sl-tp-settings`

Update the SL/TP settings for a copy follower account. These settings will apply to future orders only.

#### Parameters
- `id` (path, required): Copy follower account ID (positive integer)

#### Headers
- `Authorization: Bearer {jwt_token}` (required)
- `Content-Type: application/json`

#### Request Body
```json
{
  "copy_sl_mode": "percentage",
  "sl_percentage": 2.5,
  "copy_tp_mode": "amount", 
  "tp_amount": 100.00
}
```

#### Request Fields
- `copy_sl_mode` (optional): Stop loss mode
  - `"none"`: No stop loss
  - `"percentage"`: Stop loss based on percentage
  - `"amount"`: Stop loss based on fixed amount
- `sl_percentage` (conditional): Required when `copy_sl_mode` is `"percentage"`
  - Range: 0.01 - 100.00
- `sl_amount` (conditional): Required when `copy_sl_mode` is `"amount"`
  - Minimum: 0.01
- `copy_tp_mode` (optional): Take profit mode
  - `"none"`: No take profit
  - `"percentage"`: Take profit based on percentage
  - `"amount"`: Take profit based on fixed amount
- `tp_percentage` (conditional): Required when `copy_tp_mode` is `"percentage"`
  - Range: 0.01 - 1000.00
- `tp_amount` (conditional): Required when `copy_tp_mode` is `"amount"`
  - Minimum: 0.01

#### Response (200 OK)
```json
{
  "success": true,
  "message": "SL/TP settings updated successfully. These settings will apply to future orders.",
  "data": {
    "account_id": 123,
    "account_name": "My EURUSD Strategy Copy",
    "stop_loss_settings": {
      "mode": "percentage",
      "percentage": 2.5,
      "amount": null
    },
    "take_profit_settings": {
      "mode": "amount",
      "percentage": null,
      "amount": 100.00
    }
  },
  "updated_fields": ["copy_sl_mode", "sl_percentage", "copy_tp_mode", "tp_amount"]
}
```

## SL/TP Calculation Logic

### Percentage Mode
- **Stop Loss (BUY)**: `SL = entry_price * (1 - sl_percentage/100)`
- **Stop Loss (SELL)**: `SL = entry_price * (1 + sl_percentage/100)`
- **Take Profit (BUY)**: `TP = entry_price * (1 + tp_percentage/100)`
- **Take Profit (SELL)**: `TP = entry_price * (1 - tp_percentage/100)`

### Amount Mode
- **Stop Loss**: Price movement calculated as `amount / (lot_size * contract_size)`
- **Take Profit**: Price movement calculated as `amount / (lot_size * contract_size)`

## Error Responses

### 400 Bad Request - Validation Error
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    "copy_sl_mode must be one of: none, percentage, amount",
    "sl_percentage is required when copy_sl_mode is percentage"
  ]
}
```

### 401 Unauthorized
```json
{
  "success": false,
  "message": "Authentication required"
}
```

### 404 Not Found
```json
{
  "success": false,
  "message": "Copy follower account not found or does not belong to you"
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "message": "Failed to update SL/TP settings",
  "error": "Database connection error"
}
```

## Usage Examples

### Example 1: Set 2% Stop Loss and 5% Take Profit
```bash
curl -X PUT "https://api.livefxhub.com/api/copy-trading/accounts/123/sl-tp-settings" \
  -H "Authorization: Bearer your_jwt_token" \
  -H "Content-Type: application/json" \
  -d '{
    "copy_sl_mode": "percentage",
    "sl_percentage": 2.0,
    "copy_tp_mode": "percentage",
    "tp_percentage": 5.0
  }'
```

### Example 2: Set $50 Stop Loss, No Take Profit
```bash
curl -X PUT "https://api.livefxhub.com/api/copy-trading/accounts/123/sl-tp-settings" \
  -H "Authorization: Bearer your_jwt_token" \
  -H "Content-Type: application/json" \
  -d '{
    "copy_sl_mode": "amount",
    "sl_amount": 50.00,
    "copy_tp_mode": "none"
  }'
```

### Example 3: Disable Both SL and TP
```bash
curl -X PUT "https://api.livefxhub.com/api/copy-trading/accounts/123/sl-tp-settings" \
  -H "Authorization: Bearer your_jwt_token" \
  -H "Content-Type: application/json" \
  -d '{
    "copy_sl_mode": "none",
    "copy_tp_mode": "none"
  }'
```

### Example 4: Get Current Settings
```bash
curl -X GET "https://api.livefxhub.com/api/copy-trading/accounts/123/sl-tp-settings" \
  -H "Authorization: Bearer your_jwt_token"
```

## Important Notes

1. **Future Orders Only**: These settings only apply to new orders placed after the update. Existing open orders are not affected.

2. **Account Ownership**: Users can only modify settings for their own copy follower accounts.

3. **Active Accounts Only**: Settings can only be modified for active copy follower accounts (status=1, is_active=1).

4. **Mutual Exclusivity**: When setting percentage mode, the amount field is cleared and vice versa.

5. **Validation**: All inputs are validated for proper ranges and conditional requirements.

6. **Logging**: All changes are logged for audit purposes with user ID, account ID, and updated fields.

7. **Real-time Application**: Settings are applied immediately to the next order that gets copied from the strategy provider.
