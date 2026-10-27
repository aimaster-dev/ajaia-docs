import { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NewAttachment, Store } from './db.js';
import { attachmentsRouter, checkAttachmentFile, newAttachment } from './attachments.js';
import { HttpError, forbidden, notFound } from './errors.js';
import { parseBody } from './validate.js';
import { sanitizeContent } from './sanitize.js';
import { convertUpload, resolveImagePlaceholders } from './importFile.js';
import { originalName, singleFileUpload } from './uploads.js';
import { MAX_ATTACHMENTS_PER_DOCUMENT, attachmentPath } from '../shared/attachments.js';
import {
  MAX_CONTENT_BYTES,
  MAX_IMPORT_BYTES,
  MAX_TITLE_LENGTH,
  normalizeUsername,
  type DocumentDetail,
  type DocumentListResponse,
  type SharesResponse,
} from '../shared/types.js';

const IMAGE_EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

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
  const load = async (req: Request): Promise<DocumentDetail> => {
    const doc = await store.getDocument(String(req.params.id), req.user!.id);
    if (!doc) throw notFound();
    return doc;
  };

  router.get('/', async (req, res) => {
    const all = await store.listDocuments(req.user!.id);
    const body: DocumentListResponse = {
      owned: all.filter((d) => d.role === 'owner'),
      shared: all.filter((d) => d.role !== 'owner'),
    };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const body = parseBody(CreateBody, req.body);
    const doc = await store.createDocument(
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
    const documentId = randomUUID();

    // Each picture in a .docx becomes an attachment, embedded where it was.
    // Pictures we can't keep (unsupported format, too big, over the limit) are dropped.
    const attachments: NewAttachment[] = [];
    const ids = imported.images.map((image, i) => {
      const ext = IMAGE_EXTENSION_BY_TYPE[image.contentType];
      if (!ext || attachments.length >= MAX_ATTACHMENTS_PER_DOCUMENT) return null;
      const filename = `image-${i + 1}${ext}`;
      let mimeType: string;
      try {
        mimeType = checkAttachmentFile(filename, image.data);
      } catch (err) {
        if (err instanceof HttpError) return null; // fails the attachment rules: leave it out
        throw err;
      }
      const attachment = newAttachment(documentId, userId, filename, mimeType, image.data);
      attachments.push(attachment);
      return attachment.id;
    });
    const html = resolveImagePlaceholders(imported.html, (i, alt) => {
      const id = ids[i];
      return id ? `<img src="${attachmentPath(documentId, id, true)}" data-attachment-id="${id}" alt="${alt}">` : '';
    });

    // The document and its pictures are saved in one atomic write: all of it or none of it.
    const doc = await store.createDocumentWithAttachments({
      id: documentId,
      ownerId: userId,
      title: imported.title,
      contentHtml: sanitizeContent(html, documentId),
      attachments,
    });
    res.status(201).json(doc);
  });

  router.get('/:id', async (req, res) => {
    res.json(await load(req));
  });

  router.patch('/:id', async (req, res) => {
    const doc = await load(req);
    if (doc.role === 'viewer') throw forbidden('You have view-only access to this document.');
    const body = parseBody(UpdateBody, req.body);
    const newTitle = body.title !== undefined && body.title !== doc.title ? body.title : undefined;

    if (body.contentHtml === undefined) {
      res.json(newTitle === undefined ? doc : await store.renameDocument(doc.id, req.user!.id, newTitle));
      return;
    }

    // Embeds are kept only if they point at this document's own attachments.
    const html = sanitizeContent(body.contentHtml, doc.id);
    // A rename sent with the content is applied by the same version-checked
    // write, so a rejected save doesn't half-apply.
    const result = await store.updateContent(doc.id, req.user!.id, html, body.baseVersion!, newTitle);
    if (!result.ok) {
      throw new HttpError(409, 'version_conflict', 'Someone else saved a newer version of this document.', {
        current: result.current,
      });
    }
    res.json(result.doc);
  });

  router.delete('/:id', async (req, res) => {
    const doc = await load(req);
    if (doc.role !== 'owner') throw forbidden('Only the owner can delete this document.');
    await store.deleteDocument(doc.id);
    res.status(204).end();
  });

  // ---- attachments (access checks live in attachments.ts) -----------------

  router.use('/:id/attachments', attachmentsRouter(store));

  // ---- sharing -----------------------------------------------------------

  const sharesOf = async (doc: DocumentDetail): Promise<SharesResponse> => ({
    owner: doc.owner,
    shares: await store.listShares(doc.id),
  });

  router.get('/:id/shares', async (req, res) => {
    res.json(await sharesOf(await load(req)));
  });

  router.put('/:id/shares', async (req, res) => {
    const doc = await load(req);
    if (doc.role !== 'owner') throw forbidden('Only the owner can change who has access.');
    const { username, role } = parseBody(ShareBody, req.body);

    const target = await store.getUserByUsername(username);
    if (!target) {
      throw new HttpError(404, 'user_not_found', `There's no one with the username "${username}".`, { field: 'username' });
    }
    if (target.id === doc.owner.id) {
      throw new HttpError(400, 'validation_error', 'You already own this document.', { field: 'username' });
    }
    await store.upsertShare(doc.id, target.id, role);
    res.json(await sharesOf(doc));
  });

  router.delete('/:id/shares/:userId', async (req, res) => {
    const doc = await load(req);
    const userId = String(req.params.userId);
    // Owners can revoke anyone; anyone else can only remove themselves.
    if (doc.role !== 'owner' && userId !== req.user!.id) {
      throw forbidden('Only the owner can change who has access.');
    }
    if (!(await store.removeShare(doc.id, userId))) throw notFound('Share');
    res.status(204).end();
  });

  return router;
}
