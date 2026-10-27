// Types shared by the API (server) and the React client.
import type { AttachmentKind } from './attachments.js';

export type Role = 'owner' | 'editor' | 'viewer';
export type ShareRole = Exclude<Role, 'owner'>;

/** Public profile, safe to show to collaborators. Never includes credentials. */
export interface User {
  id: string;
  username: string;
  name: string;
  color: string;
}

/** Tells the sign-in page whether to show the shared demo accounts. */
export interface AuthConfig {
  demo: { usernames: string[]; password: string } | null;
}

export interface DocumentSummary {
  id: string;
  title: string;
  role: Role;
  owner: User;
  updatedAt: string;
  updatedBy: User | null;
  sharedWithCount: number;
  attachmentCount: number;
}

export interface DocumentDetail extends DocumentSummary {
  contentHtml: string;
  version: number;
  createdAt: string;
}

export interface Share {
  user: User;
  role: ShareRole;
  createdAt: string;
}

export interface SharesResponse {
  owner: User;
  shares: Share[];
}

/** A file attached to a document. The bytes are fetched separately (see downloadUrl in the client). */
export interface Attachment {
  id: string;
  documentId: string;
  filename: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  uploadedBy: User | null;
  createdAt: string;
}

export interface DocumentListResponse {
  owned: DocumentSummary[];
  shared: DocumentSummary[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** For validation errors, `field` names the input the message is about. */
    details?: { field?: string; [key: string]: unknown };
  };
}

/** Returned with HTTP 409 when a save is based on an out-of-date version. */
export interface ConflictDetails {
  current: DocumentDetail;
}

export const IMPORT_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx'] as const;
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
export const MAX_TITLE_LENGTH = 200;
export const MAX_CONTENT_BYTES = 1024 * 1024;

// Account rules, enforced by the server and mirrored in the sign-up form.
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 32;
/** Lowercase letters, digits, dot, dash, underscore; must start and end with a letter or digit. */
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
export const USERNAME_HINT = 'Letters, numbers, dots, dashes and underscores.';
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_NAME_LENGTH = 80;

/** Usernames are case-insensitive: stored lowercase, and a leading "@" is ignored. */
export function normalizeUsername(input: string): string {
  return input.trim().replace(/^@/, '').toLowerCase();
}
