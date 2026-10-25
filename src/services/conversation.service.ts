import {
  EVENTS,
  PERMISSIONS,
  SYSTEM_ROLES,
  type ConversationAccessDto,
  type ConversationDto,
  type CreateChannelInput,
  type EventType,
  type UpdateConversationInput,
} from '@novachat-enterprise-erp/contracts';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  isUniqueViolation,
  type MemberContext,
} from '@novachat-enterprise-erp/common';
import type { EventPublisher } from '@novachat-enterprise-erp/events';
import type { ConversationRow } from '../db/schema.js';
import type { UnitOfWork } from '../repositories/unit-of-work.js';
import type { WorkspaceDirectory } from '../providers/workspace-directory.js';
import { ConversationPolicy, isChannel } from './conversation.policy.js';
import { conversationRef, toConversationDto } from './mappers.js';

const DEFAULT_CHANNELS = [
  { name: 'general', description: 'Announcements and conversations for everyone.' },
  { name: 'random', description: 'Off-topic chatter, links and fun.' },
];

export class ConversationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policy: ConversationPolicy,
    private readonly directory: WorkspaceDirectory,
    private readonly events: EventPublisher,
  ) {}

  async listMine(actor: MemberContext): Promise<ConversationDto[]> {
    const items = await this.uow.repos.conversations.listForUser(actor.workspaceId, actor.userId);
    return items.map(toConversationDto);
  }

  async browse(actor: MemberContext, q: string | undefined, scope: 'public' | 'all'): Promise<ConversationDto[]> {
    if (actor.role === SYSTEM_ROLES.GUEST) throw new ForbiddenError('Guests cannot browse channels');
    const includePrivate = scope === 'all';
    if (includePrivate && !actor.permissions.includes(PERMISSIONS.CHANNELS_MANAGE)) {
      throw new ForbiddenError('Missing permission: channels:manage');
    }
    const items = await this.uow.repos.conversations.browse(actor.workspaceId, actor.userId, { q, includePrivate });
    return items.map(toConversationDto);
  }

  async get(actor: MemberContext, conversationId: string): Promise<ConversationDto> {
    const item = await this.uow.repos.conversations.getForUser(conversationId, actor.userId);
    this.policy.assertCanView(item?.conversation ?? null, actor, item?.membership ?? null);
    return toConversationDto(item!);
  }

  async createChannel(actor: MemberContext, input: CreateChannelInput): Promise<ConversationDto> {
    const invited = await this.directory.activeUserIds(
      actor.workspaceId,
      input.memberUserIds.filter((id) => id !== actor.userId),
    );
    const memberIds = [actor.userId, ...invited];
    try {
      const conversation = await this.uow.transaction(async (repos) => {
        const row = await repos.conversations.create({
          workspaceId: actor.workspaceId,
          type: input.isPrivate ? 'private_channel' : 'public_channel',
          name: input.name,
          description: input.description ?? null,
          createdBy: actor.userId,
        });
        await repos.conversations.addMembers(row.id, actor.workspaceId, memberIds);
        return row;
      });
      await this.publishCreated(conversation, memberIds, actor.userId);
      return this.get(actor, conversation.id);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(`A channel named #${input.name} already exists`);
      throw error;
    }
  }

  async openDirect(actor: MemberContext, userIds: string[]): Promise<ConversationDto> {
    const others = [...new Set(userIds.filter((id) => id !== actor.userId))];
    const valid = await this.directory.activeUserIds(actor.workspaceId, others);
    if (valid.length !== others.length) throw new BadRequestError('Some people are not active members of this workspace');

    const participants = [actor.userId, ...others].sort();
    const dmKey = participants.join(',');
    const existing = await this.uow.repos.conversations.findByDmKey(actor.workspaceId, dmKey);
    if (existing) return this.get(actor, existing.id);

    try {
      const conversation = await this.uow.transaction(async (repos) => {
        const row = await repos.conversations.create({
          workspaceId: actor.workspaceId,
          type: participants.length <= 2 ? 'dm' : 'group_dm',
          dmKey,
          createdBy: actor.userId,
        });
        await repos.conversations.addMembers(row.id, actor.workspaceId, participants);
        return row;
      });
      await this.publishCreated(conversation, participants, actor.userId);
      return this.get(actor, conversation.id);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.uow.repos.conversations.findByDmKey(actor.workspaceId, dmKey);
      return this.get(actor, raced!.id);
    }
  }

  async update(actor: MemberContext, conversationId: string, input: UpdateConversationInput): Promise<ConversationDto> {
    const conversation = await this.load(actor, conversationId);
    this.policy.assertCanManage(conversation, actor);
    if (conversation.isDefault && input.isPrivate) throw new BadRequestError('Default channels must stay public');

    const { isPrivate, ...rest } = input;
    try {
      await this.uow.repos.conversations.update(conversation.id, {
        ...rest,
        ...(isPrivate === undefined ? {} : { type: isPrivate ? 'private_channel' : 'public_channel' }),
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(`A channel named #${input.name} already exists`);
      throw error;
    }
    return this.publishUpdated(actor, conversation.id);
  }

  async setArchived(actor: MemberContext, conversationId: string, archived: boolean): Promise<ConversationDto> {
    const conversation = await this.load(actor, conversationId);
    this.policy.assertCanManage(conversation, actor);
    if (conversation.isDefault) throw new BadRequestError('Default channels cannot be archived');
    await this.uow.repos.conversations.update(conversation.id, { archivedAt: archived ? new Date() : null });
    return this.publishUpdated(actor, conversation.id, archived ? EVENTS.CONVERSATION_ARCHIVED : EVENTS.CONVERSATION_UPDATED);
  }

  async delete(actor: MemberContext, conversationId: string): Promise<void> {
    const conversation = await this.load(actor, conversationId);
    this.policy.assertChannel(conversation);
    if (!actor.permissions.includes(PERMISSIONS.CHANNELS_MANAGE)) throw new ForbiddenError('Missing permission: channels:manage');
    if (conversation.isDefault) throw new BadRequestError('Default channels cannot be deleted');
    const memberUserIds = await this.uow.repos.conversations.listMemberIds(conversation.id);
    await this.uow.repos.conversations.delete(conversation.id);
    await this.events.publish({
      type: EVENTS.CONVERSATION_DELETED,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      data: { conversationId: conversation.id, memberUserIds },
    });
  }

  async join(actor: MemberContext, conversationId: string): Promise<ConversationDto> {
    const conversation = await this.load(actor, conversationId);
    if (conversation.type !== 'public_channel') throw new ForbiddenError('You need an invite to join this conversation');
    if (conversation.archivedAt) throw new ForbiddenError('This channel is archived');
    await this.addAndPublish(actor, conversation, [actor.userId]);
    return this.get(actor, conversation.id);
  }

  async leave(actor: MemberContext, conversationId: string): Promise<void> {
    const conversation = await this.load(actor, conversationId);
    this.policy.assertChannel(conversation);
    if (conversation.isDefault) throw new BadRequestError(`You cannot leave #${conversation.name}`);
    if (await this.uow.repos.conversations.removeMember(conversation.id, actor.userId)) {
      await this.publishMemberRemoved(actor.workspaceId, actor.userId, conversation.id, [actor.userId]);
    }
  }

  async listMembers(actor: MemberContext, conversationId: string): Promise<string[]> {
    await this.load(actor, conversationId);
    return this.uow.repos.conversations.listMemberIds(conversationId);
  }

  async addMembers(actor: MemberContext, conversationId: string, userIds: string[]): Promise<string[]> {
    const conversation = await this.load(actor, conversationId);
    this.policy.assertChannel(conversation);
    const membership = await this.uow.repos.conversations.findMember(conversation.id, actor.userId);
    this.policy.assertCanPost(conversation, membership);
    const valid = await this.directory.activeUserIds(actor.workspaceId, userIds);
    return this.addAndPublish(actor, conversation, valid);
  }

  async removeMember(actor: MemberContext, conversationId: string, userId: string): Promise<void> {
    const conversation = await this.load(actor, conversationId);
    this.policy.assertCanManage(conversation, actor);
    if (userId === actor.userId) throw new BadRequestError('Use leave to remove yourself');
    if (conversation.isDefault) throw new BadRequestError('People cannot be removed from default channels');
    if (await this.uow.repos.conversations.removeMember(conversation.id, userId)) {
      await this.publishMemberRemoved(actor.workspaceId, actor.userId, conversation.id, [userId]);
    }
  }

  async markRead(actor: MemberContext, conversationId: string, messageId?: string): Promise<void> {
    const membership = await this.uow.repos.conversations.findMember(conversationId, actor.userId);
    if (!membership || membership.workspaceId !== actor.workspaceId) throw new NotFoundError('Conversation');
    let at = new Date();
    if (messageId) {
      const message = await this.uow.repos.messages.findById(messageId);
      if (!message || message.conversationId !== conversationId) throw new NotFoundError('Message');
      at = message.createdAt;
    }
    await this.uow.repos.conversations.markRead(conversationId, actor.userId, at);
  }

  async setMuted(actor: MemberContext, conversationId: string, muted: boolean): Promise<void> {
    const membership = await this.uow.repos.conversations.findMember(conversationId, actor.userId);
    if (!membership || membership.workspaceId !== actor.workspaceId) throw new NotFoundError('Conversation');
    await this.uow.repos.conversations.setMuted(conversationId, actor.userId, muted);
  }

  async provisionWorkspace(workspaceId: string, ownerUserId: string): Promise<void> {
    if ((await this.uow.repos.conversations.findDefaults(workspaceId)).length > 0) return;
    for (const channel of DEFAULT_CHANNELS) {
      try {
        const row = await this.uow.transaction(async (repos) => {
          const created = await repos.conversations.create({
            workspaceId,
            type: 'public_channel',
            name: channel.name,
            description: channel.description,
            isDefault: true,
            createdBy: ownerUserId,
          });
          await repos.conversations.addMembers(created.id, workspaceId, [ownerUserId]);
          return created;
        });
        await this.publishCreated(row, [ownerUserId], ownerUserId);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  async onMemberJoined(workspaceId: string, userId: string): Promise<void> {
    for (const channel of await this.uow.repos.conversations.findDefaults(workspaceId)) {
      const added = await this.uow.repos.conversations.addMembers(channel.id, workspaceId, [userId]);
      if (added.length) await this.publishMemberAdded(workspaceId, userId, channel.id, added);
    }
  }

  async onMemberRemoved(workspaceId: string, userId: string): Promise<void> {
    const ids = await this.uow.repos.conversations.removeUserFromChannels(workspaceId, userId);
    for (const id of ids) await this.publishMemberRemoved(workspaceId, userId, id, [userId]);
  }

  async access(conversationId: string, userId: string, includeMembers: boolean): Promise<ConversationAccessDto> {
    const conversation = await this.uow.repos.conversations.findById(conversationId);
    if (!conversation) throw new NotFoundError('Conversation');
    const membership = await this.uow.repos.conversations.findMember(conversationId, userId);
    return {
      conversationId,
      workspaceId: conversation.workspaceId,
      type: conversation.type,
      isMember: membership !== null,
      ...(includeMembers ? { memberUserIds: await this.uow.repos.conversations.listMemberIds(conversationId) } : {}),
    };
  }

  async conversationIdsFor(workspaceId: string, userId: string): Promise<string[]> {
    return this.uow.repos.conversations.conversationIdsForUser(workspaceId, userId);
  }

  private async load(actor: MemberContext, conversationId: string): Promise<ConversationRow> {
    const item = await this.uow.repos.conversations.getForUser(conversationId, actor.userId);
    this.policy.assertCanView(item?.conversation ?? null, actor, item?.membership ?? null);
    return item!.conversation;
  }

  private async addAndPublish(actor: MemberContext, conversation: ConversationRow, userIds: string[]): Promise<string[]> {
    const added = await this.uow.repos.conversations.addMembers(conversation.id, actor.workspaceId, userIds);
    if (added.length) await this.publishMemberAdded(actor.workspaceId, actor.userId, conversation.id, added);
    return added;
  }

  private publishCreated(conversation: ConversationRow, memberUserIds: string[], actorId: string) {
    return this.events.publish({
      type: EVENTS.CONVERSATION_CREATED,
      workspaceId: conversation.workspaceId,
      actorId,
      data: { conversation: conversationRef(conversation), memberUserIds },
    });
  }

  private async publishUpdated(actor: MemberContext, conversationId: string, type: EventType = EVENTS.CONVERSATION_UPDATED) {
    const dto = await this.get(actor, conversationId);
    const memberUserIds = await this.uow.repos.conversations.listMemberIds(conversationId);
    await this.events.publish({
      type,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      data: { conversation: { ...dto, membership: null }, memberUserIds },
    });
    return dto;
  }

  private publishMemberAdded(workspaceId: string, actorId: string, conversationId: string, userIds: string[]) {
    return this.events.publish({
      type: EVENTS.CONVERSATION_MEMBER_ADDED,
      workspaceId,
      actorId,
      data: { conversationId, userIds },
    });
  }

  private publishMemberRemoved(workspaceId: string, actorId: string, conversationId: string, userIds: string[]) {
    return this.events.publish({
      type: EVENTS.CONVERSATION_MEMBER_REMOVED,
      workspaceId,
      actorId,
      data: { conversationId, userIds },
    });
  }

  static isChannel = isChannel;
}
