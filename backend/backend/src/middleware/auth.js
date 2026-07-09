const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET environment variable. See .env.example.');
  process.exit(1);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, department: user.department },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Restricts a route to specific roles. Master Admin (superadmin) always passes,
// mirroring the frontend's hasPermission() superadmin bypass.
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user.role === 'superadmin' || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this action' });
  };
}

module.exports = { signToken, requireAuth, requireRole, JWT_SECRET };
