import type { Logger, ReadinessCheck } from '@novachat-enterprise-erp/common';
import type { EventPublisher } from '@novachat-enterprise-erp/events';
import type { UnitOfWork } from './repositories/unit-of-work.js';
import type { WorkspaceDirectory } from './providers/workspace-directory.js';
import { ConversationPolicy } from './services/conversation.policy.js';
import { ConversationService } from './services/conversation.service.js';
import { MessageService } from './services/message.service.js';
import { ConversationController } from './controllers/conversation.controller.js';
import { MessageController } from './controllers/message.controller.js';
import { InternalController } from './controllers/internal.controller.js';

export interface ContainerDeps {
  logger: Logger;
  internalSecret: string;
  uow: UnitOfWork;
  directory: WorkspaceDirectory;
  events: EventPublisher;
  readiness?: Record<string, ReadinessCheck>;
}

export const buildContainer = (deps: ContainerDeps) => {
  const policy = new ConversationPolicy();
  const services = {
    conversations: new ConversationService(deps.uow, policy, deps.directory, deps.events),
    messages: new MessageService(deps.uow, policy, deps.events),
  };
  return {
    logger: deps.logger,
    internalSecret: deps.internalSecret,
    readiness: deps.readiness ?? {},
    services,
    controllers: {
      conversations: new ConversationController(services.conversations),
      messages: new MessageController(services.messages),
      internal: new InternalController(services.conversations, services.messages),
    },
  };
};

export type Container = ReturnType<typeof buildContainer>;
