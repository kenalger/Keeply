/**
 * Keeply — turning a `{ text, params }` statement into a drizzle `SQL`.
 *
 * This is the only piece of the device path that the test suite would otherwise
 * never see: `index.ts` cannot be imported in plain Node (it reaches op-sqlite
 * through `@/db`), but this file imports nothing but `drizzle-orm`, which is
 * ordinary JavaScript. `tests/subscriptions-queries.test.ts` therefore runs
 * every statement the feature builds through here and asserts the SQL and the
 * parameter list come out unchanged.
 *
 * Why it exists at all: `sql.raw()` cannot carry parameters and `sql` is a
 * template tag, so a statement assembled as a string has to be re-split on its
 * `?` placeholders and the values re-inserted as real bound parameters. Nothing
 * a user typed is ever concatenated into SQL.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { SqlStatement } from './store';

/**
 * @throws {Error} if the placeholder count and the parameter count disagree —
 *         a stray `?` inside a generated string literal would shift every
 *         parameter by one, which writes the wrong value to the wrong column
 *         and looks like nothing at all until a user notices a wrong amount.
 */
export function bindStatement(statement: SqlStatement): SQL {
  const segments = statement.text.split('?');
  if (segments.length - 1 !== statement.params.length) {
    throw new Error(
      `Statement has ${segments.length - 1} placeholders but ` +
        `${statement.params.length} parameters`,
    );
  }
  const chunks: SQL[] = [];
  segments.forEach((segment, index) => {
    chunks.push(sql.raw(segment));
    if (index < statement.params.length) {
      chunks.push(sql`${sql.param(statement.params[index])}`);
    }
  });
  return sql.join(chunks);
}
