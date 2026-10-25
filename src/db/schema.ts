import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AttachmentDto, ConversationType, MessageKind } from '@novachat-enterprise-erp/contracts';

export const messagingSchema = pgSchema('messaging');

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 6 });

export const conversations = messagingSchema.table(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    type: text('type').$type<ConversationType>().notNull(),
    name: text('name'),
    topic: text('topic'),
    description: text('description'),
    isDefault: boolean('is_default').notNull().default(false),
    dmKey: text('dm_key'),
    createdBy: text('created_by').notNull(),
    archivedAt: ts('archived_at'),
    lastMessageAt: ts('last_message_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('conversations_workspace_idx').on(t.workspaceId, t.type),
    uniqueIndex('conversations_workspace_name_uq').on(t.workspaceId, t.name).where(sql`${t.name} is not null`),
    uniqueIndex('conversations_workspace_dm_key_uq').on(t.workspaceId, t.dmKey).where(sql`${t.dmKey} is not null`),
  ],
);

export const conversationMembers = messagingSchema.table(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    lastReadAt: ts('last_read_at'),
    muted: boolean('muted').notNull().default(false),
    joinedAt: ts('joined_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('conversation_members_user_idx').on(t.workspaceId, t.userId),
  ],
);

export const messages = messagingSchema.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull(),
    parentId: uuid('parent_id'),
    kind: text('kind').$type<MessageKind>().notNull().default('user'),
    body: jsonb('body').$type<Record<string, unknown> | null>(),
    text: text('text').notNull().default(''),
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('simple', coalesce("text", ''))`),
    attachments: jsonb('attachments').$type<AttachmentDto[]>().notNull().default([]),
    mentions: text('mentions').array().notNull().default(sql`'{}'::text[]`),
    mentionsChannel: boolean('mentions_channel').notNull().default(false),
    clientMsgId: text('client_msg_id'),
    replyCount: integer('reply_count').notNull().default(0),
    lastReplyAt: ts('last_reply_at'),
    replyUserIds: text('reply_user_ids').array().notNull().default(sql`'{}'::text[]`),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt.desc(), t.id.desc()),
    index('messages_parent_created_idx').on(t.parentId, t.createdAt),
    index('messages_search_idx').using('gin', t.search),
    index('messages_mentions_idx').using('gin', t.mentions),
    uniqueIndex('messages_author_client_msg_uq').on(t.authorId, t.clientMsgId).where(sql`${t.clientMsgId} is not null`),
  ],
);

export const reactions = messagingSchema.table(
  'reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

export const pins = messagingSchema.table(
  'pins',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    pinnedBy: text('pinned_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.messageId] })],
);

export const threadParticipants = messagingSchema.table(
  'thread_participants',
  {
    rootId: uuid('root_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    lastReadAt: ts('last_read_at'),
  },
  (t) => [primaryKey({ columns: [t.rootId, t.userId] }), index('thread_participants_user_idx').on(t.workspaceId, t.userId)],
);

export const schema = { conversations, conversationMembers, messages, reactions, pins, threadParticipants };

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationMemberRow = typeof conversationMembers.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ReactionRow = typeof reactions.$inferSelect;
