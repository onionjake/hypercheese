import { useEffect, useState } from 'react';

import * as api from './api';
import type { Session } from './api';
import type { Tag } from './types';

let cache: Map<number, Tag> | null = null;
let inflight: Promise<Map<number, Tag>> | null = null;
// Bumped by clearTagCache: a fetch started for the previous account (tag
// aliases are per user) must not become the next account's cache.
let generation = 0;
// Every mounted useTagMap: a load that one screen retried (after a failure
// at startup, say) fills in the others too.
const listeners = new Set<(map: Map<number, Tag>) => void>();

async function load(session: Session): Promise<Map<number, Tag>> {
  if (cache) return cache;
  if (!inflight) {
    const gen = generation;
    inflight = api.fetchTags(session).then((tags) => {
      const map = new Map(tags.map((t) => [t.id, t]));
      if (gen === generation) {
        cache = map;
        for (const listener of listeners) listener(map);
      }
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

// Another try after a failed load (a no-op once the tags are cached), e.g.
// on pull-to-refresh — otherwise tag lines stay missing for the whole session.
export function retryTags(session: Session): void {
  load(session).catch(() => {});
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
    const listener = (map: Map<number, Tag>) => {
      if (!cancelled) setTags(map);
    };
    listeners.add(listener);
    load(session)
      .then(listener)
      .catch(() => {});
    return () => {
      cancelled = true;
      listeners.delete(listener);
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
