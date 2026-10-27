import sanitizeHtml from 'sanitize-html';
import { ATTACHMENT_TYPES, attachmentPath } from '../shared/attachments.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = new Set(Object.values(ATTACHMENT_TYPES).map((t) => t.kind));

/** True only for a URL pointing at an attachment of *this* document, matching its declared id. */
function isOwnAttachment(url: string | undefined, id: string | undefined, documentId: string | undefined, inline: boolean) {
  if (!documentId || !id || !url || !UUID.test(id)) return false;
  return url === attachmentPath(documentId, id, inline);
}

/**
 * Document content is stored as HTML and rendered to other users, so every
 * write passes through this allowlist. It mirrors what the editor can produce:
 * anything outside it (scripts, event handlers, styles, tables) is dropped.
 *
 * Embedded files (images, audio players, file chips) are allowed only when they
 * point at this document's own attachments. That keeps out tracking pixels and
 * hotlinked images from other sites, `data:` URIs, and references to another
 * document's files. Access to the file itself is still checked on every
 * download, so an embed never grants access on its own.
 */
function optionsFor(documentId: string | undefined): sanitizeHtml.IOptions {
  return {
    allowedTags: [
      'p', 'h1', 'h2', 'h3', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li',
      'blockquote', 'pre', 'code', 'br', 'hr', 'a', 'img', 'audio',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel', 'data-attachment-id', 'data-file-name', 'data-file-size', 'data-file-kind'],
      ol: ['start'],
      img: ['src', 'alt', 'data-attachment-id'],
      audio: ['src', 'controls', 'data-attachment-id', 'data-file-name'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    // Media may only use same-site relative URLs; exclusiveFilter narrows that to this document's files.
    allowedSchemesByTag: { img: [], audio: [] },
    allowProtocolRelative: false,
    transformTags: {
      b: 'strong',
      i: 'em',
      strike: 's',
      del: 's',
      ins: 'u',
      h4: 'h3',
      h5: 'h3',
      h6: 'h3',
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
    },
    exclusiveFilter: (frame) => {
      const a = frame.attribs;
      if (frame.tag === 'img' || frame.tag === 'audio') {
        return !isOwnAttachment(a.src, a['data-attachment-id'], documentId, true);
      }
      if (frame.tag === 'a' && a['data-attachment-id'] !== undefined) {
        const valid =
          isOwnAttachment(a.href, a['data-attachment-id'], documentId, false) &&
          /^\d{1,12}$/.test(a['data-file-size'] ?? '') &&
          KINDS.has((a['data-file-kind'] ?? '') as never);
        return !valid;
      }
      return false;
    },
    // Drop these elements together with their text content.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head', 'template'],
  };
}

/**
 * Cleans HTML for storage. Pass the document's id to keep embeds of its own
 * attachments; without it, every embed is removed.
 */
export function sanitizeContent(html: string, documentId?: string): string {
  const clean = sanitizeHtml(html, optionsFor(documentId)).trim();
  return clean === '' ? '<p></p>' : clean;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
