/**
 * Keeply — module resolution for the Node test runner.
 *
 * The test suite runs on `node --test` with Node 24's built-in TypeScript type
 * stripping: no bundler, no transform step, no `jest-expo` chain to break every
 * time Expo or React Native ships a new major. The one thing Node's ESM loader
 * does not do on its own is the two resolution conveniences the app's source
 * relies on:
 *
 *   1. extensionless relative imports  — `import { isProduction } from './env'`
 *   2. the `@/` path alias             — `import { formatMoney } from '@/theme/format'`
 *
 * Both are declared in `tsconfig.json` and honoured by Metro; neither is part
 * of Node's resolution algorithm. `module.registerHooks()` (synchronous,
 * in-thread, built into Node) closes the gap in ~30 lines and costs the project
 * nothing at runtime — this file is loaded by the test command only.
 *
 * Registered with `node --import ./tests/hooks/resolve-ts.mjs`.
 */
import { registerHooks } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = path.join(ROOT, 'src');
const ASSETS = path.join(ROOT, 'assets');

/** Mirrors Metro's resolver order closely enough for source that has to run. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** `./env` -> `./env.ts`; `./schema` -> `./schema/index.ts`. */
function resolveOnDisk(basePath) {
  if (isFile(basePath)) return basePath;
  for (const extension of EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (isFile(candidate)) return candidate;
  }
  if (existsSync(basePath)) {
    for (const extension of EXTENSIONS) {
      const candidate = path.join(basePath, `index${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** `@/theme/format` -> `<root>/src/theme/format`, per tsconfig `paths`. */
function expandAlias(specifier) {
  if (specifier === '@' || specifier.startsWith('@/assets/')) {
    return path.join(ASSETS, specifier.slice('@/assets/'.length));
  }
  if (specifier.startsWith('@/')) return path.join(SRC, specifier.slice(2));
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let basePath = expandAlias(specifier);

    if (basePath === null && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      if (!context.parentURL || !context.parentURL.startsWith('file:')) {
        return nextResolve(specifier, context);
      }
      basePath = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    }

    if (basePath === null) return nextResolve(specifier, context);

    const resolved = resolveOnDisk(basePath);
    if (resolved === null) return nextResolve(specifier, context);

    return { url: pathToFileURL(resolved).href, shortCircuit: true };
  },
});
