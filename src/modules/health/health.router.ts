import { Router } from 'express';
import { healthCheck, liveness } from './health.controller';

const router = Router();

/** GET /health — readiness probe (checks DB) */
router.get('/', healthCheck);

/** GET /health/live — liveness probe (no dependencies) */
router.get('/live', liveness);

export default router;
