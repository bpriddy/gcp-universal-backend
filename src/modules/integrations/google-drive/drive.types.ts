/**
 * drive.types.ts — Internal types for the Drive sync module.
 */

import type { drive_v3 } from 'googleapis';

export type DriveFile = drive_v3.Schema$File;

/**
 * Minimum fields we need off every file in a traversal.
 * Kept narrow so the caller can't accidentally depend on fields that might
 * be absent in a particular query.
 */
export interface TraversedFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  /** Full breadcrumb path computed during traversal, e.g. "Acme / Q3 Launch / Status". */
  path: string;
  modifiedTime: string | null;
  modifiedByEmail: string | null;
  size: number | null;
  /** True when this file is itself a folder (children were walked). */
  isFolder: boolean;
}

export interface ExtractionResult {
  /** Extracted plain text. Empty string is a valid result — it means the file had no text. */
  text: string;
  /** md5 over the text, used for downstream dedup. */
  contentHash: string;
  /** How the extractor identified the file — 'gdoc', 'pdf', 'docx', 'plaintext', etc. */
  extractor: string;
}

export interface ExtractionSkip {
  kind: 'skip';
  reason:
    | 'folder'
    | 'unsupported_mime'
    | 'too_large'
    | 'empty'
    | 'delta_unchanged';
  detail?: string;
}

export type ExtractionOutcome = ({ kind: 'ok' } & ExtractionResult) | ExtractionSkip;

/**
 * Scope of a traversal — either an account folder (no campaign context) or
 * a campaign folder (with its parent account for logging/attribution).
 */
export interface TraversalScope {
  accountId: string | null;
  campaignId: string | null;
}
