# RBAC System Documentation

## 1. Overview

This document outlines the Role-Based Access Control (RBAC) system implemented for the administrative backend. The system is designed to be secure, scalable, and configurable, providing fine-grained control over admin actions.

Key features include:
- JWT-based authentication with 2FA (OTP).
- Role and permission management via the database.
- Country-based scoping for non-superadmin roles.
- Redis-backed caching for high-performance permission checks.
- Comprehensive audit logging for all privileged actions.

---

## 2. Database Schema

The RBAC system relies on the following tables:

- `admins`: Stores administrator accounts. The `role_id` links to the `roles` table, and `country_id` is used for data scoping.
- `roles`: Defines the available roles (e.g., `superadmin`, `admin`, `accountant`).
- `permissions`: Defines all possible atomic permissions in the system (e.g., `admin:create`, `user:read`).
- `role_permissions`: A join table that maps permissions to roles, defining what each role can do.
- `admin_audit_logs`: Records all actions performed by administrators.

---

## 3. How to Configure Roles and Permissions

The system is designed to be configured entirely through the database. **No code changes are required to add new roles or permissions.**

### Adding a new Permission:
1.  Insert a new record into the `permissions` table.
    ```sql
    INSERT INTO permissions (name, description, created_at, updated_at) VALUES ('new:permission', 'Description of what this permission allows.', NOW(), NOW());
    ```

### Adding a new Role:
1.  Insert a new record into the `roles` table.
    ```sql
    INSERT INTO roles (name, description, created_at, updated_at) VALUES ('new_role', 'Description of this new role.', NOW(), NOW());
    ```

### Assigning a Permission to a Role:
Use the `/api/admin/permissions/assign` endpoint (superadmin only) or insert directly into the database:
1.  Find the `id` of the role and the permission.
2.  Insert a record into the `role_permissions` join table.
    ```sql
    INSERT INTO role_permissions (role_id, permission_id, created_at, updated_at) VALUES (role_id, permission_id, NOW(), NOW());
    ```

---

## 4. Middleware

- `authenticateAdmin`: Verifies the JWT access token and checks Redis to ensure it has not been revoked. Attaches the admin payload to `req.admin`.
- `checkPermissions(requiredPermissions)`: Fetches the admin's permissions from a Redis cache (or the DB if not cached) and verifies they have all the required permissions.
- `applyScope`: If the authenticated admin is not a `superadmin`, this middleware applies a Sequelize scope to database models to automatically filter results by the admin's `country_id`.

---

## 5. Caching

To optimize performance, an admin's permissions are cached in Redis for one hour. The cache key is `permissions:<adminId>`.

**Cache Invalidation**: The cache is automatically invalidated when permissions are changed for a role. The current implementation has a placeholder for this and will require a more robust solution to target only the affected admins.

---

## 6. Audit Logging

All CUD (Create, Update, Delete) operations within the `admin.management.controller.js` and permission changes in `permission.management.controller.js` are logged to the `admin_audit_logs` table. The log captures the admin who performed the action, their IP address, the request body, and the success or failure status.

---

## 7. API Endpoints

All endpoints are prefixed with `/api/admin`.

- `/auth/login`: Admin login (email, password).
- `/auth/verify-otp`: Verify 2FA OTP and receive tokens.
- `/auth/refresh-token`: Get a new access token.
- `/auth/logout`: Log out and revoke tokens.

- `/management/admins`: (superadmin) CRUD operations for administrators.
- `/users/live-users`: (admin) List live users (scoped by country).
- `/users/demo-users`: (admin) List demo users (scoped by country).

- `/permissions/assign`: (superadmin) Assign a permission to a role.
- `/permissions/remove`: (superadmin) Remove a permission from a role.
