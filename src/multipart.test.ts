import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { BodyTooLargeError, isMultipart, MultipartError, parseMultipart, readBody } from './multipart.ts';

const B = 'XyZ-boundary-123';
const CT = `multipart/form-data; boundary=${B}`;

function part(headers: string[], data: string | Buffer): Buffer {
  return Buffer.concat([Buffer.from(`--${B}\r\n${headers.join('\r\n')}\r\n\r\n`), Buffer.from(data), Buffer.from('\r\n')]);
}

function field(name: string, value: string): Buffer {
  return part([`Content-Disposition: form-data; name="${name}"`], value);
}

function file(name: string, filename: string, data: string | Buffer, type = 'image/png'): Buffer {
  return part([`Content-Disposition: form-data; name="${name}"; filename="${filename}"`, `Content-Type: ${type}`], data);
}

function body(...parts: Buffer[]): Buffer {
  return Buffer.concat([...parts, Buffer.from(`--${B}--\r\n`)]);
}

test('parseMultipart reads text fields into a URLSearchParams', () => {
  const parsed = parseMultipart(body(field('verdict', 'approved'), field('feedback', 'looks\r\nfine')), CT);

  assert.equal(parsed.fields.get('verdict'), 'approved');
  assert.equal(parsed.fields.get('feedback'), 'looks\r\nfine');
  assert.deepEqual(parsed.files, []);
});

test('parseMultipart returns each file with its field, name, declared mime and exact bytes', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0xff]);

  const parsed = parseMultipart(body(field('t', 'k'), file('photo', 'a.png', bytes), file('photo', 'b.jpg', 'xx', 'image/jpeg')), CT);

  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0]?.field, 'photo');
  assert.equal(parsed.files[0]?.name, 'a.png');
  assert.equal(parsed.files[0]?.mime, 'image/png');
  assert.deepEqual(parsed.files[0]?.data, bytes);
  assert.equal(parsed.files[1]?.mime, 'image/jpeg');
});

test('parseMultipart keeps a file body that contains CRLF and lookalike boundary text', () => {
  const tricky = Buffer.from(`a\r\n--${B}x still data\r\n--\r\nend`);

  const parsed = parseMultipart(body(file('photo', 'a.png', tricky)), CT);

  assert.deepEqual(parsed.files[0]?.data, tricky);
});

test('parseMultipart takes a quoted boundary in the content-type', () => {
  const parsed = parseMultipart(body(field('a', '1')), `multipart/form-data; boundary="${B}"`);

  assert.equal(parsed.fields.get('a'), '1');
});

test('parseMultipart unescapes a filename with spaces and a backslash-escaped quote (curl)', () => {
  const parsed = parseMultipart(body(file('photo', 'my \\"best\\" shot.png', 'x')), CT);

  assert.equal(parsed.files[0]?.name, 'my "best" shot.png');
});

test('parseMultipart decodes %22 in a filename the way browsers send a quote', () => {
  const parsed = parseMultipart(body(file('photo', 'my %22best%22 shot.png', 'x')), CT);

  assert.equal(parsed.files[0]?.name, 'my "best" shot.png');
});

test('parseMultipart keeps a semicolon inside a quoted filename', () => {
  const parsed = parseMultipart(body(file('photo', 'a;b=c.png', 'x')), CT);

  assert.equal(parsed.files[0]?.name, 'a;b=c.png');
});

test('parseMultipart prefers the RFC 5987 filename* form when present', () => {
  const p = part([`Content-Disposition: form-data; name="photo"; filename="fallback.png"; filename*=UTF-8''caf%C3%A9.png`], 'x');

  assert.equal(parseMultipart(body(p), CT).files[0]?.name, 'café.png');
});

test('parseMultipart reads UTF-8 in field values and filenames', () => {
  const parsed = parseMultipart(body(field('feedback', 'naïve ✓'), file('photo', 'écran.png', 'x')), CT);

  assert.equal(parsed.fields.get('feedback'), 'naïve ✓');
  assert.equal(parsed.files[0]?.name, 'écran.png');
});

test('parseMultipart drops the empty file part a browser sends for an untouched input', () => {
  const parsed = parseMultipart(body(field('feedback', 'hi'), file('photo', '', '', 'application/octet-stream')), CT);

  assert.deepEqual(parsed.files, []);
  assert.equal(parsed.fields.get('feedback'), 'hi');
});

test('parseMultipart keeps a named file with no bytes so the caller can refuse it', () => {
  const parsed = parseMultipart(body(file('photo', 'zero.png', '')), CT);

  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]?.data.length, 0);
});

test('parseMultipart accepts an empty text field', () => {
  assert.equal(parseMultipart(body(field('feedback', '')), CT).fields.get('feedback'), '');
});

test('parseMultipart skips a preamble before the first boundary', () => {
  const withPreamble = Buffer.concat([Buffer.from('this is a preamble\r\n'), body(field('a', '1'))]);

  assert.equal(parseMultipart(withPreamble, CT).fields.get('a'), '1');
});

test('parseMultipart takes a body with only the closing boundary as zero parts', () => {
  const parsed = parseMultipart(Buffer.from(`--${B}--\r\n`), CT);

  assert.equal([...parsed.fields].length, 0);
  assert.deepEqual(parsed.files, []);
});

test('parseMultipart throws when the final boundary is missing', () => {
  const cut = Buffer.concat([field('a', '1'), Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="b"\r\n\r\nvalue`)]);

  assert.throws(() => parseMultipart(cut, CT), MultipartError);
});

test('parseMultipart throws when the body stops right after a part with no closing boundary', () => {
  const cut = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n`);

  assert.throws(() => parseMultipart(cut, CT), /final boundary/);
});

test('parseMultipart throws when the body ends at the boundary line itself', () => {
  assert.throws(() => parseMultipart(Buffer.concat([field('a', '1'), Buffer.from(`--${B}`)]), CT), /final boundary/);
});

test('parseMultipart throws on a body with no opening boundary', () => {
  assert.throws(() => parseMultipart(Buffer.from('a=1&b=2'), CT), /opening boundary/);
});

test('parseMultipart throws when the content-type has no boundary', () => {
  assert.throws(() => parseMultipart(body(field('a', '1')), 'multipart/form-data'), /without a boundary/);
});

test('parseMultipart throws on a part with no field name', () => {
  const nameless = part(['Content-Type: text/plain'], 'x');

  assert.throws(() => parseMultipart(body(nameless), CT), /field name/);
});

test('parseMultipart throws on part headers that never end', () => {
  assert.throws(() => parseMultipart(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="a"`), CT), MultipartError);
});

test('isMultipart matches multipart/form-data with parameters and rejects urlencoded', () => {
  assert.equal(isMultipart(CT), true);
  assert.equal(isMultipart('Multipart/Form-Data; boundary=x'), true);
  assert.equal(isMultipart('application/x-www-form-urlencoded'), false);
  assert.equal(isMultipart(undefined), false);
});

test('readBody returns the whole body when it is under the limit', async () => {
  const chunks = [Buffer.from('abc'), Buffer.from('def')];

  assert.equal((await readBody(Readable.from(chunks), 10)).toString(), 'abcdef');
});

test('readBody stops pulling chunks the moment the limit is passed', async () => {
  let pulled = 0;
  async function* endless(): AsyncGenerator<Buffer> {
    for (;;) {
      pulled += 1;
      yield Buffer.alloc(1024);
    }
  }

  await assert.rejects(readBody(endless(), 5 * 1024), BodyTooLargeError);

  assert.equal(pulled, 6);
});
