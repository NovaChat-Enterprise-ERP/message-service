import type { Database } from '../db/client.js';
import { DrizzleConversationRepository, type ConversationRepository } from './conversation.repository.js';
import { DrizzleMessageRepository, type MessageRepository } from './message.repository.js';

export interface Repositories {
  conversations: ConversationRepository;
  messages: MessageRepository;
}

export interface UnitOfWork {
  readonly repos: Repositories;
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

const createRepositories = (db: Database): Repositories => ({
  conversations: new DrizzleConversationRepository(db),
  messages: new DrizzleMessageRepository(db),
});

export class DrizzleUnitOfWork implements UnitOfWork {
  readonly repos: Repositories;

  constructor(private readonly db: Database) {
    this.repos = createRepositories(db);
  }

  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(createRepositories(tx as unknown as Database)));
  }
}
