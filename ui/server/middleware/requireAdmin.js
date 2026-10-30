// ui/server/middleware/requireAdmin.js
export function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin privileges required', code: 'ADMIN_REQUIRED' });
}
