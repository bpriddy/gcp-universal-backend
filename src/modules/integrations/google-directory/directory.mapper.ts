/**
 * directory.mapper.ts — Transform Google Directory person to internal staff schema.
 *
 * The mapper is deliberately greedy: it extracts every usable field from the
 * directory response. Fields that map directly to Staff columns land in
 * MappedDirectoryStaff. Everything else goes into `metadata` for storage in
 * the staff_metadata table — skills, relations, locations, bios, etc.
 */

import type { DirectoryPerson } from './directory.client';

// ── Types ────────────────────────────────────────────────────────────────────

export type StaffStatus = 'active' | 'on_leave' | 'former';

/** Fields that map directly to Staff table columns. */
export interface MappedDirectoryStaff {
  /** Google People API resourceName — e.g. "people/123456789" */
  resourceName: string;
  fullName: string;
  email: string;
  title: string | null;
  department: string | null;
  status: StaffStatus;
  photoUrl: string | null;
}

/** Extra structured data stored in staff_metadata. */
export interface DirectoryMetadataEntry {
  type: string;
  label: string;
  value: string | null;
  notes: string | null;
  /** Raw data preserved as JSON for anything that doesn't fit type/label/value */
  metadata: Record<string, unknown> | null;
}

export interface MappedDirectoryResult {
  staff: MappedDirectoryStaff;
  metadata: DirectoryMetadataEntry[];
}

// ── Public API ───────────────────────────────────────────────────────────────

export function mapDirectoryPerson(person: DirectoryPerson): MappedDirectoryResult | null {
  const resourceName = person.resourceName;
  if (!resourceName) return null;

  // Name — required
  const primaryName = person.names?.[0];
  const fullName = primaryName?.displayName ?? primaryName?.unstructuredName;
  if (!fullName) return null;

  // Email — required
  const primaryEmail = findPrimary(person.emailAddresses)?.value;
  if (!primaryEmail) return null;

  // Organization (title, department)
  const primaryOrg = person.organizations?.[0];
  const title = primaryOrg?.title ?? null;
  const department = primaryOrg?.department ?? null;

  // Photo
  const photo = person.photos?.find((p) => !p.default);
  const photoUrl = photo?.url ?? null;

  // ── Extract metadata ───────────────────────────────────────────────────────

  const metadata: DirectoryMetadataEntry[] = [];

  // Phone numbers
  for (const phone of person.phoneNumbers ?? []) {
    if (phone.value) {
      metadata.push({
        type: 'phone',
        label: phone.type ?? 'other',
        value: phone.canonicalForm ?? phone.value,
        notes: null,
        metadata: null,
      });
    }
  }

  // Locations (building, floor, desk)
  for (const loc of person.locations ?? []) {
    const parts = [loc.buildingId, loc.floor ? `Floor ${loc.floor}` : null, loc.floorSection, loc.deskCode ? `Desk ${loc.deskCode}` : null]
      .filter(Boolean)
      .join(', ');
    if (parts) {
      metadata.push({
        type: 'location',
        label: loc.type ?? 'desk',
        value: parts,
        notes: null,
        metadata: { buildingId: loc.buildingId, floor: loc.floor, floorSection: loc.floorSection, deskCode: loc.deskCode },
      });
    }
  }

  // Relations (manager, assistant, etc.)
  for (const rel of person.relations ?? []) {
    if (rel.person) {
      metadata.push({
        type: 'relation',
        label: rel.type ?? 'other',
        value: rel.person,
        notes: null,
        metadata: null,
      });
    }
  }

  // Skills
  for (const skill of person.skills ?? []) {
    if (skill.value) {
      metadata.push({
        type: 'skill',
        label: skill.value,
        value: null,
        notes: null,
        metadata: null,
      });
    }
  }

  // Biographies
  for (const bio of person.biographies ?? []) {
    if (bio.value) {
      metadata.push({
        type: 'biography',
        label: 'bio',
        value: bio.value.slice(0, 256),
        notes: bio.value.length > 256 ? bio.value : null,
        metadata: null,
      });
    }
  }

  // Addresses
  for (const addr of person.addresses ?? []) {
    const formatted = addr.formattedValue ?? [addr.streetAddress, addr.city, addr.region, addr.postalCode, addr.country].filter(Boolean).join(', ');
    if (formatted) {
      metadata.push({
        type: 'address',
        label: addr.type ?? 'work',
        value: formatted.slice(0, 256),
        notes: null,
        metadata: { city: addr.city, region: addr.region, country: addr.country, postalCode: addr.postalCode },
      });
    }
  }

  // Nicknames
  for (const nick of person.nicknames ?? []) {
    if (nick.value) {
      metadata.push({
        type: 'nickname',
        label: nick.type ?? 'default',
        value: nick.value,
        notes: null,
        metadata: null,
      });
    }
  }

  // Occupations (separate from org title — more like a headline)
  for (const occ of person.occupations ?? []) {
    if (occ.value) {
      metadata.push({
        type: 'occupation',
        label: 'occupation',
        value: occ.value,
        notes: null,
        metadata: null,
      });
    }
  }

  // External IDs from the directory profile (employee number, etc.)
  for (const ext of person.externalIds ?? []) {
    if (ext.value) {
      metadata.push({
        type: 'external_id',
        label: ext.type ?? 'other',
        value: ext.value,
        notes: null,
        metadata: null,
      });
    }
  }

  // URLs (personal website, LinkedIn, etc.)
  for (const url of person.urls ?? []) {
    if (url.value) {
      metadata.push({
        type: 'url',
        label: url.type ?? 'other',
        value: url.value,
        notes: null,
        metadata: null,
      });
    }
  }

  // Birthdays (store as text, not Date — only for display/reference)
  for (const bd of person.birthdays ?? []) {
    if (bd.date) {
      const { year, month, day } = bd.date;
      const dateStr = year ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      metadata.push({
        type: 'birthday',
        label: 'birthday',
        value: dateStr,
        notes: null,
        metadata: null,
      });
    }
  }

  // SIP addresses
  for (const sip of person.sipAddresses ?? []) {
    if (sip.value) {
      metadata.push({
        type: 'sip',
        label: sip.type ?? 'other',
        value: sip.value,
        notes: null,
        metadata: null,
      });
    }
  }

  // Additional organizations beyond the primary
  for (const org of (person.organizations ?? []).slice(1)) {
    const label = [org.title, org.department].filter(Boolean).join(' — ');
    if (label) {
      metadata.push({
        type: 'organization',
        label: org.name ?? 'other',
        value: label,
        notes: null,
        metadata: { title: org.title, department: org.department, startDate: org.startDate, endDate: org.endDate, current: org.current },
      });
    }
  }

  return {
    staff: {
      resourceName,
      fullName,
      email: primaryEmail,
      title,
      department,
      status: 'active', // everyone in the directory is active
      photoUrl,
    },
    metadata,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface HasMetadata {
  metadata?: { primary?: boolean | null; sourcePrimary?: boolean | null } | null;
}

function findPrimary<T extends HasMetadata>(items: T[] | undefined | null): T | undefined {
  if (!items?.length) return undefined;
  return items.find((i) => i.metadata?.primary || i.metadata?.sourcePrimary) ?? items[0];
}
