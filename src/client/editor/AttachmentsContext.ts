import { createContext, useContext } from 'react';
import type { Attachment } from '../../shared/types';

export interface AttachmentsContextValue {
  documentId: string;
  /** null while loading; afterwards, every attachment the document still has. */
  byId: ReadonlyMap<string, Attachment> | null;
}

/**
 * Lets embedded images, audio players and file chips (rendered inside the
 * editor) know whether their file still exists, so a removed file shows as
 * "removed" instead of a broken image.
 */
export const AttachmentsContext = createContext<AttachmentsContextValue>({ documentId: '', byId: null });

export const useAttachments = () => useContext(AttachmentsContext);
