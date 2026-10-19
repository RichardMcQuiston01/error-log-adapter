// Compile-time check: the real amqplib channel types must be assignable to
// `AmqpChannelLike`. `tsc --noEmit` fails when an amqplib upgrade stops fitting.
import type { Channel, ConfirmChannel } from 'amqplib';
import { describe, expect, it } from 'vitest';
import type { AmqpChannelLike } from './rabbitmq-error-adapter.js';

describe('real amqplib types fit AmqpChannelLike', () => {
  it('compiles', () => {
    const plain = (c: Channel): AmqpChannelLike => c;
    const confirm = (c: ConfirmChannel): AmqpChannelLike => c;
    expect([plain, confirm]).toHaveLength(2);
  });
});
