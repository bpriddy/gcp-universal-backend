/**
 * server.ts — MCP Server factory
 *
 * Creates and configures the McpServer instance with all tools registered.
 * Called once at startup; the same instance handles all connections.
 *
 * Tool inventory (generated from registry + compound):
 *   Generated (3 per entity × 7 entities = 21 tools):
 *     list_staff, get_staff, search_staff
 *     list_office, get_office, search_office
 *     list_team, get_team, search_team
 *     list_account, get_account, search_account
 *     list_campaign, get_campaign, search_campaign
 *     list_staffMetadata, get_staffMetadata, search_staffMetadata
 *     list_app, get_app, search_app
 *
 *   Compound (4 hand-crafted tools):
 *     find_staff_for_resourcing
 *     get_account_overview
 *     get_org_structure
 *     get_staff_access_summary
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllEntityTools } from './generator';
import { registerCompoundTools } from './compound-tools';

let _server: McpServer | null = null;

/**
 * Returns the shared McpServer instance, creating it on first call.
 * The server is stateless per-request — it does not hold session state.
 */
export function getMcpServer(): McpServer {
  if (_server) return _server;

  _server = new McpServer(
    {
      name: 'gub-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerAllEntityTools(_server);
  registerCompoundTools(_server);

  return _server;
}
