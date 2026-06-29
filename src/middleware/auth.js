import { config } from '../config.js';
import { team } from '../services/team.js';
import { verifySessionToken } from '../services/sessions.js';

/**
 * Gateway authentication.
 *
 * Clients must send "Authorization: Bearer <token>". The token can be a static
 * GATEWAY_API_KEYS key, a legacy team member key, or a signed browser session
 * issued by POST /v1/login.
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

  const session = verifySessionToken(key);
  const sessionKey = session?.key;
  const isEnvKey = key && config.gatewayApiKeys.includes(key);
  const isTeamKey = key && team.isActive(key);
  const isSession = sessionKey && team.isActive(sessionKey);

  if (!key || (!isEnvKey && !isTeamKey && !isSession)) {
    return res.status(401).json({
      error: {
        message: 'Missing or invalid gateway credentials.',
        type: 'authentication_error',
      },
    });
  }

  req.clientKey = isSession ? sessionKey : key;
  req.authType = isSession ? 'session' : isEnvKey ? 'env_key' : 'team_key';
  // Env keys are operators (full admin); team members are admins only if flagged.
  req.isAdmin = isEnvKey || team.isAdmin(req.clientKey);
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
