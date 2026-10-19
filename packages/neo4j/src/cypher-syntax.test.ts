// Parses every statement the adapter sends with Neo4j's own Cypher parser
// (`@neo4j-cypher/language-support`, the one behind Neo4j's editor tooling), so
// a typo in a statement is caught without a server. It checks syntax, not
// behavior: whether the constraint exists, say, is for a real database to say.
import { describe, expect, it } from 'vitest';
import { validateSyntax } from '@neo4j-cypher/language-support';
import {
  buildNeo4jBatchStatement,
  buildNeo4jInsertStatement,
  buildNeo4jSchemaStatements,
} from './neo4j-error-adapter.js';

describe('Cypher syntax', () => {
  it('the parser reports a statement with a typo', () => {
    expect(
      validateSyntax(
        'MERGE (e:ErrorLog {id: $id}) ON CREAT SET e.code = $code',
        {}
      ).length
    ).toBeGreaterThan(0);
  });

  it.each(['ErrorLog', 'App_Error', 'X'])(
    'every statement for label %s parses',
    (label) => {
      const statements: string[] = [
        ...buildNeo4jSchemaStatements(label),
        buildNeo4jInsertStatement(label),
        buildNeo4jBatchStatement(label),
      ];
      for (const statement of statements) {
        expect(validateSyntax(statement, {}), statement).toEqual([]);
      }
    }
  );
});
