import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import { HttpError, forbidden, notFound } from './errors.js';
import { RateLimiter } from './rateLimit.js';
import { cleanFilename, contentMatchesExtension, originalName, singleFileUpload } from './uploads.js';
import {
  ATTACHMENT_TYPES_LABEL,
  INLINE_MIME_TYPES,
  MAX_ATTACHMENTS_PER_DOCUMENT,
  MAX_ATTACHMENT_BYTES,
  attachmentTypeOf,
  extensionOf,
} from '../shared/attachments.js';
import type { DocumentDetail } from '../shared/types.js';

/** Builds an RFC 6266 Content-Disposition header that survives non-ASCII names. */
function contentDisposition(type: 'attachment' | 'inline', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Parses a single-range `Range: bytes=…` header (what media players send).
 * Returns null for no/unsupported ranges (send the whole file) and 'invalid'
 * for ranges outside the file.
 */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    // "bytes=-500": the last 500 bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

/**
 * Applies the attachment rules to a file: allowed type, not empty, contents
 * match the extension. Returns the Content-Type to store, or throws an
 * HttpError explaining what's wrong.
 */
export function checkAttachmentFile(filename: string, data: Uint8Array): string {
  const type = attachmentTypeOf(filename);
  if (!type) {
    const ext = extensionOf(filename);
    throw new HttpError(
      415,
      'unsupported_file_type',
      `${ext ? `“${ext}” files` : 'Files without an extension'} can’t be attached. Allowed: ${ATTACHMENT_TYPES_LABEL}.`,
    );
  }
  if (data.byteLength === 0) throw new HttpError(400, 'empty_file', `“${filename}” is empty.`);
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(413, 'file_too_large', `That file is larger than the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit.`);
  }
  if (!contentMatchesExtension(filename, data)) {
    throw new HttpError(
      422,
      'content_mismatch',
      `“${filename}” doesn’t look like a real ${extensionOf(filename)} file, so it wasn’t attached.`,
    );
  }
  return type.mime;
}

export function saveAttachment(store: Store, documentId: string, userId: string, filename: string, mimeType: string, data: Buffer) {
  return store.createAttachment({
    documentId,
    uploadedBy: userId,
    filename,
    mimeType,
    sha256: createHash('sha256').update(data).digest('hex'),
    data,
  });
}

/**
 * Files attached to a document. Access follows the document's own sharing:
 * anyone who can open the document can list and download its attachments;
 * owners and editors can add and remove them. Mounted at /api/documents/:id/attachments.
 */
export function attachmentsRouter(store: Store) {
  const router = Router({ mergeParams: true });
  const limiter = new RateLimiter();

  const load = (req: Request): DocumentDetail => {
    const doc = store.getDocument(String(req.params.id), req.user!.id);
    if (!doc) throw notFound();
    return doc;
  };

  /** Checks permission before the upload body is read, so a viewer's 10 MB isn't buffered for nothing. */
  const requireEditor = (req: Request, _res: Response, next: NextFunction) => {
    const doc = load(req);
    if (doc.role === 'viewer') throw forbidden('You have view-only access, so you can’t change attachments.');
    next();
  };

  router.get('/', (req, res) => {
    const doc = load(req);
    res.json({ attachments: store.listAttachments(doc.id) });
  });

  router.post(
    '/',
    requireEditor,
    (req, _res, next) => {
      limiter.hit(`upload:${req.user!.id}`, 60, 10 * 60_000);
      next();
    },
    singleFileUpload('file', MAX_ATTACHMENT_BYTES),
    (req, res) => {
      const doc = load(req);
      if (!req.file) throw new HttpError(400, 'missing_file', 'Choose a file to attach.');

      const filename = cleanFilename(originalName(req.file));
      const mimeType = checkAttachmentFile(filename, req.file.buffer);
      if (store.countAttachments(doc.id) >= MAX_ATTACHMENTS_PER_DOCUMENT) {
        throw new HttpError(
          409,
          'too_many_attachments',
          `A document can have up to ${MAX_ATTACHMENTS_PER_DOCUMENT} attachments. Remove one to add another.`,
        );
      }
      const attachment = saveAttachment(store, doc.id, req.user!.id, filename, mimeType, req.file.buffer);
      res.status(201).json({ attachment });
    },
  );

  router.get('/:attachmentId', (req, res) => {
    const doc = load(req);
    const meta = store.getAttachment(doc.id, String(req.params.attachmentId));
    if (!meta) throw notFound('Attachment');

    const etag = `"${meta.sha256}"`;
    // Revalidate every time (no-cache) so revoking someone's access takes effect
    // immediately, but skip re-sending bytes that haven't changed.
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    const data = store.getAttachmentData(meta.id);
    if (!data) throw notFound('Attachment');
    const inline = req.query.inline === '1' && INLINE_MIME_TYPES.has(meta.mimeType);
    res.setHeader('Content-Type', meta.mimeType);
    res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', meta.filename));
    res.setHeader('Accept-Ranges', 'bytes');
    // Even if a browser did render the file, it gets no script, no network, no same-origin access.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");

    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const range = parseRange(req.headers.range, bytes.length);
    if (range === 'invalid') {
      res.status(416).setHeader('Content-Range', `bytes */${bytes.length}`).end();
      return;
    }
    if (range) {
      // Partial content lets audio players seek without downloading everything first.
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      res.end(bytes.subarray(range.start, range.end + 1));
      return;
    }
    res.setHeader('Content-Length', String(bytes.length));
    res.end(bytes);
  });

  router.delete('/:attachmentId', (req, res) => {
    const doc = load(req);
    if (doc.role === 'viewer') throw forbidden('You have view-only access, so you can’t change attachments.');
    if (!store.deleteAttachment(doc.id, String(req.params.attachmentId))) throw notFound('Attachment');
    res.status(204).end();
  });

  return router;
}
