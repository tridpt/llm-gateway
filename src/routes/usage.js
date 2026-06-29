import express from 'express';
import { config } from '../config.js';
import { budgetManager } from '../services/budget.js';
import { team } from '../services/team.js';

export const usageRouter = express.Router();

/**
 * Identity + budget for the calling key only ("who am I?").
 *
 * The chat UI uses this to greet the member by their server-known name, show
 * their own budget, and reveal the admin panel only when admin === true.
 */
usageRouter.get('/me', (req, res) => {
  const key = req.clientKey || 'anonymous';
  const member = team.get(key);
  const usage = budgetManager.getUsage(key);
  res.json({
    key,
    username: member?.username || null,
    name: member?.name || null,
    admin: Boolean(req.isAdmin),
    authType: req.authType || null,
    usage: { requests: usage.requests, costUsd: usage.costUsd, date: usage.date },
    limits: budgetManager.getLimits(key),
  });
});

/**
 * Self-service budget usage for the calling key only.
 *
 * Unlike /admin/usage (which returns every key's usage), this returns just
 * req.clientKey's own daily usage + limits. That lets a team member's chat UI
 * show "you've used X / Y requests today" without exposing other users' data.
 */
usageRouter.get('/usage', (req, res) => {
  const key = req.clientKey || 'anonymous';
  const limits = budgetManager.getLimits(key);
  const usage = budgetManager.getUsage(key);

  res.json({
    enabled: config.budget.enabled,
    key,
    usage: { requests: usage.requests, costUsd: usage.costUsd, date: usage.date },
    limits,
  });
});
