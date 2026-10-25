import { Router } from 'express';
import { PERMISSIONS } from '@novachat-enterprise-erp/contracts';
import { requireMember, requirePermission, requireService } from '@novachat-enterprise-erp/common';
import type { Container } from '../container.js';

export const publicRoutes = ({ controllers: { conversations: c, messages: m } }: Container): Router => {
  const ws = Router({ mergeParams: true });
  ws.use(requireMember);

  ws.get('/conversations', c.listMine);
  ws.get('/conversations/browse', c.browse);
  ws.post('/conversations/channels', requirePermission(PERMISSIONS.CHANNELS_CREATE), c.createChannel);
  ws.post('/conversations/direct', c.openDirect);
  ws.get('/conversations/:conversationId', c.get);
  ws.patch('/conversations/:conversationId', c.update);
  ws.delete('/conversations/:conversationId', c.delete);
  ws.post('/conversations/:conversationId/archive', c.archive);
  ws.post('/conversations/:conversationId/unarchive', c.unarchive);
  ws.post('/conversations/:conversationId/join', c.join);
  ws.post('/conversations/:conversationId/leave', c.leave);
  ws.get('/conversations/:conversationId/members', c.members);
  ws.post('/conversations/:conversationId/members', c.addMembers);
  ws.delete('/conversations/:conversationId/members/:userId', c.removeMember);
  ws.post('/conversations/:conversationId/read', c.markRead);
  ws.patch('/conversations/:conversationId/preferences', c.preferences);
  ws.get('/conversations/:conversationId/messages', m.list);
  ws.post('/conversations/:conversationId/messages', m.send);
  ws.get('/conversations/:conversationId/pins', m.pins);

  ws.get('/messages/:messageId', m.get);
  ws.patch('/messages/:messageId', m.edit);
  ws.delete('/messages/:messageId', m.delete);
  ws.get('/messages/:messageId/replies', m.replies);
  ws.post('/messages/:messageId/reactions', m.addReaction);
  ws.delete('/messages/:messageId/reactions/:emoji', m.removeReaction);
  ws.post('/messages/:messageId/pin', m.pin);
  ws.delete('/messages/:messageId/pin', m.unpin);

  ws.get('/threads', m.threads);
  ws.get('/search', m.search);

  const router = Router();
  router.use('/workspaces/:workspaceId', ws);
  return router;
};

export const internalRoutes = ({ controllers: { internal } }: Container): Router => {
  const router = Router();
  router.use(requireService);
  router.get('/conversations/:conversationId/access/:userId', internal.access);
  router.post('/conversations/:conversationId/system-messages', internal.systemMessage);
  router.get('/workspaces/:workspaceId/users/:userId/conversations', internal.userConversations);
  return router;
};
