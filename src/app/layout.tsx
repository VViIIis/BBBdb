import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BBBdb",
  description:
    "BBBdb — unofficial, free leaderboard and team tracker for SBS Banana Best Ball. Not affiliated with Spoiled Banana Society.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto max-w-5xl px-4 py-6">
          <header className="mb-6 flex items-center justify-between">
            <a href="/" className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
              <span aria-hidden>🍌</span>
              <span>
                BBB<span className="text-banana-400">db</span>
              </span>
            </a>
            <nav className="flex gap-4 text-sm text-zinc-400">
              <a href="/" className="hover:text-banana-400">
                Leaderboard
              </a>
              <a href="/owners" className="hover:text-banana-400">
                Most Teams
              </a>
              <a href="/exposure" className="hover:text-banana-400">
                Exposure
              </a>
            </nav>
          </header>
          {children}
          <footer className="mt-12 border-t border-ink-600 pt-4 text-center text-xs text-zinc-500">
            <div className="mb-3 flex flex-col items-center gap-2">
              <img
                src="/ape-avatar.png"
                alt="VViIIis.eth"
                className="h-12 w-12 rounded-full border border-ink-600 object-cover"
              />
              <p>
                Built by{" "}
                <span className="font-semibold text-zinc-300">VViIIis.eth</span> — like the site?
                Tip a banana 🍌{" "}
                <span className="font-mono text-zinc-300">VViIIis.eth</span>
              </p>
            </div>
            Unofficial fan project. Not affiliated with SBS / Spoiled Banana Society. Data sourced
            from sbsfantasy.com&rsquo;s public leaderboard and the Banana Best Ball NFT collection
            on OpenSea.
          </footer>
        </div>
      </body>
    </html>
  );
}
