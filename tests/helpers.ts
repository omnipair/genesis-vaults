import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/// Anchor tags every `emit_cpi!` self-CPI with this 8-byte prefix before the event's own
/// discriminator. See anchor-lang's `EVENT_IX_TAG_LE`.
const CPI_EVENT_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export const VAULT_SEED = Buffer.from("vault");

export function deriveVault(
  programId: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, owner.toBuffer(), mint.toBuffer()],
    programId
  )[0];
}

/**
 * Pull `emit_cpi!` events out of a confirmed transaction. Because these events are self-CPIs
 * rather than log lines, they live in the transaction's inner instructions. This mirrors what
 * the Rust indexer does, so it doubles as a check that the events are decodable downstream.
 */
/**
 * A confirmed signature is not immediately queryable via getTransaction, so poll briefly.
 */
export async function getTransaction(connection: Connection, signature: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`transaction ${signature} never became available`);
}

export async function fetchEvents<T extends anchor.Idl>(
  connection: Connection,
  program: Program<T>,
  signature: string
): Promise<{ name: string; data: any }[]> {
  const tx = await getTransaction(connection, signature);
  if (!tx?.meta?.innerInstructions) return [];

  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses,
  });

  const events: { name: string; data: any }[] = [];
  for (const inner of tx.meta.innerInstructions) {
    for (const ix of inner.instructions) {
      if (!keys.get(ix.programIdIndex)?.equals(program.programId)) continue;

      const data = Buffer.from(bs58.decode(ix.data));
      if (data.length < 16 || !data.subarray(0, 8).equals(CPI_EVENT_TAG)) continue;

      const decoded = program.coder.events.decode(
        data.subarray(8).toString("base64")
      );
      if (decoded) events.push({ name: decoded.name, data: decoded.data });
    }
  }
  return events;
}

export async function fund(
  provider: anchor.AnchorProvider,
  to: PublicKey,
  lamports: number
): Promise<void> {
  const ix = anchor.web3.SystemProgram.transfer({
    fromPubkey: provider.wallet.publicKey,
    toPubkey: to,
    lamports,
  });
  await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix));
}

export async function newFundedKeypair(
  provider: anchor.AnchorProvider,
  lamports = 2 * anchor.web3.LAMPORTS_PER_SOL
): Promise<Keypair> {
  const kp = Keypair.generate();
  await fund(provider, kp.publicKey, lamports);
  return kp;
}
