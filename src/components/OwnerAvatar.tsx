/**
 * An owner's SBS profile picture, shown next to their name anywhere the site
 * lists owners (Leaderboard, Most Teams, Advancement). Owner.imageUrl is
 * synced from SBS's own profile API by syncStandings/syncLeaderboard, so
 * these are the same images sbsfantasy.com shows. Owners who never set one
 * get a banana, which is SBS's own default too.
 *
 * Plain <img> rather than next/image, same as the owner page: these are tiny
 * and it avoids having to allowlist every host SBS might serve them from.
 */
export default function OwnerAvatar({ imageUrl }: { imageUrl: string | null | undefined }) {
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        loading="lazy"
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
