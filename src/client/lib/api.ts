import type {
  ApiErrorBody,
  Attachment,
  AuthConfig,
  DocumentDetail,
  DocumentListResponse,
  SharesResponse,
  ShareRole,
  User,
} from '../../shared/types';
import { attachmentPath } from '../../shared/attachments';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ApiErrorBody['error']['details'],
  ) {
    super(message);
  }

  /** Network failures and server errors are worth retrying; 4xx responses are not. */
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }

  /** The form field this error is about, when the server says so. */
  get field(): string | undefined {
    return typeof this.details?.field === 'string' ? this.details.field : undefined;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('Content-Type', 'application/json');

  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers,
      credentials: 'same-origin',
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, 'network_error', "Can't reach the server. Check your connection.");
  }

  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body as ApiErrorBody | null)?.error;
    // A 401 outside the auth endpoints means the session expired or was revoked.
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status}).`, err?.details);
  }
  return body as T;
}

export const api = {
  authConfig: () => request<AuthConfig>('/api/auth/config'),
  me: () => request<{ user: User | null }>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: User }>('/api/auth/login', { method: 'POST', json: { username, password } }),
  register: (input: { name: string; username: string; password: string }) =>
    request<{ user: User }>('/api/auth/register', { method: 'POST', json: input }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/auth/password', { method: 'POST', json: { currentPassword, newPassword } }),
  searchUsers: (q: string) => request<{ users: User[] }>(`/api/users?q=${encodeURIComponent(q)}`),

  listDocuments: () => request<DocumentListResponse>('/api/documents'),
  getDocument: (id: string) => request<DocumentDetail>(`/api/documents/${id}`),
  createDocument: (title?: string) => request<DocumentDetail>('/api/documents', { method: 'POST', json: { title } }),
  renameDocument: (id: string, title: string) =>
    request<DocumentDetail>(`/api/documents/${id}`, { method: 'PATCH', json: { title } }),
  saveContent: (id: string, contentHtml: string, baseVersion: number) =>
    request<DocumentDetail>(`/api/documents/${id}`, { method: 'PATCH', json: { contentHtml, baseVersion } }),
  deleteDocument: (id: string) => request<void>(`/api/documents/${id}`, { method: 'DELETE' }),
  importFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<DocumentDetail>('/api/documents/import', { method: 'POST', body: form });
  },

  listShares: (id: string) => request<SharesResponse>(`/api/documents/${id}/shares`),
  share: (id: string, username: string, role: ShareRole) =>
    request<SharesResponse>(`/api/documents/${id}/shares`, { method: 'PUT', json: { username, role } }),
  unshare: (id: string, userId: string) =>
    request<void>(`/api/documents/${id}/shares/${userId}`, { method: 'DELETE' }),

  listAttachments: (docId: string) => request<{ attachments: Attachment[] }>(`/api/documents/${docId}/attachments`),
  deleteAttachment: (docId: string, attachmentId: string) =>
    request<void>(`/api/documents/${docId}/attachments/${attachmentId}`, { method: 'DELETE' }),
};

/** Download URL (the session cookie authorizes it). `inline` previews images in the browser. */
export function attachmentUrl(a: Pick<Attachment, 'documentId' | 'id'>, inline = false): string {
  return attachmentPath(a.documentId, a.id, inline);
}

/**
 * Uploads one attachment with progress reporting. Uses XMLHttpRequest because
 * fetch can't report upload progress.
 */
export function uploadAttachment(
  docId: string,
  file: File,
  onProgress: (fraction: number) => void,
): { done: Promise<Attachment>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<Attachment>((resolve, reject) => {
    xhr.open('POST', `/api/documents/${docId}/attachments`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response as { attachment?: Attachment } & Partial<ApiErrorBody>;
      if (xhr.status >= 200 && xhr.status < 300 && body?.attachment) return resolve(body.attachment);
      if (xhr.status === 401) onUnauthorized();
      const err = body?.error;
      reject(new ApiError(xhr.status, err?.code ?? 'http_error', err?.message ?? `Upload failed (${xhr.status}).`, err?.details));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', "Couldn't upload: can't reach the server."));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled.'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
  return { done, abort: () => xhr.abort() };
}
