import { useState } from 'react';
import { Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  FileX,
  ImageOff,
  Music,
  Presentation,
} from 'lucide-react';
import {
  attachmentPath,
  embedStyleOf,
  formatBytes,
  type AttachmentKind,
} from '../../shared/attachments';
import type { Attachment } from '../../shared/types';
import { useAttachments } from './AttachmentsContext';

/*
 * Three ways a file can sit in the document text. Each is an "atom" (one
 * unit you can select, move, copy or delete) that points at an attachment by
 * id. The HTML they produce is exactly what the server's sanitizer accepts,
 * and they only parse references to *this* document's attachments, so pasting
 * content from another document drops its files instead of hotlinking them.
 */

interface EmbedOptions {
  documentId: string;
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

/** The attachment id if `el` points at one of this document's attachments, else null. */
function ownAttachmentId(el: HTMLElement, documentId: string, attr: 'src' | 'href', inline: boolean): string | null {
  const id = el.getAttribute('data-attachment-id');
  return id && el.getAttribute(attr) === attachmentPath(documentId, id, inline) ? id : null;
}

/** True once the attachments list has loaded and this file isn't in it. */
function useRemoved(id: string): boolean {
  const { byId } = useAttachments();
  return byId !== null && !byId.has(id);
}

// ---- image -----------------------------------------------------------------

function ImageView({ node, selected }: NodeViewProps) {
  const { documentId } = useAttachments();
  const id = node.attrs.attachmentId as string;
  const removed = useRemoved(id);
  const [broken, setBroken] = useState(false);
  return (
    <NodeViewWrapper className={`embed-image${selected ? ' is-selected' : ''}`} data-drag-handle="">
      {removed || broken ? (
        <div className="embed-missing">
          <ImageOff size={18} /> {removed ? 'Image removed' : 'Image couldn’t be loaded'}
        </div>
      ) : (
        <img
          src={attachmentPath(documentId, id, true)}
          alt={node.attrs.alt as string}
          draggable={false}
          onError={() => setBroken(true)}
        />
      )}
    </NodeViewWrapper>
  );
}

export const AttachmentImage = Node.create<EmbedOptions>({
  name: 'attachmentImage',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions: () => ({ documentId: '' }),
  addAttributes: () => ({
    attachmentId: { default: null, parseHTML: (el) => el.getAttribute('data-attachment-id'), renderHTML: () => ({}) },
    alt: { default: '', parseHTML: (el) => el.getAttribute('alt') ?? '', renderHTML: () => ({}) },
  }),
  parseHTML() {
    return [
      {
        tag: 'img[data-attachment-id]',
        getAttrs: (el) => (ownAttachmentId(el as HTMLElement, this.options.documentId, 'src', true) ? null : false),
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'img',
      {
        src: attachmentPath(this.options.documentId, node.attrs.attachmentId, true),
        alt: node.attrs.alt,
        'data-attachment-id': node.attrs.attachmentId,
      },
    ];
  },
  renderText: ({ node }) => `[image: ${node.attrs.alt || 'image'}]`,
  addNodeView: () => ReactNodeViewRenderer(ImageView),
});

// ---- audio -----------------------------------------------------------------

function AudioView({ node, selected }: NodeViewProps) {
  const { documentId } = useAttachments();
  const id = node.attrs.attachmentId as string;
  const removed = useRemoved(id);
  return (
    <NodeViewWrapper className={`embed-audio${selected ? ' is-selected' : ''}`} data-drag-handle="">
      <div className="embed-audio-name">
        <Music size={15} /> {node.attrs.name as string}
      </div>
      {removed ? (
        <div className="embed-missing">
          <FileX size={18} /> Audio file removed
        </div>
      ) : (
        <audio controls preload="metadata" src={attachmentPath(documentId, id, true)} />
      )}
    </NodeViewWrapper>
  );
}

export const AttachmentAudio = Node.create<EmbedOptions>({
  name: 'attachmentAudio',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions: () => ({ documentId: '' }),
  addAttributes: () => ({
    attachmentId: { default: null, parseHTML: (el) => el.getAttribute('data-attachment-id'), renderHTML: () => ({}) },
    name: { default: '', parseHTML: (el) => el.getAttribute('data-file-name') ?? '', renderHTML: () => ({}) },
  }),
  parseHTML() {
    return [
      {
        tag: 'audio[data-attachment-id]',
        getAttrs: (el) => (ownAttachmentId(el as HTMLElement, this.options.documentId, 'src', true) ? null : false),
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'audio',
      {
        src: attachmentPath(this.options.documentId, node.attrs.attachmentId, true),
        controls: 'true',
        'data-attachment-id': node.attrs.attachmentId,
        'data-file-name': node.attrs.name,
      },
    ];
  },
  renderText: ({ node }) => `[audio: ${node.attrs.name}]`,
  addNodeView: () =>
    // Let the player's own controls receive clicks and keys instead of the editor.
    ReactNodeViewRenderer(AudioView, { stopEvent: ({ event }) => (event.target as HTMLElement | null)?.tagName === 'AUDIO' }),
});

// ---- file chip -------------------------------------------------------------

function ChipView({ node, selected }: NodeViewProps) {
  const { documentId } = useAttachments();
  const id = node.attrs.attachmentId as string;
  const name = node.attrs.name as string;
  const removed = useRemoved(id);
  const Icon = KIND_ICON[node.attrs.kind as AttachmentKind] ?? FileText;
  return (
    <NodeViewWrapper as="span" className={`file-chip${removed ? ' is-removed' : ''}${selected ? ' is-selected' : ''}`}>
      {removed ? (
        <span title="This file was removed from the document">
          <FileX size={14} /> <s>{name}</s> <em>removed</em>
        </span>
      ) : (
        <a href={attachmentPath(documentId, id)} download={name} title={`Download ${name}`}>
          <Icon size={14} />
          <span className="file-chip-name">{name}</span>
          <span className="file-chip-size">{formatBytes(node.attrs.size as number)}</span>
        </a>
      )}
    </NodeViewWrapper>
  );
}

export const FileChip = Node.create<EmbedOptions>({
  name: 'fileChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addOptions: () => ({ documentId: '' }),
  addAttributes: () => ({
    attachmentId: { default: null, parseHTML: (el) => el.getAttribute('data-attachment-id'), renderHTML: () => ({}) },
    name: {
      default: '',
      parseHTML: (el) => el.getAttribute('data-file-name') || el.textContent || 'file',
      renderHTML: () => ({}),
    },
    size: { default: 0, parseHTML: (el) => Number(el.getAttribute('data-file-size')) || 0, renderHTML: () => ({}) },
    kind: { default: 'doc', parseHTML: (el) => el.getAttribute('data-file-kind') || 'doc', renderHTML: () => ({}) },
  }),
  parseHTML() {
    return [
      {
        tag: 'a[data-attachment-id]',
        priority: 100, // before the Link mark, which also matches <a href>
        getAttrs: (el) => (ownAttachmentId(el as HTMLElement, this.options.documentId, 'href', false) ? null : false),
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'a',
      {
        href: attachmentPath(this.options.documentId, node.attrs.attachmentId),
        'data-attachment-id': node.attrs.attachmentId,
        'data-file-name': node.attrs.name,
        'data-file-size': String(node.attrs.size),
        'data-file-kind': node.attrs.kind,
      },
      node.attrs.name,
    ];
  },
  renderText: ({ node }) => node.attrs.name,
  addNodeView: () =>
    ReactNodeViewRenderer(ChipView, {
      as: 'span',
      // A click on the chip downloads the file instead of just selecting it.
      stopEvent: ({ event }) => event.type === 'click' && !!(event.target as HTMLElement | null)?.closest('a'),
    }),
});

export const EMBED_NODE_TYPES = new Set(['attachmentImage', 'attachmentAudio', 'fileChip']);

/** Editor content that places an attachment in the text, picking the right style for its type. */
export function embedContent(a: Attachment) {
  switch (embedStyleOf(a.kind)) {
    case 'image':
      return { type: 'attachmentImage', attrs: { attachmentId: a.id, alt: a.filename } };
    case 'audio':
      return { type: 'attachmentAudio', attrs: { attachmentId: a.id, name: a.filename } };
    default:
      return { type: 'fileChip', attrs: { attachmentId: a.id, name: a.filename, size: a.size, kind: a.kind } };
  }
}

/** Ids of every attachment placed in the document, in order of appearance. */
export function embeddedAttachmentIds(doc: PMNode): string[] {
  const ids: string[] = [];
  doc.descendants((node) => {
    if (EMBED_NODE_TYPES.has(node.type.name) && node.attrs.attachmentId) ids.push(node.attrs.attachmentId as string);
  });
  return ids;
}
