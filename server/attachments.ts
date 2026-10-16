import path from 'node:path';
export interface ExtractRequest { filename?: string; mime?: string; content_base64: string }
export interface ExtractResponse { text: string; kind: 'pdf' | 'text'; filename: string }
export function decodeAttachment(raw: string): Buffer {
  const payload = String(raw || '').trim().replace(/^data:[^,]*,/, '').trim();
  if (payload.length > 11_184_820) throw new Error('Attachment is too large to extract (max 8 MB)');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) throw new Error('Invalid base64 attachment payload');
  const buffer = Buffer.from(payload, 'base64'); if (buffer.length > 8 * 1024 * 1024) throw new Error('Attachment is too large to extract (max 8 MB)'); return buffer;
}
export function normalizeExtractedText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\0/g, '').trim();
  return normalized.length > 500_000 ? `${normalized.slice(0, 500_000)}\n[Text truncated]` : normalized;
}
export async function extractAttachment(request: ExtractRequest): Promise<ExtractResponse> {
  const filename = request.filename?.trim() || 'attachment'; const mime = request.mime?.trim().toLowerCase() || '';
  if (filename.length > 255 || mime.length > 255) throw new Error('Attachment metadata is too long (max 255 characters)');
  const bytes = decodeAttachment(request.content_base64);
  if (mime.includes('pdf') || filename.toLowerCase().endsWith('.pdf')) {
    const pdf = await import('pdf-parse'); const parser = new pdf.PDFParse({ data: new Uint8Array(bytes) });
    try { const result = await parser.getText(); return { filename, kind: 'pdf', text: normalizeExtractedText(result.text) }; } finally { await parser.destroy(); }
  }
  if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mime) || /\.(txt|md|markdown|csv|tsv|jsonl?|xml|html?|css|[cm]?js|tsx?|jsx|py|rs|go|java|[ch](pp)?|ya?ml|toml|ini|log|sql|sh|bat|ps1)$/i.test(filename)) {
    let text: string; try { text = new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { throw new Error('File is not valid UTF-8 text'); }
    return { filename, kind: 'text', text: normalizeExtractedText(text) };
  }
  throw new Error('Unsupported file type for text extraction. Enable OCR for images, or attach a PDF/text file.');
}
