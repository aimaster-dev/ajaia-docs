import { Extension, type Editor } from '@tiptap/react';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  MAX_ATTACHMENTS_PER_DOCUMENT,
  MAX_ATTACHMENT_BYTES,
  attachmentTypeOf,
  embedStyleOf,
  extensionOf,
  formatBytes,
  type EmbedStyle,
} from '../../shared/attachments';
import type { Attachment } from '../../shared/types';
import { ApiError, uploadAttachment } from '../lib/api';
import { embedContent } from './embeds';

/*
 * Files pasted, dropped or inserted into the text upload in the background.
 * While they do, a placeholder marks the spot. It's a ProseMirror decoration,
 * not real content, so autosave never stores a half-finished upload, and
 * edits around it simply move it along. When the upload finishes, the real
 * embed is inserted where the placeholder ended up.
 */

interface PendingUpload {
  id: string;
  /** Files dropped or picked together share a batch and keep their order. */
  batch: string;
  pos: number;
  name: string;
  style: EmbedStyle;
}

const placeholderKey = new PluginKey<PendingUpload[]>('uploadPlaceholders');

type Action = { add: PendingUpload } | { remove: string } | { moveBatch: { batch: string; pos: number } };

/** Live placeholder elements, so progress can be updated without a transaction per tick. */
const elements = new Map<string, HTMLElement>();

function placeholderElement(id: string, name: string, style: EmbedStyle): HTMLElement {
  const el = document.createElement(style === 'chip' ? 'span' : 'div');
  el.className = `upload-placeholder upload-${style}`;
  el.contentEditable = 'false';
  const label = document.createElement('span');
  label.className = 'upload-label';
  label.textContent = `Uploading ${name}…`;
  const bar = document.createElement('span');
  bar.className = 'upload-bar';
  bar.append(document.createElement('span'));
  el.append(label, bar);
  elements.set(id, el);
  return el;
}

export const UploadPlaceholders = Extension.create({
  name: 'uploadPlaceholders',
  addProseMirrorPlugins() {
    return [
      new Plugin<PendingUpload[]>({
        key: placeholderKey,
        state: {
          init: () => [],
          apply(tr, pending) {
            // Positions are mapped by hand (rather than relying on decoration
            // mapping, which drops a widget whose spot is split or replaced, as
            // happens when an earlier upload inserts a block right there). Mapping
            // to the right keeps later files after earlier ones dropped at the same spot.
            let next = tr.docChanged ? pending.map((p) => ({ ...p, pos: tr.mapping.map(p.pos, 1) })) : pending;
            const action = tr.getMeta(placeholderKey) as Action | undefined;
            if (action && 'add' in action) next = [...next, action.add];
            if (action && 'remove' in action) {
              next = next.filter((p) => p.id !== action.remove);
              elements.delete(action.remove);
            }
            if (action && 'moveBatch' in action) {
              const { batch, pos } = action.moveBatch;
              next = next.map((p) => (p.batch === batch ? { ...p, pos } : p));
            }
            return next;
          },
        },
        props: {
          decorations: (state) =>
            DecorationSet.create(
              state.doc,
              (placeholderKey.getState(state) ?? []).map((p) =>
                Decoration.widget(p.pos, () => elements.get(p.id) ?? placeholderElement(p.id, p.name, p.style), {
                  key: p.id,
                  side: 1,
                }),
              ),
            ),
        },
      }),
    ];
  },
});

function placeholderPos(state: EditorState, id: string): number | null {
  const pending = placeholderKey.getState(state)?.find((p) => p.id === id);
  return pending ? Math.min(pending.pos, state.doc.content.size) : null;
}

/** Why a file can't be attached, before uploading it. The server checks again. */
export function precheckAttachment(file: File): string | undefined {
  if (!attachmentTypeOf(file.name)) {
    const ext = extensionOf(file.name);
    return `${ext ? `“${ext}” files` : 'files without an extension'} can’t be attached`;
  }
  if (file.size === 0) return 'the file is empty';
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `it’s ${formatBytes(file.size)}; the limit is ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`;
  }
}

export interface InlineUploadOptions {
  documentId: string;
  /** How many more attachments the document can take right now. */
  roomLeft: () => number;
  onUploaded: (attachment: Attachment) => void;
  onError: (message: string) => void;
  /** Called with +1 when an upload starts and -1 when it ends. */
  onBusyChange?: (delta: number) => void;
}

const queues = new WeakMap<Editor, Promise<void>>();
let counter = 0;

/**
 * Uploads `files` as attachments and embeds each one at `pos` (images inline,
 * audio as a player, anything else as a file chip). Files go one at a time.
 */
/** Where an embed for `attachmentId` ends, searching from `from` (to skip earlier copies of the same file). */
function embedEnd(editor: Editor, attachmentId: string, from: number): number | null {
  let end: number | null = null;
  editor.state.doc.descendants((node, p) => {
    if (end !== null) return false;
    if (p >= from && node.attrs.attachmentId === attachmentId) end = p + node.nodeSize;
    return true;
  });
  return end;
}

export function uploadFilesIntoText(editor: Editor, files: File[], pos: number, options: InlineUploadOptions) {
  let room = options.roomLeft();
  const batch = `batch-${Date.now()}-${counter++}`;
  for (const file of files) {
    const problem =
      precheckAttachment(file) ??
      (room <= 0 ? `this document already has the maximum of ${MAX_ATTACHMENTS_PER_DOCUMENT} attachments` : undefined);
    if (problem) {
      options.onError(`“${file.name}” wasn’t added: ${problem}.`);
      continue;
    }
    room--;

    const id = `upload-${Date.now()}-${counter++}`;
    const style = embedStyleOf(attachmentTypeOf(file.name)!.kind);
    editor.view.dispatch(editor.state.tr.setMeta(placeholderKey, { add: { id, batch, pos, name: file.name, style } } satisfies Action));
    options.onBusyChange?.(1);

    const run = async () => {
      const { done } = uploadAttachment(options.documentId, file, (fraction) => {
        const fill = elements.get(id)?.querySelector<HTMLElement>('.upload-bar > span');
        if (fill) fill.style.width = `${Math.max(4, fraction * 100)}%`;
      });
      try {
        const attachment = await done;
        options.onUploaded(attachment);
        if (editor.isDestroyed) return;
        const at = placeholderPos(editor.state, id);
        editor.view.dispatch(editor.state.tr.setMeta(placeholderKey, { remove: id } satisfies Action));
        if (at !== null) {
          editor.chain().insertContentAt(at, embedContent(attachment), { updateSelection: false }).run();
          // The rest of this batch goes right after this file, so files keep the order they were dropped in.
          const end = embedEnd(editor, attachment.id, Math.max(0, at - 1));
          if (end !== null) editor.view.dispatch(editor.state.tr.setMeta(placeholderKey, { moveBatch: { batch, pos: end } } satisfies Action));
        }
      } catch (err) {
        if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(placeholderKey, { remove: id } satisfies Action));
        options.onError(`“${file.name}” wasn’t added: ${(err as ApiError).message}`);
      } finally {
        options.onBusyChange?.(-1);
      }
    };
    const queue = (queues.get(editor) ?? Promise.resolve()).then(run);
    queues.set(editor, queue);
  }
}
