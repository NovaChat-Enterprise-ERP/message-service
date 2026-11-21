import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EVENTS, type DomainEvent } from '@novachat-enterprise-erp/contracts';
import { createLogger } from '@novachat-enterprise-erp/common';
import { createHarness, WS } from '../test/harness.js';
import { OutboxRelay, type EventSink } from './outbox-relay.js';

let h: Awaited<ReturnType<typeof createHarness>>;
const logger = createLogger('test', 'silent');

const publishInTx = (count: number, label = 'x') =>
  h.uow.transaction(async (repos) => {
    for (let i = 0; i < count; i++) {
      await repos.events.publish({
        type: EVENTS.MESSAGE_DELETED,
        workspaceId: WS,
        data: { label, i },
      });
    }
  });

class FlakySink implements EventSink {
  readonly delivered: DomainEvent[] = [];
  failAt: number | null = null;

  async deliver(event: DomainEvent): Promise<void> {
    if (this.failAt !== null && this.delivered.length === this.failAt)
      throw new Error('broker unavailable');
    this.delivered.push(event);
  }
}

beforeAll(async () => {
  h = await createHarness();
});

beforeEach(async () => {
  // Start every test with an empty backlog.
  await h.flushEvents();
});

afterAll(() => h.close());

describe('transactional outbox', () => {
  it('drops events when the transaction rolls back', async () => {
    await expect(
      h.uow.transaction(async (repos) => {
        await repos.events.publish({
          type: EVENTS.MESSAGE_DELETED,
          workspaceId: WS,
          data: { doomed: true },
        });
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');

    expect(await h.uow.repos.outbox.pending(10)).toHaveLength(0);
  });

  it('relays committed events in order, with stable ids, exactly once per drain', async () => {
    const sink = new FlakySink();
    const relay = new OutboxRelay(h.uow, sink, { logger, batchSize: 2 });
    await publishInTx(5, 'ordered');

    expect(await relay.drain()).toBe(5);
    expect(sink.delivered.map((e) => (e.data as { i: number }).i)).toEqual([0, 1, 2, 3, 4]);
    expect(sink.delivered.every((e) => e.source === 'message-service' && e.id)).toBe(true);

    expect(await relay.drain()).toBe(0);
    expect(sink.delivered).toHaveLength(5);
  });

  it('keeps progress on a broker failure and redelivers the same event later', async () => {
    const sink = new FlakySink();
    sink.failAt = 1;
    const relay = new OutboxRelay(h.uow, sink, { logger });
    await publishInTx(3, 'flaky');

    await expect(relay.drain()).rejects.toThrow('broker unavailable');
    expect(sink.delivered).toHaveLength(1);
    const [stuck] = await h.uow.repos.outbox.pending(10);
    expect(stuck).toMatchObject({ attempts: 1, lastError: 'broker unavailable' });

    sink.failAt = null;
    expect(await relay.drain()).toBe(2);
    expect(sink.delivered.map((e) => (e.data as { i: number }).i)).toEqual([0, 1, 2]);
    expect(sink.delivered[1]!.id).toBe(stuck!.eventId);
  });

  it('wakes up when a transaction commits events', async () => {
    const sink = new FlakySink();
    const relay = new OutboxRelay(h.uow, sink, { logger, pollIntervalMs: 60_000 });
    relay.start();
    try {
      await publishInTx(1, 'nudge');
      await expect.poll(() => sink.delivered.length, { timeout: 2_000 }).toBe(1);
    } finally {
      await relay.stop();
    }
  });

  it('purges published rows past retention', async () => {
    await publishInTx(2, 'old');
    await h.flushEvents();
    expect(
      await h.uow.repos.outbox.purgePublished(new Date(Date.now() + 1_000)),
    ).toBeGreaterThanOrEqual(2);
  });
});
