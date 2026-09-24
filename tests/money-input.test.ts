/**
 * Keeply — the amount field's edit model, exercised directly.
 *
 * `applyAmountEdit` decides what one `TextInput` change MEANS: a keystroke the
 * field regroups, a backspace that landed on a separator the field inserted,
 * a selection deleted in one go, or a paste that has to be judged as written.
 * T15 found the third case judged as the fourth — `'1,234,567' → '1,2367'`
 * read as `ambiguous-separators` and cleared the committed amount, while
 * `'1,234,567' → '1,567'` happened to survive — so it failed intermittently.
 * These pin every branch.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { applyAmountEdit, parseAmountInput } from '@/components/ui/money-input';

describe('applyAmountEdit() — typing', () => {
  test('a keystroke is regrouped, never judged as a paste', () => {
    const parse = applyAmountEdit('1,499', '1,4990');
    assert.equal(parse.minor, 1_499_000);
    assert.equal(parse.display, '14,990');
    assert.equal(parse.problem, null);
  });

  test('backspace on a separator removes the digit in front of it', () => {
    // Otherwise the group re-forms and the key appears to do nothing.
    const parse = applyAmountEdit('1,499', '1499');
    assert.equal(parse.minor, 49_900);
    assert.equal(parse.display, '499');
  });

  test('a second decimal point is refused and the draft kept', () => {
    const parse = applyAmountEdit('1,499.5', '1,499.5.');
    assert.equal(parse.display, '1,499.5');
    assert.equal(parse.minor, 149_950);
  });

  test('one decimal place too many is refused and the draft kept', () => {
    const parse = applyAmountEdit('1,499.50', '1,499.505');
    assert.equal(parse.display, '1,499.50');
    assert.equal(parse.minor, 149_950);
  });
});

describe('applyAmountEdit() — deleting a selection (T15)', () => {
  test('the case that cleared a committed amount', () => {
    const parse = applyAmountEdit('1,234,567', '1,2367');
    assert.equal(parse.problem, null, 'a deletion cannot make a draft ambiguous');
    assert.equal(parse.minor, 1_236_700);
    assert.equal(parse.display, '12,367');
  });

  test('the case that happened to survive still does', () => {
    const parse = applyAmountEdit('1,234,567', '1,567');
    assert.equal(parse.minor, 156_700);
    assert.equal(parse.display, '1,567');
  });

  test('a run deleted from the front', () => {
    assert.equal(applyAmountEdit('1,234,567', '567').minor, 56_700);
  });

  test('a run deleted across the decimal point', () => {
    const parse = applyAmountEdit('1,234.50', '1.50');
    assert.equal(parse.minor, 150);
    assert.equal(parse.display, '1.50');
  });

  test('a run deleted from the end', () => {
    assert.equal(applyAmountEdit('1,234,567', '1,2').minor, 1_200);
  });

  test('select-all and delete leaves an empty, incomplete, problem-free draft', () => {
    const parse = applyAmountEdit('1,234', '');
    assert.equal(parse.minor, null);
    assert.equal(parse.problem, null);
    assert.equal(parse.incomplete, true);
  });
});

describe('applyAmountEdit() — pasting', () => {
  test('a multi-character insertion is still judged as written', () => {
    // `'1,2367'` is genuinely ambiguous as pasted text: 12,367 or a decimal
    // comma? The field refuses to guess and keeps the text on screen to fix.
    const parse = applyAmountEdit('', '1,2367');
    assert.equal(parse.problem, 'ambiguous-separators');
    assert.equal(parse.minor, null);
    assert.equal(parse.display, '1,2367');
  });

  test('a well-grouped paste is accepted', () => {
    const parse = applyAmountEdit('', '1,234,567.89');
    assert.equal(parse.minor, 123_456_789);
    assert.equal(parse.display, '1,234,567.89');
  });

  test('replacing a selection with typed text is a paste-shaped change and is judged', () => {
    // Removed `234,` and inserted `9` in one change: neither a single
    // keystroke nor a pure deletion. The result happens to be well formed.
    const parse = applyAmountEdit('1,234,567', '1,9567');
    assert.equal(parse.problem, 'ambiguous-separators');
  });
});

describe('parseAmountInput() — the shapes the edit model relies on', () => {
  test('empty is incomplete, not wrong', () => {
    const parse = parseAmountInput('');
    assert.deepEqual(
      { minor: parse.minor, problem: parse.problem, incomplete: parse.incomplete },
      { minor: null, problem: null, incomplete: true },
    );
  });

  test('a trailing point is not an error', () => {
    // Whether it counts as "incomplete" is the parser's call (its type doc and
    // its behaviour currently disagree — see `AmountParse.incomplete`); what
    // the edit model relies on is only that it is never a PROBLEM.
    assert.equal(parseAmountInput('1499.').problem, null);
  });

  test('a decimal comma is refused rather than reordered', () => {
    assert.equal(parseAmountInput('1499,50').problem, 'ambiguous-separators');
  });
});
