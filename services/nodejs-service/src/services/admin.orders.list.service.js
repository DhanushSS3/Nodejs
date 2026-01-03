const { Op, fn, col, where } = require('sequelize');
const {
  LiveUserOrder,
  LiveUser,
  StrategyProviderOrder,
  StrategyProviderAccount,
  CopyFollowerOrder,
  CopyFollowerAccount,
} = require('../models');

const DEFAULT_SORT = { field: 'created_at', direction: 'DESC' };
const STATUS_FILTER = ['OPEN'];

/**
 * Normalize sort
 */
function normalizeSort(sortByRaw, sortDirRaw) {
  const allowedFields = new Set([
    'created_at',
    'order_quantity',
  ]);
  const field = allowedFields.has(String(sortByRaw)) ? String(sortByRaw) : DEFAULT_SORT.field;
  const dir = String(sortDirRaw || '').toUpperCase() === 'ASC' ? 'ASC' : DEFAULT_SORT.direction;
  return { field, direction: dir };
}

function likeFilter(column, term) {
  return where(fn('LOWER', col(column)), {
    [Op.like]: `%${term.toLowerCase()}%`,
  });
}

const ENTITY_CONFIG = {
  live: {
    OrderModel: LiveUserOrder,
    include: [
      {
        model: LiveUser,
        as: 'user',
        attributes: ['id', 'name', 'email', 'account_number', 'group', 'country_id'],
        required: true,
      },
    ],
    groupAlias: 'user',
    countryAlias: 'user',
    instrumentColumn: 'symbol',
    serialize(order) {
      const user = order.user || {};
      return {
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: order.order_price,
        order_quantity: order.order_quantity,
        contract_value: order.contract_value,
        margin: order.margin,
        stop_loss: order.stop_loss,
        take_profit: order.take_profit,
        commission: order.commission,
        swap: order.swap,
        created_at: order.created_at,
        updated_at: order.updated_at,
        group: user.group,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          account_number: user.account_number,
        },
      };
    },
    searchColumns: ['order_id', 'symbol', 'user.name', 'user.email', 'user.account_number'],
  },
  strategy_provider: {
    OrderModel: StrategyProviderOrder,
    include: [
      {
        model: StrategyProviderAccount,
        as: 'strategyAccount',
        attributes: ['id', 'strategy_name', 'account_number', 'group', 'user_id'],
        required: true,
        include: [
          {
            model: LiveUser,
            as: 'owner',
            attributes: ['id', 'name', 'country_id'],
            required: false,
          },
        ],
      },
    ],
    groupAlias: 'strategyAccount',
    countryAlias: 'strategyAccount.owner',
    instrumentColumn: 'order_company_name',
    columnMap: {
      symbol: 'order_company_name',
    },
    serialize(order) {
      const account = order.strategyAccount || {};
      const owner = account.owner || {};
      return {
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: order.order_price,
        order_quantity: order.order_quantity,
        contract_value: order.contract_value,
        margin: order.margin,
        stop_loss: order.stop_loss,
        take_profit: order.take_profit,
        commission: order.commission,
        swap: order.swap,
        created_at: order.created_at,
        updated_at: order.updated_at,
        group: account.group,
        strategy_provider: {
          id: account.id,
          strategy_name: account.strategy_name,
          account_number: account.account_number,
          owner_name: owner.name,
        },
      };
    },
    searchColumns: [
      'order_id',
      'order_company_name',
      'strategyAccount.strategy_name',
      'strategyAccount.account_number',
    ],
  },
  copy_follower: {
    OrderModel: CopyFollowerOrder,
    include: [
      {
        model: CopyFollowerAccount,
        as: 'copyAccount',
        attributes: [
          'id',
          'account_name',
          'account_number',
          'group',
          'strategy_provider_id',
          'user_id',
        ],
        required: true,
        include: [
          {
            model: LiveUser,
            as: 'owner',
            attributes: ['id', 'name', 'country_id'],
            required: false,
          },
        ],
      },
      {
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        attributes: ['id', 'strategy_name', 'account_number'],
        required: false,
      },
    ],
    groupAlias: 'copyAccount',
    countryAlias: 'copyAccount.owner',
    instrumentColumn: 'symbol',
    serialize(order) {
      const copyAccount = order.copyAccount || {};
      const owner = copyAccount.owner || {};
      const strategyProvider = order.strategyProvider || {};
      return {
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: order.order_price,
        order_quantity: order.order_quantity,
        contract_value: order.contract_value,
        margin: order.margin,
        stop_loss: order.stop_loss,
        take_profit: order.take_profit,
        commission: order.commission,
        swap: order.swap,
        master_order_id: order.master_order_id,
        created_at: order.created_at,
        updated_at: order.updated_at,
        group: copyAccount.group,
        copy_follower: {
          id: copyAccount.id,
          account_name: copyAccount.account_name,
          account_number: copyAccount.account_number,
          owner_name: owner.name,
        },
        strategy_provider: {
          id: strategyProvider.id,
          strategy_name: strategyProvider.strategy_name,
          account_number: strategyProvider.account_number,
        },
      };
    },
    searchColumns: [
      'order_id',
      'symbol',
      'copyAccount.account_name',
      'copyAccount.account_number',
      'strategyProvider.strategy_name',
      'strategyProvider.account_number',
    ],
  },
};

function buildSearchFilters(search, columns) {
  if (!search) return null;
  const term = search.toLowerCase();
  const likeClause = `%${term}%`;
  const filters = columns.map((column) => likeFilter(column, term));
  return { [Op.or]: filters };
}

function applyGroupFilter(whereClause, groupValue, alias) {
  if (!groupValue) return;
  whereClause[Op.and] = whereClause[Op.and] || [];
  whereClause[Op.and].push({ [`$${alias}.group$`]: groupValue });
}

function applyCountryScope(whereClause, countryId, alias) {
  if (!countryId) return;
  whereClause[Op.and] = whereClause[Op.and] || [];
  whereClause[Op.and].push({ [`$${alias}.country_id$`]: countryId });
}

function applyInstrumentFilter(whereClause, instrumentValue, columnName) {
  if (!instrumentValue) return;
  const column = columnName || 'symbol';
  whereClause[Op.and] = whereClause[Op.and] || [];
  whereClause[Op.and].push({ [column]: instrumentValue });
}

function sortOrders(orders, sort) {
  const directionFactor = sort.direction === 'ASC' ? 1 : -1;
  const extractValue = (order) => {
    if (sort.field === 'order_quantity') {
      return Number(order.order_quantity) || 0;
    }
    const ts = Date.parse(order.created_at || order.updated_at || order.createdAt || order.updatedAt || '');
    return Number.isNaN(ts) ? 0 : ts;
  };
  return orders.sort((a, b) => {
    const aVal = extractValue(a);
    const bVal = extractValue(b);
    if (aVal === bVal) return 0;
    return aVal > bVal ? directionFactor : -directionFactor;
  });
}

async function fetchOrdersForEntityType(entityType, options) {
  const config = ENTITY_CONFIG[entityType];
  if (!config) {
    return [];
  }

  const {
    group,
    instrument,
    search,
    sort,
    admin,
  } = options;

  const { OrderModel, include, groupAlias, countryAlias, instrumentColumn, serialize, columnMap } = config;

  const whereClause = {
    order_status: { [Op.in]: STATUS_FILTER },
  };

  if (group) {
    applyGroupFilter(whereClause, group, groupAlias);
  }

  if (instrument) {
    applyInstrumentFilter(whereClause, instrument, columnMap?.symbol || instrumentColumn || 'symbol');
  }

  if (search) {
    whereClause[Op.and] = whereClause[Op.and] || [];
    whereClause[Op.and].push({
      order_id: { [Op.like]: `%${search}%` },
    });
  }

  if (admin?.role !== 'superadmin' && admin?.country_id) {
    applyCountryScope(whereClause, admin.country_id, countryAlias);
  }

  const dbSortField = columnMap?.[sort.field] || sort.field;
  const order = [[dbSortField, sort.direction]];

  const rows = await OrderModel.findAll({
    where: whereClause,
    include,
    order,
    distinct: true,
    subQuery: false,
  });

  return rows.map((row) => ({
    user_type: entityType,
    ...serialize(row),
  }));
}

/**
 * Fetch open orders for admin views with filters
 */
async function getAdminOpenOrders({
  entityTypes,
  group,
  search,
  sortBy,
  sortDir,
  instrument,
  admin,
}) {
  const typesToQuery = Array.isArray(entityTypes) && entityTypes.length
    ? entityTypes.filter((type) => type !== 'demo')
    : ['live', 'strategy_provider', 'copy_follower'];
  const sort = normalizeSort(sortBy, sortDir);

  const allOrders = [];
  for (const type of typesToQuery) {
    const orders = await fetchOrdersForEntityType(type, {
      group,
      instrument,
      search,
      sort,
      admin,
    });
    allOrders.push(...orders);
  }

  const sortedOrders = sortOrders(allOrders, sort);

  return {
    filters: {
      user_types: typesToQuery,
      group: group || null,
      instrument: instrument || null,
      sort_by: sort.field,
      sort_dir: sort.direction,
    },
    orders: sortedOrders,
    total: sortedOrders.length,
  };
}

module.exports = {
  getAdminOpenOrders,
};
