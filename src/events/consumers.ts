import { EVENTS } from '@novachat-enterprise-erp/contracts';
import type { EventSubscriber } from '@novachat-enterprise-erp/events';
import type { ConversationService } from '../services/conversation.service.js';

export const registerConsumers = (subscriber: EventSubscriber, conversations: ConversationService): void => {
  subscriber
    .on<{ workspace: { ownerId: string } }>(EVENTS.WORKSPACE_CREATED, (event) =>
      conversations.provisionWorkspace(event.workspaceId!, event.data.workspace.ownerId),
    )
    .on<{ userId: string }>(EVENTS.MEMBER_JOINED, (event) => conversations.onMemberJoined(event.workspaceId!, event.data.userId))
    .on<{ userId: string }>(EVENTS.MEMBER_REMOVED, (event) => conversations.onMemberRemoved(event.workspaceId!, event.data.userId));
};
