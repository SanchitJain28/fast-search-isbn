import Busboy from 'busboy';
import { CoverLookupError } from './errors.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 16 * 1024;
const types = {
  'image/jpeg': bytes => bytes.length > 4 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) && bytes.readUInt16BE(bytes.length - 2) === 0xffd9,
  'image/png': bytes => bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND',
  'image/webp': bytes => bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8
    && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)),
};

export async function readCoverImage(req, signal) {
  if (!/^multipart\/form-data\s*;/i.test(req.headers['content-type'] || '')) {
    throw new CoverLookupError(415, 'Send the image as multipart form data.');
  }
  if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) throw new CoverLookupError(413, 'Image exceeds the 5 MiB upload limit.');
  signal.throwIfAborted();
  let parser;
  try {
    parser = Busboy({ headers: req.headers, limits: { files: 1, fields: 0, parts: 2, fileSize: MAX_IMAGE_BYTES + 1, headerPairs: 32 } });
  } catch {
    throw new CoverLookupError(400, 'Invalid multipart upload.');
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let imageBytes = 0;
    let requestBytes = 0;
    let mimeType;
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      req.off('data', count);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      req.unpipe(parser);
      // Busboy can emit a limit event from inside its multipart parser.
      queueMicrotask(() => parser.destroy());
      req.resume();
      reject(error);
    };
    const malformed = () => fail(new CoverLookupError(400, 'Send exactly one image part named image.'));
    const tooLarge = () => fail(new CoverLookupError(413, 'Image exceeds the 5 MiB upload limit.'));
    const abort = () => fail(signal.reason);
    const count = chunk => {
      requestBytes += chunk.length;
      if (requestBytes > MAX_REQUEST_BYTES) tooLarge();
    };
    req.once('error', malformed);
    signal.addEventListener('abort', abort, { once: true });
    parser.on('error', malformed);
    for (const event of ['partsLimit', 'filesLimit', 'fieldsLimit']) parser.on(event, malformed);
    parser.on('file', (name, file, info) => {
      file.on('error', malformed);
      file.on('limit', tooLarge);
      if (name !== 'image') return malformed();
      if (!Object.hasOwn(types, info.mimeType)) return fail(new CoverLookupError(415, 'Use a JPEG, PNG, or WebP image.'));
      mimeType = info.mimeType;
      file.on('data', chunk => {
        if (settled) return;
        imageBytes += chunk.length;
        if (imageBytes > MAX_IMAGE_BYTES) tooLarge();
        else chunks.push(chunk);
      });
    });
    parser.on('close', () => {
      if (settled) return;
      if (!mimeType || !imageBytes) return malformed();
      const bytes = Buffer.concat(chunks, imageBytes);
      if (!types[mimeType](bytes)) return fail(new CoverLookupError(415, 'The file does not match its image format.'));
      settled = true;
      cleanup();
      resolve({ bytes, mimeType });
    });
    req.on('data', count);
    req.pipe(parser);
  });
}
