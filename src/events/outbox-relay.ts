import type { DomainEvent } from '@novachat-enterprise-erp/contracts';
import type { Logger } from '@novachat-enterprise-erp/common';
import type { UnitOfWork } from '../repositories/unit-of-work.js';

/** Where relayed events go. Must deliver the event as-is (same id) so consumers can de-duplicate. */
export interface EventSink {
  deliver(event: DomainEvent): Promise<void>;
}

export interface OutboxRelayOptions {
  logger: Logger;
  batchSize?: number;
  /** Fallback poll interval; commits in this process wake the relay immediately. */
  pollIntervalMs?: number;
  /** How long published rows are kept for debugging before being deleted. */
  retentionMs?: number;
  purgeIntervalMs?: number;
  maxBackoffMs?: number;
}

interface BatchResult {
  delivered: number;
  more: boolean;
  error?: unknown;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Moves committed outbox rows to the event stream.
 *
 * - One relay at a time: each batch takes a transaction-scoped advisory lock, so with
 *   several replicas the others skip the round and events stay in `seq` order.
 * - At-least-once: if delivery succeeds but marking the row fails, the event is sent
 *   again later with the same id. Consumers must tolerate duplicates.
 * - A failed delivery stops the batch (later events wait behind it, preserving order)
 *   and the relay backs off exponentially.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly retentionMs: number;
  private readonly purgeIntervalMs: number;
  private readonly maxBackoffMs: number;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private nudged = false;
  private backingOff = false;
  private lastPurgeAt = 0;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly sink: EventSink,
    private readonly options: OutboxRelayOptions,
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
    this.purgeIntervalMs = options.purgeIntervalMs ?? 10 * 60 * 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    uow.onEventsCommitted(() => this.nudge());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  /** Signals that new events were committed. Ignored while backing off from a broker failure. */
  nudge(): void {
    this.nudged = true;
    if (!this.backingOff) this.wake?.();
  }

  /**
   * Delivers every pending event, committing progress batch by batch.
   * Throws the delivery error if a batch fails part-way.
   */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.relayBatch();
      total += batch.delivered;
      if (batch.error) throw batch.error;
      if (!batch.more) return total;
    }
  }

  private relayBatch(): Promise<BatchResult> {
    return this.uow.transaction(async (repos) => {
      if (!(await repos.outbox.tryLockRelay())) return { delivered: 0, more: false };
      const rows = await repos.outbox.pending(this.batchSize);
      const delivered: number[] = [];
      for (const row of rows) {
        try {
          await this.sink.deliver(row.event);
          delivered.push(row.seq);
        } catch (error) {
          // Keep the progress made so far, record the failure, and let the caller back off.
          await repos.outbox.markPublished(delivered);
          await repos.outbox.recordFailure(row.seq, errorMessage(error));
          return { delivered: delivered.length, more: false, error };
        }
      }
      await repos.outbox.markPublished(delivered);
      return { delivered: delivered.length, more: rows.length === this.batchSize };
    });
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      this.nudged = false;
      let delay = this.pollIntervalMs;
      try {
        await this.drain();
        await this.purgeIfDue();
        failures = 0;
      } catch (error) {
        failures += 1;
        delay = Math.min(this.maxBackoffMs, 500 * 2 ** (failures - 1));
        this.options.logger.error(
          { err: error, failures, retryInMs: delay },
          'Outbox relay failed; backing off',
        );
      }
      if (!this.running) break;
      if (failures === 0 && this.nudged) continue; // events were committed while we were draining
      this.backingOff = failures > 0;
      await this.sleep(delay);
      this.backingOff = false;
    }
  }

  private async purgeIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPurgeAt < this.purgeIntervalMs) return;
    this.lastPurgeAt = now;
    const purged = await this.uow.repos.outbox.purgePublished(new Date(now - this.retentionMs));
    if (purged > 0) this.options.logger.debug({ purged }, 'Purged published outbox rows');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
