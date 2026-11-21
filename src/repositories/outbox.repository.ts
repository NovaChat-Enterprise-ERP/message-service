import { randomUUID } from 'node:crypto';
import { and, asc, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { DomainEvent } from '@novachat-enterprise-erp/contracts';
import type { EventPublisher, NewEvent } from '@novachat-enterprise-erp/events';
import type { Database } from '../db/client.js';
import { outbox, type OutboxRow } from '../db/schema.js';

/** Arbitrary constant key for the advisory lock that elects a single active relay. */
const RELAY_LOCK_KEY = 0x6d73676f; // "msgo"

export interface OutboxRepository {
  add(event: DomainEvent): Promise<void>;
  /** Transaction-scoped: true if this transaction now holds the relay lock. */
  tryLockRelay(): Promise<boolean>;
  pending(limit: number): Promise<OutboxRow[]>;
  markPublished(seqs: number[]): Promise<void>;
  recordFailure(seq: number, error: string): Promise<void>;
  purgePublished(before: Date): Promise<number>;
}

export class DrizzleOutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: Database,
    private readonly onAdd: () => void = () => undefined,
  ) {}

  async add(event: DomainEvent): Promise<void> {
    await this.db.insert(outbox).values({ eventId: event.id, type: event.type, event });
    this.onAdd();
  }

  async tryLockRelay(): Promise<boolean> {
    // Both node-postgres and PGlite return `{ rows }` for raw queries.
    const result = (await this.db.execute(
      sql`select pg_try_advisory_xact_lock(${RELAY_LOCK_KEY}) as locked`,
    )) as {
      rows: { locked: boolean }[];
    };
    return result.rows[0]?.locked === true;
  }

  pending(limit: number): Promise<OutboxRow[]> {
    return this.db
      .select()
      .from(outbox)
      .where(isNull(outbox.publishedAt))
      .orderBy(asc(outbox.seq))
      .limit(limit);
  }

  async markPublished(seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;
    await this.db.update(outbox).set({ publishedAt: new Date() }).where(inArray(outbox.seq, seqs));
  }

  async recordFailure(seq: number, error: string): Promise<void> {
    await this.db
      .update(outbox)
      .set({ attempts: sql`${outbox.attempts} + 1`, lastError: error.slice(0, 1000) })
      .where(sql`${outbox.seq} = ${seq}`);
  }

  async purgePublished(before: Date): Promise<number> {
    const deleted = await this.db
      .delete(outbox)
      .where(and(isNotNull(outbox.publishedAt), lt(outbox.publishedAt, before)))
      .returning({ seq: outbox.seq });
    return deleted.length;
  }
}

/**
 * EventPublisher that writes to the outbox instead of the broker. Use the instance
 * from a transaction's repositories so the event commits (or rolls back) with the
 * state change it describes.
 */
export class OutboxEventPublisher implements EventPublisher {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly source: string,
  ) {}

  async publish<T>(event: NewEvent<T>): Promise<void> {
    await this.outbox.add({
      ...event,
      id: randomUUID(),
      source: this.source,
      occurredAt: new Date().toISOString(),
    } as DomainEvent);
  }
}
