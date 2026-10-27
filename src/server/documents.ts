import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Store } from './db.js';
import { attachmentsRouter, checkAttachmentFile, saveAttachment } from './attachments.js';
import { HttpError, forbidden, notFound } from './errors.js';
import { parseBody } from './validate.js';
import { sanitizeContent } from './sanitize.js';
import { convertUpload, resolveImagePlaceholders } from './importFile.js';
import { originalName, singleFileUpload } from './uploads.js';
import { MAX_ATTACHMENTS_PER_DOCUMENT, attachmentPath } from '../shared/attachments.js';

const IMAGE_EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
import {
  MAX_CONTENT_BYTES,
  MAX_IMPORT_BYTES,
  MAX_TITLE_LENGTH,
  normalizeUsername,
  type DocumentDetail,
  type DocumentListResponse,
  type SharesResponse,
} from '../shared/types.js';

const Title = z
  .string()
  .trim()
  .max(MAX_TITLE_LENGTH, `Title must be ${MAX_TITLE_LENGTH} characters or fewer.`)
  .transform((t) => t || 'Untitled document');

const Content = z
  .string()
  .refine((html) => Buffer.byteLength(html, 'utf8') <= MAX_CONTENT_BYTES, 'Document is too large (1 MB limit).');

const CreateBody = z.object({
  title: Title.optional(),
  contentHtml: Content.optional(),
});

const UpdateBody = z
  .object({
    title: Title.optional(),
    contentHtml: Content.optional(),
    baseVersion: z.number().int().positive().optional(),
  })
  .refine((b) => b.title !== undefined || b.contentHtml !== undefined, 'Nothing to update.')
  .refine((b) => b.contentHtml === undefined || b.baseVersion !== undefined, {
    message: 'baseVersion is required when saving content.',
    path: ['baseVersion'],
  });

const ShareBody = z.object({
  username: z
    .string({ error: 'Enter a username.' })
    .transform(normalizeUsername)
    .pipe(z.string().min(1, 'Enter a username.')),
  role: z.enum(['viewer', 'editor'], { error: 'Choose “Can view” or “Can edit”.' }),
});

export function documentsRouter(store: Store) {
  const router = Router();

  /** Loads a document the signed-in user can access, or 404s (we don't reveal that it exists). */
  const load = (req: Request): DocumentDetail => {
    const doc = store.getDocument(String(req.params.id), req.user!.id);
    if (!doc) throw notFound();
    return doc;
  };

  router.get('/', (req, res) => {
    const all = store.listDocuments(req.user!.id);
    const body: DocumentListResponse = {
      owned: all.filter((d) => d.role === 'owner'),
      shared: all.filter((d) => d.role !== 'owner'),
    };
    res.json(body);
  });

  router.post('/', (req, res) => {
    const body = parseBody(CreateBody, req.body);
    const doc = store.createDocument(
      req.user!.id,
      body.title ?? 'Untitled document',
      sanitizeContent(body.contentHtml ?? ''),
    );
    res.status(201).json(doc);
  });

  router.post('/import', singleFileUpload('file', MAX_IMPORT_BYTES), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'missing_file', 'Choose a file to import.');
    const imported = await convertUpload(originalName(req.file), req.file.buffer);
    const userId = req.user!.id;

    // One transaction: the document, its images and its content appear together or not at all.
    const doc = store.transaction(() => {
      const created = store.createDocument(userId, imported.title, '<p></p>');
      // Each picture in a .docx becomes an attachment, embedded where it was.
      // Pictures we can't keep (unsupported format, too big, over the limit) are dropped.
      const ids = imported.images.map((image, i) => {
        const ext = IMAGE_EXTENSION_BY_TYPE[image.contentType];
        if (!ext || i >= MAX_ATTACHMENTS_PER_DOCUMENT) return null;
        const filename = `image-${i + 1}${ext}`;
        let mimeType: string;
        try {
          mimeType = checkAttachmentFile(filename, image.data);
        } catch (err) {
          if (err instanceof HttpError) return null; // fails the attachment rules: leave it out
          throw err;
        }
        return saveAttachment(store, created.id, userId, filename, mimeType, image.data).id;
      });
      const html = resolveImagePlaceholders(imported.html, (i, alt) => {
        const id = ids[i];
        return id ? `<img src="${attachmentPath(created.id, id, true)}" data-attachment-id="${id}" alt="${alt}">` : '';
      });
      store.replaceContent(created.id, sanitizeContent(html, created.id));
      return store.getDocument(created.id, userId)!;
    });
    res.status(201).json(doc);
  });

  router.get('/:id', (req, res) => {
    res.json(load(req));
  });

  router.patch('/:id', (req, res) => {
    const doc = load(req);
    if (doc.role === 'viewer') throw forbidden('You have view-only access to this document.');
    const body = parseBody(UpdateBody, req.body);

    // One transaction, so a rejected content save also rolls back a rename sent with it.
    const updated = store.transaction(() => {
      let next = doc;
      if (body.title !== undefined && body.title !== doc.title) {
        next = store.renameDocument(doc.id, req.user!.id, body.title);
      }
      if (body.contentHtml !== undefined) {
        // Embeds are kept only if they point at this document's own attachments.
        const html = sanitizeContent(body.contentHtml, doc.id);
        const result = store.updateContent(doc.id, req.user!.id, html, body.baseVersion!);
        if (!result.ok) {
          throw new HttpError(409, 'version_conflict', 'Someone else saved a newer version of this document.', {
            current: result.current,
          });
        }
        next = result.doc;
      }
      return next;
    });
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    const doc = load(req);
    if (doc.role !== 'owner') throw forbidden('Only the owner can delete this document.');
    store.deleteDocument(doc.id);
    res.status(204).end();
  });

  // ---- attachments (access checks live in attachments.ts) -----------------

  router.use('/:id/attachments', attachmentsRouter(store));

  // ---- sharing -----------------------------------------------------------

  const sharesOf = (doc: DocumentDetail): SharesResponse => ({ owner: doc.owner, shares: store.listShares(doc.id) });

  router.get('/:id/shares', (req, res) => {
    res.json(sharesOf(load(req)));
  });

  router.put('/:id/shares', (req, res) => {
    const doc = load(req);
    if (doc.role !== 'owner') throw forbidden('Only the owner can change who has access.');
    const { username, role } = parseBody(ShareBody, req.body);

    const target = store.getUserByUsername(username);
    if (!target) {
      throw new HttpError(404, 'user_not_found', `There's no one with the username "${username}".`, { field: 'username' });
    }
    if (target.id === doc.owner.id) {
      throw new HttpError(400, 'validation_error', 'You already own this document.', { field: 'username' });
    }
    store.upsertShare(doc.id, target.id, role);
    res.json(sharesOf(doc));
  });

  router.delete('/:id/shares/:userId', (req, res) => {
    const doc = load(req);
    const userId = String(req.params.userId);
    // Owners can revoke anyone; anyone else can only remove themselves.
    if (doc.role !== 'owner' && userId !== req.user!.id) {
      throw forbidden('Only the owner can change who has access.');
    }
    if (!store.removeShare(doc.id, userId)) throw notFound('Share');
    res.status(204).end();
  });

  return router;
}
