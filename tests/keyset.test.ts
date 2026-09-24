/**
 * Keeply — the keyset cursor: what it encodes, what it refuses, and whether the
 * predicate it builds means "the rows after this one".
 *
 * The last block is the one that matters most. It does not trust the
 * predicate's text; it hands SQLite a table full of the values that break
 * keyset paging — NULLs in both directions, ties, ASCII case that NOCASE folds,
 * accents it does not, a TEXT and a REAL sitting in an INTEGER column — and for
 * EVERY row, uses that row as the cursor and checks the continuation returns
 * exactly the rows the ORDER BY puts after it. A predicate that is right for
 * the rows a developer thought of and wrong for one they did not is how a
 * receipt goes missing at a page boundary.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  KeysetCursorError,
  continuationStatement,
  cursorAfter,
  defineKeyset,
  nextCursor,
  orderByClause,
  readCursor,
  splitPeek,
  type KeyValue,
  type KeysetSpec,
  type KeysetStatement,
} from '@/lib/keyset';

const BY_DATE = defineKeyset({
  tag: 'test:by-date',
  qualifier: '"r".',
  keys: [
    { column: 'purchase_date', direction: 'desc' },
    { column: 'created_at', direction: 'desc' },
    { column: 'id', direction: 'asc' },
  ],
});

const BY_NAME = defineKeyset({
  tag: 'test:by-name',
  qualifier: '',
  keys: [
    { column: 'name', direction: 'asc', collate: 'nocase' },
    { column: 'id', direction: 'asc' },
  ],
});

const BY_EXPIRY = defineKeyset({
  tag: 'test:by-expiry',
  qualifier: '',
  keys: [
    { column: 'expiry_date', direction: 'asc', nullsLast: true },
    { column: 'name', direction: 'asc', collate: 'nocase' },
    { column: 'id', direction: 'asc' },
  ],
});

/** A page statement shaped exactly like every builder in `src/features/*\/sql.ts`. */
function pageOf(spec: KeysetSpec, inner = 'SELECT * FROM "t"', params: KeyValue[] = []): KeysetStatement {
  return {
    text: `${inner}${orderByClause(spec)} LIMIT ? OFFSET ?`,
    params: [...params, 40, 0],
  };
}

function placeholders(text: string): number {
  return text.split('?').length - 1;
}

/* -------------------------------------------------------------------------- */

describe('keyset / a spec', () => {
  test('must end in the row id, or paging it loses rows', () => {
    assert.throws(() => defineKeyset({ tag: 'x', qualifier: '', keys: [] }));
    assert.throws(() =>
      defineKeyset({ tag: 'x', qualifier: '', keys: [{ column: 'name', direction: 'asc' }] }),
    );
    assert.throws(() =>
      defineKeyset({
        tag: 'x',
        qualifier: '',
        keys: [{ column: 'id', direction: 'asc', nullsLast: true }],
      }),
    );
    assert.throws(() => defineKeyset({ tag: '', qualifier: '', keys: [{ column: 'id', direction: 'asc' }] }));
  });

  test('renders its ORDER BY exactly as the builders spell it', () => {
    assert.equal(
      orderByClause(BY_DATE),
      ' ORDER BY "r"."purchase_date" DESC, "r"."created_at" DESC, "r"."id" ASC',
    );
    assert.equal(
      orderByClause(BY_EXPIRY),
      ' ORDER BY "expiry_date" IS NULL ASC, "expiry_date" ASC, "name" COLLATE NOCASE ASC, "id" ASC',
    );
    assert.equal(
      orderByClause(BY_NAME, '"page".'),
      ' ORDER BY "page"."name" COLLATE NOCASE ASC, "page"."id" ASC',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('keyset / the token round-trips every value SQLite can sort by', () => {
  const position = { seen: 40, total: 128 };

  const cases: readonly (readonly [string, KeyValue])[] = [
    ['plain ASCII', 'Jollibee'],
    ['accented, precomposed', 'Émile'],
    ['accented, combining mark', 'E\u0301mile'],
    ['CJK', '日本橋'],
    ['emoji', '😀 Café'],
    ['the empty string', ''],
    ['JSON punctuation', '"}{\\\n\t'],
    ['text that looks like a number stays text', '12'],
    ['text that says null stays text', 'null'],
    ['zero', 0],
    ['a REAL where an integer belongs', 1234.5],
    ['a negative', -7],
    ['the largest safe integer', Number.MAX_SAFE_INTEGER],
    ['+Infinity, which JSON cannot spell', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];

  for (const [label, value] of cases) {
    test(label, () => {
      const token = cursorAfter(BY_NAME, { name: value, id: 'row-1' }, position);
      const cursor = readCursor(BY_NAME, token);
      assert.deepEqual(cursor.keys, [value, 'row-1']);
      assert.equal(typeof cursor.keys?.[0], typeof value, 'a string key must not come back a number');
    });
  }

  test('a NULL in a nulls-last key is a real position, not a failure', () => {
    const token = cursorAfter(BY_EXPIRY, { expiry_date: null, name: 'Birth certificate', id: 'd-9' }, position);
    assert.deepEqual(readCursor(BY_EXPIRY, token).keys, [null, 'Birth certificate', 'd-9']);
  });

  test('carries the position, the first page’s count and its calendar day', () => {
    const token = cursorAfter(BY_NAME, { name: 'a', id: 'b' }, { seen: 7, total: 9, todayISO: '2026-09-24' });
    const cursor = readCursor(BY_NAME, token);
    assert.equal(cursor.seen, 7);
    assert.equal(cursor.total, 9);
    assert.equal(cursor.todayISO, '2026-09-24');
    assert.equal(readCursor(BY_NAME, cursorAfter(BY_NAME, { name: 'a', id: 'b' }, position)).todayISO, null);
  });

  test('nextCursor continues after the LAST row, and has nothing to continue after none', () => {
    const rows = [
      { name: 'first', id: '1' },
      { name: 'last', id: '2' },
    ];
    const token = nextCursor(BY_NAME, rows, position);
    assert.ok(token !== null);
    assert.deepEqual(readCursor(BY_NAME, token).keys, ['last', '2']);
    assert.equal(nextCursor(BY_NAME, [], position), null);
  });

  test('refuses a position that is not two counts', () => {
    assert.throws(() => cursorAfter(BY_NAME, { name: 'a', id: 'b' }, { seen: -1, total: 0 }));
    assert.throws(() => cursorAfter(BY_NAME, { name: 'a', id: 'b' }, { seen: 0, total: 1.5 }));
  });
});

/* -------------------------------------------------------------------------- */

describe('keyset / a row that cannot be a cursor falls back to the offset', () => {
  const position = { seen: 12, total: 30 };

  const unbindable: readonly (readonly [string, unknown])[] = [
    ['a NULL in a column the order assumes is never NULL', null],
    ['a BLOB', new Uint8Array([0, 255])],
    ['an integer JavaScript has already rounded', 2 ** 60],
    ['NaN', Number.NaN],
    ['a bigint', 5n],
    ['a boolean', true],
  ];

  for (const [label, value] of unbindable) {
    test(label, () => {
      const cursor = readCursor(BY_NAME, cursorAfter(BY_NAME, { name: value, id: 'x' }, position));
      assert.equal(cursor.keys, null);
      assert.equal(cursor.seen, 12, 'the fallback still knows where the list stopped');
      assert.equal(cursor.total, 30);
    });
  }

  test('…and the continuation is the page statement itself, skipping what was read', () => {
    const cursor = readCursor(BY_NAME, cursorAfter(BY_NAME, { name: null, id: 'x' }, position));
    const page = pageOf(BY_NAME, 'SELECT * FROM "t" WHERE "k" = ?', ['v']);
    const statement = continuationStatement(page, BY_NAME, cursor, 40);
    assert.equal(statement.text, page.text);
    assert.deepEqual(statement.params, ['v', 41, 12]);
  });

  test('a column the page does not project is a bug, and says which column', () => {
    assert.throws(
      () => cursorAfter(BY_NAME, { id: 'x' }, position),
      (error: Error) => error.message.includes('"name"'),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('keyset / a token that is not this list’s is refused, loudly and quietly', () => {
  const token = cursorAfter(BY_NAME, { name: 'MUÑOZ Pharmacy', id: 'r-1' }, { seen: 1, total: 2 });

  function refuses(read: () => unknown): void {
    assert.throws(read, (error: unknown) => {
      assert.ok(error instanceof KeysetCursorError);
      // The token holds a merchant name. The error must not.
      assert.doesNotMatch(error.message, /MUÑOZ|Pharmacy|r-1/);
      return true;
    });
  }

  test('a cursor from another sort order', () => refuses(() => readCursor(BY_DATE, token)));
  test('not JSON at all', () => refuses(() => readCursor(BY_NAME, 'MUÑOZ Pharmacy')));
  test('JSON that is not a cursor', () => refuses(() => readCursor(BY_NAME, '["MUÑOZ Pharmacy"]')));

  test('the wrong number of keys', () => {
    const parsed = JSON.parse(token) as { k: unknown[] };
    refuses(() => readCursor(BY_NAME, JSON.stringify({ ...parsed, k: [...parsed.k, 'r-1'] })));
  });

  test('a value its order cannot hold', () => {
    const parsed = JSON.parse(token) as Record<string, unknown>;
    refuses(() => readCursor(BY_NAME, JSON.stringify({ ...parsed, k: [{ blob: 'MUÑOZ' }, 'r-1'] })));
    refuses(() => readCursor(BY_NAME, JSON.stringify({ ...parsed, k: [null, 'r-1'] })));
  });

  test('a lost position', () => {
    const parsed = JSON.parse(token) as Record<string, unknown>;
    refuses(() => readCursor(BY_NAME, JSON.stringify({ ...parsed, s: -1 })));
    refuses(() => readCursor(BY_NAME, JSON.stringify({ ...parsed, n: 'MUÑOZ' })));
  });
});

/* -------------------------------------------------------------------------- */

describe('keyset / the continuation statement', () => {
  test('refuses a page whose ORDER BY has drifted from the spec', () => {
    const cursor = readCursor(BY_NAME, cursorAfter(BY_NAME, { name: 'a', id: 'b' }, { seen: 1, total: 2 }));
    const drifted: KeysetStatement = {
      text: 'SELECT * FROM "t" ORDER BY "name" COLLATE NOCASE ASC, "created_at" DESC, "id" ASC LIMIT ? OFFSET ?',
      params: [40, 0],
    };
    assert.throws(() => continuationStatement(drifted, BY_NAME, cursor, 40), /no longer matches/);
    assert.throws(
      () => continuationStatement({ text: pageOf(BY_NAME).text, params: [40] }, BY_NAME, cursor, 40),
      /no longer matches/,
    );
  });

  test('wraps the page verbatim and seeks on the leading key', () => {
    const cursor = readCursor(
      BY_NAME,
      cursorAfter(BY_NAME, { name: 'Émile', id: 'r-9' }, { seen: 40, total: 90 }),
    );
    const page = pageOf(BY_NAME, 'SELECT "id", "name" FROM "t" WHERE "kind" = ?', ['food']);
    const statement = continuationStatement(page, BY_NAME, cursor, 40);

    assert.equal(
      statement.text,
      'SELECT * FROM (SELECT "id", "name" FROM "t" WHERE "kind" = ?) AS "page"' +
        ' WHERE "page"."name" COLLATE NOCASE >= ?' +
        ' AND ("page"."name" COLLATE NOCASE > ? OR ("page"."name" COLLATE NOCASE = ? AND "page"."id" > ?))' +
        ' ORDER BY "page"."name" COLLATE NOCASE ASC, "page"."id" ASC LIMIT ?',
    );
    // The page's own parameters first, then the cursor, then one row more than
    // the page — the peek that replaces the count.
    assert.deepEqual(statement.params, ['food', 'Émile', 'Émile', 'Émile', 'r-9', 41]);
    assert.equal(placeholders(statement.text), statement.params.length);
  });

  test('compares a NULL bucket first, and a nullable value with IS', () => {
    const inBucket = readCursor(
      BY_EXPIRY,
      cursorAfter(BY_EXPIRY, { expiry_date: null, name: 'Birth certificate', id: 'd-1' }, { seen: 3, total: 9 }),
    );
    const dated = readCursor(
      BY_EXPIRY,
      cursorAfter(BY_EXPIRY, { expiry_date: '2027-01-01', name: 'Passport', id: 'd-2' }, { seen: 1, total: 9 }),
    );
    const bucketStatement = continuationStatement(pageOf(BY_EXPIRY), BY_EXPIRY, inBucket, 10);
    const datedStatement = continuationStatement(pageOf(BY_EXPIRY), BY_EXPIRY, dated, 10);

    assert.match(bucketStatement.text, /\("page"\."expiry_date" IS NULL\) >= \?/);
    assert.match(bucketStatement.text, /"page"\."expiry_date" IS \? AND/);
    assert.equal(bucketStatement.params[0], 1, 'a cursor among the undated seeks the undated');
    assert.equal(datedStatement.params[0], 0);
    assert.equal(placeholders(bucketStatement.text), bucketStatement.params.length);
  });

  test('splitPeek keeps the page and reports whether a row followed it', () => {
    assert.deepEqual(splitPeek([1, 2, 3], 2), { page: [1, 2], hasMore: true });
    assert.deepEqual(splitPeek([1, 2], 2), { page: [1, 2], hasMore: false });
    assert.deepEqual(splitPeek([], 2), { page: [], hasMore: false });
  });
});

/* -------------------------------------------------------------------------- */
/* Every row as the cursor                                                     */
/* -------------------------------------------------------------------------- */

interface Row {
  id: string;
  [column: string]: unknown;
}

/**
 * The adversarial table. `name` mixes what NOCASE folds (ASCII case) with what
 * it does not (accents, CJK, emoji, combining marks); `score` is an INTEGER
 * column holding NULLs, ties, a REAL and a TEXT — which is what a damaged
 * `amount_minor` looks like, and SQLite sorts all of them.
 */
function adversarialTable(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE "t" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "day" TEXT, "score" INTEGER, "made" INTEGER NOT NULL)',
  );
  const names = [
    'apple', 'Apple', 'APPLE', 'Émile', 'émile', 'E\u0301mile', 'Zoë', 'zoe', '日本橋',
    '😀 Café', 'Ñandú', 'ñandú', ' leading space', 'MUÑOZ', 'muñoz', '',
  ];
  const days = [null, '2026-01-31', '2026-01-31', '2026-02-28', null, '2025-12-01'];
  const scores: KeyValue[] = [null, 100, 100, 250, 1234.5, 'abc', 0, -5, null, 100];
  const insert = db.prepare('INSERT INTO "t" VALUES (?, ?, ?, ?, ?)');
  for (let index = 0; index < 64; index += 1) {
    insert.run(
      // Not in insertion order, so `id ASC` is doing real work.
      `row-${String((index * 37) % 64).padStart(2, '0')}`,
      names[index % names.length],
      days[index % days.length],
      scores[index % scores.length],
      1_700_000_000_000 + (index % 5) * 1000,
    );
  }
  return db;
}

const ADVERSARIAL_ORDERS: readonly KeysetSpec[] = [
  defineKeyset({
    tag: 'adv:name',
    qualifier: '',
    keys: [
      { column: 'name', direction: 'asc', collate: 'nocase' },
      { column: 'id', direction: 'asc' },
    ],
  }),
  defineKeyset({
    tag: 'adv:day-nulls-last',
    qualifier: '',
    keys: [
      { column: 'day', direction: 'asc', nullsLast: true },
      { column: 'name', direction: 'asc', collate: 'nocase' },
      { column: 'id', direction: 'asc' },
    ],
  }),
  defineKeyset({
    // The bills "amount" shape: biggest first, the unknown ones last.
    tag: 'adv:score-desc-nulls-last',
    qualifier: '',
    keys: [
      { column: 'score', direction: 'desc', nullsLast: true },
      { column: 'name', direction: 'asc', collate: 'nocase' },
      { column: 'id', direction: 'asc' },
    ],
  }),
  defineKeyset({
    tag: 'adv:made-desc-id-desc',
    qualifier: '',
    keys: [
      { column: 'made', direction: 'desc' },
      { column: 'id', direction: 'desc' },
    ],
  }),
];

describe('keyset / every row as the cursor returns exactly the rows after it', () => {
  const db = adversarialTable();

  for (const spec of ADVERSARIAL_ORDERS) {
    test(spec.tag, () => {
      const page = pageOf(spec);
      const everything = db
        .prepare(page.text)
        .all(...([1000, 0] as never[])) as unknown as Row[];
      const order = everything.map((row) => row.id);
      assert.equal(new Set(order).size, 64);

      everything.forEach((row, index) => {
        const cursor = readCursor(spec, cursorAfter(spec, row, { seen: index + 1, total: 64 }));
        assert.ok(cursor.keys !== null, `row ${row.id} should be a keyset cursor`);
        const statement = continuationStatement(page, spec, cursor, 1000);
        const after = (
          db.prepare(statement.text).all(...(statement.params as never[])) as unknown as Row[]
        ).map((next) => next.id);
        assert.deepEqual(after, order.slice(index + 1), `after ${row.id} in ${spec.tag}`);
      });
    });
  }
});
