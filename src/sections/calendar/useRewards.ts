// The points-only rewards catalog (Stage 10.4, PLAN.md) -- balances, the
// reward list, and redemptions. Same shape and conventions as ./useChores.ts
// and src/sections/members/useMembers.ts: one hook, live-refreshed, shared
// by whatever screens need it (today: PersonalView.tsx).

import { useCallback, useEffect, useState } from "react";
import { api, type Reward, type Redemption, type MemberBalance } from "../../api.ts";
import { useLiveRefresh } from "../../useLiveRefresh.ts";
import { KIOSK } from "../../kiosk.ts";

export interface RewardsApi {
  rewards: Reward[];
  balances: Record<string, MemberBalance>;
  redemptions: Redemption[];
  error: string;
  // True until the first fetch settles (success or failure) -- see
  // useChores.ts's `loading` for why: a caller that renders an empty state
  // needs to tell "genuinely nothing yet" apart from "hasn't loaded yet".
  loading: boolean;
  setError: (message: string) => void;
  refresh: () => Promise<void>;
  addReward: (fields: { title: string; cost: number }) => Promise<void>;
  removeReward: (reward: Reward) => Promise<void>;
  redeem: (reward: Reward, memberId: string) => Promise<boolean>;
}

export function useRewards(memberId?: string): RewardsApi {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [balances, setBalances] = useState<Record<string, MemberBalance>>({});
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [rewardsRes, balancesRes, redemptionsRes] = await Promise.all([
        api.get<{ rewards: Reward[] }>("/api/rewards"),
        api.get<{ balances: Record<string, MemberBalance> }>("/api/rewards/balances"),
        api.get<{ redemptions: Redemption[] }>(
          `/api/rewards/redemptions${memberId ? `?memberId=${encodeURIComponent(memberId)}` : ""}`
        ),
      ]);
      setRewards(rewardsRes.rewards);
      setBalances(balancesRes.balances);
      setRedemptions(redemptionsRes.redemptions);
      setError("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [memberId]);

  useEffect(() => { refresh(); }, [refresh]);

  useLiveRefresh(() => { refresh(); }, KIOSK ? 30_000 : 60_000);

  const addReward = useCallback(async (fields: { title: string; cost: number }) => {
    try {
      await api.post("/api/rewards", fields);
      await refresh();
    } catch (err: any) { setError(err.message); }
  }, [refresh]);

  const removeReward = useCallback(async (reward: Reward) => {
    try {
      await api.del(`/api/rewards/${reward.id}`);
      await refresh();
    } catch (err: any) { setError(err.message); }
  }, [refresh]);

  // Returns whether it succeeded so the caller (a confirm dialog) can decide
  // what to do next without threading its own try/catch around this.
  const redeem = useCallback(async (reward: Reward, forMemberId: string) => {
    try {
      await api.post(`/api/rewards/${reward.id}/redeem`, { memberId: forMemberId });
      await refresh();
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  }, [refresh]);

  return { rewards, balances, redemptions, error, loading, setError, refresh, addReward, removeReward, redeem };
}
