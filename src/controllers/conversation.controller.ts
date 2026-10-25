import type { Request, Response } from 'express';
import {
  addConversationMembersSchema,
  browseChannelsQuerySchema,
  conversationPreferencesSchema,
  createChannelSchema,
  markReadSchema,
  openDirectSchema,
  updateConversationSchema,
} from '@novachat-enterprise-erp/contracts';
import { memberContext, parse, stringParam, uuidParam } from '@novachat-enterprise-erp/common';
import type { ConversationService } from '../services/conversation.service.js';

const cid = (req: Request) => uuidParam(req, 'conversationId', 'Conversation');

export class ConversationController {
  constructor(private readonly conversations: ConversationService) {}

  listMine = async (req: Request, res: Response) => {
    res.json({ items: await this.conversations.listMine(memberContext(req)) });
  };

  browse = async (req: Request, res: Response) => {
    const { q, scope } = parse(browseChannelsQuerySchema, req.query);
    res.json({ items: await this.conversations.browse(memberContext(req), q, scope) });
  };

  get = async (req: Request, res: Response) => {
    res.json(await this.conversations.get(memberContext(req), cid(req)));
  };

  createChannel = async (req: Request, res: Response) => {
    res.status(201).json(await this.conversations.createChannel(memberContext(req), parse(createChannelSchema, req.body)));
  };

  openDirect = async (req: Request, res: Response) => {
    const { userIds } = parse(openDirectSchema, req.body);
    res.json(await this.conversations.openDirect(memberContext(req), userIds));
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.conversations.update(memberContext(req), cid(req), parse(updateConversationSchema, req.body)));
  };

  archive = async (req: Request, res: Response) => {
    res.json(await this.conversations.setArchived(memberContext(req), cid(req), true));
  };

  unarchive = async (req: Request, res: Response) => {
    res.json(await this.conversations.setArchived(memberContext(req), cid(req), false));
  };

  delete = async (req: Request, res: Response) => {
    await this.conversations.delete(memberContext(req), cid(req));
    res.status(204).end();
  };

  join = async (req: Request, res: Response) => {
    res.json(await this.conversations.join(memberContext(req), cid(req)));
  };

  leave = async (req: Request, res: Response) => {
    await this.conversations.leave(memberContext(req), cid(req));
    res.status(204).end();
  };

  members = async (req: Request, res: Response) => {
    res.json({ items: await this.conversations.listMembers(memberContext(req), cid(req)) });
  };

  addMembers = async (req: Request, res: Response) => {
    const { userIds } = parse(addConversationMembersSchema, req.body);
    res.json({ added: await this.conversations.addMembers(memberContext(req), cid(req), userIds) });
  };

  removeMember = async (req: Request, res: Response) => {
    await this.conversations.removeMember(memberContext(req), cid(req), stringParam(req, 'userId'));
    res.status(204).end();
  };

  markRead = async (req: Request, res: Response) => {
    const { messageId } = parse(markReadSchema, req.body ?? {});
    await this.conversations.markRead(memberContext(req), cid(req), messageId);
    res.status(204).end();
  };

  preferences = async (req: Request, res: Response) => {
    const { muted } = parse(conversationPreferencesSchema, req.body);
    await this.conversations.setMuted(memberContext(req), cid(req), muted);
    res.status(204).end();
  };
}
