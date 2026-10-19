/**
 * Live test for Neo4jErrorAdapter against a real Neo4j server. It is skipped
 * unless NEO4J_TEST_URL is set, so `bun run test` and CI never touch a server.
 *
 * Start a server and run it:
 *
 *   docker run -d -p 7687:7687 -e NEO4J_AUTH=neo4j/livetest123 neo4j:5
 *   NEO4J_TEST_URL=neo4j://localhost:7687 NEO4J_TEST_USER=neo4j \
 *     NEO4J_TEST_PASSWORD=livetest123 bun run test:live
 *
 * Optional: NEO4J_TEST_DATABASE. The test writes nodes with a label that starts
 * with `LiveTest` and removes them, and the constraint and index it created,
 * when it finishes.
 */
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import { Neo4jErrorAdapter } from './neo4j-error-adapter.js';

const url: string | undefined = process.env['NEO4J_TEST_URL'];
const isConfigured: boolean = url !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
const label = `LiveTest${runId}`;

describe.skipIf(!isConfigured)(
  'Neo4jErrorAdapter against a real server',
  () => {
    const database: string | undefined = process.env['NEO4J_TEST_DATABASE'];
    const driver: Driver = neo4j.driver(
      url ?? '',
      neo4j.auth.basic(
        process.env['NEO4J_TEST_USER'] ?? 'neo4j',
        process.env['NEO4J_TEST_PASSWORD'] ?? ''
      )
    );

    async function read(
      query: string,
      parameters: Record<string, unknown> = {}
    ): Promise<Record<string, unknown>[]> {
      const result = await driver.executeQuery(query, parameters, {
        routing: neo4j.routing.READ,
        ...(database !== undefined && { database }),
      });
      return result.records.map((record) => record.toObject());
    }

    afterAll(async () => {
      const config = database !== undefined ? { database } : {};
      await driver.executeQuery(
        `MATCH (e:\`${label}\`) DETACH DELETE e`,
        {},
        config
      );
      const lower: string = label.toLowerCase();
      await driver.executeQuery(
        `DROP CONSTRAINT \`${lower}_id\` IF EXISTS`,
        {},
        config
      );
      await driver.executeQuery(
        `DROP INDEX \`${lower}_occurred_at\` IF EXISTS`,
        {},
        config
      );
      await driver.close();
    });

    const adapter: Neo4jErrorAdapter = new Neo4jErrorAdapter(driver, {
      label,
      ...(database !== undefined && { database }),
    });

    it('writes an entry as a node with the expected properties', async () => {
      const result = await adapter.log({
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        cause: new Error('the cause'),
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(result).toEqual({ ok: true });

      const rows = await read(
        `MATCH (e:\`${label}\` {code: $code})
       RETURN e.id AS id, e.message AS message, e.source AS source,
              e.cause AS cause, toString(e.occurred_at) AS occurred_at,
              e.created_at IS NOT NULL AS has_created_at`,
        { code: 'LIVE_ONE' }
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        message: 'first live entry',
        source: 'live-test',
        has_created_at: true,
      });
      expect(rows[0]?.['occurred_at']).toContain('2026-01-02T03:04:05.678');
      expect(String(rows[0]?.['cause'])).toContain('the cause');
      expect(String(rows[0]?.['id'])).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('creates the uniqueness constraint and the index', async () => {
      const lower: string = label.toLowerCase();
      const constraints = await read('SHOW CONSTRAINTS YIELD name RETURN name');
      const indexes = await read('SHOW INDEXES YIELD name RETURN name');
      expect(constraints.map((row) => row['name'])).toContain(`${lower}_id`);
      expect(indexes.map((row) => row['name'])).toContain(
        `${lower}_occurred_at`
      );
    });

    it('does not duplicate an entry that is logged again with the same id', async () => {
      const entry: ErrorLogEntry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'logged twice',
      };
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await adapter.log(entry)).toEqual({ ok: true });
      const rows = await read(
        `MATCH (e:\`${label}\` {code: 'LIVE_REPEAT'}) RETURN count(e) AS total`
      );
      expect(Number(String(rows[0]?.['total']))).toBe(1);
    });

    it('writes a batch in one call', async () => {
      const entries: ErrorLogEntry[] = [1, 2, 3].map((n) => ({
        code: 'LIVE_BATCH',
        message: `batch entry ${n}`,
      }));
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      const rows = await read(
        `MATCH (e:\`${label}\` {code: 'LIVE_BATCH'}) RETURN count(e) AS total`
      );
      expect(Number(String(rows[0]?.['total']))).toBe(3);
    });

    it('reports a failure instead of throwing when the server rejects the login', async () => {
      const badDriver: Driver = neo4j.driver(
        url ?? '',
        neo4j.auth.basic('neo4j', 'definitely-not-the-password')
      );
      const failing = new Neo4jErrorAdapter(badDriver, {
        label: `${label}Bad`,
        createSchema: false,
        timeoutMs: 15000,
      });
      const result = await failing.log({ code: 'LIVE_FAIL', message: 'no' });
      await badDriver.close();
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);
