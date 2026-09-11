import "dotenv/config";
/**
 * One-shot diagnostic. Run BEFORE scripts/sync-collection.ts to confirm real
 * field/trait names. Checks two things:
 *  1. A page of the bulk collection listing (confirms pagination + traits on
 *     an UNREVEALED "Draft Pass" token).
 *  2. One SPECIFIC token we know is a fully drafted, revealed team (card
 *     #7304, "UsedCarSales" from the SBS leaderboard sync) via the
 *     single-NFT endpoint, to see real roster trait names.
 * Delete this file once sync-collection.ts is confirmed working.
 */
const OPENSEA_BASE = "https://api.opensea.io/api/v2";
const slug = process.env.OPENSEA_COLLECTION_SLUG ?? "banana-best-ball-4";
const CONTRACT = "0xadf5b9b46616de6d073f226e7b7c532ae2cffb80"; // confirmed via live API response
const CHAIN = process.env.NFT_CHAIN ?? "base";
const KNOWN_DRAFTED_TOKEN = "7304"; // UsedCarSales, rank 1 in our leaderboard sync

async function main() {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) throw new Error("Set OPENSEA_API_KEY in .env first");
  const headers = { accept: "application/json", "x-api-key": key };

  console.log("=== single known-drafted token ===");
  const res1 = await fetch(
    `${OPENSEA_BASE}/chain/${CHAIN}/contract/${CONTRACT}/nfts/${KNOWN_DRAFTED_TOKEN}`,
    { headers },
  );
  console.log("status:", res1.status);
  console.log(await res1.text());

  console.log("\n=== ownerOf via Base public RPC (no key needed) ===");
  const paddedId = BigInt(KNOWN_DRAFTED_TOKEN).toString(16).padStart(64, "0");
  const rpcRes = await fetch("https://mainnet.base.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: CONTRACT, data: "0x6352211e" + paddedId }, "latest"],
    }),
  });
  const rpcJson = await rpcRes.json();
  console.log(JSON.stringify(rpcJson));
  if (rpcJson.result && rpcJson.result !== "0x") {
    console.log("owner address:", "0x" + rpcJson.result.slice(-40));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
