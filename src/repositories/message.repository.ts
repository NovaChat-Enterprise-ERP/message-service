import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  conversationMembers,
  conversations,
  messages,
  pins,
  reactions,
  threadParticipants,
  type ConversationRow,
  type MessageRow,
  type ReactionRow,
} from '../db/schema.js';

export type NewMessage = Pick<MessageRow, 'workspaceId' | 'conversationId' | 'authorId' | 'text'> &
  Partial<Pick<MessageRow, 'parentId' | 'kind' | 'body' | 'attachments' | 'mentions' | 'mentionsChannel' | 'clientMsgId'>>;
export type MessagePatch = Partial<Pick<MessageRow, 'body' | 'text' | 'mentions' | 'mentionsChannel' | 'editedAt' | 'deletedAt' | 'attachments'>>;

export interface Cursor {
  createdAt: string;
  id: string;
}

export interface SearchHit {
  message: MessageRow;
  conversation: ConversationRow;
  highlight: string;
}

export interface ThreadHit {
  root: MessageRow;
  conversation: ConversationRow;
  lastReadAt: Date | null;
}

export interface MessageRepository {
  create(input: NewMessage): Promise<MessageRow>;
  findById(id: string): Promise<MessageRow | null>;
  findByClientMsgId(authorId: string, clientMsgId: string): Promise<MessageRow | null>;
  listRoot(conversationId: string, before: Cursor | null, limit: number): Promise<MessageRow[]>;
  listReplies(parentId: string, after: Cursor | null, limit: number): Promise<MessageRow[]>;
  update(id: string, patch: MessagePatch): Promise<MessageRow | null>;
  recordReply(rootId: string, authorId: string, at: Date): Promise<void>;
  removeReply(rootId: string): Promise<void>;

  addReaction(messageId: string, userId: string, emoji: string): Promise<boolean>;
  removeReaction(messageId: string, userId: string, emoji: string): Promise<boolean>;
  reactionsFor(messageIds: string[]): Promise<ReactionRow[]>;

  pin(conversationId: string, messageId: string, userId: string): Promise<boolean>;
  unpin(conversationId: string, messageId: string): Promise<boolean>;
  pinnedIds(messageIds: string[]): Promise<Set<string>>;
  listPinned(conversationId: string): Promise<MessageRow[]>;

  joinThread(rootId: string, workspaceId: string, userId: string, readAt: Date | null): Promise<void>;
  markThreadRead(rootId: string, userId: string, at: Date): Promise<void>;
  listThreads(workspaceId: string, userId: string, before: { at: string; id: string } | null, limit: number): Promise<ThreadHit[]>;

  search(workspaceId: string, userId: string, query: SearchQuery): Promise<SearchHit[]>;
}

export interface SearchQuery {
  tsQuery: string;
  conversationId?: string;
  authorId?: string;
  before: Cursor | null;
  limit: number;
}

const beforeCursor = (cursor: Cursor | null) =>
  cursor
    ? or(
        lt(messages.createdAt, new Date(cursor.createdAt)),
        and(eq(messages.createdAt, new Date(cursor.createdAt)), lt(messages.id, cursor.id)),
      )
    : undefined;

export class DrizzleMessageRepository implements MessageRepository {
  constructor(private readonly db: Database) {}

  async create(input: NewMessage): Promise<MessageRow> {
    const [row] = await this.db.insert(messages).values(input).returning();
    return row!;
  }

  async findById(id: string): Promise<MessageRow | null> {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return row ?? null;
  }

  async findByClientMsgId(authorId: string, clientMsgId: string): Promise<MessageRow | null> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.authorId, authorId), eq(messages.clientMsgId, clientMsgId)))
      .limit(1);
    return row ?? null;
  }

  async listRoot(conversationId: string, before: Cursor | null, limit: number): Promise<MessageRow[]> {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), isNull(messages.parentId), beforeCursor(before)))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);
  }

  async listReplies(parentId: string, after: Cursor | null, limit: number): Promise<MessageRow[]> {
    const cursor = after
      ? or(
          gt(messages.createdAt, new Date(after.createdAt)),
          and(eq(messages.createdAt, new Date(after.createdAt)), gt(messages.id, after.id)),
        )
      : undefined;
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.parentId, parentId), cursor))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(limit);
  }

  async update(id: string, patch: MessagePatch): Promise<MessageRow | null> {
    const [row] = await this.db.update(messages).set(patch).where(eq(messages.id, id)).returning();
    return row ?? null;
  }

  async recordReply(rootId: string, authorId: string, at: Date): Promise<void> {
    await this.db
      .update(messages)
      .set({
        replyCount: sql`${messages.replyCount} + 1`,
        lastReplyAt: at,
        replyUserIds: sql`(array_remove(${messages.replyUserIds}, ${authorId}) || array[${authorId}::text])[greatest(1, cardinality(array_remove(${messages.replyUserIds}, ${authorId})) - 2):]`,
      })
      .where(eq(messages.id, rootId));
  }

  async removeReply(rootId: string): Promise<void> {
    await this.db
      .update(messages)
      .set({ replyCount: sql`greatest(0, ${messages.replyCount} - 1)` })
      .where(eq(messages.id, rootId));
  }

  async addReaction(messageId: string, userId: string, emoji: string): Promise<boolean> {
    const rows = await this.db.insert(reactions).values({ messageId, userId, emoji }).onConflictDoNothing().returning();
    return rows.length > 0;
  }

  async removeReaction(messageId: string, userId: string, emoji: string): Promise<boolean> {
    const rows = await this.db
      .delete(reactions)
      .where(and(eq(reactions.messageId, messageId), eq(reactions.userId, userId), eq(reactions.emoji, emoji)))
      .returning();
    return rows.length > 0;
  }

  async reactionsFor(messageIds: string[]): Promise<ReactionRow[]> {
    if (messageIds.length === 0) return [];
    return this.db
      .select()
      .from(reactions)
      .where(inArray(reactions.messageId, messageIds))
      .orderBy(asc(reactions.createdAt));
  }

  async pin(conversationId: string, messageId: string, userId: string): Promise<boolean> {
    const rows = await this.db.insert(pins).values({ conversationId, messageId, pinnedBy: userId }).onConflictDoNothing().returning();
    return rows.length > 0;
  }

  async unpin(conversationId: string, messageId: string): Promise<boolean> {
    const rows = await this.db
      .delete(pins)
      .where(and(eq(pins.conversationId, conversationId), eq(pins.messageId, messageId)))
      .returning();
    return rows.length > 0;
  }

  async pinnedIds(messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set();
    const rows = await this.db.select({ id: pins.messageId }).from(pins).where(inArray(pins.messageId, messageIds));
    return new Set(rows.map((r) => r.id));
  }

  async listPinned(conversationId: string): Promise<MessageRow[]> {
    const rows = await this.db
      .select({ message: messages })
      .from(pins)
      .innerJoin(messages, eq(pins.messageId, messages.id))
      .where(and(eq(pins.conversationId, conversationId), isNull(messages.deletedAt)))
      .orderBy(desc(pins.createdAt));
    return rows.map((r) => r.message);
  }

  async joinThread(rootId: string, workspaceId: string, userId: string, readAt: Date | null): Promise<void> {
    await this.db
      .insert(threadParticipants)
      .values({ rootId, workspaceId, userId, lastReadAt: readAt })
      .onConflictDoUpdate({
        target: [threadParticipants.rootId, threadParticipants.userId],
        set: readAt ? { lastReadAt: readAt } : { userId },
      });
  }

  async markThreadRead(rootId: string, userId: string, at: Date): Promise<void> {
    await this.db
      .update(threadParticipants)
      .set({ lastReadAt: at })
      .where(and(eq(threadParticipants.rootId, rootId), eq(threadParticipants.userId, userId)));
  }

  async listThreads(
    workspaceId: string,
    userId: string,
    before: { at: string; id: string } | null,
    limit: number,
  ): Promise<ThreadHit[]> {
    const cursor = before
      ? or(
          lt(messages.lastReplyAt, new Date(before.at)),
          and(eq(messages.lastReplyAt, new Date(before.at)), lt(messages.id, before.id)),
        )
      : undefined;
    const rows = await this.db
      .select({ root: messages, conversation: conversations, lastReadAt: threadParticipants.lastReadAt })
      .from(threadParticipants)
      .innerJoin(messages, eq(threadParticipants.rootId, messages.id))
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .innerJoin(
        conversationMembers,
        and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.userId, userId)),
      )
      .where(
        and(
          eq(threadParticipants.workspaceId, workspaceId),
          eq(threadParticipants.userId, userId),
          gt(messages.replyCount, 0),
          cursor,
        ),
      )
      .orderBy(desc(messages.lastReplyAt), desc(messages.id))
      .limit(limit);
    return rows;
  }

  async search(workspaceId: string, userId: string, query: SearchQuery): Promise<SearchHit[]> {
    const tsQuery = sql`to_tsquery('simple', ${query.tsQuery})`;
    const rows = await this.db
      .select({
        message: messages,
        conversation: conversations,
        highlight: sql<string>`ts_headline('simple', ${messages.text}, ${tsQuery}, 'StartSel=<mark>,StopSel=</mark>,MaxWords=30,MinWords=10')`,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .innerJoin(
        conversationMembers,
        and(eq(conversationMembers.conversationId, messages.conversationId), eq(conversationMembers.userId, userId)),
      )
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          isNull(messages.deletedAt),
          sql`${messages.search} @@ ${tsQuery}`,
          query.conversationId ? eq(messages.conversationId, query.conversationId) : undefined,
          query.authorId ? eq(messages.authorId, query.authorId) : undefined,
          beforeCursor(query.before),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(query.limit);
    return rows;
  }
}
