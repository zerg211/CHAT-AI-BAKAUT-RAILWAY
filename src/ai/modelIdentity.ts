/** A provider may resolve an alias to its dated snapshot, never to another family. */
export function sameModel(actual: string | undefined, requested: string) {
  if (actual === requested) return true;
  if (!actual?.startsWith(requested + '-')) return false;
  const date = actual.slice(requested.length + 1).split('-');
  return date.map(part => part.length).join(',') === '4,2,2' &&
    date.every(part => [...part].every(character => '0123456789'.includes(character)));
}
