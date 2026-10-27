import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  CircleX,
  Download,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Paperclip,
  Plus,
  Presentation,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_TYPES_LABEL,
  MAX_ATTACHMENTS_PER_DOCUMENT,
  MAX_ATTACHMENT_BYTES,
  embedStyleOf,
  formatBytes,
  type AttachmentKind,
} from '../../shared/attachments';
import type { Attachment, DocumentDetail } from '../../shared/types';
import { api, ApiError, attachmentUrl, uploadAttachment } from '../lib/api';
import { precheckAttachment } from '../editor/inlineUploads';
import { timeAgo } from '../lib/format';
import { useToast } from './Toasts';

interface UploadItem {
  key: string;
  file: File;
  progress: number;
  status: 'queued' | 'uploading' | 'error';
  error?: string;
  abort?: () => void;
}

const KIND_ICON: Record<AttachmentKind, typeof FileText> = {
  pdf: FileType,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  text: FileText,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
};

const LIMIT_MB = MAX_ATTACHMENT_BYTES / (1024 * 1024);
const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
const INSERT_LABEL = { image: 'Insert image', audio: 'Insert player', chip: 'Insert link' } as const;

interface Props {
  doc: DocumentDetail;
  /** Every attachment of the document (null while loading). Owned by the editor page. */
  items: Attachment[] | null;
  loadError: string | null;
  onReload: () => void;
  onAdded: (a: Attachment) => void;
  onRemoved: (id: string) => void;
  /** Attachments that currently appear somewhere in the document text. */
  usedIds: ReadonlySet<string>;
  /** Places an attachment at the cursor. Only given to people who can edit. */
  onInsert?: (a: Attachment) => void;
}

/**
 * The index of every file in a document. Files placed in the text are marked
 * "In text"; others can be inserted at the cursor. Everyone with access can
 * download; owners and editors can add (button or drag and drop, several at
 * once, with progress) and remove.
 */
export function AttachmentsPanel({ doc, items, loadError, onReload, onAdded, onRemoved, usedIds, onInsert }: Props) {
  const canEdit = doc.role !== 'viewer';
  const notify = useToast();
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const cancelled = useRef(new Set<string>());
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const busy = uploads.some((u) => u.status !== 'error');

  // Don't let people close the tab mid-upload without a warning.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const patch = (key: string, change: Partial<UploadItem>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));
  const drop = (key: string) => setUploads((list) => list.filter((u) => u.key !== key));

  const run = async (item: UploadItem) => {
    if (cancelled.current.delete(item.key)) return; // cancelled while waiting
    const { done, abort } = uploadAttachment(doc.id, item.file, (progress) => patch(item.key, { progress }));
    patch(item.key, { status: 'uploading', abort });
    try {
      onAdded(await done);
      drop(item.key);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'aborted') drop(item.key);
      else patch(item.key, { status: 'error', error: err.message, abort: undefined });
    }
  };

  const addFiles = (files: File[]) => {
    if (!canEdit || files.length === 0) return;
    let room = MAX_ATTACHMENTS_PER_DOCUMENT - (items?.length ?? 0) - uploads.filter((u) => u.status !== 'error').length;
    const added: UploadItem[] = files.map((file, i) => {
      let error = precheckAttachment(file);
      if (!error && room <= 0) error = `this document already has the maximum of ${MAX_ATTACHMENTS_PER_DOCUMENT} attachments`;
      if (!error) room--;
      return {
        key: `${Date.now()}-${i}-${file.name}`,
        file,
        progress: 0,
        status: error ? 'error' : 'queued',
        error: error && `${error[0]!.toUpperCase()}${error.slice(1)}.`,
      };
    });
    setUploads((list) => [...list, ...added]);
    // One at a time keeps memory use flat and progress easy to follow.
    for (const item of added.filter((a) => a.status === 'queued')) {
      queue.current = queue.current.then(() => run(item));
    }
  };

  const cancel = (u: UploadItem) => {
    if (u.status === 'uploading') u.abort?.();
    else {
      if (u.status === 'queued') cancelled.current.add(u.key);
      drop(u.key);
    }
  };

  const remove = async (a: Attachment) => {
    const inText = usedIds.has(a.id) ? ' It’s used in the document text, which will show “removed” in its place.' : '';
    if (!window.confirm(`Remove “${a.filename}”? People with access won’t be able to download it any more.${inText}`)) return;
    try {
      await api.deleteAttachment(doc.id, a.id);
      onRemoved(a.id);
      notify(`Removed “${a.filename}”`);
    } catch (e) {
      notify((e as ApiError).message, 'error');
      onReload();
    }
  };

  const dragProps = canEdit
    ? {
        onDragOver: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
          addFiles([...e.dataTransfer.files]);
        },
      }
    : {};

  const empty = items?.length === 0 && uploads.length === 0;

  return (
    <section id="attachments" className={`attachments${dragging ? ' is-dragging' : ''}`} aria-labelledby="attachments-title" {...dragProps}>
      <div className="attachments-head">
        <h2 id="attachments-title">
          <Paperclip size={16} /> Attachments {items && items.length > 0 && <span className="count">{items.length}</span>}
        </h2>
        {canEdit && (
          <button className="btn btn-sm" onClick={() => input.current?.click()}>
            <Upload size={14} /> Add files
          </button>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={ATTACHMENT_ACCEPT}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            addFiles(files);
          }}
        />
      </div>

      {loadError && (
        <p className="form-error">
          {loadError}{' '}
          <button className="link-btn" onClick={onReload}>
            Try again
          </button>
        </p>
      )}
      {items === null && !loadError && <p className="muted">Loading attachments…</p>}

      {items?.length || uploads.length ? (
        <ul className="attachment-list">
          {items?.map((a) => (
            <AttachmentRow
              key={a.id}
              attachment={a}
              inText={usedIds.has(a.id)}
              canEdit={canEdit}
              onInsert={onInsert && (() => onInsert(a))}
              onRemove={() => remove(a)}
            />
          ))}
          {uploads.map((u) => (
            <li key={u.key} className={`attachment${u.status === 'error' ? ' has-error' : ''}`}>
              <span className="attachment-icon">{u.status === 'error' ? <CircleX size={18} /> : <Upload size={18} />}</span>
              <div className="attachment-main">
                <span className="attachment-name">{u.file.name}</span>
                {u.status === 'error' ? (
                  <span className="attachment-error" role="alert">
                    Not attached: {u.error}
                  </span>
                ) : (
                  <span className="attachment-meta">
                    <span
                      className="progress"
                      role="progressbar"
                      aria-label={`Uploading ${u.file.name}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(u.progress * 100)}
                    >
                      <span style={{ width: `${Math.max(4, u.progress * 100)}%` }} />
                    </span>
                    {u.status === 'queued' ? 'Waiting…' : `${Math.round(u.progress * 100)}% of ${formatBytes(u.file.size)}`}
                  </span>
                )}
              </div>
              <button
                className="icon-btn"
                onClick={() => cancel(u)}
                title={u.status === 'error' ? 'Dismiss' : 'Cancel upload'}
                aria-label={u.status === 'error' ? `Dismiss ${u.file.name}` : `Cancel uploading ${u.file.name}`}
              >
                <X size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {empty && (
        <p className="attachments-empty">
          {canEdit
            ? 'No files yet. To place a file in the text, paste or drop it there, or use the image and paperclip buttons in the toolbar. To just attach it, drop it here or use “Add files”.'
            : 'No files attached.'}
        </p>
      )}
      {canEdit && (
        <p className="attachments-hint">
          {ATTACHMENT_TYPES_LABEL}. Up to {LIMIT_MB} MB each, {MAX_ATTACHMENTS_PER_DOCUMENT} per document.
        </p>
      )}
      {dragging && (
        <div className="attachments-drop" aria-hidden="true">
          <Upload size={22} /> Drop to attach
        </div>
      )}
    </section>
  );
}

function AttachmentRow(props: {
  attachment: Attachment;
  inText: boolean;
  canEdit: boolean;
  onInsert?: () => void;
  onRemove: () => void;
}) {
  const { attachment: a, inText } = props;
  const Icon = KIND_ICON[a.kind] ?? FileText;
  const isImage = a.kind === 'image';
  return (
    <li className="attachment">
      {isImage ? (
        <img className="attachment-thumb" src={attachmentUrl(a, true)} alt="" loading="lazy" />
      ) : (
        <span className={`attachment-icon kind-${a.kind}`}>
          <Icon size={18} />
        </span>
      )}
      <div className="attachment-main">
        {/* Images open in a new tab for a full-size look; everything else downloads. */}
        <a
          className="attachment-name"
          href={attachmentUrl(a, isImage)}
          {...(isImage ? { target: '_blank', rel: 'noopener noreferrer' } : { download: a.filename })}
          title={a.filename}
        >
          {a.filename}
        </a>
        <span className="attachment-meta">
          {formatBytes(a.size)} · {a.uploadedBy?.name ?? 'Former member'} · {timeAgo(a.createdAt)}
          {inText && <span className="badge badge-intext">In text</span>}
        </span>
      </div>
      {props.onInsert && !inText && (
        <button className="btn btn-sm btn-ghost" onClick={props.onInsert} title="Place it at the cursor in the document">
          <Plus size={14} /> {INSERT_LABEL[embedStyleOf(a.kind)]}
        </button>
      )}
      <a className="icon-btn" href={attachmentUrl(a)} download={a.filename} title="Download" aria-label={`Download ${a.filename}`}>
        <Download size={16} />
      </a>
      {props.canEdit && (
        <button className="icon-btn attachment-remove" onClick={props.onRemove} title="Remove" aria-label={`Remove ${a.filename}`}>
          <Trash2 size={16} />
        </button>
      )}
    </li>
  );
}
