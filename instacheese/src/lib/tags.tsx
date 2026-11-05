import { useEffect, useState } from 'react';

import * as api from './api';
import type { Session } from './api';
import type { Tag } from './types';

let cache: Map<number, Tag> | null = null;
let inflight: Promise<Map<number, Tag>> | null = null;
// Bumped by clearTagCache: a fetch started for the previous account (tag
// aliases are per user) must not become the next account's cache.
let generation = 0;

async function load(session: Session): Promise<Map<number, Tag>> {
  if (cache) return cache;
  if (!inflight) {
    const gen = generation;
    inflight = api.fetchTags(session).then((tags) => {
      const map = new Map(tags.map((t) => [t.id, t]));
      if (gen === generation) cache = map;
      return map;
    });
  }
  const request = inflight;
  try {
    return await request;
  } finally {
    if (inflight === request) inflight = null;
  }
}

export function clearTagCache() {
  cache = null;
  inflight = null;
  generation++;
}

export function useTagMap(session: Session | null): Map<number, Tag> | null {
  const [tags, setTags] = useState<Map<number, Tag> | null>(cache);

  useEffect(() => {
    // Not skipped when the cache is already filled: it may have been filled
    // after this component's first render read it.
    if (!session) return;
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
