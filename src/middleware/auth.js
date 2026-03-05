const ALLOWED_ORIGINS = [
  'https://api.alpharena.ai',
  'http://api.alpharena.ai',
];

const API_SECRET = process.env.API_SECRET;

function authMiddleware(req, res, next) {
  // Validate API secret
  const token = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!API_SECRET || token !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Validate origin
  const origin = req.headers['origin'] || req.headers['referer'] || '';

  // Allow requests with no origin (server-to-server calls from NestJS)
  // but block requests from unknown browser origins
  if (origin && !ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }

  next();
}

module.exports = authMiddleware;
