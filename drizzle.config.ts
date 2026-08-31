import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit 0.31.10 config (shape verified against
 * node_modules/drizzle-kit/api.d.mts:355-470).
 *
 * `driver: 'expo'` is the setting that makes `generate` emit a
 * React-Native-consumable bundle: alongside `drizzle/<tag>.sql` and
 * `drizzle/meta/`, it writes `drizzle/migrations.js`, which inline-imports each
 * `.sql` file and re-exports `{ journal, migrations }`
 * (node_modules/drizzle-kit/bin.cjs:32959-32971). The `.sql` imports are turned
 * into string literals at build time by `babel-plugin-inline-import`, wired in
 * `babel.config.js`.
 *
 * This combination takes no `dbCredentials`: there is no database for the CLI
 * to reach. The database only ever exists on-device, encrypted.
 */
export default {
  dialect: 'sqlite',
  driver: 'expo',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  // Must match the `casing` passed to `drizzle()` in src/db/client.ts, so a
  // column declared without an explicit name resolves identically in the
  // generated DDL and in queries at runtime.
  casing: 'snake_case',
  strict: true,
} satisfies Config;
