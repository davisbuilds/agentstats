import { Router } from 'express';
import { eventsRouter } from './events.js';
import { statsRouter } from './stats.js';
import { sessionsRouter } from './sessions.js';
import { transcriptsRouter } from './transcripts.js';
import { streamRouter } from './stream.js';
import { healthRouter } from './health.js';
import { filterOptionsRouter } from './filter-options.js';
import { otelRouter } from './otel.js';

export const apiRouter = Router();

apiRouter.use('/events', eventsRouter);
apiRouter.use('/stats', statsRouter);
apiRouter.use('/sessions', sessionsRouter);
apiRouter.use('/sessions', transcriptsRouter);
apiRouter.use('/stream', streamRouter);
apiRouter.use('/health', healthRouter);
apiRouter.use('/filter-options', filterOptionsRouter);
apiRouter.use('/otel', otelRouter);
