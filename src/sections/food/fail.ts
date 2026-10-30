// The one way the Food section turns a failed call into words: the server's own message, with the food-diary
// PIN lock (423) also telling the section to swap to its lock screen.

import { ApiError, errorText } from "./api.ts";

export function failWith(onLocked: () => void): (err: unknown) => string {
  return (err) => {
    if (err instanceof ApiError && err.status === 423) onLocked();
    return errorText(err);
  };
}

export type ToastFn = (message: string, opts?: { tone?: "info" | "error"; action?: { label: string; onClick: () => void } }) => void;
