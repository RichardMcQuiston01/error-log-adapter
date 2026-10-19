import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  Neo4jErrorAdapter,
  buildNeo4jBatchStatement,
  buildNeo4jInsertStatement,
  buildNeo4jSchemaStatements,
} from './neo4j-error-adapter.js';
import type {
  Neo4jDriverLike,
  Neo4jExecuteQueryConfigLike,
  Neo4jParameters,
} from './neo4j-error-adapter.js';

interface Call {
  query: string;
  parameters: Neo4jParameters | undefined;
  config: Neo4jExecuteQueryConfigLike | undefined;
}

interface Fake {
  driver: Neo4jDriverLike;
  calls: Call[];
  writes: () => Call[];
}

function fakeDriver(
  respond: (call: Call) => Promise<unknown> = async () => ({})
): Fake {
  const calls: Call[] = [];
  const driver: Neo4jDriverLike = {
    executeQuery(query, parameters, config): Promise<unknown> {
      const call: Call = { query, parameters, config };
      calls.push(call);
      return respond(call);
    },
  };
  return {
    driver,
    calls,
    writes: () =>
      calls.filter((c) => !/^CREATE (CONSTRAINT|INDEX)/.test(c.query)),
  };
}

const entry: ErrorLogEntry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  cause: new Error('ECONNREFUSED'),
  timestamp: '2026-10-19T05:00:00.123Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('statements', () => {
  it('builds the schema, insert and batch statements', () => {
    expect(buildNeo4jSchemaStatements()).toEqual([
      'CREATE CONSTRAINT `errorlog_id` IF NOT EXISTS FOR (e:`ErrorLog`) REQUIRE e.id IS UNIQUE',
      'CREATE INDEX `errorlog_occurred_at` IF NOT EXISTS FOR (e:`ErrorLog`) ON (e.occurred_at)',
    ]);
    expect(buildNeo4jInsertStatement()).toBe(
      'MERGE (e:`ErrorLog` {id: $id}) ON CREATE SET e.code = $code, e.message = $message, e.cause = $cause, e.source = $source, e.occurred_at = datetime($occurred_at), e.created_at = datetime()'
    );
    expect(buildNeo4jBatchStatement('App_Error')).toBe(
      'UNWIND $entries AS entry MERGE (e:`App_Error` {id: entry.id}) ON CREATE SET e.code = entry.code, e.message = entry.message, e.cause = entry.cause, e.source = entry.source, e.occurred_at = datetime(entry.occurred_at), e.created_at = datetime()'
    );
  });

  it('rejects a label that could alter a statement', () => {
    for (const label of ['a b', 'x`) DETACH DELETE (n', 'a-b', '']) {
      expect(() => buildNeo4jInsertStatement(label)).toThrow(RangeError);
      expect(() => buildNeo4jBatchStatement(label)).toThrow(RangeError);
      expect(() => buildNeo4jSchemaStatements(label)).toThrow(RangeError);
    }
  });
});

describe('Neo4jErrorAdapter', () => {
  it('creates the schema once, then merges the node', async () => {
    const { driver, calls, writes } = fakeDriver();
    const adapter = new Neo4jErrorAdapter(driver);
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(calls.filter((c) => c.query.startsWith('CREATE'))).toHaveLength(2);
    expect(writes()).toHaveLength(2);
    expect(writes()[0]?.query).toBe(buildNeo4jInsertStatement());
    expect(writes()[0]?.config).toEqual({ routing: 'WRITE' });
  });

  it('passes the entry as plain parameters', async () => {
    const { driver, writes } = fakeDriver();
    await new Neo4jErrorAdapter(driver, { createSchema: false }).log(entry);
    const parameters = writes()[0]?.parameters as Neo4jParameters;
    expect(parameters).toMatchObject({
      id: entry.id,
      code: 'DB_DOWN',
      message: 'cannot reach the database',
      source: 'checkout',
      occurred_at: '2026-10-19T05:00:00.123Z',
    });
    expect(JSON.parse(parameters['cause'] as string)).toMatchObject({
      message: 'ECONNREFUSED',
    });
  });

  it('sends null for a missing cause and source, and generates an id', async () => {
    const { driver, writes } = fakeDriver();
    await new Neo4jErrorAdapter(driver, { createSchema: false }).log({
      code: 'X',
      message: 'y',
    });
    const parameters = writes()[0]?.parameters as Neo4jParameters;
    expect(parameters['cause']).toBeNull();
    expect(parameters['source']).toBeNull();
    expect(parameters['id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honors label, database and createSchema', async () => {
    const { driver, calls } = fakeDriver();
    await new Neo4jErrorAdapter(driver, {
      label: 'App_Error',
      database: 'logs',
      createSchema: false,
    }).log(entry);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain('(e:`App_Error` {id: $id})');
    expect(calls[0]?.config).toEqual({ routing: 'WRITE', database: 'logs' });
  });

  it('retries the schema creation after it fails', async () => {
    let attempts = 0;
    const { driver, writes } = fakeDriver(async (call) => {
      if (call.query.startsWith('CREATE CONSTRAINT')) {
        attempts += 1;
        if (attempts === 1) {
          throw new Error(
            'Neo.ClientError.Security.Forbidden: not allowed to create a constraint'
          );
        }
      }
      return {};
    });
    const adapter = new Neo4jErrorAdapter(driver);
    const first = await adapter.log(entry);
    expect(first.ok).toBe(false);
    expect(first.error).toBe(
      'Neo4jErrorAdapter failed to write an :ErrorLog node: Neo.ClientError.Security.Forbidden: not allowed to create a constraint'
    );
    expect(writes()).toHaveLength(0);
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it('reports a failed write', async () => {
    const { driver } = fakeDriver(async () => {
      throw new Error(
        'Could not perform discovery. No routing servers available.'
      );
    });
    const result = await new Neo4jErrorAdapter(driver, {
      createSchema: false,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No routing servers available');
  });

  it('times out a request that never completes', async () => {
    const { driver } = fakeDriver(() => new Promise<unknown>(() => undefined));
    const result = await new Neo4jErrorAdapter(driver, {
      createSchema: false,
      timeoutMs: 20,
    }).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Neo4j did not respond within 20 ms');
  });

  it('rejects an invalid id or timestamp without any request', async () => {
    const { driver, calls } = fakeDriver();
    const adapter = new Neo4jErrorAdapter(driver);
    expect((await adapter.log({ ...entry, id: 'nope' })).error).toContain(
      'entry.id must be a UUID'
    );
    expect(
      (await adapter.log({ ...entry, timestamp: 'yesterday' })).error
    ).toContain('is not a valid ISO 8601 date');
    expect(calls).toHaveLength(0);
  });

  it('rejects options that can never work', () => {
    const { driver } = fakeDriver();
    expect(() => new Neo4jErrorAdapter(driver, { label: 'a b' })).toThrow(
      RangeError
    );
    expect(() => new Neo4jErrorAdapter(driver, { timeoutMs: 0 })).toThrow(
      RangeError
    );
  });

  describe('logBatch', () => {
    it('writes every entry in one query', async () => {
      const { driver, writes } = fakeDriver();
      const result = await new Neo4jErrorAdapter(driver, {
        createSchema: false,
      }).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2' },
      ]);
      expect(result).toEqual({ ok: true });
      expect(writes()).toHaveLength(1);
      expect(writes()[0]?.query).toBe(buildNeo4jBatchStatement());
      const rows = (writes()[0]?.parameters as { entries: Neo4jParameters[] })
        .entries;
      expect(rows.map((row) => row['code'])).toEqual(['A', 'B']);
    });

    it('does nothing for an empty batch', async () => {
      const { driver, calls } = fakeDriver();
      expect(await new Neo4jErrorAdapter(driver).logBatch([])).toEqual({
        ok: true,
      });
      expect(calls).toHaveLength(0);
    });

    it('writes nothing when one entry is invalid', async () => {
      const { driver, calls } = fakeDriver();
      const result = await new Neo4jErrorAdapter(driver).logBatch([
        { code: 'A', message: '1' },
        { code: 'B', message: '2', id: 'nope' },
      ]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was written'
      );
      expect(calls).toHaveLength(0);
    });

    it('reports a failed batch as one failure', async () => {
      const { driver } = fakeDriver(async () => {
        throw new Error('Neo.TransientError.Transaction.DeadlockDetected');
      });
      const result = await new Neo4jErrorAdapter(driver, {
        createSchema: false,
      }).logBatch([{ code: 'A', message: '1' }]);
      expect(result).toEqual({
        ok: false,
        error:
          'Neo4jErrorAdapter failed to write 1 :ErrorLog node: Neo.TransientError.Transaction.DeadlockDetected',
      });
    });

    it('is used by BatchingErrorAdapter', async () => {
      const { driver, writes } = fakeDriver();
      const batching = new BatchingErrorAdapter(
        new Neo4jErrorAdapter(driver, { createSchema: false }),
        { batchSize: 2, maxWaitMs: Infinity }
      );
      await batching.log({ code: 'A', message: '1' });
      await batching.log({ code: 'B', message: '2' });
      await batching.flush();
      expect(writes()).toHaveLength(1);
    });
  });
});
