import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findImageRefs, planImport, resolveImageRefs } from './import.ts';

function imageDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('findImageRefs recognizes fixture directory and glob references', () => {
  assert.deepEqual(findImageRefs('See .claude/testing/images/design-swing/ and images/761-visual-b/past-meetings-*.png.'), ['.claude/testing/images/design-swing/', 'images/761-visual-b/past-meetings-*.png']);
});

test('resolveImageRefs expands a directory, same-directory glob, and file', (t) => {
  const root = imageDir(t);
  mkdirSync(join(root, 'design-swing')); mkdirSync(join(root, '761-visual-b'));
  writeFileSync(join(root, 'design-swing', 'b.png'), 'b'); writeFileSync(join(root, 'design-swing', 'a.png'), 'a');
  writeFileSync(join(root, '761-visual-b', 'past-meetings-2.png'), '2'); writeFileSync(join(root, '761-visual-b', 'past-meetings-1.png'), '1');
  writeFileSync(join(root, '761-visual-b', 'other.png'), 'x');
  const matches = resolveImageRefs(['images/design-swing/', 'images/761-visual-b/past-meetings-*.png', 'images/761-visual-b/other.png'], root);
  assert.deepEqual(matches.map((match) => match.files.map((file) => file.slice(root.length + 1))), [['design-swing/a.png', 'design-swing/b.png'], ['761-visual-b/past-meetings-1.png', '761-visual-b/past-meetings-2.png'], ['761-visual-b/other.png']]);
});

test('planImport lists every unreferenced PNG and keeps a glob in its directory', (t) => {
  const root = imageDir(t); mkdirSync(join(root, 'one')); mkdirSync(join(root, 'two'));
  writeFileSync(join(root, 'one', 'match.png'), 'x'); writeFileSync(join(root, 'one', 'unused.png'), 'x'); writeFileSync(join(root, 'two', 'match.png'), 'x');
  const plan = planImport([{ title: 'row', details: 'images/one/match*.png', source: '', status: 'open', verdict: null, feedback: null, created_at: 'a', feedback_at: null, processed_at: null, processed_note: null, ref: null }], 7, root);
  assert.deepEqual(plan.matches[0]?.files.map((file) => file.slice(root.length + 1)), ['one/match.png']);
  assert.deepEqual(plan.skipped.map((file) => file.slice(root.length + 1)), ['one/unused.png', 'two/match.png']);
});
