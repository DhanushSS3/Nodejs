const amqp = require('amqplib');
const logger = require('../logger.service');
const LiveUserOrder = require('../../models/liveUserOrder.model');
const DemoUserOrder = require('../../models/demoUserOrder.model');
const { updateUserUsedMargin } = require('../user.margin.service');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1/';
const ORDER_DB_UPDATE_QUEUE = process.env.ORDER_DB_UPDATE_QUEUE || 'order_db_update_queue';

function getOrderModel(userType) {
  return userType === 'live' ? LiveUserOrder : DemoUserOrder;
}

async function applyDbUpdate(msg) {
  const { type, order_id, user_id, user_type, order_status, order_price, margin, used_margin_usd } = msg || {};
  if (!order_id || !user_id || !user_type) {
    throw new Error('Missing required fields in DB update message');
  }

  const OrderModel = getOrderModel(String(user_type));

  // Upsert and update
  const [row] = await OrderModel.findOrCreate({
    where: { order_id: String(order_id) },
    defaults: {
      order_id: String(order_id),
      order_user_id: parseInt(String(user_id), 10),
      order_status: String(order_status || 'OPEN'),
      order_price: order_price != null ? String(order_price) : '0',
      order_quantity: '0',
      margin: margin != null ? String(margin) : '0',
      status: undefined,
      placed_by: 'user'
    }
  });

  const updateFields = {};
  if (order_status) updateFields.order_status = String(order_status);
  if (order_price != null) updateFields.order_price = String(order_price);
  if (margin != null) updateFields.margin = String(margin);

  if (Object.keys(updateFields).length > 0) {
    await row.update(updateFields);
  }

  // Update user's used margin in SQL, if provided
  if (used_margin_usd != null) {
    try {
      await updateUserUsedMargin({ userType: String(user_type), userId: parseInt(String(user_id), 10), usedMargin: used_margin_usd });
    } catch (e) {
      logger.error('Failed to persist used margin in SQL', { error: e.message, user_id, user_type });
      // Do not fail the message solely due to mirror write; treat as non-fatal
    }
  }
}

async function startOrdersDbConsumer() {
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    const ch = await conn.createChannel();
    await ch.assertQueue(ORDER_DB_UPDATE_QUEUE, { durable: true });
    await ch.prefetch(32);

    logger.info(`Orders DB consumer connected. Listening on ${ORDER_DB_UPDATE_QUEUE}`);

    ch.consume(ORDER_DB_UPDATE_QUEUE, async (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString('utf8'));
        await applyDbUpdate(payload);
        ch.ack(msg);
      } catch (err) {
        logger.error('Orders DB consumer failed to handle message', { error: err.message });
        // Requeue to retry transient failures
        ch.nack(msg, false, true);
      }
    }, { noAck: false });

    // Handle connection errors
    conn.on('error', (e) => logger.error('AMQP connection error', { error: e.message }));
    conn.on('close', () => logger.warn('AMQP connection closed'));
  } catch (err) {
    logger.error('Failed to start Orders DB consumer', { error: err.message });
    // Let the process continue; a supervisor can retry or we can add a backoff/retry here
  }
}

module.exports = { startOrdersDbConsumer };
