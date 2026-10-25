import type { ConversationDto, MessageDto, ReactionDto } from '@novachat-enterprise-erp/contracts';
import type { ConversationRow, MessageRow, ReactionRow } from '../db/schema.js';
import type { ConversationListItem } from '../repositories/conversation.repository.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const toConversationDto = (item: ConversationListItem): ConversationDto => {
  const c = item.conversation;
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    type: c.type,
    name: c.name,
    topic: c.topic,
    description: c.description,
    isDefault: c.isDefault,
    createdBy: c.createdBy,
    archivedAt: iso(c.archivedAt),
    lastMessageAt: iso(c.lastMessageAt),
    memberCount: Number(item.memberCount),
    participantIds: item.participantIds ?? [],
    createdAt: c.createdAt.toISOString(),
    membership: item.membership
      ? {
          joinedAt: item.membership.joinedAt.toISOString(),
          lastReadAt: iso(item.membership.lastReadAt),
          muted: item.membership.muted,
          unreadCount: Number(item.unreadCount),
          mentionCount: Number(item.mentionCount),
        }
      : null,
  };
};

export const conversationRef = (c: ConversationRow) => ({ id: c.id, type: c.type, name: c.name });

export const groupReactions = (rows: ReactionRow[]): Map<string, ReactionDto[]> => {
  const byMessage = new Map<string, Map<string, ReactionDto>>();
  for (const r of rows) {
    const emojis = byMessage.get(r.messageId) ?? new Map<string, ReactionDto>();
    const entry = emojis.get(r.emoji) ?? { emoji: r.emoji, count: 0, userIds: [] };
    entry.count += 1;
    entry.userIds.push(r.userId);
    emojis.set(r.emoji, entry);
    byMessage.set(r.messageId, emojis);
  }
  return new Map([...byMessage].map(([id, emojis]) => [id, [...emojis.values()]]));
};

export const toMessageDto = (m: MessageRow, reactions: ReactionDto[] = [], isPinned = false): MessageDto => ({
  id: m.id,
  workspaceId: m.workspaceId,
  conversationId: m.conversationId,
  authorId: m.authorId,
  parentId: m.parentId,
  kind: m.kind,
  body: m.deletedAt ? null : m.body ?? null,
  text: m.deletedAt ? '' : m.text,
  attachments: m.deletedAt ? [] : m.attachments,
  mentions: m.mentions,
  mentionsChannel: m.mentionsChannel,
  reactions: m.deletedAt ? [] : reactions,
  replyCount: m.replyCount,
  lastReplyAt: iso(m.lastReplyAt),
  replyUserIds: m.replyUserIds,
  isPinned,
  clientMsgId: m.clientMsgId,
  editedAt: iso(m.editedAt),
  deletedAt: iso(m.deletedAt),
  createdAt: m.createdAt.toISOString(),
});
