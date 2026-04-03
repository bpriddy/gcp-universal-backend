/**
 * generator.ts — Registry-driven MCP Tool Generator
 *
 * Takes the entity registry and produces three MCP tools per entity:
 *   list_{entity}   — paginated list with filters
 *   get_{entity}    — single record by ID with optional relation includes
 *   search_{entity} — full-text search across searchFields + filters
 *
 * Adding a new entity to registry.ts automatically produces all three tools here.
 * No manual tool definition needed.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prisma } from '../../config/database';
import { registry, type EntityDef } from './registry';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Access any Prisma model by name at runtime */
function getModel(modelName: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any)[modelName] as {
    findMany: (args: unknown) => Promise<unknown[]>;
    findUnique: (args: unknown) => Promise<unknown>;
    count: (args: unknown) => Promise<number>;
  };
}

/** Build a Prisma `include` object from a list of relation key names */
function buildInclude(
  def: EntityDef,
  includeKeys: string[],
): Record<string, boolean> {
  const inc: Record<string, boolean> = {};
  for (const key of includeKeys) {
    const rel = def.relations[key];
    if (rel) inc[rel.prismaKey ?? key] = true;
  }
  return inc;
}

/** Build a Prisma `where` object from filter values provided by the AI */
function buildWhere(
  def: EntityDef,
  filterValues: Record<string, unknown>,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filterValues)) {
    if (value === undefined || value === null || value === '') continue;
    const filterDef = def.filters[key];
    if (!filterDef) continue;
    const field = filterDef.prismaField ?? key;

    if (filterDef.type === 'string') {
      where[field] = { contains: value, mode: 'insensitive' };
    } else {
      // boolean, enum, id — exact match
      where[field] = value;
    }
  }
  return where;
}

/** Build the Zod schema for filter params from the entity definition */
function buildFilterSchema(def: EntityDef) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, filterDef] of Object.entries(def.filters)) {
    let schema: z.ZodTypeAny;
    if (filterDef.type === 'boolean') {
      schema = z.boolean();
    } else if (filterDef.type === 'enum' && filterDef.enumValues) {
      schema = z.enum(filterDef.enumValues as [string, ...string[]]);
    } else {
      schema = z.string();
    }
    shape[key] = schema.optional().describe(filterDef.description);
  }
  return shape;
}

/** Build the Zod schema for the `include` param from the entity's relations */
function buildIncludeSchema(def: EntityDef) {
  const keys = Object.keys(def.relations);
  if (keys.length === 0) return null;
  return z
    .array(z.enum(keys as [string, ...string[]]))
    .optional()
    .describe(
      `Relations to include in results. Options: ${keys.join(', ')}`,
    );
}

// ── Tool factory ──────────────────────────────────────────────────────────────

function registerEntityTools(server: McpServer, entityKey: string, def: EntityDef) {
  const model = getModel(def.prismaModel);
  const filterSchema = buildFilterSchema(def);
  const includeSchema = buildIncludeSchema(def);
  const includeShape = includeSchema
    ? { include: includeSchema }
    : {};

  // ── list_{entity} ────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listSchema: any = {
    limit: z.number().int().min(1).max(100).default(25).describe('Max records to return'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset'),
    ...filterSchema,
    ...includeShape,
  };
  server.tool(
    `list_${entityKey}`,
    `List ${def.noun}s with optional filters and pagination. ${def.description}`,
    listSchema,
    async (args: Record<string, unknown>) => {
      const { limit, offset, include, ...filterArgs } = args as {
        limit: number;
        offset: number;
        include?: string[];
        [key: string]: unknown;
      };

      const where = buildWhere(def, filterArgs as Record<string, unknown>);
      const inc = include ? buildInclude(def, include) : {};

      const [items, total] = await Promise.all([
        model.findMany({
          where,
          include: Object.keys(inc).length > 0 ? inc : undefined,
          orderBy: def.defaultOrderBy,
          take: limit,
          skip: offset,
        }),
        model.count({ where }),
      ]);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ total, limit, offset, items }, null, 2),
          },
        ],
      };
    },
  );

  // ── get_{entity} ─────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getSchema: any = {
    id: z.string().uuid().describe(`UUID of the ${def.noun}`),
    ...includeShape,
  };
  server.tool(
    `get_${entityKey}`,
    `Get a single ${def.noun} by ID. ${def.description}`,
    getSchema,
    async (args: Record<string, unknown>) => {
      const { id, include } = args as { id: string; include?: string[] };
      const inc = include ? buildInclude(def, include) : {};

      const item = await model.findUnique({
        where: { id },
        include: Object.keys(inc).length > 0 ? inc : undefined,
      });

      if (!item) {
        return {
          content: [{ type: 'text' as const, text: `${def.noun} not found: ${id}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }],
      };
    },
  );

  // ── search_{entity} ──────────────────────────────────────────────────────
  if (def.searchFields.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const searchSchema: any = {
      query: z.string().min(1).describe(
        `Search term — matched case-insensitively against ${def.searchFields.join(', ')}`,
      ),
      limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
      ...filterSchema,
      ...includeShape,
    };
    server.tool(
      `search_${entityKey}`,
      `Search ${def.noun}s by keyword across ${def.searchFields.join(', ')}. ${def.description}`,
      searchSchema,
      async (args: Record<string, unknown>) => {
        const { query, limit, include, ...filterArgs } = args as {
          query: string;
          limit: number;
          include?: string[];
          [key: string]: unknown;
        };

        const textOr = def.searchFields.map((field) => ({
          [field]: { contains: query, mode: 'insensitive' },
        }));

        const filterWhere = buildWhere(def, filterArgs as Record<string, unknown>);
        const where =
          Object.keys(filterWhere).length > 0
            ? { AND: [{ OR: textOr }, filterWhere] }
            : { OR: textOr };

        const inc = include ? buildInclude(def, include) : {};

        const items = await model.findMany({
          where,
          include: Object.keys(inc).length > 0 ? inc : undefined,
          orderBy: def.defaultOrderBy,
          take: limit,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ count: items.length, query, items }, null, 2),
            },
          ],
        };
      },
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register all entity tools from the registry onto the MCP server.
 * Call once during server initialisation.
 */
export function registerAllEntityTools(server: McpServer): void {
  for (const [key, def] of Object.entries(registry)) {
    registerEntityTools(server, key, def);
  }
}
