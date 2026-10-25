import { z } from 'zod';
import { baseEnvSchema, loadEnv, serviceUrl } from '@novachat-enterprise-erp/common';

const schema = baseEnvSchema.extend({
  PORT: z.coerce.number().default(4003),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WORKSPACE_SERVICE_URL: serviceUrl('http://localhost:4002'),
});

export type Env = z.infer<typeof schema>;

export const loadMessageEnv = (): Env => loadEnv(schema);
