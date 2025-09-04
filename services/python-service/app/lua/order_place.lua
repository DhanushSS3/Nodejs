-- Atomic order placement script
-- Inputs (KEYS):
-- 1) user_config_key
-- 2) order_key
-- 3) portfolio_key
--
-- Inputs (ARGV):
-- 1) user_type
-- 2) user_id
-- 3) order_id
-- 4) symbol
-- 5) order_fields_json
-- 6) single_order_margin_usd
-- 7) recomputed_user_used_margin_usd
--
-- Notes on Redis Cluster:
-- In a Redis Cluster, EVAL requires that all KEYS[] target the same hash slot. Ensure
-- the caller supplies KEYS that share a common hash tag (e.g., {user_type:user_id}).
-- This script will not construct keys internally and relies entirely on KEYS[] to
-- avoid CROSSSLOT errors. Only user-scoped keys are accepted here to guarantee they
-- reside in the same slot. Non-user-scoped updates (e.g., symbol_holders) must be
-- performed by the caller outside this script after a successful atomic placement.

local cjson = cjson

local user_type = ARGV[1]
local user_id = ARGV[2]
local order_id = ARGV[3]
local symbol = ARGV[4]
local order_fields_json = ARGV[5]
local single_order_margin_usd = ARGV[6]
local recomputed_user_used_margin_usd = ARGV[7]

local resp = { ok = false, reason = nil }

-- Validate KEYS (expect exactly the three user-scoped keys)
if #KEYS < 3 then
  resp.reason = 'insufficient_keys'
  return cjson.encode(resp)
end

-- Keys (provided by caller; must be same slot in cluster)
local user_config_key = KEYS[1]
local order_key = KEYS[2]
local portfolio_key = KEYS[3]

-- Optional: validate that all KEYS share the same hash tag if any tag is used
local function _extract_tag(k)
  if not k then return nil end
  local s, e = string.find(k, "{.-}")
  if s and e and e > s + 1 then
    return string.sub(k, s + 1, e - 1)
  end
  return nil
end

local key_list = { user_config_key, order_key, portfolio_key }
local expected_tag = nil
local any_tag = false

-- Pass 1: find first tag if any
for i = 1, #key_list do
  local t = _extract_tag(key_list[i])
  if t then
    expected_tag = t
    any_tag = true
    break
  end
end

-- Pass 2: if any tag is used, enforce all provided keys have the same tag
if any_tag then
  for i = 1, #key_list do
    local k = key_list[i]
    if k and tostring(k) ~= '' then
      local t = _extract_tag(k)
      if not t then
        resp.reason = 'missing_hash_tag'
        return cjson.encode(resp)
      end
      if t ~= expected_tag then
        resp.reason = 'inconsistent_hash_tags'
        return cjson.encode(resp)
      end
    end
  end
end

-- Validate user exists
if redis.call('EXISTS', user_config_key) == 0 then
  resp.reason = 'user_not_found'
  return cjson.encode(resp)
end

-- Ensure order not already present
if redis.call('EXISTS', order_key) == 1 then
  resp.reason = 'order_exists'
  return cjson.encode(resp)
end

-- Re-check leverage > 0
local lev = redis.call('HGET', user_config_key, 'leverage')
if (not lev) or (tonumber(lev) or 0) <= 0 then
  resp.reason = 'invalid_leverage'
  return cjson.encode(resp)
end

-- Group keys are not handled within this script to avoid cross-slot access in cluster

-- Decode order fields JSON
local ok, order_fields = pcall(cjson.decode, order_fields_json or '{}')
if (not ok) or (type(order_fields) ~= 'table') then
  resp.reason = 'invalid_order_fields'
  return cjson.encode(resp)
end

-- Ensure minimal fields
order_fields['order_id'] = order_fields['order_id'] or order_id
order_fields['symbol'] = order_fields['symbol'] or symbol

-- Write order hash (HSET mapping)
local args = { order_key }
for k, v in pairs(order_fields) do
  table.insert(args, tostring(k))
  table.insert(args, tostring(v))
end
redis.call('HSET', unpack(args))

-- Note: symbol_holders update must be performed by the caller after success

-- Update user portfolio used margin if provided
if recomputed_user_used_margin_usd and tostring(recomputed_user_used_margin_usd) ~= '' then
  redis.call('HSET', portfolio_key, 'used_margin', tostring(recomputed_user_used_margin_usd))
end

-- Event streaming is not handled here to avoid cross-slot access; perform externally if needed

resp.ok = true
return cjson.encode(resp)
