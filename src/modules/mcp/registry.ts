/**
 * registry.ts — MCP Entity Registry
 *
 * Single source of truth for what the MCP layer exposes to AI clients.
 * Adding a new entity = one entry here. The generator produces
 * list_{entity}, get_{entity}, and search_{entity} tools automatically.
 *
 * Field names must match the actual Prisma model (camelCase).
 */

export interface RelationDef {
  prismaKey?: string;   // actual Prisma include key; defaults to the map key
  description: string;
}

export interface FilterDef {
  type: 'string' | 'boolean' | 'enum' | 'id';
  prismaField?: string; // actual Prisma where field; defaults to the map key
  description: string;
  enumValues?: string[];
}

export interface EntityDef {
  prismaModel: string;
  description: string;
  noun: string;
  searchFields: string[];
  defaultOrderBy: Record<string, 'asc' | 'desc'>;
  relations: Record<string, RelationDef>;
  filters: Record<string, FilterDef>;
}

export const registry: Record<string, EntityDef> = {

  // ── Staff ──────────────────────────────────────────────────────────────
  // fullName, email, title, department, status, officeId
  // Relations: office, teamMemberships, metadata, user

  staff: {
    prismaModel: 'staff',
    noun: 'staff member',
    description:
      'Agency staff members — current and former employees. ' +
      'Include metadata for skills/interests, teamMemberships for team info. ' +
      'Use for resourcing, org lookups, and people searches.',
    searchFields: ['fullName', 'email', 'title', 'department'],
    defaultOrderBy: { fullName: 'asc' },
    relations: {
      office:           { description: 'The office this person is based in' },
      teamMemberships:  { description: 'Team memberships (each has a team sub-object)' },
      metadata:         { description: 'Skills, interests, and work highlights' },
      user:             { description: 'Platform login record (email, role, isAdmin)' },
    },
    filters: {
      status: {
        type: 'enum',
        description: 'Employment status',
        enumValues: ['active', 'former', 'leave'],
      },
      officeId: {
        type: 'id',
        description: 'Filter by office UUID',
      },
      department: {
        type: 'string',
        description: 'Filter by department name (contains, case-insensitive)',
      },
      title: {
        type: 'string',
        description: 'Filter by job title (contains, case-insensitive)',
      },
    },
  },

  // ── Office ─────────────────────────────────────────────────────────────
  // name, syncCity, isActive

  office: {
    prismaModel: 'office',
    noun: 'office',
    description: 'Physical agency offices and locations.',
    searchFields: ['name', 'syncCity'],
    defaultOrderBy: { name: 'asc' },
    relations: {
      staff: { description: 'All staff members based in this office' },
    },
    filters: {
      isActive: {
        type: 'boolean',
        description: 'Whether the office is currently active',
      },
    },
  },

  // ── Team ───────────────────────────────────────────────────────────────
  // name, description, isActive
  // Relations: members (TeamMember[] — each has a staff sub-object)

  team: {
    prismaModel: 'team',
    noun: 'team',
    description:
      'Functional teams within the agency. ' +
      'Use members relation to see who is on the team.',
    searchFields: ['name', 'description'],
    defaultOrderBy: { name: 'asc' },
    relations: {
      members: { description: 'Team memberships — each entry has a staff sub-object with the person\'s details' },
    },
    filters: {
      isActive: {
        type: 'boolean',
        description: 'Whether the team is currently active',
      },
    },
  },

  // ── Account ────────────────────────────────────────────────────────────
  // name, parentId
  // Relations: campaigns, children (sub-accounts), parent

  account: {
    prismaModel: 'account',
    noun: 'client account',
    description:
      'Client accounts — the companies or brands the agency works with. ' +
      'Accounts can have sub-accounts (children) and multiple campaigns.',
    searchFields: ['name'],
    defaultOrderBy: { name: 'asc' },
    relations: {
      campaigns: { description: 'All campaigns run for this account' },
      children:  { description: 'Sub-accounts (if this is a parent account)' },
      parent:    { description: 'Parent account (if this is a sub-account)' },
    },
    filters: {
      parentId: {
        type: 'id',
        description: 'Filter to sub-accounts of a specific parent account UUID',
      },
    },
  },

  // ── Campaign ───────────────────────────────────────────────────────────
  // name, status, accountId, createdBy (staffId), createdAt

  campaign: {
    prismaModel: 'campaign',
    noun: 'campaign',
    description:
      'Client campaigns — specific projects or engagements for an account. ' +
      'Use to find work done for a client and who led it.',
    searchFields: ['name'],
    defaultOrderBy: { createdAt: 'desc' },
    relations: {
      account:        { description: 'The client account this campaign belongs to' },
      createdByStaff: { description: 'The staff member who created this campaign' },
    },
    filters: {
      accountId: {
        type: 'id',
        description: 'Filter campaigns by account UUID',
      },
      status: {
        type: 'enum',
        description: 'Campaign status',
        enumValues: ['pitch', 'active', 'paused', 'completed', 'cancelled'],
      },
    },
  },

  // ── Staff Metadata ─────────────────────────────────────────────────────
  // staffId, type, label, value, notes, isFeatured

  staffMetadata: {
    prismaModel: 'staffMetadata',
    noun: 'staff metadata entry',
    description:
      'Skill, interest, or work highlight records for staff. ' +
      'type examples: "skill", "interest", "highlight". ' +
      'For most resourcing queries, prefer find_staff_for_resourcing.',
    searchFields: ['label', 'value', 'notes'],
    defaultOrderBy: { type: 'asc' },
    relations: {
      staff: { description: 'The staff member this metadata belongs to' },
    },
    filters: {
      type: {
        type: 'string',
        description: 'Metadata category — e.g. "skill", "interest" (contains match)',
      },
      label: {
        type: 'string',
        description: 'Specific label — e.g. "React", "Brand Strategy" (contains match)',
      },
      isFeatured: {
        type: 'boolean',
        description: 'Whether this entry is featured on the staff profile',
      },
      staffId: {
        type: 'id',
        description: 'Filter to a specific staff member UUID',
      },
    },
  },

  // ── App ────────────────────────────────────────────────────────────────
  // appId, name, description, isActive, autoAccess

  app: {
    prismaModel: 'app',
    noun: 'registered app',
    description:
      'Applications registered in the platform with their own access control. ' +
      'Use to understand what systems are integrated.',
    searchFields: ['appId', 'name', 'description'],
    defaultOrderBy: { name: 'asc' },
    relations: {
      permissions: { description: 'User permissions granted for this app' },
    },
    filters: {
      isActive: {
        type: 'boolean',
        description: 'Whether the app is currently active',
      },
    },
  },

};
