/**
 * Test an If-None-Match field value against a current entity tag.
 *
 * RFC 9110 requires weak comparison for If-None-Match: a weak and strong
 * validator with the same opaque tag compare equal.
 */
export function matchesIfNoneMatch(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;

  const normalizedEtag = stripWeakPrefix(etag);
  return ifNoneMatch.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || stripWeakPrefix(trimmed) === normalizedEtag;
  });
}

function stripWeakPrefix(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value;
}
