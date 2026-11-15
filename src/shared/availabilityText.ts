export const availabilityTextLimit = 3000;

/** JSON Schema maxLength counts Unicode code points, not UTF-16 units. */
export function availabilityTextWithinLimit(text: string): boolean {
  let count = 0;
  for (const _point of text) if (++count > availabilityTextLimit) return false;
  return true;
}
