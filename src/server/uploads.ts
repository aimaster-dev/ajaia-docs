import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { basename } from 'node:path';
import { HttpError } from './errors.js';
import { MAX_FILENAME_LENGTH, extensionOf } from '../shared/attachments.js';

/**
 * Accepts one file in the multipart field `field`, held in memory (never
 * written to disk), and turns multer's errors into clear API errors that
 * mention this route's own size limit.
 */
export function singleFileUpload(field: string, maxBytes: number): RequestHandler {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5, parts: 6 },
  }).single(field);
  const limitMb = Math.round(maxBytes / (1024 * 1024));

  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, (err?: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new HttpError(413, 'file_too_large', `That file is larger than the ${limitMb} MB limit.`));
        }
        return next(new HttpError(400, 'upload_error', 'Upload one file at a time.'));
      }
      next(err);
    });
  };
}

/** Busboy reports filenames as latin1; recover UTF-8 names like "résumé.docx". */
export function originalName(file: Express.Multer.File): string {
  const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
  return decoded.includes('�') ? file.originalname : decoded;
}

/**
 * Makes an uploaded filename safe to store and show: no directory parts
 * (so "../../x" can't mean anything), no control characters, sane length.
 */
export function cleanFilename(raw: string): string {
  const base = basename(raw.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base || base === '.' || base === '..') return 'file';
  if (base.length <= MAX_FILENAME_LENGTH) return base;
  const ext = extensionOf(base);
  return base.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

const startsWith = (buf: Uint8Array, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const ZIP = (b: Uint8Array) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]);
const OLE = (b: Uint8Array) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // legacy Office
const TEXT = (b: Uint8Array) => !b.subarray(0, 8192).includes(0);
/** MP4 / M4A / MOV all start with a size and then an "ftyp" box. */
const ISO_MEDIA = (b: Uint8Array) => startsWith(b, ascii('ftyp'), 4);

/** What the first bytes of each type must look like. */
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  '.pdf': (b) => startsWith(b, ascii('%PDF-')),
  '.png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  '.jpg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  '.jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  '.gif': (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  '.webp': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  '.zip': ZIP,
  '.docx': ZIP,
  '.xlsx': ZIP,
  '.pptx': ZIP,
  '.odt': ZIP,
  '.ods': ZIP,
  '.odp': ZIP,
  '.doc': OLE,
  '.xls': OLE,
  '.ppt': OLE,
  '.rtf': (b) => startsWith(b, ascii('{\\rtf')),
  // MP3: an ID3 tag, or straight into an MPEG audio frame (11 sync bits).
  '.mp3': (b) => startsWith(b, ascii('ID3')) || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  '.m4a': ISO_MEDIA,
  '.mp4': ISO_MEDIA,
  '.mov': ISO_MEDIA,
  '.wav': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WAVE'), 8),
  '.ogg': (b) => startsWith(b, ascii('OggS')),
  '.webm': (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]), // EBML (Matroska/WebM)
  '.txt': TEXT,
  '.md': TEXT,
  '.markdown': TEXT,
  '.csv': TEXT,
};

/**
 * True when the file's contents match its extension. Stops a program renamed
 * to "report.pdf" (or an HTML page renamed to "photo.png") from being shared
 * under a trustworthy-looking name.
 */
export function contentMatchesExtension(filename: string, data: Uint8Array): boolean {
  const check = SIGNATURES[extensionOf(filename)];
  return check ? check(data) : false;
}
