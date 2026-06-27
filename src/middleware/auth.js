import { config } from '../config.js';

/**
 * Gateway authentication.
 *
 * Clients must send "Authorization: Bearer <key>" where <key> is one of
 * GATEWAY_API_KEYS. If no keys are configured, auth is disabled (dev only)
 * and every caller is labelled "anonymous".
 *
 * The resolved client key is attached as req.clientKey and used as the
 * rate-limit bucket identifier.
 */
export function authenticate(req, res, next) {
  if (config.gatewayApiKeys.length === 0) {
    req.clientKey = 'anonymous';
    return next();
  }

  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const key = match?.[1]?.trim();

  if (!key || !config.gatewayApiKeys.includes(key)) {
    return res.status(401).json({
      error: {
        message: 'Missing or invalid gateway API key.',
        type: 'authentication_error',
      },
    });
  }

  req.clientKey = key;
  next();
}
