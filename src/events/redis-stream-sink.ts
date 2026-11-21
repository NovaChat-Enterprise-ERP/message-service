import { Redis } from 'ioredis';
import type { DomainEvent } from '@novachat-enterprise-erp/contracts';
import { DEFAULT_STREAM } from '@novachat-enterprise-erp/events';
import type { EventSink } from './outbox-relay.js';

export interface RedisStreamSinkOptions {
  redisUrl: string;
  stream?: string;
  maxLen?: number;
}

/**
 * Writes already-built events to the shared Redis stream, keeping their original id.
 * The entry format ('type', 'event') must match RedisStreamEventPublisher in
 * @novachat-enterprise-erp/events, which every subscriber reads.
 */
export class RedisStreamSink implements EventSink {
  private readonly redis: Redis;
  private readonly stream: string;
  private readonly maxLen: number;

  constructor(options: RedisStreamSinkOptions) {
    this.redis = new Redis(options.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      keepAlive: 15_000,
    });
    this.redis.on('error', () => undefined);
    this.stream = options.stream ?? DEFAULT_STREAM;
    this.maxLen = options.maxLen ?? 50_000;
  }

  async deliver(event: DomainEvent): Promise<void> {
    await this.redis.xadd(
      this.stream,
      'MAXLEN',
      '~',
      this.maxLen,
      '*',
      'type',
      event.type,
      'event',
      JSON.stringify(event),
    );
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
