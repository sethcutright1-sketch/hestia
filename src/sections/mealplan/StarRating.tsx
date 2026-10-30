// A recipe's favourite star and 1-5 rating: this login's own (the server keeps them per person). Both are plain buttons,
// so the keyboard and a touch screen work the same. Tapping the rating you already gave clears it.

import { Heart, Star } from "lucide-react";

export function FavoriteButton({
  favorite,
  onChange,
  disabled = false,
  label,
  size = 16,
}: {
  favorite: boolean;
  onChange: (favorite: boolean) => void;
  disabled?: boolean;
  /** The recipe's name, for the screen reader ("Favourite Beef Chili"). */
  label: string;
  size?: number;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!favorite)}
      disabled={disabled}
      aria-pressed={favorite}
      aria-label={`${favorite ? "Remove from favourites" : "Favourite"} ${label}`}
      title={favorite ? "Your favourite" : "Mark as your favourite"}
      className={`p-1 rounded disabled:opacity-40 ${favorite ? "text-rose-500" : "text-slate-300 dark:text-slate-600 hover:text-rose-400"}`}
    >
      <Heart size={size} fill={favorite ? "currentColor" : "none"} />
    </button>
  );
}

export function RatingStars({
  rating,
  onChange,
  disabled = false,
  label,
  size = 15,
}: {
  rating: number | null;
  onChange: (rating: number | null) => void;
  disabled?: boolean;
  label: string;
  size?: number;
}) {
  return (
    <span role="group" aria-label={`Your rating for ${label}`} className="inline-flex items-center">
      {[1, 2, 3, 4, 5].map((n) => {
        const on = rating !== null && n <= rating;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(rating === n ? null : n)}
            disabled={disabled}
            aria-label={`${n} star${n === 1 ? "" : "s"}${rating === n ? " (tap again to clear)" : ""}`}
            aria-pressed={rating === n}
            className={`p-0.5 disabled:opacity-40 ${on ? "text-amber-500" : "text-slate-300 dark:text-slate-600 hover:text-amber-400"}`}
          >
            <Star size={size} fill={on ? "currentColor" : "none"} />
          </button>
        );
      })}
    </span>
  );
}
