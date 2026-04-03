/**
 * compound-tools.ts — Hand-crafted multi-entity correlation tools
 *
 * These tools are intentionally NOT auto-generated because they cross entity
 * boundaries in ways the registry generator can't express cleanly.
 * Each one answers a specific high-value question an AI agent is likely to ask.
 *
 * Current compound tools:
 *   find_staff_for_resourcing    — find people with matching skills/interests
 *   get_account_overview         — account + all campaigns + staff who led them
 *   get_org_structure            — all offices + teams + headcount
 *   get_staff_access_summary     — what systems/resources a person has access to
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prisma } from '../../config/database';

export function registerCompoundTools(server: McpServer): void {

  // ── find_staff_for_resourcing ─────────────────────────────────────────────
  // The core resourcing query: given a skill/interest and optional constraints,
  // return matching staff with their full profile.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resourcingSchema: any = {
    query:         z.string().optional().describe('Keyword to match against staff names, titles, or metadata labels/values'),
    metadataType:  z.string().optional().describe('Metadata category — e.g. "skill", "interest", "highlight"'),
    metadataLabel: z.string().optional().describe('Specific label — e.g. "React", "Brand Strategy" (contains match)'),
    metadataValue: z.string().optional().describe('Value to match within a metadata entry (contains match)'),
    officeId:      z.string().uuid().optional().describe('Restrict to a specific office'),
    teamId:        z.string().uuid().optional().describe('Restrict to a specific team'),
    status:        z.enum(['active', 'former', 'leave']).default('active').describe('Employment status — defaults to active'),
    featuredOnly:  z.boolean().default(false).describe('Only return staff where the matched metadata entry is featured'),
    limit:         z.number().int().min(1).max(50).default(10),
  };

  server.tool(
    'find_staff_for_resourcing',
    'Find staff members for a resourcing brief. Searches skills, interests, and highlights. ' +
    'Returns matching staff with their metadata, office, and team memberships. ' +
    'Use this for staffing recommendations, capability searches, and talent discovery.',
    resourcingSchema,
    async (args: Record<string, unknown>) => {
      const {
        query, metadataType, metadataLabel, metadataValue,
        officeId, teamId, status, featuredOnly, limit,
      } = args as {
        query?: string; metadataType?: string; metadataLabel?: string; metadataValue?: string;
        officeId?: string; teamId?: string; status: string; featuredOnly: boolean; limit: number;
      };

      const metadataWhere: Record<string, unknown> = {};
      if (metadataType)  metadataWhere['type']  = { contains: metadataType,  mode: 'insensitive' };
      if (metadataLabel) metadataWhere['label'] = { contains: metadataLabel, mode: 'insensitive' };
      if (metadataValue) metadataWhere['value'] = { contains: metadataValue, mode: 'insensitive' };
      if (featuredOnly)  metadataWhere['isFeatured'] = true;

      const staffWhere: Record<string, unknown> = { status };
      if (officeId) staffWhere['officeId'] = officeId;
      if (teamId)   staffWhere['teamMemberships'] = { some: { teamId } };
      if (Object.keys(metadataWhere).length > 0) staffWhere['metadata'] = { some: metadataWhere };
      if (query) {
        staffWhere['OR'] = [
          { fullName: { contains: query, mode: 'insensitive' } },
          { title:    { contains: query, mode: 'insensitive' } },
          { email:    { contains: query, mode: 'insensitive' } },
        ];
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const staff = await prisma.staff.findMany({
        where: staffWhere as any,
        include: {
          office:          true,
          teamMemberships: { include: { team: true } },
          metadata: Object.keys(metadataWhere).length > 0
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? { where: metadataWhere as any, orderBy: [{ isFeatured: 'desc' }, { type: 'asc' }] }
            : { orderBy: [{ isFeatured: 'desc' }, { type: 'asc' }] },
        },
        orderBy: { fullName: 'asc' },
        take: limit,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ count: staff.length, staff }, null, 2) }],
      };
    },
  );

  // ── get_account_overview ──────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountOverviewSchema: any = {
    accountId:   z.string().uuid().optional().describe('UUID of the account'),
    accountName: z.string().optional().describe('Search by account name (contains match) — use if you don\'t have the UUID'),
  };

  server.tool(
    'get_account_overview',
    'Get a full overview of a client account: account details, all campaigns, ' +
    'and the staff members who led each campaign. ' +
    'Use when an AI needs context about a specific client relationship.',
    accountOverviewSchema,
    async (args: Record<string, unknown>) => {
      const { accountId, accountName } = args as { accountId?: string; accountName?: string };

      if (!accountId && !accountName) {
        return {
          content: [{ type: 'text' as const, text: 'Provide either accountId or accountName.' }],
          isError: true,
        };
      }

      const where = accountId
        ? { id: accountId }
        : { name: { contains: accountName!, mode: 'insensitive' as const } };

      const accounts = await prisma.account.findMany({
        where,
        include: {
          campaigns: {
            include: {
              createdByStaff: { select: { id: true, fullName: true, title: true } },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
        take: accountId ? 1 : 5,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ count: accounts.length, accounts }, null, 2) }],
      };
    },
  );

  // ── get_org_structure ─────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orgStructureSchema: any = {
    activeOnly: z.boolean().default(true).describe('Only include active offices and teams'),
  };

  server.tool(
    'get_org_structure',
    'Get the full organisational structure: all offices with their active staff, ' +
    'and all teams with member counts. ' +
    'Use for org chart questions, capacity planning, and understanding the agency\'s shape.',
    orgStructureSchema,
    async (args: Record<string, unknown>) => {
      const { activeOnly } = args as { activeOnly: boolean };
      const activeFilter = activeOnly ? { isActive: true } : {};

      const [offices, teams] = await Promise.all([
        prisma.office.findMany({
          where: activeFilter,
          include: {
            staff: {
              where: { status: 'active' },
              select: { id: true, fullName: true, title: true },
            },
          },
          orderBy: { name: 'asc' },
        }),
        prisma.team.findMany({
          where: activeFilter,
          include: { _count: { select: { members: true } } },
          orderBy: { name: 'asc' },
        }),
      ]);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ officeCount: offices.length, teamCount: teams.length, offices, teams }, null, 2),
        }],
      };
    },
  );

  // ── get_staff_access_summary ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accessSummarySchema: any = {
    staffId:    z.string().uuid().optional().describe('UUID of the staff member'),
    staffName:  z.string().optional().describe('Name of the staff member (contains match) — use if you don\'t have the UUID'),
    activeOnly: z.boolean().default(true).describe('Only return currently active (non-revoked) grants'),
  };

  server.tool(
    'get_staff_access_summary',
    'Get a summary of all system access and resource grants for a staff member. ' +
    'Use for access audits, onboarding checks, or offboarding reviews.',
    accessSummarySchema,
    async (args: Record<string, unknown>) => {
      const { staffId, staffName, activeOnly } = args as {
        staffId?: string; staffName?: string; activeOnly: boolean;
      };

      if (!staffId && !staffName) {
        return {
          content: [{ type: 'text' as const, text: 'Provide either staffId or staffName.' }],
          isError: true,
        };
      }

      const staffWhere = staffId
        ? { id: staffId }
        : { fullName: { contains: staffName!, mode: 'insensitive' as const } };

      const staff = await prisma.staff.findFirst({
        where: staffWhere,
        select: { id: true, fullName: true, title: true, email: true, userId: true },
      });

      if (!staff) {
        return {
          content: [{ type: 'text' as const, text: 'Staff member not found.' }],
          isError: true,
        };
      }

      if (!staff.userId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              staff: { id: staff.id, fullName: staff.fullName, title: staff.title, email: staff.email },
              totalGrants: 0,
              note: 'No platform user account linked to this staff member.',
              byResourceType: {},
            }, null, 2),
          }],
        };
      }

      // AccessGrant is keyed on userId (not staffId); active = revokedAt is null
      const grantsWhere: Record<string, unknown> = { userId: staff.userId };
      if (activeOnly) grantsWhere['revokedAt'] = null;

      const grants = await prisma.accessGrant.findMany({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: grantsWhere as any,
        orderBy: [{ resourceType: 'asc' }, { grantedAt: 'desc' }],
      });

      const byType: Record<string, unknown[]> = {};
      for (const grant of grants) {
        const t = (grant as { resourceType: string }).resourceType;
        (byType[t] ??= []).push(grant);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            staff: { id: staff.id, fullName: staff.fullName, title: staff.title, email: staff.email },
            totalGrants: grants.length,
            byResourceType: byType,
          }, null, 2),
        }],
      };
    },
  );

}
