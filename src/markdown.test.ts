import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderMarkdown } from './markdown.ts';

test('a newline inside a paragraph is a soft break; a blank line still starts a new one', () => {
  assert.equal(renderMarkdown('first line\nsecond line\n\nnext'), '<p>first line second line</p><p>next</p>');
});

// Pins the reason the soft break exists: an agent hard-wrapping its details
// at 78 columns must not force those wrap points onto a 320px phone.
test('a hard-wrapped paragraph reflows instead of keeping the source wrapping', () => {
  const wrapped = 'Expected: the email you typed is still there. Actual: the field is blank and\nfocus is on the password.';

  const html = renderMarkdown(wrapped);

  assert.doesNotMatch(html, /<br>/);
  assert.equal(html, '<p>Expected: the email you typed is still there. Actual: the field is blank and focus is on the password.</p>');
});

test('renders one-level unordered lists', () => {
  assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
});

test('renders one-level ordered lists', () => {
  assert.equal(renderMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
});

test('renders fenced code, including an unmatched fence', () => {
  assert.equal(renderMarkdown('```ts\nconst x = 1;\n```'), '<pre><code>const x = 1;</code></pre>');
  assert.equal(renderMarkdown('```\n<script>'), '<pre><code>&lt;script&gt;</code></pre>');
});

test('renders inline code', () => {
  assert.equal(renderMarkdown('Run `npm test`.'), '<p>Run <code>npm test</code>.</p>');
});

test('renders only http and https links', () => {
  assert.equal(renderMarkdown('[site](https://example.test/a?q=1)'), '<p><a href="https://example.test/a?q=1">site</a></p>');
  assert.equal(renderMarkdown('[bad](javascript:alert(1))'), '<p>[bad](javascript:alert(1))</p>');
});

test('renders bold text', () => {
  assert.equal(renderMarkdown('**important**'), '<p><strong>important</strong></p>');
});

test('escapes html input before rendering the subset', () => {
  assert.equal(renderMarkdown('<script>alert("x")</script>'), '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>');
});
