/**
 * workfront.mapper.ts — Transform Workfront projects to GUB accounts/campaigns.
 *
 * Workfront projects map to GUB campaigns. The parent client/account is resolved
 * by the DE_ClientName custom field (or Maconomy job number).
 *
 * TODO: Confirm custom field names and status mapping with actual Workfront data.
 */

import type { WorkfrontProject } from './workfront.client';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MappedAccount {
  /** Name derived from Workfront's client custom field */
  name: string;
}

export interface MappedCampaign {
  workfrontId: string;
  name: string;
  status: string;
  budget: number | null;
  awardedAt: Date | null;
  liveAt: Date | null;
  endsAt: Date | null;
  /** Workfront project owner — used to resolve createdBy staff */
  ownerName: string | null;
}

export interface MappedWorkfrontResult {
  account: MappedAccount | null;
  campaign: MappedCampaign;
}

// ── Status mapping ───────────────────────────────────────────────────────────
// Workfront project statuses → GUB campaign statuses
// TODO: Verify these codes against the actual Workfront instance

const STATUS_MAP: Record<string, string> = {
  CUR: 'active',       // Current
  PLN: 'pitch',        // Planning
  CPL: 'completed',    // Complete
  DED: 'cancelled',    // Dead
  ONH: 'paused',       // On Hold
};

// ── Public API ───────────────────────────────────────────────────────────────

export function mapWorkfrontProject(project: WorkfrontProject): MappedWorkfrontResult {
  const clientName = project.DE_ClientName?.trim() ?? null;

  return {
    account: clientName ? { name: clientName } : null,
    campaign: {
      workfrontId: project.ID,
      name: project.name,
      status: STATUS_MAP[project.status] ?? 'active',
      budget: project.budget,
      awardedAt: parseDate(project.plannedStartDate),
      liveAt: parseDate(project.plannedStartDate),
      endsAt: parseDate(project.plannedCompletionDate ?? project.actualCompletionDate),
      ownerName: project.ownerName,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
