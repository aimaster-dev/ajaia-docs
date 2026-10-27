import JSZip from 'jszip';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NAMESPACES = [
  `xmlns:w="${W_NS}"`,
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');

/** Escapes text for use inside WordprocessingML. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A PNG (or other) picture placed inline, as Word does with Insert → Picture. */
export type ImageRun = { image: Buffer; extension?: 'png' | 'jpeg' | 'emf'; alt?: string };
export type Run = string | { text: string; bold?: boolean; italic?: boolean; underline?: boolean } | ImageRun;
export type Paragraph = { style?: 'Heading1' | 'Heading2'; runs: Run[] };

const CONTENT_TYPES: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', emf: 'image/x-emf' };

/**
 * Builds a minimal but valid .docx in memory, so tests and sample files
 * don't depend on binary fixtures checked into the repo.
 */
export async function makeDocx(paragraphs: Paragraph[]): Promise<Buffer> {
  const media: { name: string; relId: string; data: Buffer }[] = [];

  const runXml = (run: Run): string => {
    if (typeof run === 'object' && 'image' in run) {
      const ext = run.extension ?? 'png';
      const n = media.length + 1;
      const relId = `rIdImg${n}`;
      media.push({ name: `image${n}.${ext}`, relId, data: run.image });
      return (
        '<w:r><w:drawing><wp:inline>' +
        '<wp:extent cx="952500" cy="952500"/>' +
        `<wp:docPr id="${n}" name="Picture ${n}" descr="${esc(run.alt ?? '')}"/>` +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        `<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="Picture ${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${relId}"/></pic:blipFill><pic:spPr/></pic:pic>` +
        '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
      );
    }
    const r = typeof run === 'string' ? { text: run } : run;
    const props = [r.bold && '<w:b/>', r.italic && '<w:i/>', r.underline && '<w:u w:val="single"/>']
      .filter(Boolean)
      .join('');
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
  };

  const body = paragraphs
    .map((p) => {
      const pPr = p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : '';
      return `<w:p>${pPr}${p.runs.map(runXml).join('')}</w:p>`;
    })
    .join('');

  const extensions = [...new Set(media.map((m) => m.name.split('.').pop()!))];
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      extensions.map((e) => `<Default Extension="${e}" ContentType="${CONTENT_TYPES[e]}"/>`).join('') +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      media
        .map(
          (m) =>
            `<Relationship Id="${m.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`,
        )
        .join('') +
      '</Relationships>',
  );
  zip.file(
    'word/styles.xml',
    `${XML_HEADER}<w:styles xmlns:w="${W_NS}">` +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>' +
      '</w:styles>',
  );
  for (const m of media) zip.file(`word/media/${m.name}`, m.data);
  zip.file('word/document.xml', `${XML_HEADER}<w:document ${NAMESPACES}><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
