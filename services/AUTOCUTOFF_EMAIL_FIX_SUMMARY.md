# AutoCutoff Email Spam Fix Summary

## Issue Identified
The autocutoff system was sending 30+ emails at a time instead of limiting to one email every 3 hours when margin level is below threshold.

## Root Causes

### 1. **Incorrect TTL Duration** 
**File:** `services/python-service/app/services/autocutoff/watcher.py`
**Problem:** TTL was set to 600 seconds (10 minutes) instead of 3 hours
```python
# BEFORE (Line 11)
ALERT_TTL_SEC = 600  # 10 minutes

# AFTER 
ALERT_TTL_SEC = 10800  # 3 hours (3 * 60 * 60)
```

### 2. **Race Condition in Alert Checking**
**Problem:** Multiple portfolio update events could trigger simultaneous checks before the TTL key was set
**Solution:** Implemented atomic check-and-set using Redis `SET` with `NX` flag

## Fixes Applied

### 1. **Extended TTL to 3 Hours**
- Changed `ALERT_TTL_SEC` from 600 seconds (10 minutes) to 10,800 seconds (3 hours)
- This ensures alerts are only sent once every 3 hours per user

### 2. **Atomic Rate Limiting**
**Before:**
```python
# Non-atomic check-then-set (race condition prone)
already = await redis_cluster.get(alert_key)
if already:
    return
# ... send email ...
await redis_cluster.set(alert_key, "1", ex=ALERT_TTL_SEC)
```

**After:**
```python
# Atomic check-and-set (race condition safe)
already_set = await redis_cluster.set(alert_key, "1", ex=ALERT_TTL_SEC, nx=True)
if not already_set:
    # Alert already sent within TTL period
    return
```

### 3. **Email Failure Recovery**
- If email sending fails, the TTL key is removed so the system can retry later
- Prevents permanent blocking when email service is temporarily unavailable

## Technical Details

### Alert Flow
1. **Portfolio Update** → Redis pub/sub message → `_handle_user()`
2. **Margin Check** → If 50% ≤ margin < 100%, enter alert zone
3. **Rate Limiting** → Atomic `SET alert_key NX EX 10800` 
4. **Email Sending** → Only if key was successfully set (not already exists)
5. **Cleanup** → Remove key if email fails, keep if successful

### Redis Keys Used
- `autocutoff:alert_sent:{user_type}:{user_id}` - TTL key (3 hours)
- `autocutoff:liquidating:{user_type}:{user_id}` - Liquidation lock

### Margin Thresholds
- **≥ 100%**: Clear all flags (safe zone)
- **50% - 99%**: Send alert (once every 3 hours)
- **< 50%**: Trigger liquidation

## Expected Behavior After Fix

### Before Fix:
- User with 80% margin level receives emails every 10 minutes
- 30+ emails sent in a few hours due to frequent portfolio updates
- Race conditions could cause multiple simultaneous emails

### After Fix:
- User with 80% margin level receives **1 email every 3 hours maximum**
- No duplicate emails due to race conditions
- System retries if email service is temporarily down

## Files Modified

1. **`services/python-service/app/services/autocutoff/watcher.py`**
   - Fixed TTL duration from 10 minutes to 3 hours
   - Implemented atomic rate limiting with Redis SET NX
   - Added email failure recovery logic
   - Enhanced error handling and logging

## Testing Recommendations

1. **Verify TTL**: Check Redis keys have 3-hour expiration
2. **Race Condition**: Test with multiple simultaneous portfolio updates
3. **Email Failure**: Test behavior when email service is down
4. **Margin Recovery**: Verify flags are cleared when margin returns to safe levels

## Result

The autocutoff email system now properly limits alerts to **once every 3 hours per user** regardless of how many portfolio updates occur, eliminating the email spam issue while maintaining proper margin monitoring functionality.
