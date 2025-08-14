const { Admin, Role, Permission } = require('../models');
const { redisCluster } = require('../../config/redis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

class AdminAuthService {
  async login(email, password) {
    const admin = await Admin.findOne({ where: { email } });
    if (!admin) {
      throw new Error('Invalid credentials');
    }

    const isPasswordValid = await admin.isValidPassword(password);
    if (!isPasswordValid) {
      throw new Error('Invalid credentials');
    }

    if (!admin.is_active) {
      throw new Error('Admin account is inactive');
    }

    const otp = require('../utils/otp.util').generateOTP();
    const emailService = require('./email.service');

    const otpKey = `otp:${admin.id}`;
    await redisCluster.set(otpKey, otp, 'EX', 300); // OTP valid for 5 minutes

    try {
      await emailService.sendOTPEmail(admin.email, otp, 'Your Admin Login OTP');
    } catch (error) {
      console.error(`Failed to send OTP email to ${admin.email}`, error);
      throw new Error('Could not send verification email.');
    }

    return { adminId: admin.id };
  }

  async verifyOtp(adminId, otp) {
    const otpKey = `otp:${adminId}`;
    const storedOtp = await redisCluster.get(otpKey);

    if (!storedOtp || storedOtp !== otp) {
      throw new Error('Invalid or expired OTP');
    }

    // OTP is correct, delete it to prevent reuse
    await redisCluster.del(otpKey);

    const admin = await Admin.findByPk(adminId);
    if (!admin) {
      throw new Error('Admin not found');
    }

    // Update last login time
    admin.last_login = new Date();
    await admin.save();

    return this.generateTokens(admin);
  }

  async generateTokens(admin) {
    // Fetch the admin's role and associated permissions
    const adminWithPermissions = await Admin.findByPk(admin.id, {
      include: {
        model: Role,
        include: {
          model: Permission,
          through: { attributes: [] }, // Don't include the join table attributes
        },
      },
    });

    const role = adminWithPermissions.Role.name;
    const permissions = adminWithPermissions.Role.Permissions.map(p => p.name);

    // Cache permissions in Redis for faster middleware access
    const permissionsCacheKey = `permissions:${admin.id}`;
    await redisCluster.set(permissionsCacheKey, JSON.stringify(permissions), 'EX', 60 * 60); // Cache for 1 hour

    const jti = require('uuid').v4();
    const accessTokenKey = `jti:${admin.id}:${jti}`;
    const accessTokenTTL = 60 * 15; // 15 minutes
    const refreshTokenTTL = 60 * 60 * 24 * 7; // 7 days

    const accessTokenPayload = {
      sub: admin.id,
      role,
      permissions,
      country_id: admin.country_id,
      jti,
    };

    const refreshTokenPayload = {
      sub: admin.id,
      jti, // Link refresh token to the access token's JTI
    };

    const accessToken = jwt.sign(accessTokenPayload, process.env.JWT_SECRET, { expiresIn: `${accessTokenTTL}s` });
    const refreshToken = jwt.sign(refreshTokenPayload, process.env.JWT_REFRESH_SECRET, { expiresIn: `${refreshTokenTTL}s` });

    // Store JTI in Redis to enable revocation (logout)
    await redisCluster.set(accessTokenKey, 'valid', 'EX', refreshTokenTTL); // Use longer expiry for revocation check

    return { accessToken, refreshToken };
  }

  async refreshToken(token) {
    try {
      // 1. Verify the refresh token
      const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      const { sub, jti } = decoded;

      // 2. Check if the original JTI is still valid in Redis
      const jtiKey = `jti:${sub}:${jti}`;
      const isValid = await redisCluster.get(jtiKey);

      if (!isValid) {
        throw new Error('Refresh token is invalid or has been revoked.');
      }

      // 3. Revoke the old JTI to prevent reuse (token rotation)
      await redisCluster.del(jtiKey);

      // 4. Issue new tokens
      const admin = await Admin.findByPk(sub);
      if (!admin) {
        throw new Error('Admin not found');
      }

      return this.generateTokens(admin);
    } catch (error) {
      // If token is expired or invalid, or any other error occurs
      throw new Error('Invalid refresh token.');
    }
  }

  async logout(adminId, jti) {
    const jtiKey = `jti:${adminId}:${jti}`;
    const permissionsCacheKey = `permissions:${adminId}`;
    await Promise.all([
      redisCluster.del(jtiKey),
      redisCluster.del(permissionsCacheKey)
    ]);
  }

  async invalidatePermissionsCache(adminId = null) {
    if (adminId) {
      // Invalidate specific admin's permissions cache
      const permissionsCacheKey = `permissions:${adminId}`;
      await redisCluster.del(permissionsCacheKey);
    } else {
      // Invalidate all permissions caches (when roles/permissions are updated globally)
      const keys = await redisCluster.keys('permissions:*');
      if (keys.length > 0) {
        await redisCluster.del(keys);
      }
    }
  }
}

module.exports = new AdminAuthService();
