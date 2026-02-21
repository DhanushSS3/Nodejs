/**
 * fix_pending_order_swap.js
 *
 * ONE-TIME CLEANUP SCRIPT
 *
 * Root cause: swap scheduler was incorrectly including PENDING (limit/stop) orders
 * when computing daily swap. These orders have not been executed yet (they are
 * waiting to trigger) so they should NEVER accumulate swap charges.
 *
 * This script:
 *  1. Resets swap = 0 on all PENDING orders in the database (live + demo + copy + SP)
 *  2. Updates the corresponding Redis user_holdings hashes to match
 *  3. Sets the affected users' portfolio (user_portfolio) back to a sane state
 *     (equity = balance, free_margin = balance, open_pnl = 0) when they have
 *     no actual OPEN orders.
 *
 * Run ONCE after deploying the swap_scheduler fix:
 *   node src/scripts/fix_pending_order_swap.js
 */

'use strict';

require('dotenv').config();

const { Op } = require('sequelize');
const sequelize = require('../config/db');
const { redisCluster } = require('../../config/redis');
const logger = require('../services/logger.service');

const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');

const ORDER_TYPES = [
    { model: LiveUserOrder, userModel: LiveUser, userType: 'live' },
    { model: DemoUserOrder, userModel: DemoUser, userType: 'demo' },
    { model: CopyFollowerOrder, userModel: CopyFollowerAccount, userType: 'copy_follower' },
    { model: StrategyProviderOrder, userModel: StrategyProviderAccount, userType: 'strategy_provider' },
];

async function fixPendingOrderSwaps() {
    console.log('=== fix_pending_order_swap.js starting ===\n');
    let totalFixed = 0;
    let totalUsersFixed = 0;

    for (const { model, userModel, userType } of ORDER_TYPES) {
        console.log(`\n--- Processing ${userType} PENDING orders ---`);

        // 1. Find all PENDING orders that have non-zero swap
        const pendingOrders = await model.findAll({
            where: {
                order_status: 'PENDING',
                swap: { [Op.ne]: 0 }
            },
            attributes: ['id', 'order_id', 'order_user_id', 'symbol', 'swap', 'order_status']
        });

        if (pendingOrders.length === 0) {
            console.log(`  No PENDING orders with non-zero swap found for ${userType}.`);
            continue;
        }

        console.log(`  Found ${pendingOrders.length} PENDING orders with non-zero swap.`);

        // Track which users are affected
        const affectedUserIds = new Set();

        // 2. Reset swap = 0 in DB
        const transaction = await sequelize.transaction();
        try {
            for (const order of pendingOrders) {
                console.log(`  [DB] Resetting swap for ${userType} order ${order.order_id} (user ${order.order_user_id}): swap was ${order.swap}`);
                await model.update(
                    { swap: 0 },
                    { where: { id: order.id }, transaction }
                );
                affectedUserIds.add(String(order.order_user_id));
            }
            await transaction.commit();
            console.log(`  [DB] Committed swap reset for ${pendingOrders.length} PENDING orders.`);
            totalFixed += pendingOrders.length;
        } catch (err) {
            await transaction.rollback();
            console.error(`  [DB] ROLLBACK - failed to reset swap for ${userType}: ${err.message}`);
            continue;
        }

        // 3. Update Redis user_holdings for each order
        for (const order of pendingOrders) {
            const hashTag = `${userType}:${order.order_user_id}`;
            const holdingKey = `user_holdings:{${hashTag}}:${order.order_id}`;
            try {
                await redisCluster.hset(holdingKey, 'swap', '0');
                console.log(`  [Redis] Reset swap on ${holdingKey}`);
            } catch (redisErr) {
                console.warn(`  [Redis] Failed to reset swap on ${holdingKey}: ${redisErr.message}`);
            }
        }

        // 4. For each affected user, check if they have any OPEN orders.
        //    If not, normalize their portfolio snapshot.
        for (const userId of affectedUserIds) {
            try {
                const openOrderCount = await model.count({
                    where: {
                        order_user_id: userId,
                        order_status: { [Op.in]: ['OPEN', 'PARTIAL_FILLED'] }
                    }
                });

                if (openOrderCount > 0) {
                    console.log(`  [Portfolio] User ${userType}:${userId} has ${openOrderCount} OPEN order(s) — skipping portfolio normalization.`);
                    continue;
                }

                // No real open positions — fetch wallet_balance and normalize
                const user = await userModel.findByPk(parseInt(userId), { attributes: ['wallet_balance'] });
                const balance = parseFloat(user?.wallet_balance || 0);

                const portfolioKey = `user_portfolio:{${userType}:${userId}}`;
                const exists = await redisCluster.exists(portfolioKey);
                if (!exists) {
                    console.log(`  [Portfolio] user_portfolio key missing for ${userType}:${userId}, skipping.`);
                    continue;
                }

                await redisCluster.hset(portfolioKey, {
                    used_margin_executed: '0.0',
                    used_margin_all: '0.0',
                    used_margin: '0.0',
                    equity: String(balance),
                    free_margin: String(balance),
                    open_pnl: '0.0',
                    total_pl: '0.0',
                    margin_level: '0.0',
                    ts: String(Date.now()),
                    calc_status: 'ok',
                    degraded_fields: ''
                });

                console.log(`  [Portfolio] Normalized user_portfolio for ${userType}:${userId} (balance=${balance})`);
                totalUsersFixed++;
            } catch (userFixErr) {
                console.warn(`  [Portfolio] Error normalizing portfolio for ${userType}:${userId}: ${userFixErr.message}`);
            }
        }
    }

    console.log(`\n=== Done ===`);
    console.log(`Total PENDING orders fixed (swap reset to 0): ${totalFixed}`);
    console.log(`Total user portfolios normalized:              ${totalUsersFixed}`);
}

fixPendingOrderSwaps()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
