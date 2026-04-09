import { Router } from 'express';
import { importMetadataBatch, parseCsv } from './metadata-import';
import { logger } from '../../../services/logger';

const router = Router();

/**
 * POST /integrations/staff-metadata/import
 *
 * Import staff metadata from a JSON array or CSV.
 * Content-Type: application/json → expects { rows: MetadataImportRow[] }
 * Content-Type: text/csv → expects CSV with header: email,type,label,value,notes,isFeatured
 *
 * This endpoint is for batch imports. For ongoing ingestion (e.g. Google Forms),
 * a scheduled reader will be added later.
 */
router.post('/import', async (req, res) => {
  try {
    const contentType = req.headers['content-type'] ?? '';
    let rows;

    if (contentType.includes('text/csv')) {
      // Raw CSV body
      const csv = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      rows = parseCsv(csv);
    } else {
      // JSON body: { rows: [...] }
      rows = req.body?.rows;
      if (!Array.isArray(rows)) {
        res.status(400).json({ error: 'Body must have a "rows" array or be text/csv' });
        return;
      }
    }

    const result = await importMetadataBatch(rows);
    res.status(200).json(result);
  } catch (err) {
    logger.error({ err }, 'Metadata import endpoint failed');
    res.status(500).json({ error: 'Import failed' });
  }
});

export default router;
