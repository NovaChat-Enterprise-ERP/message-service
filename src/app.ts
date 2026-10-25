import express, { type Express } from 'express';
import { errorHandler, healthRouter, httpLogger, internalAuth, notFoundHandler, requestId } from '@novachat-enterprise-erp/common';
import type { Container } from './container.js';
import { internalRoutes, publicRoutes } from './routes/index.js';

export const createApp = (container: Container): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId());
  app.use(httpLogger(container.logger));
  app.use(healthRouter('message-service', container.readiness));
  app.use(express.json({ limit: '1mb' }));
  app.use(internalAuth(container.internalSecret));
  app.use('/api/v1', publicRoutes(container));
  app.use('/internal', internalRoutes(container));
  app.use(notFoundHandler);
  app.use(errorHandler(container.logger));
  return app;
};
