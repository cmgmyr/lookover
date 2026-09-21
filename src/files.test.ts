import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  detectImage,
  MAX_FILE_BYTES,
  MAX_FILES,
  ImageError,
  prepareImages,
  storedPath,
  storeImage,
  storeImages,
  stripExif,
} from './files.ts';
import { openStore, StoreError } from './store.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([16, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8, 2)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(16, 3)]);

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

const APP0 = segment(0xe0, Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00'));
const APP1_EXIF = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPS 40.7128 -74.0060', 'latin1')]));
const APP1_XMP = segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'));
const APP13 = segment(0xed, Buffer.from('Photoshop 3.0\0iptc caption'));
const DQT = segment(0xdb, Buffer.alloc(65, 5));
const SOF0 = segment(0xc0, Buffer.from([8, 0, 4, 0, 4, 1, 1, 0x11, 0]));
const SOS = segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
const SCAN = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function jpeg(...segments: Buffer[]): Buffer {
  return Buffer.concat([SOI, ...segments, SOS, SCAN, EOI]);
}

/** Marker of every segment up to and including SOS, by walking the lengths. */
function markers(buf: Buffer): number[] {
  const found: number[] = [];
  let pos = 2;
  while (pos < buf.length) {
    const marker = buf[pos + 1] as number;
    found.push(marker);
    if (marker === 0xda) {
      break;
    }
    pos += 2 + buf.readUInt16BE(pos + 2);
  }
  return found;
}

const DIRTY = jpeg(APP0, APP1_EXIF, APP1_XMP, APP13, DQT, SOF0);

test('detectImage recognises PNG by its magic bytes', () => {
  assert.deepEqual(detectImage(PNG), { mime: 'image/png', ext: 'png' });
});

test('detectImage recognises JPEG by its magic bytes', () => {
  assert.deepEqual(detectImage(DIRTY), { mime: 'image/jpeg', ext: 'jpg' });
});

test('detectImage recognises WebP by RIFF and WEBP', () => {
  assert.deepEqual(detectImage(WEBP), { mime: 'image/webp', ext: 'webp' });
});

test('detectImage does not take a RIFF file that is not WebP for WebP', () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([16, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(8)]);

  assert.equal(detectImage(wav), undefined);
});

test('detectImage recognises GIF by its magic bytes', () => {
  assert.deepEqual(detectImage(GIF), { mime: 'image/gif', ext: 'gif' });
});

test('detectImage returns undefined for bytes shorter than any signature', () => {
  assert.equal(detectImage(Buffer.from([0xff, 0xd8])), undefined);
  assert.equal(detectImage(Buffer.alloc(0)), undefined);
});

test('prepareImages refuses a .txt renamed .png by its bytes and says it saw text', () => {
  assert.throws(
    () => prepareImages([{ name: 'notes.png', data: Buffer.from('just some notes\n') }]),
    (error: unknown) => error instanceof ImageError && error.reason === 'type' && /notes\.png is text/.test(error.message),
  );
});

test('prepareImages refuses HEIC and tells the tester to pick JPEG', () => {
  assert.throws(
    () => prepareImages([{ name: 'IMG_0001.jpg', data: HEIC }]),
    (error: unknown) => error instanceof ImageError && /HEIC/.test(error.message) && /JPEG in the phone camera settings/.test(error.message),
  );
});

test('prepareImages names a PDF it refuses', () => {
  assert.throws(
    () => prepareImages([{ name: 'a.png', data: Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3', 'latin1') }]),
    (error: unknown) => error instanceof ImageError && /a\.png is PDF/.test(error.message),
  );
});

test('prepareImages refuses an empty file', () => {
  assert.throws(() => prepareImages([{ name: 'empty.png', data: Buffer.alloc(0) }]), /empty\.png is empty/);
});

test('prepareImages accepts a file of exactly the size cap', () => {
  const exact = Buffer.concat([PNG, Buffer.alloc(MAX_FILE_BYTES - PNG.length)]);

  assert.equal(prepareImages([{ name: 'big.png', data: exact }]).length, 1);
});

test('prepareImages refuses a file one byte over the size cap with a size error', () => {
  const over = Buffer.concat([PNG, Buffer.alloc(MAX_FILE_BYTES + 1 - PNG.length)]);

  assert.throws(
    () => prepareImages([{ name: 'huge.png', data: over }]),
    (error: unknown) => error instanceof ImageError && error.reason === 'size' && /huge\.png is 10\.0 MB/.test(error.message),
  );
});

test('prepareImages refuses more files than the cap allows', () => {
  const inputs = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `${i}.png`, data: PNG }));

  assert.throws(
    () => prepareImages(inputs),
    (error: unknown) => error instanceof ImageError && error.reason === 'size' && /too many files/.test(error.message),
  );
  assert.equal(prepareImages(inputs.slice(0, MAX_FILES)).length, MAX_FILES);
});

test('prepareImages refuses the whole batch when one file among good ones is wrong', () => {
  assert.throws(() =>
    prepareImages([
      { name: 'ok.png', data: PNG },
      { name: 'bad.png', data: Buffer.from('nope') },
    ]),
  );
});

test('prepareImages keeps the original name, including spaces and a quote', () => {
  const [image] = prepareImages([{ name: 'my "best" shot.png', data: PNG }]);

  assert.equal(image?.name, 'my "best" shot.png');
});

test('prepareImages refuses a JPEG whose segments run past the end of the file', () => {
  const truncated = Buffer.concat([SOI, APP0, Buffer.from([0xff, 0xe1, 0x40, 0x00, 0x45])]);

  assert.throws(
    () => prepareImages([{ name: 'cut.jpg', data: truncated }]),
    (error: unknown) => error instanceof ImageError && /cut\.jpg: corrupt JPEG/.test(error.message),
  );
});

test('stripExif removes the APP1 Exif segment and the APP13 segment and nothing else', () => {
  const clean = stripExif(DIRTY);

  assert.deepEqual(markers(DIRTY), [0xe0, 0xe1, 0xe1, 0xed, 0xdb, 0xc0, 0xda]);
  assert.deepEqual(markers(clean), [0xe0, 0xe1, 0xdb, 0xc0, 0xda]);
  assert.equal(clean.includes(Buffer.from('Exif\0\0', 'latin1')), false);
  assert.equal(clean.includes(Buffer.from('GPS 40.7128')), false);
  assert.equal(clean.includes(Buffer.from('Photoshop 3.0')), false);
});

test('stripExif keeps the XMP APP1 segment, which is not Exif', () => {
  assert.equal(stripExif(DIRTY).includes(Buffer.from('http://ns.adobe.com/xap/1.0/')), true);
});

test('stripExif leaves SOI, JFIF, tables, SOF, SOS, the scan and EOI byte for byte', () => {
  assert.deepEqual(stripExif(DIRTY), jpeg(APP0, APP1_XMP, DQT, SOF0));
  assert.deepEqual(stripExif(DIRTY).subarray(0, 2), SOI);
  assert.deepEqual(stripExif(DIRTY).subarray(-2), EOI);
});

test('stripExif does not touch stuffed FF00 or RSTn bytes inside the scan', () => {
  const clean = stripExif(DIRTY);

  assert.equal(clean.includes(Buffer.concat([SOS, SCAN, EOI])), true);
});

test('stripExif returns a JPEG with no metadata segments as the same bytes', () => {
  const plain = jpeg(APP0, DQT, SOF0);

  assert.deepEqual(stripExif(plain), plain);
});

test('stripExif handles a run of Exif segments and fill bytes before a marker', () => {
  const filled = Buffer.concat([SOI, Buffer.from([0xff]), APP1_EXIF, APP1_EXIF, SOF0, SOS, SCAN, EOI]);

  assert.deepEqual(stripExif(filled), Buffer.concat([SOI, Buffer.from([0xff]), SOF0, SOS, SCAN, EOI]));
});

/** A TIFF with Make, Orientation (optional) and a GPS IFD pointer in IFD0, in either byte order. */
function tiff(little: boolean, orientation: number | undefined, extra = false): Buffer {
  const w16 = (v: number): Buffer => { const b = Buffer.alloc(2); if (little) b.writeUInt16LE(v); else b.writeUInt16BE(v); return b; };
  const w32 = (v: number): Buffer => { const b = Buffer.alloc(4); if (little) b.writeUInt32LE(v); else b.writeUInt32BE(v); return b; };
  const count = orientation === undefined ? 2 : 3;
  const dataAt = 8 + 2 + count * 12 + 4;
  const make = Buffer.from('Canon\0');
  const gps = Buffer.from('GPSMARK 40.7128 -74.0060');
  const entries = [
    Buffer.concat([w16(0x010f), w16(2), w32(make.length), w32(dataAt)]),
    ...(orientation === undefined ? [] : [Buffer.concat([w16(0x0112), w16(3), w32(1), w16(orientation), w16(0)])]),
    Buffer.concat([w16(0x8825), w16(4), w32(1), w32(dataAt + make.length)]),
  ];
  const parts = [Buffer.from(little ? 'II' : 'MM'), w16(42), w32(8), w16(count), ...entries, w32(0), make, gps];
  if (extra) parts.push(Buffer.from('THUMBNAIL-BYTES'));
  return Buffer.concat(parts);
}

function exifSegment(payload: Buffer): Buffer {
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), payload]));
}

/** What stripExif must emit for a kept orientation: IFD0 with that one entry and nothing else. */
function minimalOrientation(little: boolean, value: number): Buffer {
  const w16 = (v: number): Buffer => { const b = Buffer.alloc(2); if (little) b.writeUInt16LE(v); else b.writeUInt16BE(v); return b; };
  const w32 = (v: number): Buffer => { const b = Buffer.alloc(4); if (little) b.writeUInt32LE(v); else b.writeUInt32BE(v); return b; };
  return exifSegment(Buffer.concat([Buffer.from(little ? 'II' : 'MM'), w16(42), w32(8), w16(1), w16(0x0112), w16(3), w32(1), w16(value), w16(0), w32(0)]));
}

test('stripExif keeps orientation 6 as a minimal Exif segment, byte for byte, little-endian', () => {
  const clean = stripExif(jpeg(APP0, exifSegment(tiff(true, 6)), DQT, SOF0));

  assert.deepEqual(clean, jpeg(APP0, minimalOrientation(true, 6), DQT, SOF0));
});

test('stripExif keeps orientation 8 as a minimal Exif segment, byte for byte, big-endian', () => {
  const clean = stripExif(jpeg(APP0, exifSegment(tiff(false, 8)), DQT, SOF0));

  assert.deepEqual(clean, jpeg(APP0, minimalOrientation(false, 8), DQT, SOF0));
});

test('stripExif drops the GPS IFD pointer, the Make tag and everything else in the Exif segment', () => {
  const clean = stripExif(jpeg(APP0, exifSegment(tiff(true, 6, true)), DQT, SOF0));

  assert.equal(clean.includes(Buffer.from('GPSMARK')), false);
  assert.equal(clean.includes(Buffer.from('Canon')), false);
  assert.equal(clean.includes(Buffer.from('THUMBNAIL')), false);
  assert.equal(clean.includes(Buffer.from([0x25, 0x88])), false);
});

test('stripExif leaves no APP1 at all when the Exif segment had no orientation', () => {
  const clean = stripExif(jpeg(APP0, exifSegment(tiff(true, undefined)), DQT, SOF0));

  assert.deepEqual(markers(clean), [0xe0, 0xdb, 0xc0, 0xda]);
  assert.equal(clean.includes(Buffer.from('GPSMARK')), false);
});

test('stripExif drops an orientation value outside 1 to 8 rather than carrying it', () => {
  const clean = stripExif(jpeg(APP0, exifSegment(tiff(true, 9)), DQT, SOF0));

  assert.deepEqual(markers(clean), [0xe0, 0xdb, 0xc0, 0xda]);
});

test('stripExif drops the Exif segment and keeps no orientation when the TIFF is garbage', () => {
  const clean = stripExif(jpeg(APP0, exifSegment(Buffer.from('not a tiff header at all')), DQT, SOF0));

  assert.deepEqual(markers(clean), [0xe0, 0xdb, 0xc0, 0xda]);
});

test('stripExif puts the kept orientation where the first Exif segment was and drops the rest of a second one', () => {
  const clean = stripExif(jpeg(APP0, exifSegment(tiff(true, undefined)), APP1_XMP, exifSegment(tiff(true, 3)), DQT, SOF0));

  assert.deepEqual(clean, jpeg(APP0, minimalOrientation(true, 3), APP1_XMP, DQT, SOF0));
});

test('stripExif still drops APP13 when it keeps an orientation', () => {
  const clean = stripExif(jpeg(APP0, exifSegment(tiff(true, 6)), APP13, DQT, SOF0));

  assert.deepEqual(markers(clean), [0xe0, 0xe1, 0xdb, 0xc0, 0xda]);
  assert.equal(clean.includes(Buffer.from('Photoshop 3.0')), false);
});

test('stripExif returns PNG, WebP and GIF as they came', () => {
  assert.equal(stripExif(PNG), PNG);
  assert.equal(stripExif(WEBP), WEBP);
  assert.equal(stripExif(GIF), GIF);
});

test('prepareImages strips a JPEG on the way in and stores PNG untouched', () => {
  const [jpg, png] = prepareImages([
    { name: 'a.jpg', data: DIRTY },
    { name: 'b.png', data: PNG },
  ]);

  assert.equal(jpg?.data.includes(Buffer.from('Exif')), false);
  assert.equal(png?.data, PNG);
});

function scratch(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), 'lookover-files-'));
  const store = openStore(join(home, 'queue.sqlite'));
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const project = store.registerProject({ slug: 'app', name: 'App', identity: '/repos/app/.git', identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const item = store.addItem({ projectId: project.id, title: 'card' });
  return { home, store, item };
}

function filesOnDisk(home: string): string[] {
  const root = join(home, 'files');
  if (!existsSync(root)) {
    return [];
  }
  return (readdirSync(root, { recursive: true }) as string[]).filter((entry) => /\.(png|jpg|webp|gif)$/.test(entry));
}

test('storeImages writes files under files/<slug>/<item>/ and stores the relative path', (t) => {
  const { home, store, item } = scratch(t);

  const rows = storeImages(store, home, 'app', item.id, 'card', prepareImages([
    { name: 'my "best" shot.png', data: PNG },
    { name: 'b.jpg', data: DIRTY },
  ]));

  assert.equal(rows.length, 2);
  assert.match(rows[0]?.path ?? '', new RegExp(`^app/${item.id}/[0-9a-f-]{36}\\.png$`));
  assert.match(rows[1]?.path ?? '', /\.jpg$/);
  assert.equal(rows[0]?.name, 'my "best" shot.png');
  assert.equal(rows[0]?.mime, 'image/png');
  assert.equal(rows[0]?.side, 'card');
  assert.deepEqual(readFileSync(join(home, 'files', rows[0]?.path ?? '')), PNG);
  assert.equal(readFileSync(join(home, 'files', rows[1]?.path ?? '')).includes(Buffer.from('Exif')), false);
  assert.equal(rows[1]?.size, stripExif(DIRTY).length);
  assert.equal(store.listFiles(item.id).length, 2);
});

test('storeImages leaves no file on disk when the row insert fails', (t) => {
  const { home, store, item } = scratch(t);

  assert.throws(
    () => storeImages(store, home, 'app', item.id + 100, 'feedback', prepareImages([
      { name: 'a.png', data: PNG },
      { name: 'b.png', data: GIF },
    ])),
    StoreError,
  );

  assert.deepEqual(filesOnDisk(home), []);
});

test('storeImage stores one file and returns its row', (t) => {
  const { home, store, item } = scratch(t);

  const row = storeImage(store, home, 'app', item.id, 'feedback', 'one.gif', GIF);

  assert.equal(row.mime, 'image/gif');
  assert.equal(store.getFile(row.id)?.path, row.path);
});

test('storedPath refuses a path that leaves the files directory', () => {
  assert.throws(() => storedPath('/home/x', '../queue.sqlite'), /escapes/);
  assert.throws(() => storedPath('/home/x', 'app/../../secret'), /escapes/);
  assert.throws(() => storedPath('/home/x', '/etc/passwd'), /escapes/);
  assert.equal(storedPath('/home/x', 'app/1/a.png'), '/home/x/files/app/1/a.png');
});
