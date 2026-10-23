/** Text extraction for attached files: PDFs through pdf-parse, and UTF-8 text and code files. */

export interface ExtractRequest { filename?: string; mime?: string; content_base64: string }
export interface ExtractResponse { text: string; kind: 'pdf' | 'text'; filename: string }

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_CHARS = 11_184_820;
const MAX_TEXT_CHARS = 500_000;
const TEXT_TYPES = ['application/json', 'application/xml', 'application/javascript'];
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|jsonl?|xml|html?|css|[cm]?js|tsx?|jsx|py|rs|go|java|[ch](pp)?|ya?ml|toml|ini|log|sql|sh|bat|ps1)$/i;

/** Decode base64 (optionally a data: URL) into at most 8 MB. */
export function decodeAttachment(raw: string): Buffer {
  const payload = String(raw || '').trim().replace(/^data:[^,]*,/, '').trim();
  if (payload.length > MAX_BASE64_CHARS) throw new Error('Attachment is too large to extract (max 8 MB)');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) throw new Error('Invalid base64 attachment payload');
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment is too large to extract (max 8 MB)');
  return buffer;
}

/** Unix line endings, no trailing spaces or NULs, at most two blank lines in a row, and a size cap. */
export function normalizeExtractedText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n')
    .replace(/\n{4,}/g, '\n\n\n').replace(/\0/g, '').trim();
  return normalized.length > MAX_TEXT_CHARS ? `${normalized.slice(0, MAX_TEXT_CHARS)}\n[Text truncated]` : normalized;
}

export async function extractAttachment(request: ExtractRequest): Promise<ExtractResponse> {
  const filename = request.filename?.trim() || 'attachment';
  const mime = request.mime?.trim().toLowerCase() || '';
  if (filename.length > 255 || mime.length > 255) throw new Error('Attachment metadata is too long (max 255 characters)');
  const bytes = decodeAttachment(request.content_base64);
  if (mime.includes('pdf') || filename.toLowerCase().endsWith('.pdf')) {
    const pdf = await import('pdf-parse');
    const parser = new pdf.PDFParse({ data: new Uint8Array(bytes) });
    try { return { filename, kind: 'pdf', text: normalizeExtractedText((await parser.getText()).text) }; }
    finally { await parser.destroy(); }
  }
  if (mime.startsWith('text/') || TEXT_TYPES.includes(mime) || TEXT_EXTENSIONS.test(filename)) {
    let text: string;
    try { text = new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { throw new Error('File is not valid UTF-8 text'); }
    return { filename, kind: 'text', text: normalizeExtractedText(text) };
  }
  throw new Error('Unsupported file type for text extraction. Enable OCR for images, or attach a PDF/text file.');
}
