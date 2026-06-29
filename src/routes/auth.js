import express from 'express';
import { team } from '../services/team.js';
import { createSessionToken } from '../services/sessions.js';

export const authRouter = express.Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const member = team.verifyLogin(username, password);
  if (!member) {
    return res.status(401).json({
      error: { message: 'Invalid username or password.', type: 'authentication_error' },
    });
  }

  const session = createSessionToken(member.key);
  res.json({
    token: session.token,
    expiresAt: session.expiresAt,
    member: {
      key: member.key,
      username: member.username,
      name: member.name,
      admin: member.admin,
    },
  });
});
