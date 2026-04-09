/**
 * aem.enricher.ts — Response enrichment for campaign data.
 *
 * Called by the org service when a campaign response is being built
 * and the campaign has an AEM collection reference. Merges AEM asset
 * data into the response without storing it locally.
 *
 * STATUS: SPECULATIVE — See README.md in this directory.
 */

import { fetchCollectionAssets, type AemCollectionResponse } from './aem.client';
import { logger } from '../../../services/logger';

/**
 * Enrich a campaign response with AEM assets if a collection ID is available.
 *
 * Returns the assets to merge, or null if no AEM collection is linked
 * or the fetch fails (fail-open — don't block the campaign response).
 */
export async function enrichWithAssets(
  aemCollectionId: string | null | undefined,
): Promise<AemCollectionResponse | null> {
  if (!aemCollectionId) return null;

  try {
    return await fetchCollectionAssets(aemCollectionId);
  } catch (err) {
    // Fail open — AEM being down should not block campaign data
    logger.warn({ err, aemCollectionId }, 'AEM enrichment failed — returning campaign without assets');
    return null;
  }
}
