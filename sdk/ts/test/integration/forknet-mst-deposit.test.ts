import Decimal from 'decimal.js';
import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  parseEther,
  parseUnits,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { Client, createSigners, withBlockchainRPC } from '../../src';

const DEFAULT_WS_URL = 'ws://127.0.0.1:7824/ws';
const DEFAULT_RPC_URL = 'http://127.0.0.1:8545';

const DEFAULT_ANVIL_FUNDER_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Default to Anvil's built-in unlocked accounts (excluding account #0, which is the clearnode signer by default).
// This matters because the SDK's Node.js fallback uses `eth_sendTransaction` (RPC signing), not local signing.
const DEFAULT_ANVIL_USER_PKS = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // #1
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // #2
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // #3
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // #4
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // #5
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', // #6
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356', // #7
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', // #8
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', // #9
] as const;

const erc20Abi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const channelHubAbi = [
  {
    type: 'function',
    name: 'getOpenChannels',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
] as const;

function asHexPk(value: string): `0x${string}` {
  if (!value) throw new Error('empty private key');
  const v = value.startsWith('0x') ? value : `0x${value}`;
  return v as `0x${string}`;
}

async function waitFor<T>(
  fn: () => Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number }
): Promise<T> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms. Last error: ${String(lastErr)}`);
}

describe('forknet (local) - Nitrolite deposit flow', () => {
  jest.setTimeout(120_000);

  test('mint + approve MST, then deposit via clearnode (creates/checkpoints channel on-chain)', async () => {
    const wsUrl = process.env.NITROLITE_WS_URL || DEFAULT_WS_URL;
    const rpcUrl = process.env.ANVIL_RPC_URL || DEFAULT_RPC_URL;
    const chainId = BigInt(process.env.NITROLITE_CHAIN_ID || '31337');

    const funderPk = asHexPk(process.env.NITROLITE_FUNDER_PRIVATE_KEY || DEFAULT_ANVIL_FUNDER_PK);
    const userPkOverride = process.env.NITROLITE_TEST_PRIVATE_KEY;

    const anvilChain = {
      id: Number(chainId),
      name: 'Anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    } as const;

    const publicClient = createPublicClient({
      chain: anvilChain,
      transport: http(rpcUrl),
    });

    // Smoke-check RPC.
    const liveChainId = await publicClient.getChainId();
    if (BigInt(liveChainId) !== chainId) {
      throw new Error(
        `Unexpected chain id from ${rpcUrl}: ${liveChainId} (expected ${chainId.toString()}).`
      );
    }

    const funderAccount = privateKeyToAccount(funderPk);

    const funderWalletClient = createWalletClient({
      chain: anvilChain,
      transport: http(rpcUrl),
      account: funderAccount,
    });

    // Bootstrap node config (no auth) using a known unlocked Anvil key.
    const seedPk = asHexPk(DEFAULT_ANVIL_USER_PKS[0]);
    const seedSigners = createSigners(seedPk);
    const seedClient = await Client.create(
      wsUrl,
      seedSigners.stateSigner,
      seedSigners.txSigner,
      withBlockchainRPC(chainId, rpcUrl)
    );

    let custodyFromSeed: Address;
    try {
      const cfg = await seedClient.getConfig();
      const custody = cfg.blockchains.find((b) => b.id === chainId)?.contractAddress as Address | undefined;
      if (!custody) {
        throw new Error(`Node does not report a custody contract for chain ${chainId.toString()}.`);
      }
      custodyFromSeed = custody;
    } finally {
      await seedClient.close();
    }

    let userPk: `0x${string}` | undefined = userPkOverride ? asHexPk(userPkOverride) : undefined;
    if (!userPk) {
      for (const candidate of DEFAULT_ANVIL_USER_PKS) {
        const candidatePk = asHexPk(candidate);
        const candidateAccount = privateKeyToAccount(candidatePk);
        const openChannels = (await publicClient.readContract({
          address: custodyFromSeed,
          abi: channelHubAbi,
          functionName: 'getOpenChannels',
          args: [candidateAccount.address],
        })) as `0x${string}`[];

        if (openChannels.length === 0) {
          userPk = candidatePk;
          break;
        }
      }
    }

    if (!userPk) {
      throw new Error(
        'No unused Anvil account found for a fresh channel. ' +
          'Reset forknet (docker compose down -v) or set NITROLITE_TEST_PRIVATE_KEY to a different Anvil key.'
      );
    }

    const userAccount = privateKeyToAccount(userPk);

    const walletClient = createWalletClient({
      chain: anvilChain,
      transport: http(rpcUrl),
      account: userAccount,
    });

    const { stateSigner, txSigner } = createSigners(userPk);
    const client = await Client.create(
      wsUrl,
      stateSigner,
      txSigner,
      withBlockchainRPC(chainId, rpcUrl)
    );

    try {
      const cfg = await client.getConfig();
      const custody = cfg.blockchains.find((b) => b.id === chainId)?.contractAddress;
      if (!custody) {
        throw new Error(`Node does not report a custody contract for chain ${chainId.toString()}.`);
      }

      if (cfg.nodeAddress.toLowerCase() === userAccount.address.toLowerCase()) {
        throw new Error(
          `Test user wallet (${userAccount.address}) must not equal node signer (${cfg.nodeAddress}). ` +
            `Set NITROLITE_TEST_PRIVATE_KEY to a different funded Anvil key.`
        );
      }

      const assets = await client.getAssets(chainId);
      const mst = assets.find((a) => a.symbol.toLowerCase() === 'mst');
      if (!mst) {
        throw new Error(
          `MST asset not found via clearnode. Make sure forknet assets.yaml includes MST (run ./forknet/up.sh).`
        );
      }

      const mstToken = mst.tokens.find((t) => t.blockchainId === chainId);
      if (!mstToken) {
        throw new Error(`MST token is not configured for chain ${chainId.toString()}.`);
      }

      const tokenAddress = mstToken.address as Address;

      // Ensure the user is funded for gas.
      const minEth = parseEther('0.05');
      const userEth = await publicClient.getBalance({ address: userAccount.address });
      if (userEth < minEth && funderAccount.address.toLowerCase() !== userAccount.address.toLowerCase()) {
        const fundTx = await funderWalletClient.sendTransaction({
          to: userAccount.address,
          value: parseEther('1'),
        });
        await publicClient.waitForTransactionReceipt({ hash: fundTx });
      }

      // Mint MST to user (contract is permissionless in forknet).
      const mintAmount = parseUnits('100', mstToken.decimals);
      const mintHash = await walletClient.writeContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'mint',
        args: [userAccount.address, mintAmount],
      });
      await publicClient.waitForTransactionReceipt({ hash: mintHash });

      // Approve custody to pull MST for channel creation/checkpoint deposits.
      const approveHash = await walletClient.writeContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [custody, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      // Execute the "yellow" flow: node signs channel creation, then we submit the on-chain tx.
      const txHash = await client.deposit(chainId, 'MST', new Decimal('1'));
      expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

      await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });

      // Wait for the node to recognize the newly opened channel (async event indexing).
      await waitFor(() => client.getHomeChannel(userAccount.address, 'MST'), {
        timeoutMs: 20_000,
        intervalMs: 250,
      });

      const state = await client.getLatestState(userAccount.address, 'MST', false);
      expect(state.homeChannelId).toBeTruthy();

      // Verify the channel exists on-chain for this user.
      const openChannels = (await publicClient.readContract({
        address: custody,
        abi: channelHubAbi,
        functionName: 'getOpenChannels',
        args: [userAccount.address],
      })) as `0x${string}`[];

      const expected = (state.homeChannelId as string).toLowerCase();
      expect(openChannels.map((id) => id.toLowerCase())).toContain(expected);

      // Sanity: token balance should be non-zero after mint.
      const tokenBal = (await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [userAccount.address],
      })) as bigint;
      expect(tokenBal > BigInt(0)).toBe(true);

      // Also exercise the checkpoint deposit path (existing open channel).
      const checkpointHash = await client.deposit(chainId, 'MST', new Decimal('1'));
      expect(checkpointHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      await publicClient.waitForTransactionReceipt({ hash: checkpointHash as `0x${string}` });
    } finally {
      await client.close();
    }
  });
});
