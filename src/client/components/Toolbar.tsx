import { useRef, type ChangeEvent, type ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { ATTACHMENT_ACCEPT, IMAGE_ACCEPT } from '../../shared/attachments';
import {
  Bold,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Paperclip,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

type BlockStyle = 'p' | 'h1' | 'h2' | 'h3';

function ToolButton(props: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const title = props.shortcut ? `${props.label} (${props.shortcut})` : props.label;
  return (
    <button
      type="button"
      className={`tool-btn${props.active ? ' is-active' : ''}`}
      title={title}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      // Keep focus (and the selection) in the editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function Toolbar({
  editor,
  disabled,
  onInsertFiles,
}: {
  editor: Editor;
  disabled: boolean;
  /** Places picked files at the cursor (images inline, audio as a player, others as file chips). */
  onInsertFiles?: (files: File[]) => void;
}) {
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length) onInsertFiles?.(files);
  };

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: (e.isActive('heading', { level: 1 })
        ? 'h1'
        : e.isActive('heading', { level: 2 })
          ? 'h2'
          : e.isActive('heading', { level: 3 })
            ? 'h3'
            : 'p') as BlockStyle,
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const chain = () => editor.chain().focus();
  const setBlock = (value: BlockStyle) => {
    if (value === 'p') chain().setParagraph().run();
    else chain().setHeading({ level: Number(value[1]) as 1 | 2 | 3 }).run();
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <ToolButton label="Undo" shortcut={`${mod}Z`} disabled={disabled || !s.canUndo} onClick={() => chain().undo().run()}>
        <Undo2 size={17} />
      </ToolButton>
      <ToolButton label="Redo" shortcut={isMac ? '⇧⌘Z' : 'Ctrl+Y'} disabled={disabled || !s.canRedo} onClick={() => chain().redo().run()}>
        <Redo2 size={17} />
      </ToolButton>
      <span className="tool-sep" />
      <select
        className="block-select"
        aria-label="Text style"
        value={s.block}
        disabled={disabled}
        onChange={(e) => setBlock(e.target.value as BlockStyle)}
      >
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <span className="tool-sep" />
      <ToolButton label="Bold" shortcut={`${mod}B`} active={s.bold} disabled={disabled} onClick={() => chain().toggleBold().run()}>
        <Bold size={17} />
      </ToolButton>
      <ToolButton label="Italic" shortcut={`${mod}I`} active={s.italic} disabled={disabled} onClick={() => chain().toggleItalic().run()}>
        <Italic size={17} />
      </ToolButton>
      <ToolButton label="Underline" shortcut={`${mod}U`} active={s.underline} disabled={disabled} onClick={() => chain().toggleUnderline().run()}>
        <Underline size={17} />
      </ToolButton>
      <ToolButton label="Strikethrough" active={s.strike} disabled={disabled} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough size={17} />
      </ToolButton>
      <span className="tool-sep" />
      <ToolButton label="Bulleted list" active={s.bullet} disabled={disabled} onClick={() => chain().toggleBulletList().run()}>
        <List size={17} />
      </ToolButton>
      <ToolButton label="Numbered list" active={s.ordered} disabled={disabled} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={17} />
      </ToolButton>
      <ToolButton label="Quote" active={s.quote} disabled={disabled} onClick={() => chain().toggleBlockquote().run()}>
        <Quote size={17} />
      </ToolButton>
      <span className="tool-sep" />
      <ToolButton
        label="Clear formatting"
        disabled={disabled}
        onClick={() => chain().unsetAllMarks().clearNodes().run()}
      >
        <RemoveFormatting size={17} />
      </ToolButton>
      {onInsertFiles && (
        <>
          <span className="tool-sep" />
          <ToolButton label="Insert image" disabled={disabled} onClick={() => imageInput.current?.click()}>
            <ImagePlus size={17} />
          </ToolButton>
          <ToolButton label="Insert file (PDF, Office, audio, video, ZIP…)" disabled={disabled} onClick={() => fileInput.current?.click()}>
            <Paperclip size={17} />
          </ToolButton>
          <input ref={imageInput} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={pick} />
          <input ref={fileInput} type="file" accept={ATTACHMENT_ACCEPT} multiple hidden onChange={pick} />
        </>
      )}
    </div>
  );
}
