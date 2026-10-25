import { fileURLToPath } from 'node:url';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@novachat-enterprise-erp/contracts';
import { createLogger } from '@novachat-enterprise-erp/common';
import { InMemoryEventBus } from '@novachat-enterprise-erp/events';
import { TEST_SECRET, asUser, createTestDatabase } from '@novachat-enterprise-erp/testing';
import { schema } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { DrizzleUnitOfWork } from '../repositories/unit-of-work.js';
import type { WorkspaceDirectory } from '../providers/workspace-directory.js';
import { buildContainer } from '../container.js';
import { createApp } from '../app.js';

export const WS = '00000000-0000-4000-8000-000000000001';
export const OTHER_WS = '00000000-0000-4000-8000-000000000002';

const ROLES: Record<string, keyof typeof DEFAULT_ROLE_PERMISSIONS> = {
  owner: 'owner',
  ada: 'member',
  grace: 'member',
  linus: 'member',
  gus: 'guest',
};

class FakeDirectory implements WorkspaceDirectory {
  constructor(public active = new Set(Object.keys(ROLES))) {}
  async activeUserIds(_workspaceId: string, userIds: string[]) {
    return userIds.filter((id) => this.active.has(id));
  }
}

export const createHarness = async () => {
  const migrations = fileURLToPath(new URL('../../drizzle', import.meta.url));
  const { db, close } = await createTestDatabase(schema, migrations, 'messaging');
  const events = new InMemoryEventBus('message-service');
  const directory = new FakeDirectory();
  const container = buildContainer({
    logger: createLogger('test', 'silent'),
    internalSecret: TEST_SECRET,
    uow: new DrizzleUnitOfWork(db as unknown as Database),
    directory,
    events,
  });

  const as = (userId: string, workspaceId = WS) => {
    const role = ROLES[userId] ?? 'member';
    return asUser({
      userId,
      workspaceId,
      memberId: `m-${userId}`,
      role,
      permissions: role === 'owner' ? ALL_PERMISSIONS : DEFAULT_ROLE_PERMISSIONS[role],
    });
  };

  return { app: createApp(container), container, events, directory, close, as };
};
