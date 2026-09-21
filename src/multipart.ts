/** Five files at the per-file cap, plus room for the text fields. */
export const MAX_BODY_BYTES = 55 * 1024 * 1024;

export class MultipartError extends Error {}

export class BodyTooLargeError extends Error {}

export interface MultipartFile {
  field: string;
  name: string;
  mime: string;
  data: Buffer;
}

export interface Multipart {
  fields: URLSearchParams;
  files: MultipartFile[];
}

export function isMultipart(contentType: string | undefined): boolean {
  return /^\s*multipart\/form-data\s*(;|$)/i.test(contentType ?? '');
}

/**
 * Buffers a request body, giving up the moment it passes `limit` instead of
 * after. The iterator is abandoned rather than closed: closing an
 * IncomingMessage destroys its socket, and the caller still has a 413 to send.
 */
export async function readBody(source: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const iterator = source[Symbol.asyncIterator]();
  let total = 0;

  for (;;) {
    const next = await iterator.next();
    if (next.done === true) {
      return Buffer.concat(chunks);
    }

    total += next.value.length;
    if (total > limit) {
      throw new BodyTooLargeError(`request body is over ${limit} bytes`);
    }
    chunks.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.length));
  }
}

export function parseMultipart(body: Buffer, contentType: string | undefined): Multipart {
  const boundary = boundaryOf(contentType);
  if (boundary === undefined) {
    throw new MultipartError('multipart body without a boundary in its content-type');
  }

  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const closer = Buffer.from(`\r\n--${boundary}`, 'latin1');
  const fields = new URLSearchParams();
  const files: MultipartFile[] = [];

  let pos = findOpening(body, delimiter);
  for (;;) {
    pos += delimiter.length;

    if (body.length - pos < 2) {
      throw new MultipartError('multipart body ends without its final boundary');
    }
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) {
      return { fields, files };
    }

    pos = skipLineEnd(body, pos);
    const headerEnd = body.indexOf('\r\n\r\n', pos - 2, 'latin1');
    if (headerEnd < 0) {
      throw new MultipartError('multipart part headers are not terminated');
    }
    const headers = parseHeaders(headerEnd > pos ? body.toString('utf8', pos, headerEnd) : '');
    const dataStart = headerEnd + 4;

    const next = findCloser(body, closer, dataStart);
    if (next < 0) {
      throw new MultipartError('multipart body ends without its final boundary');
    }
    const data = body.subarray(dataStart, next);
    pos = next + 2;

    const disposition = parseDisposition(headers.get('content-disposition'));
    if (disposition.name === undefined) {
      throw new MultipartError('multipart part without a field name');
    }

    if (disposition.filename === undefined) {
      fields.append(disposition.name, data.toString('utf8'));
    } else if (disposition.filename !== '' || data.length > 0) {
      // An untouched file input arrives as an empty filename and no bytes:
      // that is no upload and no error.
      files.push({
        field: disposition.name,
        name: disposition.filename,
        mime: headers.get('content-type') ?? 'application/octet-stream',
        data: Buffer.from(data),
      });
    }
  }
}

function boundaryOf(contentType: string | undefined): string | undefined {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  const boundary = match?.[1] ?? match?.[2];
  return boundary === undefined || boundary === '' || boundary.length > 70 ? undefined : boundary;
}

/** The first delimiter, at the very start or after a preamble line. */
function findOpening(body: Buffer, delimiter: Buffer): number {
  if (body.subarray(0, delimiter.length).equals(delimiter)) {
    return 0;
  }

  const found = findCloser(body, Buffer.concat([Buffer.from('\r\n'), delimiter]), 0);
  if (found < 0) {
    throw new MultipartError('multipart body has no opening boundary');
  }
  return found + 2;
}

/**
 * The next `\r\n--boundary` that really is a delimiter: followed by `--` or a
 * line end, so text that merely starts with the boundary is not a match.
 */
function findCloser(body: Buffer, closer: Buffer, from: number): number {
  let at = body.indexOf(closer, from);

  while (at >= 0) {
    const after = at + closer.length;
    const a = body[after];
    const b = body[after + 1];
    const dashes = a === 0x2d && b === 0x2d;
    const lineEnd = a === 0x0d && b === 0x0a;
    const padded = a === 0x20 || a === 0x09;
    if (dashes || lineEnd || padded || after >= body.length) {
      return at;
    }
    at = body.indexOf(closer, at + 1);
  }

  return -1;
}

/** Past the CRLF after a delimiter, allowing the transport padding RFC 2046 permits. */
function skipLineEnd(body: Buffer, from: number): number {
  let pos = from;
  while (body[pos] === 0x20 || body[pos] === 0x09) {
    pos += 1;
  }
  if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) {
    throw new MultipartError('multipart boundary is not followed by a line end');
  }
  return pos + 2;
}

function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  return headers;
}

interface Disposition {
  name?: string;
  filename?: string;
}

/** Quoted values with `\"` (curl) or `%22` (browsers) escapes, and RFC 5987 `filename*`. */
function parseDisposition(value: string | undefined): Disposition {
  const result: Disposition = {};
  if (value === undefined) {
    return result;
  }

  let pos = value.indexOf(';');
  let extended: string | undefined;

  while (pos >= 0 && pos < value.length) {
    pos += 1;
    while (value[pos] === ' ' || value[pos] === '\t') {
      pos += 1;
    }
    const eq = value.indexOf('=', pos);
    if (eq < 0) {
      break;
    }
    const key = value.slice(pos, eq).trim().toLowerCase();
    pos = eq + 1;

    let raw = '';
    if (value[pos] === '"') {
      pos += 1;
      while (pos < value.length && value[pos] !== '"') {
        if (value[pos] === '\\' && pos + 1 < value.length) {
          pos += 1;
        }
        raw += value[pos];
        pos += 1;
      }
      pos += 1;
    } else {
      const end = value.indexOf(';', pos);
      raw = value.slice(pos, end < 0 ? value.length : end).trim();
      pos = end < 0 ? value.length : end;
    }

    if (key === 'name') {
      result.name = raw;
    } else if (key === 'filename') {
      result.filename = raw.replace(/%22/g, '"').replace(/%0D/gi, '\r').replace(/%0A/gi, '\n');
    } else if (key === 'filename*') {
      extended = raw;
    }
    pos = value.indexOf(';', pos);
  }

  if (extended !== undefined) {
    const decoded = decodeExtended(extended);
    if (decoded !== undefined) {
      result.filename = decoded;
    }
  }
  return result;
}

function decodeExtended(value: string): string | undefined {
  const match = /^utf-8'[^']*'(.*)$/i.exec(value);
  if (match === null) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1] ?? '');
  } catch {
    return undefined;
  }
}
