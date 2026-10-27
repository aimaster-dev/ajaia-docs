import { extname, basename } from 'node:path';
import { marked } from 'marked';
import mammoth from 'mammoth';
import { HttpError } from './errors.js';
import { escapeHtml } from './sanitize.js';
import { IMPORT_EXTENSIONS, MAX_TITLE_LENGTH } from '../shared/types.js';

export interface ImportedImage {
  data: Buffer;
  contentType: string;
}

export interface ImportedDocument {
  title: string;
  /**
   * Unsanitized HTML. Images found in the file appear as
   * `<img src="ajaia-image:N">` placeholders, where N indexes `images`; the
   * caller stores them as attachments and swaps in real URLs (or drops them)
   * before sanitizing.
   */
  html: string;
  images: ImportedImage[];
}

export const IMAGE_PLACEHOLDER = 'ajaia-image:';

const SUPPORTED = new Set<string>(IMPORT_EXTENSIONS);

/** Plain text: blank lines separate paragraphs, single newlines become line breaks. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((para) => para.replace(/^\n+|\n+$/g, ''))
    .filter((para) => para.trim() !== '')
    .map((para) => `<p>${para.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('');
}

function decodeText(buffer: Buffer): string {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  // A NUL byte almost always means a binary file renamed to .txt/.md.
  if (text.includes('\u0000')) {
    throw new HttpError(422, 'unreadable_file', 'This file does not look like plain text.');
  }
  return text;
}

function titleFromFilename(filename: string): string {
  const title = basename(filename, extname(filename)).replace(/[_]+/g, ' ').trim();
  return (title || 'Imported document').slice(0, MAX_TITLE_LENGTH);
}

/**
 * Turns an uploaded file into the content of a new document. The caller must
 * sanitize `html` (after resolving image placeholders), so imported HTML
 * follows the same rules as typed content.
 */
export async function convertUpload(filename: string, buffer: Buffer): Promise<ImportedDocument> {
  const ext = extname(filename).toLowerCase();
  if (!SUPPORTED.has(ext)) {
    throw new HttpError(
      415,
      'unsupported_file_type',
      `"${ext || filename}" files can't be imported. Supported types: .txt, .md and .docx.`,
    );
  }
  if (buffer.length === 0) {
    throw new HttpError(400, 'empty_file', 'That file is empty.');
  }

  const images: ImportedImage[] = [];
  let html: string;
  if (ext === '.docx') {
    try {
      const result = await mammoth.convertToHtml(
        { buffer },
        {
          // Mammoth ignores underline by default; map it so formatting survives.
          styleMap: ['u => u'],
          // Keep pictures: collect their bytes and leave a placeholder where each one sat.
          convertImage: mammoth.images.imgElement(async (image) => {
            const index = images.push({ data: await image.readAsBuffer(), contentType: image.contentType }) - 1;
            return { src: `${IMAGE_PLACEHOLDER}${index}` };
          }),
        },
      );
      html = result.value;
    } catch {
      throw new HttpError(422, 'unreadable_file', "We couldn't read that .docx file. Is it a valid Word document?");
    }
  } else if (ext === '.txt') {
    html = textToHtml(decodeText(buffer));
  } else {
    html = await marked.parse(decodeText(buffer), { gfm: true });
  }

  return { title: titleFromFilename(filename), html, images };
}

/**
 * Replaces each image placeholder with `render(index, alt)`; return '' to drop
 * that image. Anything that merely looks like a placeholder but wasn't produced
 * by the converter is removed later by the sanitizer.
 */
export function resolveImagePlaceholders(html: string, render: (index: number, alt: string) => string): string {
  // Word puts each picture in its own paragraph. A picture alone in a paragraph
  // replaces that paragraph, so no empty line is left above or below it.
  const pattern = new RegExp(`(<p>\\s*)?(<img\\b[^>]*\\bsrc="${IMAGE_PLACEHOLDER}(\\d+)"[^>]*>)(\\s*</p>)?`, 'g');
  return html.replace(pattern, (_match, open: string | undefined, tag: string, n: string, close: string | undefined) => {
    const alt = /\balt="([^"]*)"/.exec(tag)?.[1] ?? '';
    const rendered = render(Number(n), alt);
    return open && close ? rendered : `${open ?? ''}${rendered}${close ?? ''}`;
  });
}
