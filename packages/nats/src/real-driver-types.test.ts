// Compile-time check: the real `nats` types must be assignable to the
// adapters' `...Like` interfaces. `tsc --noEmit` fails when a `nats` upgrade
// stops fitting.
import type { JetStreamClient, MsgHdrs, NatsConnection } from 'nats';
import { describe, expect, it } from 'vitest';
import type {
  JetStreamClientLike,
  NatsConnectionLike,
  NatsHeadersLike,
} from './nats-error-adapter.js';

describe('real nats types fit the ...Like interfaces', () => {
  it('compiles', () => {
    const connection = (c: NatsConnection): NatsConnectionLike => c;
    const jetstream = (j: JetStreamClient): JetStreamClientLike => j;
    const headers = (h: MsgHdrs): NatsHeadersLike => h;
    expect([connection, jetstream, headers]).toHaveLength(3);
  });
});
