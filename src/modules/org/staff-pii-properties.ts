/**
 * The set of staff_changes.property values whose value_text contains
 * personally identifiable information (PII).
 *
 * This is the single source of truth used by:
 *   - directory.sync.ts — sets valueIsPii = true when writing change rows
 *   - anonymise route   — filters rows to scrub on GDPR Art. 17 erasure
 *
 * Property names use snake_case to match the string values stored in the
 * staff_changes.property column.
 *
 * Non-PII properties (status, office_id, started_at, ended_at) are omitted
 * intentionally — they are operational metadata safe to retain after erasure.
 */
export const STAFF_PII_PROPERTIES: ReadonlySet<string> = new Set([
  'full_name',
  'email',
  'title',
  'department',
]);
