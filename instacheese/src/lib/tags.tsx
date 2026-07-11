import { useEffect, useState } from 'react';

import * as api from './api';
import type { Session } from './api';
import type { Tag } from './types';

let cache: Map<number, Tag> | null = null;
let inflight: Promise<Map<number, Tag>> | null = null;

async function load(session: Session): Promise<Map<number, Tag>> {
  if (cache) return cache;
  inflight ??= api.fetchTags(session).then((tags) => {
    cache = new Map(tags.map((t) => [t.id, t]));
    return cache;
  });
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function clearTagCache() {
  cache = null;
}

export function useTagMap(session: Session | null): Map<number, Tag> | null {
  const [tags, setTags] = useState<Map<number, Tag> | null>(cache);

  useEffect(() => {
    if (!session || cache) return;
    let cancelled = false;
    load(session)
      .then((map) => {
        if (!cancelled) setTags(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session]);

  return tags;
}

export function tagLine(tagIds: number[], tags: Map<number, Tag> | null): string {
  if (!tags) return '';
  const labels = tagIds
    .map((id) => {
      const tag = tags.get(id);
      return tag ? tag.alias || tag.label : null;
    })
    .filter((label): label is string => !!label);
  return labels.join(', ');
}
