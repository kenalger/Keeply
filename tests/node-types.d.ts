/**
 * Keeply — Node's type declarations, for the test suite only.
 *
 * The suite runs on `node --test`, so it imports `node:test`, `node:assert`,
 * `node:sqlite`, `node:fs`. TypeScript 6 no longer pulls every `@types/*`
 * package into a program implicitly, and `tsconfig.json` sets no `types`
 * array, so `@types/node` has to be requested. It is requested here rather
 * than in `tsconfig.json` so the request lives next to the only code that
 * needs it.
 *
 * This does make Node's globals visible to `src/**` as well — a whole-program
 * setting is the only kind TypeScript has. Nothing in `src/**` may actually
 * use them: the app runs on Hermes, where `process`, `Buffer` and
 * `__dirname` do not exist. `src/lib/env.ts` is the only sanctioned way to
 * read the environment.
 */
/// <reference types="node" />
