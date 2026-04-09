/**
 * aem.client.ts — AEM Assets API client.
 *
 * Pass-through only — queries AEM at request time, never syncs or stores
 * AEM data locally. The only thing stored in GUB is a collection reference
 * on the campaign record.
 *
 * STATUS: SPECULATIVE — AEM may not become the asset management platform.
 * See README.md in this directory.
 */

import { config } from '../../../config/env';
import { logger } from '../../../services/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AemAsset {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  /** Direct URL to the asset (or rendition) */
  url: string;
  /** File size in bytes */
  size: number | null;
  /** Last modified timestamp */
  modifiedAt: string | null;
}

export interface AemCollectionResponse {
  collectionId: string;
  assets: AemAsset[];
  total: number;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch assets from an AEM collection.
 *
 * Stub — returns empty. Implement when AEM is adopted and API details
 * are confirmed.
 */
export async function fetchCollectionAssets(
  collectionId: string,
): Promise<AemCollectionResponse> {
  logger.debug({ collectionId }, 'AEM: fetchCollectionAssets called (stub)');

  // TODO: Implement with actual AEM Assets API:
  // const baseUrl = config.AEM_BASE_URL;
  // const res = await fetch(`${baseUrl}/api/assets/collections/${collectionId}`, {
  //   headers: { Authorization: `Bearer ${config.AEM_API_TOKEN}` },
  // });

  return {
    collectionId,
    assets: [],
    total: 0,
  };
}
