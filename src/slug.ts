const MAX_LENGTH = 40;

/** Lowercase, non-alphanumeric runs collapsed to "-", trimmed, capped. */
export function slugify(name: string): string {
  const collapsed = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Truncating can leave a trailing "-", so trim again after the cap.
  return collapsed.slice(0, MAX_LENGTH).replace(/-+$/, '');
}
