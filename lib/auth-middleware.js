import { getTokenFromRequest, verifyToken } from './jwt';

// Role-based access levels
export const ROLES = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  STAFF: 'staff',
  VIEWER: 'viewer',
};

// Role hierarchy (higher number = more access)
const ROLE_LEVELS = {
  [ROLES.ADMIN]: 4,
  [ROLES.MANAGER]: 3,
  [ROLES.STAFF]: 2,
  [ROLES.VIEWER]: 1,
};

/**
 * Which menu permissions an API area needs. These mirror the permissions set
 * on each user in Setup > Users, so the server enforces what the menu shows.
 *
 * - Writes (POST/PUT/PATCH/DELETE) always need one of the listed permissions.
 * - Reads are open to any signed-in user (pages share lookups like products and
 *   locations), except money areas marked `protectReads`.
 * A permission like "expenses" also covers its sub-permissions ("expenses.entry").
 */
const API_PERMISSION_RULES = [
  { prefixes: ['/api/expenses', '/api/accounting', '/api/taxes', '/api/credits'], permissions: ['expenses'], protectReads: true },
  { prefixes: ['/api/setup', '/api/heroes', '/api/site-social-links'], permissions: ['setup'] },
  { prefixes: ['/api/staff', '/api/salary-mail'], permissions: ['staff', 'manage.staff', 'manage.staff-roles'] },
  { prefixes: ['/api/assets'], permissions: ['assets', 'setup.assets'] },
  { prefixes: ['/api/support'], permissions: ['support'] },
  {
    prefixes: ['/api/stock-take', '/api/stock-movement', '/api/stock-management', '/api/purchase-orders', '/api/notify-low-stock'],
    permissions: ['stock', 'manage.purchase-orders'],
  },
  { prefixes: ['/api/products', '/api/categories', '/api/vendors'], permissions: ['manage', 'stock'] },
  { prefixes: ['/api/promotions', '/api/campaigns', '/api/hotel', '/api/orders', '/api/send-email'], permissions: ['manage'] },
  { prefixes: ['/api/customers'], permissions: ['manage', 'expenses'] },
  { prefixes: ['/api/transactions', '/api/till', '/api/reporting'], permissions: ['reporting', 'expenses', 'manage'] },
  { prefixes: ['/api/upload'], permissions: ['manage', 'setup', 'stock', 'assets', 'expenses'] },
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function getRequestPath(req) {
  return String(req.url || '').split('?')[0];
}

function findPermissionRule(path) {
  return API_PERMISSION_RULES.find((rule) =>
    rule.prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  );
}

export function userHasPermission(user, permission) {
  if (!user) return false;
  if (user.role === ROLES.ADMIN) return true;
  const granted = Array.isArray(user.permissions) ? user.permissions : [];
  return granted.some((entry) => entry === permission || String(entry).startsWith(`${permission}.`));
}

export function authMiddleware(req, res) {
  const token = getTokenFromRequest(req);

  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }

  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = decoded;

  const rule = findPermissionRule(getRequestPath(req));
  const isRead = READ_METHODS.has(String(req.method || 'GET').toUpperCase());

  if (rule && (!isRead || rule.protectReads) && decoded.role !== ROLES.ADMIN) {
    // Sessions from before permissions were added to the token have to sign in again once.
    if (!Array.isArray(decoded.permissions)) {
      return res.status(401).json({ error: 'Please sign in again to continue.' });
    }

    if (!rule.permissions.some((permission) => userHasPermission(decoded, permission))) {
      return res.status(403).json({ error: 'You do not have permission for this area. Ask an admin to grant it in Setup > Users.' });
    }
  }

  return null; // No error
}

export function requireRole(...roles) {
  return (req, res) => {
    const error = authMiddleware(req, res);
    if (error) return error;

    const userRole = req.user.role;
    const userLevel = ROLE_LEVELS[userRole] || 0;
    const requiredLevel = Math.max(...roles.map(r => ROLE_LEVELS[r] || 0));

    if (userLevel < requiredLevel) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    return null; // No error
  };
}

/**
 * For routes that were public: requires a signed-in non-viewer user and runs
 * the same area permission check as every other route.
 */
export function requireStaffAuth(req, res) {
  const error = authMiddleware(req, res);
  if (error) return error;
  if (!isStaff(req)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  return null;
}

export function isAdmin(req) {
  return req.user && req.user.role === ROLES.ADMIN;
}

export function isManager(req) {
  return req.user && (req.user.role === ROLES.ADMIN || req.user.role === ROLES.MANAGER);
}

export function isStaff(req) {
  return req.user && req.user.role !== ROLES.VIEWER;
}
