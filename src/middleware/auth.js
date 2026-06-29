import { config } from '../config.js';
import { team } from '../services/team.js';

/**
 * Gateway authentication.
 *
 * Clients must send "Authorization: Bearer <key>" where <key> is either one of
 * the static GATEWAY_API_KEYS (env) or an enabled team member key (team.json,
 * managed from the admin UI). If no static keys AND no team members are
 * configured, auth is disabled (dev only) and every caller is "anonymous".
 *
 * The resolved client key is attached as req.clientKey (the rate-limit and
 * budget bucket). req.isAdmin marks env keys and team admins, gating the team
 * management routes.
 */
export function authenticate(req, res, next) {
  if (config.gatewayApiKeys.length === 0 && team.snapshot().count === 0) {
    req.clientKey = 'anonymous';
    req.isAdmin = true; // open dev mode: no keys configured at all
    return next();
  }

  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const key = match?.[1]?.trim();

  const isEnvKey = key && config.gatewayApiKeys.includes(key);
  const isTeamKey = key && team.isActive(key);

  if (!key || (!isEnvKey && !isTeamKey)) {
    return res.status(401).json({
      error: {
        message: 'Missing or invalid gateway API key.',
        type: 'authentication_error',
      },
    });
  }

  req.clientKey = key;
  // Env keys are operators (full admin); team members are admins only if flagged.
  req.isAdmin = isEnvKey || team.isAdmin(key);
  next();
}

/**
 * Restrict a route to admins (env keys or team members with admin=true).
 * Must run after authenticate.
 */
export function requireAdmin(req, res, next) {
  if (req.isAdmin) return next();
  return res.status(403).json({
    error: { message: 'Admin privileges required.', type: 'forbidden' },
  });
}
