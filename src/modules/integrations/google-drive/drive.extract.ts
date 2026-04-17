/**
 * drive.extract.ts — Text extraction dispatch.
 *
 * Given a TraversedFile, return an ExtractionOutcome:
 *   - { kind: 'ok', text, contentHash, extractor } for supported files
 *   - { kind: 'skip', reason } for folders, unsupported mime, oversized, or empty
 *
 * Skip reasons route to drive_scan_logs with the matching category.
 *
 * Extractors in v0:
 *   - Google Docs   → export text/plain
 *   - Google Sheets → export text/csv
 *   - Google Slides → export text/plain
 *   - application/pdf                     → pdf-parse
 *   - application/vnd.openxmlformats-officedocument.wordprocessingml.document (.docx) → mammoth
 *   - text/* (plaintext, markdown, csv, etc.) → direct download
 *
 * Anything else → skip with reason='unsupported_mime'.
 */

import crypto from 'node:crypto';
import mammoth from 'mammoth';
import { config } from '../../../config/env';
import { logger } from '../../../services/logger';
import { downloadFileBuffer, exportFileBuffer } from './drive.client';
import type { ExtractionOutcome, TraversedFile } from './drive.types';

const MIME = {
  GOOGLE_DOC: 'application/vnd.google-apps.document',
  GOOGLE_SHEET: 'application/vnd.google-apps.spreadsheet',
  GOOGLE_SLIDES: 'application/vnd.google-apps.presentation',
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

function hash(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

function ok(text: string, extractor: string): ExtractionOutcome {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: 'skip', reason: 'empty', detail: `extractor=${extractor}` };
  }
  return { kind: 'ok', text: trimmed, contentHash: hash(trimmed), extractor };
}

export async function extractText(file: TraversedFile): Promise<ExtractionOutcome> {
  if (file.isFolder) return { kind: 'skip', reason: 'folder' };

  if (file.size && file.size > config.DRIVE_MAX_FILE_SIZE_BYTES) {
    return {
      kind: 'skip',
      reason: 'too_large',
      detail: `size=${file.size} limit=${config.DRIVE_MAX_FILE_SIZE_BYTES}`,
    };
  }

  try {
    switch (file.mimeType) {
      case MIME.GOOGLE_DOC: {
        const buf = await exportFileBuffer(file.id, 'text/plain');
        return ok(buf.toString('utf-8'), 'gdoc');
      }
      case MIME.GOOGLE_SHEET: {
        const buf = await exportFileBuffer(file.id, 'text/csv');
        return ok(buf.toString('utf-8'), 'gsheet');
      }
      case MIME.GOOGLE_SLIDES: {
        const buf = await exportFileBuffer(file.id, 'text/plain');
        return ok(buf.toString('utf-8'), 'gslides');
      }
      case MIME.PDF: {
        const buf = await downloadFileBuffer(file.id);
        // Import lazily to keep pdfjs-dist off the module init path.
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(buf) });
        const parsed = await parser.getText();
        return ok(parsed.text, 'pdf');
      }
      case MIME.DOCX: {
        const buf = await downloadFileBuffer(file.id);
        const { value } = await mammoth.extractRawText({ buffer: buf });
        return ok(value, 'docx');
      }
      default: {
        if (file.mimeType.startsWith('text/')) {
          const buf = await downloadFileBuffer(file.id);
          return ok(buf.toString('utf-8'), 'plaintext');
        }
        return { kind: 'skip', reason: 'unsupported_mime', detail: file.mimeType };
      }
    }
  } catch (err) {
    logger.error(
      { err, fileId: file.id, name: file.name, mimeType: file.mimeType },
      '[drive] extraction failed',
    );
    throw err;
  }
}
