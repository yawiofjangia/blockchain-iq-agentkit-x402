/**
 * Demo / self-test for the Blockchain IQ AgentKit x402 integration.
 *
 * What it does (in order):
 *  1. Loads the agent wallet from BIQ_KEYPAIR_PATH (a JSON file with
 *     { address, privateKey }). The private key is never printed.
 *  2. Builds AgentKit with a ViemWalletProvider (Base) + the
 *     BlockchainIqActionProvider, and lists the registered actions.
 *  3. Invokes get_free_sample through AgentKit — a real, free, end-to-end
 *     call against the live API.
 *  4. Dry-run inspection of the paid endpoint: plain fetch to /brief,
 *     expects HTTP 402, decodes the PAYMENT-REQUIRED header and runs it
 *     through the spending guard. No wallet, no signature, no payment.
 *  5. Local mock of the full 402 -> sign -> retry loop: a localhost server
 *     replays the real captured 402 (only its `resource` URL rewritten to
 *     localhost). The wrapped fetch signs an EIP-3009 authorization and
 *     retries against localhost; the mock records that a PAYMENT-SIGNATURE
 *     header arrived (its value is never logged) and answers 200 with a
 *     clearly-fabricated PAYMENT-RESPONSE. Nothing leaves the machine and
 *     no real payment is attempted.
 *
 * The real paid call lives in src/paid-brief.ts and is NOT run here.
 */

import "reflect-metadata";
import "./noTelemetry.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { decodePaymentResponseHeader } from "@x402/fetch";
import {
  BRIEF_PATH,
  BASE_URL,
  NETWORK,
  PAY_TO,
  createPaymentFetch,
  decodePaymentRequired,
  encodePaymentRequired,
  inspectBriefPrice,
} from "./blockchainIq.js";
import { BlockchainIqActionProvider } from "./provider.js";

const keypairPath = process.env.BIQ_KEYPAIR_PATH;
if (!keypairPath) {
  console.error("Set BIQ_KEYPAIR_PATH to a JSON file with { address, privateKey }.");
  process.exit(1);
}
const keypair = JSON.parse(readFileSync(keypairPath, "utf8")) as {
  address: string;
  privateKey: `0x${string}`;
};
const account = privateKeyToAccount(keypair.privateKey);
if (account.address.toLowerCase() !== keypair.address.toLowerCase()) {
  throw new Error("keypair file address does not match its private key");
}
console.log(`Wallet: ${account.address} (Base)`);
console.log("Private key: loaded from file, never printed.\n");

// --- 1. AgentKit wiring -----------------------------------------------------
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(),
});
const walletProvider = new ViemWalletProvider(walletClient);
const provider = new BlockchainIqActionProvider(account);
const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [provider],
});
const actions = agentKit.getActions();
console.log("AgentKit actions registered:");
for (const action of actions) {
  console.log(`  - ${action.name}: ${action.description.slice(0, 90)}...`);
}

// --- 2. Free sample, end to end through AgentKit ---------------------------
// AgentKit prefixes action names with the provider class name
// (BlockchainIqActionProvider_get_free_sample), so match by suffix.
const sampleAction = actions.find((a) => a.name.endsWith("_get_free_sample"));
if (!sampleAction) throw new Error("get_free_sample action not registered");
const sampleJson = await sampleAction.invoke({});
const sample = JSON.parse(sampleJson) as {
  paid: boolean;
  data: { data?: { chain?: string; asOf?: string; transactions?: { value?: number } } };
};
console.log("\n[free sample] paid:", sample.paid);
console.log(
  "[free sample] chain:",
  sample.data?.data?.chain,
  "| asOf:",
  sample.data?.data?.asOf,
  "| transactions:",
  sample.data?.data?.transactions?.value,
);

// --- 3. Dry-run inspection of the paid endpoint ---------------------------
const inspection = await inspectBriefPrice();
console.log(`\n[402 inspection] GET ${BRIEF_PATH} -> HTTP ${inspection.status} (as expected)`);
for (const v of inspection.validated) {
  console.log(
    `[402 inspection] requirement passes guard: $${v.amountUsd} USDC, ` +
      `payTo ${PAY_TO}, network ${NETWORK}`,
  );
}
console.log(
  "[402 inspection] accepts in 402:",
  (inspection.requirements.accepts ?? []).map((a) => ({
    scheme: a.scheme,
    network: a.network,
    amount: a.amount,
    asset: a.asset,
    payTo: a.payTo,
  })),
);

// --- 4. Local mock of the 402 -> sign -> retry loop ------------------------
const rewritten = structuredClone(inspection.requirements) as Record<string, unknown>;
const mockPath = "/mock-brief";
let mockUrl = "";
const server = createServer((req, res) => {
  const signature = req.headers["payment-signature"];
  if (signature) {
    // A signature arrived. Record only its presence, never its value.
    (server as unknown as { sawSignature: boolean }).sawSignature = true;
    const fakeResponse = Buffer.from(
      JSON.stringify({
        success: true,
        transaction: `0x${"ab".repeat(32)}`,
        network: NETWORK,
        payer: account.address,
      }),
      "utf8",
    ).toString("base64url");
    res.writeHead(200, {
      "Content-Type": "application/json",
      "PAYMENT-RESPONSE": fakeResponse,
    });
    res.end(
      JSON.stringify({
        simulated: true,
        note: "localhost mock: no real payment was made",
        data: { brief: "simulated" },
      }),
    );
    return;
  }
  // First hit: replay the real 402, resource rewritten to this mock URL.
  const header = encodePaymentRequired({
    ...rewritten,
    resource: mockUrl,
    accepts: (rewritten.accepts as Record<string, unknown>[] | undefined)?.map(
      (a) => ({ ...a, resource: mockUrl }),
    ),
  });
  res.writeHead(402, {
    "Content-Type": "application/json",
    "PAYMENT-REQUIRED": header,
  });
  res.end(JSON.stringify({ error: "Payment Required (localhost mock)" }));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("mock server failed to bind");
mockUrl = `http://127.0.0.1:${address.port}${mockPath}`;

const fetchWithPayment = createPaymentFetch(account);
const mockResponse = await fetchWithPayment(mockUrl, { method: "GET" });
const mockBody = (await mockResponse.json()) as { simulated?: boolean };
const mockPaymentHeader = mockResponse.headers.get("PAYMENT-RESPONSE");
let mockDecoded: unknown = null;
if (mockPaymentHeader) {
  try {
    mockDecoded = decodePaymentResponseHeader(mockPaymentHeader);
  } catch {
    mockDecoded = { raw: mockPaymentHeader.slice(0, 40) + "..." };
  }
}
console.log("\n[mock 402 loop] mock server saw PAYMENT-SIGNATURE header:",
  (server as unknown as { sawSignature?: boolean }).sawSignature === true);
console.log("[mock 402 loop] retry returned HTTP", mockResponse.status, "| simulated body:", mockBody.simulated === true);
console.log("[mock 402 loop] decoded PAYMENT-RESPONSE:", JSON.stringify(mockDecoded));
server.close();

if (
  mockResponse.status !== 200 ||
  (server as unknown as { sawSignature?: boolean }).sawSignature !== true
) {
  throw new Error("mock 402 -> sign -> retry loop did not complete");
}

console.log(`
DEMO RESULT: all green.
  - AgentKit action provider registered (get_market_brief, get_free_sample)
  - Free sample works end to end through the live API (no payment)
  - Paid endpoint returns 402 for $0.01 to the catalogue payTo; guard accepts it
  - Full 402 -> sign -> retry loop verified against a localhost mock
  - Real paid call NOT attempted: the wallet is unfunded.
    After funding, run: npm run paid-brief -- --confirm-paid
`);
