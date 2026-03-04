import { Router, type Request, type Response } from 'express';
import { broadcaster } from '../sse/emitter.js';
import { getStats, getUsageMonitor } from '../db/queries.js';
import { config } from '../config.js';

export const streamRouter = Router();

// Periodic stats broadcaster
let statsInterval: ReturnType<typeof setInterval> | null = null;

export function startStatsBroadcast(): void {
  if (statsInterval) return;
  statsInterval = setInterval(() => {
    if (broadcaster.clientCount === 0) return;
    const stats = getStats();
    const usage_monitor = getUsageMonitor();
    broadcaster.broadcast('stats', { ...stats, usage_monitor } as unknown as Record<string, unknown>);
  }, config.statsIntervalMs);
}

export function stopStatsBroadcast(): void {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

// GET /api/stream - SSE endpoint
streamRouter.get('/', (req: Request, res: Response) => {
  const accepted = broadcaster.addClient(res, {
    agentType: req.query.agent_type as string | undefined,
    eventType: req.query.event_type as string | undefined,
  });

  if (!accepted) {
    res.status(503).json({
      error: 'SSE client limit reached',
      max_clients: config.maxSseClients,
    });
  }
});
