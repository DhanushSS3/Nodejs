const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Group = sequelize.define('Group', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  symbol: {
    type: DataTypes.STRING(255),
    allowNull: false,
    validate: {
      notEmpty: true,
      len: [1, 255]
    }
  },
  name: {
    type: DataTypes.STRING(255),
    allowNull: false,
    validate: {
      notEmpty: true,
      len: [1, 255]
    }
  },
  commision_type: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      isInt: true
    }
  },
  commision_value_type: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      isInt: true
    }
  },
  type: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      isInt: true
    }
  },
  pip_currency: {
    type: DataTypes.STRING(255),
    allowNull: false,
    validate: {
      notEmpty: true,
      len: [1, 255]
    }
  },
  show_points: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: {
      isInt: true
    }
  },
  swap_buy: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false,
    validate: {
      isDecimal: true
    }
  },
  swap_sell: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false,
    validate: {
      isDecimal: true
    }
  },
  commision: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false,
    validate: {
      isDecimal: true
    }
  },
  margin: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false,
    validate: {
      isDecimal: true
    }
  },
  spread: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false,
    validate: {
      isDecimal: true
    }
  },
  deviation: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false,
    validate: {
      isDecimal: true
    }
  },
  min_lot: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false,
    validate: {
      isDecimal: true,
      min: 0
    }
  },
  max_lot: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false,
    validate: {
      isDecimal: true,
      min: 0
    }
  },
  pips: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false,
    validate: {
      isDecimal: true
    }
  },
  spread_pip: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: true,
    validate: {
      isDecimal: true
    }
  },
  contract_size: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true,
    validate: {
      isDecimal: true
    }
  },
  profit: {
    type: DataTypes.STRING(10),
    allowNull: true,
    validate: {
      len: [0, 10]
    }
  },
  swap_type: {
    type: DataTypes.STRING(50),
    allowNull: true,
    validate: {
      len: [0, 50]
    }
  },
  bonus: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: true,
    validate: {
      isDecimal: true,
      min: 0
    }
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'groups',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      unique: true,
      fields: ['symbol', 'name'] // Composite unique index for symbol-name combination
    },
    {
      fields: ['symbol'] // Index for fast symbol lookups
    },
    {
      fields: ['name'] // Index for fast name lookups
    },
    {
      fields: ['type'] // Index for filtering by type
    }
  ],
  validate: {
    // Custom validation to ensure min_lot <= max_lot
    minMaxLotValidation() {
      if (this.min_lot && this.max_lot && parseFloat(this.min_lot) > parseFloat(this.max_lot)) {
        throw new Error('min_lot cannot be greater than max_lot');
      }
    }
  }
});

module.exports = Group;
