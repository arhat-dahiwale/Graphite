/**
 * Sanitize a CSV header into a safe Postgres identifier suffix.
 * Deterministic: same input always yields the same column name; callers
 * deduplicate by position when collisions occur.
 */
export function sanitizeColumnName(originalName: string, position: number): string {
  let s = originalName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 58);
  if (s.length === 0 || /^[0-9]/.test(s)) {
    s = `col_${position}`;
  }
  return s;
}

/** Deduplicate sanitized names, appending _2, _3, ... on collision. */
export function dedupeColumnNames(sanitized: string[]): string[] {
  const seen = new Map<string, number>();
  return sanitized.map((base) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}
