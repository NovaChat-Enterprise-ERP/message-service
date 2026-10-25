import type { Request, Response } from 'express';
import {
  editMessageSchema,
  listMessagesQuerySchema,
  paginationQuerySchema,
  reactionSchema,
  searchMessagesQuerySchema,
  sendMessageSchema,
} from '@novachat-enterprise-erp/contracts';
import { memberContext, parse, stringParam, uuidParam } from '@novachat-enterprise-erp/common';
import type { MessageService } from '../services/message.service.js';

const mid = (req: Request) => uuidParam(req, 'messageId', 'Message');

export class MessageController {
  constructor(private readonly messages: MessageService) {}

  list = async (req: Request, res: Response) => {
    const { cursor, limit } = parse(listMessagesQuerySchema, req.query);
    res.json(await this.messages.list(memberContext(req), uuidParam(req, 'conversationId', 'Conversation'), cursor, limit));
  };

  send = async (req: Request, res: Response) => {
    const input = parse(sendMessageSchema, req.body);
    res.status(201).json(await this.messages.send(memberContext(req), uuidParam(req, 'conversationId', 'Conversation'), input));
  };

  pins = async (req: Request, res: Response) => {
    res.json({ items: await this.messages.listPinned(memberContext(req), uuidParam(req, 'conversationId', 'Conversation')) });
  };

  get = async (req: Request, res: Response) => {
    res.json(await this.messages.get(memberContext(req), mid(req)));
  };

  edit = async (req: Request, res: Response) => {
    res.json(await this.messages.edit(memberContext(req), mid(req), parse(editMessageSchema, req.body)));
  };

  delete = async (req: Request, res: Response) => {
    await this.messages.delete(memberContext(req), mid(req));
    res.status(204).end();
  };

  replies = async (req: Request, res: Response) => {
    const { cursor, limit } = parse(listMessagesQuerySchema, req.query);
    res.json(await this.messages.replies(memberContext(req), mid(req), cursor, limit));
  };

  addReaction = async (req: Request, res: Response) => {
    const { emoji } = parse(reactionSchema, req.body);
    res.json(await this.messages.react(memberContext(req), mid(req), emoji, true));
  };

  removeReaction = async (req: Request, res: Response) => {
    const { emoji } = parse(reactionSchema, { emoji: stringParam(req, 'emoji') });
    res.json(await this.messages.react(memberContext(req), mid(req), emoji, false));
  };

  pin = async (req: Request, res: Response) => {
    res.json(await this.messages.setPinned(memberContext(req), mid(req), true));
  };

  unpin = async (req: Request, res: Response) => {
    res.json(await this.messages.setPinned(memberContext(req), mid(req), false));
  };

  threads = async (req: Request, res: Response) => {
    const { cursor, limit } = parse(paginationQuerySchema, req.query);
    res.json(await this.messages.threads(memberContext(req), cursor, limit));
  };

  search = async (req: Request, res: Response) => {
    res.json(await this.messages.search(memberContext(req), parse(searchMessagesQuerySchema, req.query)));
  };
}
