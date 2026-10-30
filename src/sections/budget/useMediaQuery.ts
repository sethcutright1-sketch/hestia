// src/sections/budget/useMediaQuery.ts -- tells a component which of two
// layouts to render (e.g. the Transactions tab's desktop table vs. phone
// cards) so only ONE of them actually mounts. The old approach rendered both
// unconditionally and hid one with `hidden md:block` CSS -- every row (and
// its ~18-option category <select>) was built twice on every render, once for
// a layout that was never even visible.

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const getMatch = () => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(getMatch);

  useEffect(() => {
    const mql = window.matchMedia(query);
    // Re-read synchronously on mount/query change too -- the initial
    // useState above can't safely call matchMedia during SSR, and the query
    // string itself might change between renders.
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
