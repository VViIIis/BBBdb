"use client";

import { useEffect, useRef, useState } from "react";

/**
 * An owner's SBS profile picture, shown next to their name anywhere the site
 * lists owners (Leaderboard, Most Teams, Advancement). Owner.imageUrl is
 * synced from SBS's own profile API by syncStandings/syncLeaderboard, so
 * these are the same images sbsfantasy.com shows. Owners who never set one
 * get a banana, which is SBS's own default too.
 *
 * A client component only so it can swap to the banana when an image URL
 * fails to load — some SBS profile picture links are dead, and those showed
 * a broken-image icon instead.
 *
 * Plain <img> rather than next/image, same as the owner page: these are tiny
 * and it avoids having to allowlist every host SBS might serve them from.
 */
export default function OwnerAvatar({ imageUrl }: { imageUrl: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // An image that already failed before React hydrated never fires onError,
  // so check once on mount too.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, []);
  if (imageUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={imgRef}
        src={imageUrl}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-7 w-7 shrink-0 rounded-full border border-ink-600 object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ink-600 bg-ink-800 text-sm"
    >
      🍌
    </span>
  );
}
