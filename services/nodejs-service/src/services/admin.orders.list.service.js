const { Op, fn, col, where } = require('sequelize');
const {
  LiveUserOrder,
  LiveUser,
  StrategyProviderOrder,
  StrategyProviderAccount,
  CopyFollowerOrder,
  CopyFollowerAccount,
} = require('../models');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SORT = { field: 'created_at', direction: 'DESC' };
const STATUS_FILTER = ['OPEN'];

/**
 * Normalize pagination inputs
 */
function normalizePagination(pageRaw, pageSizeRaw) {
  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(pageSizeRaw, 10) || DEFAULT_PAGE_SIZE),
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * Normalize sort
 */
function normalizeSort(sortByRaw, sortDirRaw) {
  const allowedFields = new Set([
    'created_at',
    'updated_at',
    'symbol',
    'order_price',
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

/**
 * Fetch open (and queued) orders for admin views with pagination + filters
 */
async function getAdminOpenOrders({
  entityType,
  group,
  search,
  page,
  pageSize,
  sortBy,
  sortDir,
  admin,
}) {
  const config = ENTITY_CONFIG[entityType];
  if (!config) {
    throw new Error('Invalid entity type requested');
  }

  const { OrderModel, include, groupAlias, countryAlias, serialize, searchColumns } = config;
  const pagination = normalizePagination(page, pageSize);
  const sort = normalizeSort(sortBy, sortDir);

  const whereClause = {
    order_status: { [Op.in]: STATUS_FILTER },
  };

  if (group) {
    applyGroupFilter(whereClause, group, groupAlias);
  }

  if (admin?.role !== 'superadmin' && admin?.country_id) {
    applyCountryScope(whereClause, admin.country_id, countryAlias);
  }

  const searchFilter = buildSearchFilters(search, searchColumns);
  if (searchFilter) {
    whereClause[Op.and] = whereClause[Op.and] || [];
    whereClause[Op.and].push(searchFilter);
  }

  const dbSortField = config.columnMap?.[sort.field] || sort.field;
  const order = [[dbSortField, sort.direction]];

  const { rows, count } = await OrderModel.findAndCountAll({
    where: whereClause,
    include,
    limit: pagination.pageSize,
    offset: pagination.offset,
    order,
    distinct: true,
    subQuery: false,
  });

  const totalPages = Math.ceil(count / pagination.pageSize) || 1;

  return {
    pagination: {
      page: pagination.page,
      page_size: pagination.pageSize,
      total: count,
      total_pages: totalPages,
      has_next_page: pagination.page < totalPages,
      has_previous_page: pagination.page > 1,
    },
    filters: {
      group: group || null,
      search: search || null,
      sort_by: sort.field,
      sort_dir: sort.direction,
    },
    orders: rows.map(serialize),
  };
}

module.exports = {
  getAdminOpenOrders,
};
