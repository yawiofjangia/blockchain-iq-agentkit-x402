/**
 * Coinbase AgentKit action provider for Blockchain IQ's x402 market-data API.
 *
 * Two actions, both parameter-free:
 *  - get_market_brief — the paid call ($0.01, Base USDC). The opening call
 *    of a trading-agent loop: BTC/ETH/SOL/XRP with price and 24h/7d/30d
 *    moves, scheduled events in the next 48h, and short risk flags.
 *  - get_free_sample — the free Bitcoin-network sample, for testing the
 *    integration before any payment.
 *
 * The provider is constructed with the agent's viem account; the x402
 * payment client is built from that same account, so the payer is always
 * the wallet AgentKit itself is using. Spending is capped by the guard in
 * ./blockchainIq.ts (Base USDC only, the catalogue payTo only, max $2.00
 * per payment) — the provider never handles raw amounts.
 */

import "reflect-metadata";
import {
  ActionProvider,
  CreateAction,
  Network,
  WalletProvider,
} from "@coinbase/agentkit";
import { z } from "zod";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  BRIEF_PRICE_USD,
  createPaymentFetch,
  fetchBrief,
  fetchFreeSample,
} from "./blockchainIq.js";

export const GetMarketBriefSchema = z.object({});
export const GetFreeSampleSchema = z.object({});

export class BlockchainIqActionProvider extends ActionProvider<WalletProvider> {
  private readonly fetchWithPayment: typeof fetch;

  constructor(account: PrivateKeyAccount) {
    super("blockchain-iq-x402", []);
    this.fetchWithPayment = createPaymentFetch(account);
  }

  supportsNetwork = (_network: Network) => true;

  @CreateAction({
    name: "get_market_brief",
    description:
      "Fetch the Blockchain IQ market brief (x402, $0.01 USDC on Base): " +
      "BTC, ETH, SOL and XRP with price, 24h/7d/30d moves and rank, " +
      "scheduled events in the next 48 hours, and short risk flags. " +
      "The $0.01 is paid from the agent wallet via x402; the response " +
      "includes the on-chain payment transaction hash.",
    schema: GetMarketBriefSchema,
  })
  async getMarketBrief(
    walletProvider: WalletProvider,
    _args: z.infer<typeof GetMarketBriefSchema>,
  ): Promise<string> {
    const payer = await walletProvider.getAddress();
    const result = await fetchBrief(this.fetchWithPayment);
    return JSON.stringify(
      {
        action: "get_market_brief",
        payer,
        paid: true,
        priceUsd: BRIEF_PRICE_USD,
        paymentTxHash: result.paymentTxHash,
        payment: result.payment,
        data: result.data,
      },
      null,
      2,
    );
  }

  @CreateAction({
    name: "get_free_sample",
    description:
      "Fetch the free Blockchain IQ sample (no payment): Bitcoin network " +
      "activity for its latest day — transactions, active addresses and " +
      "fees. Use it to test the integration before paying for anything.",
    schema: GetFreeSampleSchema,
  })
  async getFreeSample(
    walletProvider: WalletProvider,
    _args: z.infer<typeof GetFreeSampleSchema>,
  ): Promise<string> {
    const payer = await walletProvider.getAddress();
    const result = await fetchFreeSample(this.fetchWithPayment);
    return JSON.stringify(
      {
        action: "get_free_sample",
        payer,
        paid: false,
        priceUsd: 0,
        data: result.data,
      },
      null,
      2,
    );
  }
}

export const blockchainIqActionProvider = (account: PrivateKeyAccount) =>
  new BlockchainIqActionProvider(account);
