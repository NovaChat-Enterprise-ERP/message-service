import type { Request, Response } from 'express';
import { z } from 'zod';
import { parse, stringParam, uuidParam } from '@novachat-enterprise-erp/common';
import type { ConversationService } from '../services/conversation.service.js';
import type { MessageService } from '../services/message.service.js';

const systemMessageSchema = z.object({
  authorId: z.string().min(1),
  text: z.string().min(1).max(4000),
  body: z.record(z.string(), z.unknown()).nullable().optional(),
});

export class InternalController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
  ) {}

  access = async (req: Request, res: Response) => {
    const includeMembers = req.query.includeMembers === 'true';
    res.json(
      await this.conversations.access(uuidParam(req, 'conversationId', 'Conversation'), stringParam(req, 'userId'), includeMembers),
    );
  };

  userConversations = async (req: Request, res: Response) => {
    res.json({
      items: await this.conversations.conversationIdsFor(uuidParam(req, 'workspaceId', 'Workspace'), stringParam(req, 'userId')),
    });
  };

  systemMessage = async (req: Request, res: Response) => {
    const input = parse(systemMessageSchema, req.body);
    res.status(201).json(
      await this.messages.postSystemMessage({ ...input, conversationId: uuidParam(req, 'conversationId', 'Conversation') }),
    );
  };
}
