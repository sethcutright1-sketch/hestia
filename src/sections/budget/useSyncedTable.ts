import { useCallback, useEffect, useRef, useState } from "react";

// Replaces Budget Sync's whole-table PUT-on-every-change (App.tsx's old save
// effects). That approach deletes every row the client doesn't currently hold,
// which is fine with one client holding the whole dataset in memory, but breaks
// the moment a second writer exists -- another household member's tab, or the
// assistant's write tools hitting the same table directly. This hook instead
// diffs against what was last written and sends only the changed items.
//
// Seeded from the initial load (via `seed`) so mounting/remounting a section
// (e.g. <Budget key={dataVersion} />) never re-writes data it just read.
//
// `lastSynced` records what the SERVER is known to hold, so it is only ever
// updated after a confirmed-OK response. An earlier version updated it before
// the request, which meant a failed write was marked as saved: the next diff
// saw no change, never retried, and the edit was gone for good behind a toast
// the user could dismiss. For financial records that is data loss, so the rule
// here is that an unconfirmed write stays dirty.

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [500, 2000, 6000];

type Op =
  | { kind: "put"; key: string; json: string; attempts: number }
  | { kind: "del"; key: string; attempts: number };

export interface SyncStatus {
  /** Writes queued or in flight. Non-zero means "not saved yet". */
  pending: number;
  /** Writes that exhausted automatic retries and need `retryFailed()`. */
  failed: number;
  lastError: string | null;
}

const IDLE: SyncStatus = { pending: 0, failed: 0, lastError: null };

export function useSyncedTable<T extends { [key: string]: any }>(
  table: string,
  items: T[],
  opts: { enabled: boolean; keyOf?: (item: T) => string; onError?: (err: Error) => void }
) {
  const { enabled, keyOf = (item: T) => String(item.id), onError } = opts;

  const lastSynced = useRef<Map<string, string> | null>(null);
  // Keyed by item key, so a second edit to the same row while the first is
  // still queued replaces it rather than sending both -- the server only cares
  // about the final state, and sending stale intermediates invites races.
  const queue = useRef<Map<string, Op>>(new Map());
  const failedOps = useRef<Map<string, Op>>(new Map());
  const draining = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);

  const [status, setStatus] = useState<SyncStatus>(IDLE);

  // Held in a ref so the drain loop never closes over a stale callback.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;

  const publish = useCallback((lastError?: string | null) => {
    if (unmounted.current) return;
    setStatus((prev) => ({
      pending: queue.current.size + (draining.current ? 1 : 0),
      failed: failedOps.current.size,
      lastError: lastError === undefined ? prev.lastError : lastError,
    }));
  }, []);

  // Called once, right after the initial GET /api/budget/store response is
  // applied to state, so the first render's diff against `items` is empty.
  const seed = useCallback((seedItems: T[]) => {
    const map = new Map<string, string>();
    for (const item of seedItems) map.set(keyOfRef.current(item), JSON.stringify(item));
    lastSynced.current = map;
  }, []);

  const send = useCallback(
    async (op: Op): Promise<void> => {
      const url = `/api/budget/${table}/${encodeURIComponent(op.key)}`;
      const res =
        op.kind === "put"
          ? await fetch(url, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              // op.json is already serialized; wrapping it as text avoids a
              // parse/stringify round trip and guarantees we send exactly what
              // gets recorded in lastSynced on success.
              body: `{"item":${op.json}}`,
            })
          : await fetch(url, { method: "DELETE" });

      if (res.ok) return;
      // Deleting something already gone is the outcome we wanted.
      if (op.kind === "del" && res.status === 404) return;

      const err = new Error(
        `Failed to ${op.kind === "put" ? "save" : "delete"} ${table}/${op.key} (${res.status})`
      ) as Error & { permanent?: boolean };
      // A 4xx won't fix itself by being sent again, so retrying it just blocks
      // the queue behind one bad row. 408/429 are the exceptions that do.
      err.permanent =
        res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      throw err;
    },
    [table]
  );

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;

    try {
      while (queue.current.size > 0 && !unmounted.current) {
        const [key, op] = queue.current.entries().next().value as [string, Op];
        queue.current.delete(key);
        publish();

        try {
          await send(op);
          // Only now is the server known to hold this.
          if (op.kind === "put") lastSynced.current?.set(op.key, op.json);
          else lastSynced.current?.delete(op.key);
          failedOps.current.delete(op.key);
        } catch (err: any) {
          const permanent = Boolean(err?.permanent);
          op.attempts += 1;

          if (!permanent && op.attempts < MAX_ATTEMPTS) {
            // Requeue -- unless a newer edit to this row already landed, in
            // which case that one supersedes this payload.
            if (!queue.current.has(op.key)) queue.current.set(op.key, op);
            const delay = BACKOFF_MS[Math.min(op.attempts - 1, BACKOFF_MS.length - 1)];
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => {
              retryTimer.current = null;
              void drain();
            }, delay);
            publish(err?.message ?? String(err));
            // Stop draining: a transient failure usually means the server or
            // network is down, so the rest of the queue would fail too.
            break;
          }

          failedOps.current.set(op.key, op);
          publish(err?.message ?? String(err));
          onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
          // Permanent failures are per-row, so keep going.
        }
      }
    } finally {
      draining.current = false;
      publish();
    }
  }, [publish, send]);

  /** Re-queue everything that gave up, e.g. from a "retry" button. */
  const retryFailed = useCallback(() => {
    for (const [key, op] of failedOps.current) {
      op.attempts = 0;
      if (!queue.current.has(key)) queue.current.set(key, op);
    }
    failedOps.current.clear();
    publish(null);
    void drain();
  }, [drain, publish]);

  useEffect(() => {
    if (!enabled || !lastSynced.current) return;
    const synced = lastSynced.current;
    const seen = new Set<string>();

    for (const item of items) {
      const key = keyOfRef.current(item);
      seen.add(key);
      const json = JSON.stringify(item);
      // Compares against what the server holds, so a previously failed write is
      // still dirty here and gets picked up again automatically.
      if (synced.get(key) === json) continue;
      queue.current.set(key, { kind: "put", key, json, attempts: 0 });
    }

    for (const key of synced.keys()) {
      if (seen.has(key)) continue;
      queue.current.set(key, { kind: "del", key, attempts: 0 });
    }

    if (queue.current.size > 0) {
      publish();
      void drain();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, items]);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  return { seed, status, retryFailed };
}
