const { Admin, Role, Permission } = require('../models');
const { redisCluster } = require('../../config/redis');

const CACHE_KEY_PREFIX = 'permissions:';
const CACHE_EXPIRATION_SECONDS = 3600; // 1 hour

class PermissionService {
  /**
   * Fetches permissions for an admin, using a cache-aside strategy.
   * @param {number} adminId The ID of the admin.
   * @returns {Promise<string[]>} A promise that resolves to an array of permission names.
   */
  async getPermissionsForAdmin(adminId) {
    const cacheKey = `${CACHE_KEY_PREFIX}${adminId}`;

    // 1. Try to get from cache
    const cachedPermissions = await redisCluster.get(cacheKey);
    if (cachedPermissions) {
      return JSON.parse(cachedPermissions);
    }

    // 2. If not in cache, get from DB
    const admin = await Admin.findByPk(adminId, {
      include: {
        model: Role,
        as: 'role',
        include: {
          model: Permission,
          as: 'permissions',
          attributes: ['name'],
          through: { attributes: [] }, // Don't include the join table attributes
        },
      },
    });

    if (!admin || !admin.role || !admin.role.permissions) {
      return [];
    }

    const permissions = admin.role.permissions.map(p => p.name);

    // 3. Store in cache for future requests
    await redisCluster.set(cacheKey, JSON.stringify(permissions), 'EX', CACHE_EXPIRATION_SECONDS);

    return permissions;
  }

  /**
   * Invalidates the permission cache for a specific admin.
   * @param {number} adminId The ID of the admin whose cache should be cleared.
   */
  async invalidatePermissionsForAdmin(adminId) {
    const cacheKey = `${CACHE_KEY_PREFIX}${adminId}`;
    await redisCluster.del(cacheKey);
  }
}

module.exports = new PermissionService();
