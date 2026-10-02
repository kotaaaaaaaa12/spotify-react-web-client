export interface LibraryPage<T> {
  items: T[];
  next: string | null;
}

export async function collectLibraryPages<T extends { id: string }>(
  fetchPage: (params: Record<string, string | number>) => Promise<LibraryPage<T>>,
  cursor: 'after' | 'offset',
): Promise<T[]> {
  const items = new Map<string, T>();
  const visited = new Set<string>();
  let params: Record<string, string | number> = { limit: 50 };
  while (true) {
    const page = await fetchPage(params);
    for (const item of page.items) if (item?.id) items.set(item.id, item);
    if (!page.next) break;
    const next = new URL(page.next).searchParams.get(cursor);
    if (!next || visited.has(next)) throw new Error('Spotify returned an invalid library cursor. Please refresh.');
    visited.add(next);
    params = { limit: 50, [cursor]: next };
  }
  return [...items.values()];
}
