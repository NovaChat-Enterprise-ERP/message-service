import { PERMISSIONS, SYSTEM_ROLES } from '@novachat-enterprise-erp/contracts';
import { BadRequestError, ForbiddenError, NotFoundError, type MemberContext } from '@novachat-enterprise-erp/common';
import type { ConversationMemberRow, ConversationRow } from '../db/schema.js';

export const isChannel = (c: ConversationRow) => c.type === 'public_channel' || c.type === 'private_channel';

export class ConversationPolicy {
  canView(c: ConversationRow, actor: MemberContext, membership: ConversationMemberRow | null): boolean {
    if (c.workspaceId !== actor.workspaceId) return false;
    if (membership) return true;
    return c.type === 'public_channel' && actor.role !== SYSTEM_ROLES.GUEST;
  }

  assertCanView(c: ConversationRow | null, actor: MemberContext, membership: ConversationMemberRow | null): asserts c is ConversationRow {
    if (!c || !this.canView(c, actor, membership)) throw new NotFoundError('Conversation');
  }

  assertCanPost(c: ConversationRow, membership: ConversationMemberRow | null): void {
    if (!membership) throw new ForbiddenError('Join this conversation to send messages');
    if (c.archivedAt) throw new ForbiddenError('This channel is archived');
  }

  assertChannel(c: ConversationRow): void {
    if (!isChannel(c)) throw new BadRequestError('This action is only available for channels');
  }

  canManage(c: ConversationRow, actor: MemberContext): boolean {
    return c.createdBy === actor.userId || actor.permissions.includes(PERMISSIONS.CHANNELS_MANAGE);
  }

  assertCanManage(c: ConversationRow, actor: MemberContext): void {
    this.assertChannel(c);
    if (!this.canManage(c, actor)) throw new ForbiddenError('Only the channel creator or an admin can do this');
  }
}
