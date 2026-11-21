import type { EventPublisher } from '@novachat-enterprise-erp/events';
import type { Database } from '../db/client.js';
import { DrizzleConversationRepository, type ConversationRepository } from './conversation.repository.js';
import { DrizzleMessageRepository, type MessageRepository } from './message.repository.js';
import { DrizzleOutboxRepository, OutboxEventPublisher, type OutboxRepository } from './outbox.repository.js';

export interface Repositories {
  conversations: ConversationRepository;
  messages: MessageRepository;
  outbox: OutboxRepository;
  /** Publishes through the outbox: events commit atomically with this scope's writes. */
  events: EventPublisher;
}

export interface UnitOfWork {
  readonly repos: Repositories;
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
  /** Called after outbox rows become visible to other connections (i.e. committed). */
  onEventsCommitted(listener: () => void): void;
}

export interface UnitOfWorkOptions {
  /** Service name stamped on every event as `source`. */
  source?: string;
}

const createRepositories = (db: Database, source: string, onOutboxWrite: () => void): Repositories => {
  const outbox = new DrizzleOutboxRepository(db, onOutboxWrite);
  return {
    conversations: new DrizzleConversationRepository(db),
    messages: new DrizzleMessageRepository(db),
    outbox,
    events: new OutboxEventPublisher(outbox, source),
  };
};

export class DrizzleUnitOfWork implements UnitOfWork {
  readonly repos: Repositories;
  private readonly source: string;
  private readonly listeners: (() => void)[] = [];

  constructor(
    private readonly db: Database,
    options: UnitOfWorkOptions = {},
  ) {
    this.source = options.source ?? 'message-service';
    // Outside a transaction each statement autocommits, so a write is visible at once.
    this.repos = createRepositories(db, this.source, () => this.emitCommitted());
  }

  async transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    let wroteEvents = false;
    const result = await this.db.transaction((tx) =>
      work(createRepositories(tx as unknown as Database, this.source, () => (wroteEvents = true))),
    );
    if (wroteEvents) this.emitCommitted();
    return result;
  }

  onEventsCommitted(listener: () => void): void {
    this.listeners.push(listener);
  }

  private emitCommitted(): void {
    for (const listener of this.listeners) listener();
  }
}
