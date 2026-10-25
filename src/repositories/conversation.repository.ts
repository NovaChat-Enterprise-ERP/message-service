import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  conversationMembers,
  conversations,
  messages,
  type ConversationMemberRow,
  type ConversationRow,
} from '../db/schema.js';

export type NewConversation = Pick<ConversationRow, 'workspaceId' | 'type' | 'createdBy'> &
  Partial<Pick<ConversationRow, 'name' | 'topic' | 'description' | 'isDefault' | 'dmKey'>>;
export type ConversationPatch = Partial<
  Pick<ConversationRow, 'name' | 'topic' | 'description' | 'type' | 'archivedAt' | 'lastMessageAt'>
>;

export interface ConversationListItem {
  conversation: ConversationRow;
  membership: ConversationMemberRow | null;
  memberCount: number;
  participantIds: string[];
  unreadCount: number;
  mentionCount: number;
}

export interface BrowseFilter {
  q?: string;
  includePrivate: boolean;
}

export interface ConversationRepository {
  create(input: NewConversation): Promise<ConversationRow>;
  findById(id: string): Promise<ConversationRow | null>;
  findByDmKey(workspaceId: string, dmKey: string): Promise<ConversationRow | null>;
  findDefaults(workspaceId: string): Promise<ConversationRow[]>;
  update(id: string, patch: ConversationPatch): Promise<ConversationRow | null>;
  delete(id: string): Promise<void>;
  listForUser(workspaceId: string, userId: string): Promise<ConversationListItem[]>;
  getForUser(conversationId: string, userId: string): Promise<ConversationListItem | null>;
  browse(workspaceId: string, userId: string, filter: BrowseFilter): Promise<ConversationListItem[]>;

  addMembers(conversationId: string, workspaceId: string, userIds: string[]): Promise<string[]>;
  removeMember(conversationId: string, userId: string): Promise<boolean>;
  removeUserFromChannels(workspaceId: string, userId: string): Promise<string[]>;
  findMember(conversationId: string, userId: string): Promise<ConversationMemberRow | null>;
  listMemberIds(conversationId: string): Promise<string[]>;
  conversationIdsForUser(workspaceId: string, userId: string): Promise<string[]>;
  markRead(conversationId: string, userId: string, at: Date): Promise<void>;
  setMuted(conversationId: string, userId: string, muted: boolean): Promise<void>;
}

export class DrizzleConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database) {}

  private readonly memberCount = sql<number>`(select count(*)::int from ${conversationMembers} cm where cm.conversation_id = ${conversations.id})`;

  private readonly participantIds = sql<string[]>`case when ${conversations.type} in ('dm', 'group_dm')
    then array(select cm.user_id from ${conversationMembers} cm where cm.conversation_id = ${conversations.id} order by cm.user_id)
    else '{}'::text[] end`;

  private unreadCount(userId: string) {
    return sql<number>`(select count(*)::int from ${messages} m
      where m.conversation_id = ${conversations.id} and m.parent_id is null and m.deleted_at is null
        and m.author_id <> ${userId}
        and (${conversationMembers.lastReadAt} is null or m.created_at > ${conversationMembers.lastReadAt}))`;
  }

  private mentionCount(userId: string) {
    return sql<number>`(select count(*)::int from ${messages} m
      where m.conversation_id = ${conversations.id} and m.deleted_at is null and m.author_id <> ${userId}
        and (${userId} = any(m.mentions) or m.mentions_channel or ${conversations.type} in ('dm', 'group_dm'))
        and m.parent_id is null
        and (${conversationMembers.lastReadAt} is null or m.created_at > ${conversationMembers.lastReadAt}))`;
  }

  private selectForUser(userId: string) {
    return this.db
      .select({
        conversation: conversations,
        membership: conversationMembers,
        memberCount: this.memberCount,
        participantIds: this.participantIds,
        unreadCount: this.unreadCount(userId),
        mentionCount: this.mentionCount(userId),
      })
      .from(conversations);
  }

  async create(input: NewConversation): Promise<ConversationRow> {
    const [row] = await this.db.insert(conversations).values(input).returning();
    return row!;
  }

  async findById(id: string): Promise<ConversationRow | null> {
    const [row] = await this.db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    return row ?? null;
  }

  async findByDmKey(workspaceId: string, dmKey: string): Promise<ConversationRow | null> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.dmKey, dmKey)))
      .limit(1);
    return row ?? null;
  }

  async findDefaults(workspaceId: string): Promise<ConversationRow[]> {
    return this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.isDefault, true), isNull(conversations.archivedAt)));
  }

  async update(id: string, patch: ConversationPatch): Promise<ConversationRow | null> {
    const [row] = await this.db
      .update(conversations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(conversations).where(eq(conversations.id, id));
  }

  async listForUser(workspaceId: string, userId: string): Promise<ConversationListItem[]> {
    const rows = await this.selectForUser(userId)
      .innerJoin(
        conversationMembers,
        and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.userId, userId)),
      )
      .where(eq(conversations.workspaceId, workspaceId))
      .orderBy(asc(conversations.type), asc(conversations.name), desc(conversations.lastMessageAt));
    return rows;
  }

  async getForUser(conversationId: string, userId: string): Promise<ConversationListItem | null> {
    const [row] = await this.selectForUser(userId)
      .leftJoin(
        conversationMembers,
        and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.userId, userId)),
      )
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return row ?? null;
  }

  async browse(workspaceId: string, userId: string, filter: BrowseFilter): Promise<ConversationListItem[]> {
    const types = filter.includePrivate ? ['public_channel', 'private_channel'] : ['public_channel'];
    const term = filter.q ? `%${filter.q.replace(/[%_\\]/g, '\\$&')}%` : null;
    return this.selectForUser(userId)
      .leftJoin(
        conversationMembers,
        and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.userId, userId)),
      )
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          inArray(conversations.type, types as ('public_channel' | 'private_channel')[]),
          term ? or(ilike(conversations.name, term), ilike(conversations.description, term)) : undefined,
        ),
      )
      .orderBy(asc(conversations.name))
      .limit(200);
  }

  async addMembers(conversationId: string, workspaceId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .insert(conversationMembers)
      .values([...new Set(userIds)].map((userId) => ({ conversationId, workspaceId, userId, lastReadAt: new Date() })))
      .onConflictDoNothing()
      .returning({ userId: conversationMembers.userId });
    return rows.map((r) => r.userId);
  }

  async removeMember(conversationId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
      .returning({ userId: conversationMembers.userId });
    return rows.length > 0;
  }

  async removeUserFromChannels(workspaceId: string, userId: string): Promise<string[]> {
    const channelIds = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), ne(conversations.type, 'dm'), ne(conversations.type, 'group_dm')));
    const rows = await this.db
      .delete(conversationMembers)
      .where(and(eq(conversationMembers.userId, userId), inArray(conversationMembers.conversationId, channelIds)))
      .returning({ conversationId: conversationMembers.conversationId });
    return rows.map((r) => r.conversationId);
  }

  async findMember(conversationId: string, userId: string): Promise<ConversationMemberRow | null> {
    const [row] = await this.db
      .select()
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async listMemberIds(conversationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId))
      .orderBy(asc(conversationMembers.joinedAt));
    return rows.map((r) => r.userId);
  }

  async conversationIdsForUser(workspaceId: string, userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.workspaceId, workspaceId), eq(conversationMembers.userId, userId)));
    return rows.map((r) => r.id);
  }

  async markRead(conversationId: string, userId: string, at: Date): Promise<void> {
    await this.db
      .update(conversationMembers)
      .set({ lastReadAt: at })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
          or(isNull(conversationMembers.lastReadAt), sql`${conversationMembers.lastReadAt} < ${at.toISOString()}`),
        ),
      );
  }

  async setMuted(conversationId: string, userId: string, muted: boolean): Promise<void> {
    await this.db
      .update(conversationMembers)
      .set({ muted })
      .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
  }
}
