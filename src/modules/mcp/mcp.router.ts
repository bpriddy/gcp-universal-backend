/**
 * mcp.router.ts — Express router for the MCP endpoint
 *
 * Mounts the MCP server at POST /mcp (and GET /mcp for SSE-capable clients).
 * Every request must carry a valid GUB Bearer token — the same JWT issued by
 * /auth/google/exchange or /auth/google/broker/token.
 *
 * Auth model: delegated (the AI acts as the authenticated user).
 * Every tool call is attributed to the human whose token is on the request.
 * The audit log records the person, not the AI agent.
 *
 * Transport: StreamableHTTPServerTransport (stateless mode).
 * Each request creates a fresh transport instance connected to the shared server.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { verifyAccessToken } from '../../services/jwt.service';
import { getMcpServer } from './server';
import { logger } from '../../services/logger';

const router = Router();

// ── JWT auth for MCP ──────────────────────────────────────────────────────────

async function extractUser(req: Request): Promise<{ sub: string; email: string } | null> {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  if (!token) return null;
  try {
    return await verifyAccessToken(token);
  } catch {
    return null;
  }
}

// ── MCP endpoint ──────────────────────────────────────────────────────────────

/**
 * POST /mcp — main MCP endpoint (JSON-RPC tool calls)
 * GET  /mcp — SSE stream for clients that use server-sent events
 * DELETE /mcp — session termination (stateless: no-op but responds 200)
 */
async function handleMcp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await extractUser(req);
    if (!user) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: valid Bearer token required' },
        id: null,
      });
      return;
    }

    logger.debug(
      { method: req.method, sub: user.sub, email: user.email },
      'MCP request',
    );

    const server = getMcpServer();

    // Stateless mode: omit sessionIdGenerator entirely
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new StreamableHTTPServerTransport({} as any);

    // Clean up transport when the request ends
    res.on('close', () => {
      transport.close().catch(() => {/* ignore */});
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await server.connect(transport as any);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    next(err);
  }
}

router.post('/', handleMcp);
router.get('/',  handleMcp);
router.delete('/', (_req: Request, res: Response) => res.status(200).send());

// ── Health / discovery ────────────────────────────────────────────────────────

/** GET /mcp/info — unauthenticated endpoint listing available tool names */
router.get('/info', (_req: Request, res: Response) => {
  const server = getMcpServer();
  // Access internal tool registry for the info endpoint
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, unknown> | undefined;
  const toolNames = tools ? Object.keys(tools).sort() : [];

  res.json({
    name: 'gub-mcp',
    version: '1.0.0',
    toolCount: toolNames.length,
    tools: toolNames,
  });
});

export default router;
