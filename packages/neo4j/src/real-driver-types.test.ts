// Compile-time check: the real `neo4j-driver` `Driver` must be assignable to
// `Neo4jDriverLike`, and the `WRITE` routing constant must be the string this
// adapter passes. `tsc --noEmit` fails when a driver upgrade stops fitting.
import neo4j from 'neo4j-driver';
import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import type { Neo4jDriverLike } from './neo4j-error-adapter.js';

describe('real neo4j-driver types fit Neo4jDriverLike', () => {
  it('compiles', () => {
    const driver = (d: Driver): Neo4jDriverLike => d;
    expect([driver]).toHaveLength(1);
  });

  it('uses the same value for write routing as the driver', () => {
    expect(neo4j.routing.WRITE).toBe('WRITE');
  });
});
