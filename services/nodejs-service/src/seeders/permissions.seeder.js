const { Permission } = require('../models');

class PermissionSeeder {
  static async seed() {
    const permissions = [
      // User Management Permissions
      { name: 'user:create', description: 'Create new users' },
      { name: 'user:read', description: 'View user information' },
      { name: 'user:update', description: 'Update user information' },
      { name: 'user:delete', description: 'Delete users' },
      { name: 'user:manage_status', description: 'Activate/deactivate users' },

      // Admin Management Permissions
      { name: 'admin:create', description: 'Create new admin accounts' },
      { name: 'admin:read', description: 'View admin information' },
      { name: 'admin:update', description: 'Update admin information' },
      { name: 'admin:delete', description: 'Delete admin accounts' },
      { name: 'admin:reset_password', description: 'Reset admin passwords' },

      // Role & Permission Management
      { name: 'role:create', description: 'Create new roles' },
      { name: 'role:read', description: 'View roles and their permissions' },
      { name: 'role:update', description: 'Update role information' },
      { name: 'role:delete', description: 'Delete roles' },
      { name: 'permission:create', description: 'Create new permissions' },
      { name: 'permission:read', description: 'View permissions' },
      { name: 'permission:assign', description: 'Assign permissions to roles' },
      { name: 'permission:remove', description: 'Remove permissions from roles' },

      // Financial Permissions
      { name: 'financial:view', description: 'View financial data and reports' },
      { name: 'financial:create', description: 'Create financial records' },
      { name: 'financial:update', description: 'Update financial records' },
      { name: 'financial:delete', description: 'Delete financial records' },
      { name: 'financial:approve', description: 'Approve financial transactions' },

      // Transaction Permissions
      { name: 'transaction:read', description: 'View user transaction history' },
      { name: 'transaction:create', description: 'Create transactions (deposits/withdrawals)' },
      { name: 'transaction:approve', description: 'Approve pending transactions' },
      { name: 'transaction:stats', description: 'View transaction statistics and reports' },

      // Strategy Provider Permissions
      { name: 'strategy_provider:read', description: 'View strategy provider account details' },

      // Copy Follower Permissions
      { name: 'copy_follower:read', description: 'View copy follower account details' },

      // Trading Permissions
      { name: 'trading:view', description: 'View trading data' },
      { name: 'trading:create', description: 'Create trading orders' },
      { name: 'trading:update', description: 'Update trading orders' },
      { name: 'trading:cancel', description: 'Cancel trading orders' },
      { name: 'trading:approve', description: 'Approve trading operations' },

      // Reports Permissions
      { name: 'reports:view', description: 'View system reports' },
      { name: 'reports:create', description: 'Generate custom reports' },
      { name: 'reports:export', description: 'Export reports to files' },
      { name: 'reports:schedule', description: 'Schedule automated reports' },

      // System Permissions
      { name: 'system:settings', description: 'Manage system settings' },
      { name: 'system:logs', description: 'View system logs' },
      { name: 'system:backup', description: 'Create system backups' },
      { name: 'system:maintenance', description: 'Perform system maintenance' },

      // Audit Permissions
      { name: 'audit:view', description: 'View audit logs' },
      { name: 'audit:export', description: 'Export audit logs' },
      { name: 'audit:manage', description: 'Manage audit settings' },

      // Country-specific Permissions
      { name: 'country:manage', description: 'Manage country-specific operations' },
      { name: 'country:view_all', description: 'View data from all countries' },
      { name: 'country:restricted', description: 'Access restricted to assigned country' },
    ];

    console.log('🌱 Starting permission seeding...');

    for (const permissionData of permissions) {
      try {
        const [permission, created] = await Permission.findOrCreate({
          where: { name: permissionData.name },
          defaults: permissionData
        });

        if (created) {
          console.log(`✅ Created permission: ${permission.name}`);
        } else {
          console.log(`⚠️  Permission already exists: ${permission.name}`);
        }
      } catch (error) {
        console.error(`❌ Error creating permission ${permissionData.name}:`, error.message);
      }
    }

    console.log('🎉 Permission seeding completed!');
  }

  static async clear() {
    console.log('🧹 Clearing all permissions...');
    await Permission.destroy({ where: {} });
    console.log('✅ All permissions cleared!');
  }
}

module.exports = PermissionSeeder;
