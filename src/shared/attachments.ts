// Attachment rules shared by the server (enforcement) and the client (instant feedback, icons).

export type AttachmentKind = 'pdf' | 'doc' | 'sheet' | 'slides' | 'text' | 'image' | 'audio' | 'video' | 'archive';

/** How a file appears when placed in the document text. */
export type EmbedStyle = 'image' | 'audio' | 'chip';

/**
 * Images and audio play inline. Video is a downloadable chip for now: at the
 * 4 MB limit a video is only a few seconds long, and large media belongs in
 * object storage rather than the database.
 */
export function embedStyleOf(kind: AttachmentKind): EmbedStyle {
  return kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : 'chip';
}

interface TypeInfo {
  /** The Content-Type we serve it with. Never taken from the uploader. */
  mime: string;
  kind: AttachmentKind;
}

/**
 * Allowed attachment types, by extension. An allowlist (rather than "anything
 * goes") keeps executables and HTML/SVG, which could run script, out of shared
 * documents.
 */
export const ATTACHMENT_TYPES: Record<string, TypeInfo> = {
  '.pdf': { mime: 'application/pdf', kind: 'pdf' },
  '.doc': { mime: 'application/msword', kind: 'doc' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'doc' },
  '.odt': { mime: 'application/vnd.oasis.opendocument.text', kind: 'doc' },
  '.rtf': { mime: 'application/rtf', kind: 'doc' },
  '.xls': { mime: 'application/vnd.ms-excel', kind: 'sheet' },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'sheet' },
  '.ods': { mime: 'application/vnd.oasis.opendocument.spreadsheet', kind: 'sheet' },
  '.csv': { mime: 'text/csv; charset=utf-8', kind: 'sheet' },
  '.ppt': { mime: 'application/vnd.ms-powerpoint', kind: 'slides' },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'slides' },
  '.odp': { mime: 'application/vnd.oasis.opendocument.presentation', kind: 'slides' },
  '.txt': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.md': { mime: 'text/markdown; charset=utf-8', kind: 'text' },
  '.markdown': { mime: 'text/markdown; charset=utf-8', kind: 'text' },
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
  '.m4a': { mime: 'audio/mp4', kind: 'audio' },
  '.wav': { mime: 'audio/wav', kind: 'audio' },
  '.ogg': { mime: 'audio/ogg', kind: 'audio' },
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.webm': { mime: 'video/webm', kind: 'video' },
  '.mov': { mime: 'video/quicktime', kind: 'video' },
  '.zip': { mime: 'application/zip', kind: 'archive' },
};

export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES).join(',');
export const IMAGE_ACCEPT = Object.keys(ATTACHMENT_TYPES)
  .filter((ext) => ATTACHMENT_TYPES[ext]!.kind === 'image')
  .join(',');
export const ATTACHMENT_TYPES_LABEL =
  'PDF, Word, Excel, PowerPoint, OpenDocument, text, Markdown, CSV, images (PNG, JPG, GIF, WebP), audio (MP3, M4A, WAV, OGG), video (MP4, WebM, MOV) and ZIP';

/** Content types the server may send inline (shown/played in the page). Everything else is download-only. */
export const INLINE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
]);

/** The URL an attachment is served from. Embedded images/audio use the inline form. */
export function attachmentPath(documentId: string, attachmentId: string, inline = false): string {
  return `/api/documents/${documentId}/attachments/${attachmentId}${inline ? '?inline=1' : ''}`;
}
// 4 MB keeps an upload (or download) under the 4.5 MB request limit of serverless hosts like Vercel.
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_DOCUMENT = 20;
export const MAX_FILENAME_LENGTH = 200;

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot).toLowerCase() : '';
}

export function attachmentTypeOf(filename: string): TypeInfo | undefined {
  return ATTACHMENT_TYPES[extensionOf(filename)];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
