import { InternalHttpClient, createLogger, startServer } from '@novachat-enterprise-erp/common';
import { RedisStreamEventPublisher, RedisStreamEventSubscriber } from '@novachat-enterprise-erp/events';
import { loadMessageEnv } from './config/env.js';
import { createDatabase } from './db/client.js';
import { DrizzleUnitOfWork } from './repositories/unit-of-work.js';
import { WorkspaceServiceDirectory } from './providers/workspace-directory.js';
import { registerConsumers } from './events/consumers.js';
import { buildContainer } from './container.js';
import { createApp } from './app.js';

const env = loadMessageEnv();
const logger = createLogger('message-service', env.LOG_LEVEL);
const { db, pool } = createDatabase(env.DATABASE_URL, (err) =>
  logger.warn({ err }, 'Idle database connection failed; the pool will reconnect'),
);
const events = new RedisStreamEventPublisher({ redisUrl: env.REDIS_URL, source: 'message-service' });

const container = buildContainer({
  logger,
  internalSecret: env.INTERNAL_SECRET,
  uow: new DrizzleUnitOfWork(db),
  directory: new WorkspaceServiceDirectory(new InternalHttpClient(env.WORKSPACE_SERVICE_URL, env.INTERNAL_SECRET, 'message-service')),
  events,
  readiness: { database: async () => void (await pool.query('select 1')) },
});

const subscriber = new RedisStreamEventSubscriber({
  redisUrl: env.REDIS_URL,
  source: 'message-service',
  group: 'message-service',
  logger,
});
registerConsumers(subscriber, container.services.conversations);
await subscriber.start();

startServer({
  app: createApp(container),
  port: env.PORT,
  logger,
  onShutdown: [() => subscriber.stop(), () => events.close(), () => pool.end()],
});
