/**
 * workfront.client.ts — Workfront API client.
 *
 * Workfront proxies Maconomy data for accounts and campaigns.
 * This client fetches project and task data via the Workfront REST API.
 *
 * TODO: Implement when API credentials and field mapping are confirmed.
 */

import { config } from '../../../config/env';
import { logger } from '../../../services/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkfrontProject {
  ID: string;
  name: string;
  status: string;
  description: string | null;
  plannedStartDate: string | null;
  plannedCompletionDate: string | null;
  actualCompletionDate: string | null;
  budget: number | null;
  /** Custom field — Maconomy job number */
  DE_MaconomyJobNumber: string | null;
  /** Custom field — client/account name */
  DE_ClientName: string | null;
  /** Owner / project lead */
  ownerID: string | null;
  ownerName: string | null;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function baseUrl(): string {
  const url = config.WORKFRONT_BASE_URL;
  if (!url) throw new Error('WORKFRONT_BASE_URL is not configured');
  return url;
}

function headers(): Record<string, string> {
  const token = config.WORKFRONT_API_TOKEN;
  if (!token) throw new Error('WORKFRONT_API_TOKEN is not configured');
  return {
    apiKey: token,
    'Content-Type': 'application/json',
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all active projects from Workfront.
 * Handles pagination via the offset/limit pattern.
 *
 * TODO: Confirm the actual fields, custom field names, and filter criteria
 * once Workfront access is available.
 */
export async function fetchAllProjects(): Promise<WorkfrontProject[]> {
  const projects: WorkfrontProject[] = [];
  const limit = 100;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const url = `${baseUrl()}/attask/api/v17.0/project/search` +
      `?$$LIMIT=${limit}&$$FIRST=${offset}` +
      `&status=CUR&status_Mod=in` + // CUR = Current (active)
      `&fields=name,status,description,plannedStartDate,plannedCompletionDate,` +
      `actualCompletionDate,budget,ownerID,ownerName,` +
      `DE:Maconomy Job Number,DE:Client Name`;

    const res = await fetch(url, { headers: headers() });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Workfront API error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as { data: WorkfrontProject[] };
    const page = json.data ?? [];
    projects.push(...page);

    hasMore = page.length === limit;
    offset += limit;

    logger.debug({ pageSize: page.length, total: projects.length }, 'Workfront: fetched page');
  }

  return projects;
}

/**
 * Fetch a single project by Workfront ID.
 */
export async function fetchProjectById(projectId: string): Promise<WorkfrontProject | null> {
  const url = `${baseUrl()}/attask/api/v17.0/project/${projectId}` +
    `?fields=name,status,description,plannedStartDate,plannedCompletionDate,` +
    `actualCompletionDate,budget,ownerID,ownerName,` +
    `DE:Maconomy Job Number,DE:Client Name`;

  const res = await fetch(url, { headers: headers() });

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Workfront API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { data: WorkfrontProject };
  return json.data;
}
