import {
  EVENTS,
  PERMISSIONS,
  type EditMessageInput,
  type MessageCreatedEvent,
  type MessageDto,
  type Page,
  type SearchMessagesQuery,
  type SearchResultDto,
  type SendMessageInput,
  type ThreadSummaryDto,
} from '@novachat-enterprise-erp/contracts';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  decodeCursor,
  encodeCursor,
  isUniqueViolation,
  type MemberContext,
} from '@novachat-enterprise-erp/common';
import type { EventPublisher } from '@novachat-enterprise-erp/events';
import type { ConversationMemberRow, ConversationRow, MessageRow } from '../db/schema.js';
import type { Cursor } from '../repositories/message.repository.js';
import type { UnitOfWork } from '../repositories/unit-of-work.js';
import { isChannel, type ConversationPolicy } from './conversation.policy.js';
import { conversationRef, groupReactions, toMessageDto } from './mappers.js';

export const toTsQuery = (q: string): string | null => {
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
    .slice(0, 8);
  return terms.length ? terms.map((t) => `${t}:*`).join(' & ') : null;
};

interface SystemMessageInput {
  conversationId: string;
  authorId: string;
  text: string;
  body?: Record<string, unknown> | null;
}

export class MessageService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policy: ConversationPolicy,
    private readonly events: EventPublisher,
  ) {}

  async list(actor: MemberContext, conversationId: string, cursor: string | undefined, limit: number): Promise<Page<MessageDto>> {
    await this.access(actor, conversationId);
    const rows = await this.uow.repos.messages.listRoot(conversationId, decodeCursor<Cursor>(cursor), limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const visible = page.filter((m) => !m.deletedAt || m.replyCount > 0);
    return {
      items: await this.hydrate(visible),
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async send(actor: MemberContext, conversationId: string, input: SendMessageInput): Promise<MessageDto> {
    const { conversation, membership } = await this.access(actor, conversationId);
    this.policy.assertCanPost(conversation, membership);

    if (input.clientMsgId) {
      const existing = await this.uow.repos.messages.findByClientMsgId(actor.userId, input.clientMsgId);
      if (existing) return (await this.hydrate([existing]))[0]!;
    }

    let root: MessageRow | null = null;
    if (input.parentId) {
      root = await this.uow.repos.messages.findById(input.parentId);
      if (!root || root.conversationId !== conversationId || root.parentId) throw new BadRequestError('Invalid thread');
      if (root.deletedAt) throw new BadRequestError('You cannot reply to a deleted message');
    }

    let message: MessageRow;
    try {
      message = await this.uow.transaction(async (repos) => {
        const created = await repos.messages.create({
          workspaceId: actor.workspaceId,
          conversationId,
          authorId: actor.userId,
          parentId: root?.id ?? null,
          body: input.body,
          text: input.text,
          attachments: input.attachments,
          mentions: [...new Set(input.mentions)].filter((id) => id !== actor.userId),
          mentionsChannel: input.mentionsChannel && isChannel(conversation),
          clientMsgId: input.clientMsgId ?? null,
        });
        if (root) {
          await repos.messages.recordReply(root.id, actor.userId, created.createdAt);
          await repos.messages.joinThread(root.id, actor.workspaceId, root.authorId, null);
          await repos.messages.joinThread(root.id, actor.workspaceId, actor.userId, created.createdAt);
        } else {
          await repos.conversations.update(conversationId, { lastMessageAt: created.createdAt });
          await repos.conversations.markRead(conversationId, actor.userId, created.createdAt);
        }
        return created;
      });
    } catch (error) {
      if (!isUniqueViolation(error) || !input.clientMsgId) throw error;
      message = (await this.uow.repos.messages.findByClientMsgId(actor.userId, input.clientMsgId))!;
    }

    const dto = (await this.hydrate([message]))[0]!;
    await this.publishCreated(actor.userId, conversation, dto, root);
    return dto;
  }

  async get(actor: MemberContext, messageId: string): Promise<MessageDto> {
    const message = await this.loadMessage(actor, messageId);
    return (await this.hydrate([message]))[0]!;
  }

  async edit(actor: MemberContext, messageId: string, input: EditMessageInput): Promise<MessageDto> {
    const message = await this.loadMessage(actor, messageId);
    if (message.authorId !== actor.userId || message.kind !== 'user') throw new ForbiddenError('You can only edit your own messages');
    if (message.deletedAt) throw new BadRequestError('This message was deleted');
    const conversation = (await this.uow.repos.conversations.findById(message.conversationId))!;
    const updated = await this.uow.repos.messages.update(message.id, {
      body: input.body,
      text: input.text,
      mentions: [...new Set(input.mentions)].filter((id) => id !== actor.userId),
      mentionsChannel: input.mentionsChannel && isChannel(conversation),
      editedAt: new Date(),
    });
    const dto = (await this.hydrate([updated!]))[0]!;
    await this.publishMessageEvent(EVENTS.MESSAGE_UPDATED, actor, dto);
    return dto;
  }

  async delete(actor: MemberContext, messageId: string): Promise<void> {
    const message = await this.loadMessage(actor, messageId);
    const canDeleteAny = actor.permissions.includes(PERMISSIONS.MESSAGES_DELETE_ANY);
    if (message.authorId !== actor.userId && !canDeleteAny) throw new ForbiddenError('You can only delete your own messages');
    if (message.deletedAt) return;
    await this.uow.transaction(async (repos) => {
      await repos.messages.update(message.id, { deletedAt: new Date(), text: '', body: null, attachments: [] });
      if (message.parentId) await repos.messages.removeReply(message.parentId);
    });
    await this.events.publish({
      type: EVENTS.MESSAGE_DELETED,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      data: { messageId: message.id, conversationId: message.conversationId, parentId: message.parentId },
    });
  }

  async replies(actor: MemberContext, rootId: string, cursor: string | undefined, limit: number): Promise<Page<MessageDto>> {
    const root = await this.loadMessage(actor, rootId);
    if (root.parentId) throw new BadRequestError('Not a thread root');
    const rows = await this.uow.repos.messages.listReplies(root.id, decodeCursor<Cursor>(cursor), limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    await this.uow.repos.messages.markThreadRead(root.id, actor.userId, new Date());
    return {
      items: await this.hydrate(page),
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async react(actor: MemberContext, messageId: string, emoji: string, add: boolean): Promise<MessageDto> {
    const message = await this.loadMessage(actor, messageId, true);
    if (message.deletedAt) throw new BadRequestError('This message was deleted');
    const changed = add
      ? await this.uow.repos.messages.addReaction(message.id, actor.userId, emoji)
      : await this.uow.repos.messages.removeReaction(message.id, actor.userId, emoji);
    const dto = (await this.hydrate([message]))[0]!;
    if (changed) {
      await this.events.publish({
        type: add ? EVENTS.REACTION_ADDED : EVENTS.REACTION_REMOVED,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        data: {
          messageId: dto.id,
          conversationId: dto.conversationId,
          parentId: dto.parentId,
          authorId: dto.authorId,
          emoji,
          reactions: dto.reactions,
        },
      });
    }
    return dto;
  }

  async setPinned(actor: MemberContext, messageId: string, pinned: boolean): Promise<MessageDto> {
    const message = await this.loadMessage(actor, messageId, true);
    if (message.deletedAt) throw new BadRequestError('This message was deleted');
    const changed = pinned
      ? await this.uow.repos.messages.pin(message.conversationId, message.id, actor.userId)
      : await this.uow.repos.messages.unpin(message.conversationId, message.id);
    const dto = (await this.hydrate([message]))[0]!;
    if (changed) await this.publishMessageEvent(EVENTS.MESSAGE_UPDATED, actor, dto);
    return dto;
  }

  async listPinned(actor: MemberContext, conversationId: string): Promise<MessageDto[]> {
    await this.access(actor, conversationId);
    return this.hydrate(await this.uow.repos.messages.listPinned(conversationId));
  }

  async threads(actor: MemberContext, cursor: string | undefined, limit: number): Promise<Page<ThreadSummaryDto>> {
    const before = decodeCursor<{ at: string; id: string }>(cursor);
    const rows = await this.uow.repos.messages.listThreads(actor.workspaceId, actor.userId, before, limit + 1);
    const page = rows.slice(0, limit);
    const roots = await this.hydrate(page.map((r) => r.root));
    const last = page.at(-1);
    return {
      items: page.map((r, i) => ({
        root: roots[i]!,
        conversation: conversationRef(r.conversation),
        unread: !!r.root.lastReplyAt && (!r.lastReadAt || r.root.lastReplyAt > r.lastReadAt),
      })),
      nextCursor:
        rows.length > limit && last?.root.lastReplyAt
          ? encodeCursor({ at: last.root.lastReplyAt.toISOString(), id: last.root.id })
          : null,
    };
  }

  async search(actor: MemberContext, query: SearchMessagesQuery): Promise<Page<SearchResultDto>> {
    const tsQuery = toTsQuery(query.q);
    if (!tsQuery) return { items: [], nextCursor: null };
    const hits = await this.uow.repos.messages.search(actor.workspaceId, actor.userId, {
      tsQuery,
      conversationId: query.conversationId,
      authorId: query.authorId,
      before: decodeCursor<Cursor>(query.cursor),
      limit: query.limit + 1,
    });
    const page = hits.slice(0, query.limit);
    const messages = await this.hydrate(page.map((h) => h.message));
    const last = page.at(-1);
    return {
      items: page.map((h, i) => ({ message: messages[i]!, conversation: conversationRef(h.conversation), highlight: h.highlight })),
      nextCursor:
        hits.length > query.limit && last
          ? encodeCursor({ createdAt: last.message.createdAt.toISOString(), id: last.message.id })
          : null,
    };
  }

  async postSystemMessage(input: SystemMessageInput): Promise<MessageDto> {
    const conversation = await this.uow.repos.conversations.findById(input.conversationId);
    if (!conversation) throw new NotFoundError('Conversation');
    const message = await this.uow.transaction(async (repos) => {
      const created = await repos.messages.create({
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        authorId: input.authorId,
        kind: 'system',
        text: input.text,
        body: input.body ?? null,
      });
      await repos.conversations.update(conversation.id, { lastMessageAt: created.createdAt });
      return created;
    });
    const dto = toMessageDto(message);
    await this.publishCreated(input.authorId, conversation, dto, null);
    return dto;
  }

  private async access(
    actor: MemberContext,
    conversationId: string,
  ): Promise<{ conversation: ConversationRow; membership: ConversationMemberRow | null }> {
    const item = await this.uow.repos.conversations.getForUser(conversationId, actor.userId);
    this.policy.assertCanView(item?.conversation ?? null, actor, item?.membership ?? null);
    return { conversation: item!.conversation, membership: item!.membership };
  }

  private async loadMessage(actor: MemberContext, messageId: string, requireMembership = false): Promise<MessageRow> {
    const message = await this.uow.repos.messages.findById(messageId);
    if (!message || message.workspaceId !== actor.workspaceId) throw new NotFoundError('Message');
    const { membership } = await this.access(actor, message.conversationId);
    if (requireMembership && !membership) throw new ForbiddenError('Join this conversation first');
    return message;
  }

  private async hydrate(rows: MessageRow[]): Promise<MessageDto[]> {
    const ids = rows.map((r) => r.id);
    const [reactionRows, pinned] = await Promise.all([
      this.uow.repos.messages.reactionsFor(ids),
      this.uow.repos.messages.pinnedIds(ids),
    ]);
    const reactions = groupReactions(reactionRows);
    return rows.map((r) => toMessageDto(r, reactions.get(r.id) ?? [], pinned.has(r.id)));
  }

  private async publishCreated(actorId: string, conversation: ConversationRow, message: MessageDto, root: MessageRow | null) {
    const isDirect = conversation.type === 'dm' || conversation.type === 'group_dm';
    const recipients = isDirect ? await this.uow.repos.conversations.listMemberIds(conversation.id) : [];
    const threadRecipients = root ? [root.authorId, ...root.replyUserIds] : [];
    const data: MessageCreatedEvent & { threadParticipantIds: string[] } = {
      message,
      conversation: conversationRef(conversation),
      recipientUserIds: recipients.filter((id) => id !== actorId),
      threadParticipantIds: [...new Set(threadRecipients)].filter((id) => id !== actorId),
    };
    await this.events.publish({ type: EVENTS.MESSAGE_CREATED, workspaceId: conversation.workspaceId, actorId, data });
  }

  private publishMessageEvent(type: typeof EVENTS.MESSAGE_UPDATED, actor: MemberContext, message: MessageDto) {
    return this.events.publish({ type, workspaceId: actor.workspaceId, actorId: actor.userId, data: { message } });
  }
}
