import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { FILES_DIR } from './home.ts';
import type { FileRow, FileSide, Store } from './store.ts';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 5;

const NAME_LIMIT = 255;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface DetectedImage {
  mime: ImageMime;
  ext: string;
}

/** 'type' is a 400 on the page, 'size' a 413; the CLI exits 1 for both. */
export class ImageError extends Error {
  readonly reason: 'type' | 'size';

  constructor(reason: 'type' | 'size', message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface ImageInput {
  name: string;
  data: Buffer;
}

export interface PreparedImage {
  name: string;
  mime: ImageMime;
  ext: string;
  data: Buffer;
}

export function detectImage(buf: Buffer): DetectedImage | undefined {
  if (startsWith(buf, 0, [0x89, 0x50, 0x4e, 0x47])) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (startsWith(buf, 0, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (ascii(buf, 0, 4) === 'GIF8') {
    return { mime: 'image/gif', ext: 'gif' };
  }
  return undefined;
}

const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];

/** Names what the bytes are, so the refusal says more than "not an image". */
export function describeBytes(buf: Buffer): string {
  const brand = ascii(buf, 4, 12);
  if (brand.startsWith('ftyp')) {
    const kind = brand.slice(4, 8);
    if (HEIF_BRANDS.includes(kind)) {
      return 'HEIC';
    }
    if (kind === 'avif' || kind === 'avis') {
      return 'AVIF';
    }
  }
  if (ascii(buf, 0, 4) === '%PDF') {
    return 'PDF';
  }
  if (ascii(buf, 0, 2) === 'PK') {
    return 'ZIP archive';
  }
  if (ascii(buf, 0, 2) === 'BM') {
    return 'BMP';
  }
  if (startsWith(buf, 0, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, 0, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'TIFF';
  }
  if (looksLikeText(buf)) {
    return 'text';
  }

  const head = [...buf.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  return `unknown data (starts ${head})`;
}

/**
 * Drops every APP1 segment that starts "Exif\0\0" and every APP13 segment,
 * and puts back one minimal Exif segment carrying only the orientation tag
 * (0x0112) when the original had one, so a portrait phone photo still opens
 * upright. GPS, maker notes and embedded thumbnails do not survive. All other
 * bytes pass through untouched and nothing is ever re-encoded. PNG eXIf chunks
 * are rare from phones, so only JPEG is stripped.
 */
export function stripExif(buf: Buffer): Buffer {
  if (!startsWith(buf, 0, [0xff, 0xd8, 0xff])) {
    return buf;
  }

  const kept: Buffer[] = [buf.subarray(0, 2)];
  let pos = 2;
  let orientation: Buffer | undefined;
  let orientationAt = -1;

  for (;;) {
    if (pos + 2 > buf.length || buf[pos] !== 0xff) {
      throw new ImageError('type', 'corrupt JPEG (bad segment header before the image data)');
    }

    const marker = buf[pos + 1] as number;
    if (marker === 0xff) {
      // Fill byte before a marker.
      kept.push(buf.subarray(pos, pos + 1));
      pos += 1;
      continue;
    }

    if (marker === 0xda || marker === 0xd9) {
      // SOS starts the entropy-coded data; the rest is copied as it is.
      kept.push(buf.subarray(pos));
      if (orientation !== undefined) {
        kept.splice(orientationAt, 0, orientation);
      }
      return Buffer.concat(kept);
    }

    const length = pos + 4 <= buf.length ? buf.readUInt16BE(pos + 2) : 0;
    const end = pos + 2 + length;
    if (length < 2 || end > buf.length) {
      throw new ImageError('type', 'corrupt JPEG (a segment runs past the end of the file)');
    }

    const payloadStart = pos + 4;
    const isExif = marker === 0xe1 && ascii(buf, payloadStart, payloadStart + 6) === 'Exif\0\0';
    if (isExif) {
      if (orientationAt < 0) {
        orientationAt = kept.length;
      }
      orientation ??= orientationSegment(buf.subarray(payloadStart + 6, end));
    } else if (marker !== 0xed) {
      kept.push(buf.subarray(pos, end));
    }
    pos = end;
  }
}

/** A whole APP1 segment holding IFD0 with just the orientation, or undefined. */
function orientationSegment(tiff: Buffer): Buffer | undefined {
  const order = ascii(tiff, 0, 2);
  if ((order !== 'II' && order !== 'MM') || tiff.length < 8) {
    return undefined;
  }
  const little = order === 'II';
  const u16 = (at: number): number => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number): number => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));

  if (u16(2) !== 42) {
    return undefined;
  }
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) {
    return undefined;
  }

  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) {
      return undefined;
    }
    // Tag 0x0112, type SHORT, one value, held in the first two value bytes.
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? buildOrientation(little, value) : undefined;
    }
  }
  return undefined;
}

function buildOrientation(little: boolean, value: number): Buffer {
  const body = Buffer.alloc(6 + 8 + 2 + 12 + 4);
  body.write('Exif\0\0', 0, 'latin1');
  const t = 6;
  const w16 = (at: number, v: number): void => void (little ? body.writeUInt16LE(v, t + at) : body.writeUInt16BE(v, t + at));
  const w32 = (at: number, v: number): void => void (little ? body.writeUInt32LE(v, t + at) : body.writeUInt32BE(v, t + at));
  body.write(little ? 'II' : 'MM', t, 'latin1');
  w16(2, 42);
  w32(4, 8);
  w16(8, 1);
  w16(10, 0x0112);
  w16(12, 3);
  w32(14, 1);
  w16(18, value);

  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** Checks and cleans every file before anything touches the disk or the store. */
export function prepareImages(inputs: readonly ImageInput[]): PreparedImage[] {
  if (inputs.length > MAX_FILES) {
    throw new ImageError('size', `too many files: ${inputs.length} sent, ${MAX_FILES} allowed at once`);
  }

  return inputs.map((input) => {
    const label = displayName(input.name);

    if (input.data.length === 0) {
      throw new ImageError('type', `${label} is empty`);
    }
    if (input.data.length > MAX_FILE_BYTES) {
      throw new ImageError(
        'size',
        `${label} is ${formatMb(input.data.length)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB per file`,
      );
    }

    const detected = detectImage(input.data);
    if (detected === undefined) {
      const seen = describeBytes(input.data);
      const hint =
        seen === 'HEIC'
          ? ' Pick JPEG in the phone camera settings, or share the photo as JPEG.'
          : ' Accepted: PNG, JPEG, WebP, GIF.';
      throw new ImageError('type', `${label} is ${seen}, not an image lookover accepts.${hint}`);
    }

    return { name: label, mime: detected.mime, ext: detected.ext, data: clean(detected.mime, input.data, label) };
  });
}

function clean(mime: ImageMime, data: Buffer, label: string): Buffer {
  if (mime !== 'image/jpeg') {
    return data;
  }

  try {
    return stripExif(data);
  } catch (error) {
    throw error instanceof ImageError ? new ImageError(error.reason, `${label}: ${error.message}`) : error;
  }
}

/**
 * Writes each file, then inserts every row in one transaction. A failure at
 * any point unlinks what was written, so no file outlives a missing row.
 */
export function storeImages(
  store: Store,
  home: string,
  projectSlug: string,
  itemId: number,
  side: FileSide,
  images: readonly PreparedImage[],
): FileRow[] {
  const written: string[] = [];

  try {
    const rows = images.map((image) => {
      // A UUID, not the row id: the row cannot exist before the file is on disk.
      const path = `${projectSlug}/${itemId}/${randomUUID()}.${image.ext}`;
      const absolute = storedPath(home, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, image.data, { flag: 'wx' });
      written.push(absolute);

      return { itemId, side, name: image.name, mime: image.mime, size: image.data.length, path };
    });

    return store.addFiles(rows);
  } catch (error) {
    for (const absolute of written) {
      try {
        unlinkSync(absolute);
      } catch {
        // Already gone; the original error is the one to report.
      }
    }
    throw error;
  }
}

export function storeImage(
  store: Store,
  home: string,
  projectSlug: string,
  itemId: number,
  side: FileSide,
  name: string,
  data: Buffer,
): FileRow {
  return storeImages(store, home, projectSlug, itemId, side, prepareImages([{ name, data }]))[0] as FileRow;
}

/** The absolute path of a stored file; refuses anything that leaves <home>/files. */
export function storedPath(home: string, storedRelative: string): string {
  const root = resolve(home, FILES_DIR);
  const absolute = resolve(root, storedRelative);
  const inside = relative(root, absolute);

  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`stored path escapes the files directory: ${storedRelative}`);
  }
  return absolute;
}

function displayName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (cleaned === '' ? 'unnamed' : cleaned).slice(0, NAME_LIMIT);
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function startsWith(buf: Buffer, offset: number, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => buf[offset + index] === byte);
}

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString('latin1');
}

function looksLikeText(buf: Buffer): boolean {
  const head = buf.subarray(0, 512);
  if (head.some((byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
    return false;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head);
    return true;
  } catch {
    return false;
  }
}
