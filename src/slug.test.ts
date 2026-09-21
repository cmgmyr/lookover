import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slugify } from './slug.ts';

test('slugify lowercases and collapses each punctuation run into one dash', () => {
  assert.equal(slugify('Novel Hood!!'), 'novel-hood');
  assert.equal(slugify('  Foo --- Bar  '), 'foo-bar');
  assert.equal(slugify('@cmgmyr/lookover'), 'cmgmyr-lookover');
});

test('slugify caps a long name at 40 characters', () => {
  assert.equal(slugify('a'.repeat(50)), 'a'.repeat(40));
});

test('slugify trims the dash the 40 character cap can leave behind', () => {
  // The cap lands on the separator, so trimming has to happen after it.
  assert.equal(slugify(`${'a'.repeat(39)} ${'b'.repeat(10)}`), 'a'.repeat(39));
});

test('slugify returns empty for a name with nothing alphanumeric in it', () => {
  assert.equal(slugify('!!! ???'), '');
});
