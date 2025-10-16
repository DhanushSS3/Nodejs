const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const sequelize = require('./src/config/db');
const LiveUserOrder = require('./src/models/liveUserOrder.model');
const DemoUserOrder = require('./src/models/demoUserOrder.model');
const LiveUser = require('./src/models/liveUser.model');
const DemoUser = require('./src/models/demoUser.model');
const swapSchedulerService = require('./src/services/swap.scheduler.service');
const swapCalculationService = require('./src/services/swap.calculation.service');
const groupsCacheService = require('./src/services/groups.cache.service');
const { redisCluster, redisReadyPromise } = require('./config/redis');
const { Op } = require('sequelize');

async function runDiagnostics() {
  try {
    console.log('🔍 SWAP SYSTEM DIAGNOSTICS');
    console.log('=' .repeat(50));
    
    // 1. Database Connection
    await sequelize.authenticate();
    console.log('✅ Database connected');
    
    // 2. Check scheduler status
    const schedulerStatus = swapSchedulerService.getStatus();
    console.log('\n📅 SCHEDULER STATUS:');
    console.log(`  - Is Scheduled: ${schedulerStatus.isScheduled}`);
    console.log(`  - Is Running: ${schedulerStatus.isRunning}`);
    console.log(`  - Next Run: ${schedulerStatus.nextRun}`);
    
    // 3. Check open orders
    console.log('\n📊 OPEN ORDERS ANALYSIS:');
    console.log(`Current date: ${new Date().toDateString()} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()]})`);
    
    const liveOrders = await LiveUserOrder.findAll({
      where: {
        order_status: {
          [Op.in]: ['OPEN', 'PENDING', 'PARTIAL_FILLED']
        }
      },
      include: [{
        model: LiveUser,
        as: 'user',
        attributes: ['group'],
        required: true
      }],
      limit: 5
    });
    
    const demoOrders = await DemoUserOrder.findAll({
      where: {
        order_status: {
          [Op.in]: ['OPEN', 'PENDING', 'PARTIAL_FILLED']
        }
      },
      include: [{
        model: DemoUser,
        as: 'user',
        attributes: ['group'],
        required: true
      }],
      limit: 5
    });
    
    console.log(`  - Live Orders: ${liveOrders.length} found`);
    console.log(`  - Demo Orders: ${demoOrders.length} found`);
    
    // Check for crypto orders specifically
    const allOrders = [...liveOrders, ...demoOrders];
    const cryptoOrders = [];
    const nonCryptoOrders = [];
    
    for (const order of allOrders) {
      try {
        const groupConfig = await groupsCacheService.getGroup(order.user.group, order.symbol);
        if (groupConfig) {
          if (parseInt(groupConfig.type) === 4) {
            cryptoOrders.push({...order.dataValues, group_config: groupConfig});
          } else {
            nonCryptoOrders.push({...order.dataValues, group_config: groupConfig});
          }
        }
      } catch (err) {
        console.log(`    ⚠️  Could not get group config for ${order.symbol}:${order.user.group}`);
      }
    }
    
    console.log(`  - Crypto Orders (type=4): ${cryptoOrders.length} found`);
    console.log(`  - Non-Crypto Orders: ${nonCryptoOrders.length} found`);
    
    if (cryptoOrders.length > 0) {
      console.log(`\n🪙 CRYPTO ORDERS DETAILS:`);
      cryptoOrders.slice(0, 3).forEach((order, i) => {
        console.log(`    ${i+1}. ${order.order_id} - ${order.symbol} (${order.order_type}) - Group: ${order.user.group}`);
        console.log(`       Swap Buy: ${order.group_config.swap_buy}, Swap Sell: ${order.group_config.swap_sell}`);
      });
    }
    
    // 4. Test swap calculation for sample orders
    if (liveOrders.length > 0) {
      console.log('\n🧮 TESTING SWAP CALCULATIONS:');
      const testOrder = liveOrders[0];
      testOrder.group_name = testOrder.user.group;
      testOrder.user_type = 'live';
      
      console.log(`\nTesting order: ${testOrder.order_id}`);
      console.log(`  - Symbol: ${testOrder.symbol}`);
      console.log(`  - Group: ${testOrder.group_name}`);
      console.log(`  - Order Type: ${testOrder.order_type}`);
      console.log(`  - Quantity: ${testOrder.order_quantity}`);
      console.log(`  - Status: ${testOrder.order_status}`);
      
        // Test for different dates
      const dates = [
        new Date(), // Today
        new Date('2025-10-15'), // Tuesday  
        new Date('2025-10-13'), // Sunday
        new Date('2025-10-12'), // Saturday
      ];
      
      // Check if this is a crypto order
      const testGroupConfig = await groupsCacheService.getGroup(testOrder.group_name, testOrder.symbol);
      const isCrypto = testGroupConfig && parseInt(testGroupConfig.type) === 4;
      console.log(`  🪙 Is Crypto Order: ${isCrypto} (type=${testGroupConfig?.type})`);
      
      for (const testDate of dates) {
        const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][testDate.getDay()];
        const isWeekend = testDate.getDay() === 0 || testDate.getDay() === 6;
        console.log(`\n  📅 Testing date: ${testDate.toDateString()} (${dayName}) ${isWeekend ? '🏖️ WEEKEND' : '💼 WEEKDAY'}`);
        
        if (isCrypto && isWeekend) {
          console.log(`    🪙 CRYPTO on WEEKEND - Should process!`);
        } else if (!isCrypto && isWeekend) {
          console.log(`    💱 NON-CRYPTO on WEEKEND - Should skip!`);
        }
        
        try {
          // Check group config
          const groupConfig = await groupsCacheService.getGroup(testOrder.group_name, testOrder.symbol);
          if (!groupConfig) {
            console.log(`    ❌ No group config found for ${testOrder.group_name}:${testOrder.symbol}`);
            continue;
          }
          
          console.log(`    ✅ Group config found:`);
          console.log(`      - Type: ${groupConfig.type} (${groupConfig.type == 4 ? 'CRYPTO' : 'NON-CRYPTO'})`);
          console.log(`      - Swap Type: ${groupConfig.swap_type}`);
          console.log(`      - Swap Buy: ${groupConfig.swap_buy}`);
          console.log(`      - Swap Sell: ${groupConfig.swap_sell}`);
          console.log(`      - Contract Size: ${groupConfig.contract_size}`);
          console.log(`      - Show Points: ${groupConfig.show_points}`);
          console.log(`      - Profit Currency: ${groupConfig.profit}`);
          
          // Test shouldApplySwap
          const shouldApply = swapCalculationService.shouldApplySwap(groupConfig, testDate);
          console.log(`    - Should Apply Swap: ${shouldApply}`);
          
          if (shouldApply) {
            // Check swap rates
            const swapRate = testOrder.order_type.toLowerCase() === 'buy' 
              ? parseFloat(groupConfig.swap_buy) 
              : parseFloat(groupConfig.swap_sell);
            console.log(`    - Swap Rate (${testOrder.order_type}): ${swapRate}`);
            
            if (swapRate === 0) {
              console.log(`    ❌ ISSUE: Swap rate is 0 for ${testOrder.order_type} orders`);
            } else {
              const swapCharge = await swapCalculationService.calculateSwapCharge(testOrder, testDate);
              console.log(`    - Calculated Swap: ${swapCharge}`);
              
              if (swapCharge === 0) {
                console.log(`    ❌ ISSUE: Swap charge calculated as 0 despite non-zero rate`);
              }
            }
          } else {
            if (groupConfig.type == 4) {
              console.log(`    ❌ CRITICAL: Crypto instrument should process daily but shouldApplySwap returned false!`);
            }
          }
          
        } catch (error) {
          console.log(`    ❌ Error: ${error.message}`);
        }
      }
    }
    
    // 5. Test manual trigger for weekend (if crypto orders exist)
    if (cryptoOrders.length > 0) {
      console.log('\n🚀 TESTING WEEKEND MANUAL TRIGGER FOR CRYPTO:');
      const weekendDate = new Date('2025-10-13'); // Sunday
      console.log(`Testing with date: ${weekendDate.toDateString()} (Sunday)`);
      
      try {
        const result = await swapSchedulerService.triggerManual(weekendDate, 'diagnostic-test', 'Weekend crypto swap test');
        console.log('✅ Weekend manual trigger completed');
      } catch (error) {
        console.log(`❌ Weekend manual trigger failed: ${error.message}`);
      }
    } else {
      console.log('\n⚠️  No crypto orders found - skipping weekend test');
    }
    
    // 6. Summary and recommendations
    console.log('\n📋 SUMMARY & RECOMMENDATIONS:');
    console.log('=' .repeat(50));
    
    if (cryptoOrders.length === 0) {
      console.log('⚠️  NO CRYPTO ORDERS FOUND');
      console.log('   - Check if you have crypto instruments (type=4) in your groups');
      console.log('   - Verify crypto orders exist in OPEN status');
    } else {
      console.log(`✅ Found ${cryptoOrders.length} crypto orders`);
      
      // Check if crypto orders have valid swap rates
      const cryptoWithZeroRates = cryptoOrders.filter(order => 
        parseFloat(order.group_config.swap_buy) === 0 && parseFloat(order.group_config.swap_sell) === 0
      );
      
      if (cryptoWithZeroRates.length > 0) {
        console.log(`❌ ISSUE: ${cryptoWithZeroRates.length} crypto orders have ZERO swap rates`);
        console.log('   - Check group configurations for swap_buy and swap_sell values');
      }
    }
    
    if (!schedulerStatus.isScheduled) {
      console.log('❌ SCHEDULER NOT RUNNING');
      console.log('   - Call POST /api/admin/swap/scheduler/start to activate');
    }
    
    console.log('\n✅ DIAGNOSTICS COMPLETE');
    
  } catch (error) {
    console.error('❌ Diagnostic failed:', error);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
}

// Run diagnostics
runDiagnostics();
