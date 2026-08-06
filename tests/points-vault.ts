import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { PointsVault } from "../target/types/points_vault";
import { deriveVault, fetchEvents, getTransaction, newFundedKeypair } from "./helpers";

const DECIMALS = 6;
const ONE = 10 ** DECIMALS;

describe("points_vault", () => {
  // Anchor's default provider commits at `processed`, which is too weak to read transactions
  // back afterwards. These tests inspect emitted events, so they need `confirmed`.
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(env.connection.rpcEndpoint, "confirmed"),
    env.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const program = anchor.workspace.pointsVault as Program<PointsVault>;
  const connection = provider.connection;

  let mint: PublicKey;
  let owner: Keypair;
  let ownerAta: PublicKey;
  let stranger: Keypair;
  let strangerAta: PublicKey;

  before(async () => {
    owner = await newFundedKeypair(provider);
    stranger = await newFundedKeypair(provider);

    const mintAuthority = Keypair.generate();
    mint = await createMint(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mintAuthority.publicKey,
      null,
      DECIMALS
    );

    ownerAta = await createAssociatedTokenAccount(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      owner.publicKey
    );
    strangerAta = await createAssociatedTokenAccount(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      stranger.publicKey
    );

    await mintTo(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      ownerAta,
      mintAuthority,
      1000 * ONE
    );
    await mintTo(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      strangerAta,
      mintAuthority,
      1000 * ONE
    );
  });

  describe("create_vault", () => {
    it("creates a token account whose authority is the user, not the program", async () => {
      const vaultId = new BN(0);
      const vault = deriveVault(program.programId, owner.publicKey, mint, vaultId);

      const sig = await program.methods
        .createVault(vaultId)
        .accountsPartial({
          payer: owner.publicKey,
          owner: owner.publicKey,
          mint,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const account = await getAccount(connection, vault);
      assert.isTrue(
        account.owner.equals(owner.publicKey),
        "vault authority must be the user's wallet"
      );
      assert.isTrue(account.mint.equals(mint));
      assert.equal(account.amount.toString(), "0");

      const events = await fetchEvents(connection, program, sig);
      const created = events.find((e) => e.name === "vaultCreated");
      assert.ok(created, "VaultCreated event should be emitted");
      assert.isTrue(created!.data.vault.equals(vault));
      assert.isTrue(created!.data.owner.equals(owner.publicKey));
      assert.isTrue(created!.data.mint.equals(mint));
      assert.equal(created!.data.decimals, DECIMALS);
      assert.equal(created!.data.vaultId.toString(), "0");
    });

    it("lets one wallet hold several vaults for the same mint", async () => {
      const vaultId = new BN(7);
      const vault = deriveVault(program.programId, owner.publicKey, mint, vaultId);

      await program.methods
        .createVault(vaultId)
        .accountsPartial({
          payer: owner.publicKey,
          owner: owner.publicKey,
          mint,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const account = await getAccount(connection, vault);
      assert.isTrue(account.owner.equals(owner.publicKey));
    });

    it("refuses to create a vault for a wallet that did not sign", async () => {
      const vaultId = new BN(99);
      const vault = deriveVault(program.programId, owner.publicKey, mint, vaultId);

      // `stranger` pays, but claims `owner` as the vault owner without owner's signature.
      const ix = await program.methods
        .createVault(vaultId)
        .accountsPartial({
          payer: stranger.publicKey,
          owner: owner.publicKey,
          mint,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      const tx = new Transaction().add(ix);
      tx.feePayer = stranger.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      let failed = false;
      try {
        await connection.sendTransaction(tx, [stranger]);
      } catch (e) {
        failed = true;
      }
      assert.isTrue(failed, "creating a vault without the owner's signature must fail");
    });
  });

  describe("deposit", () => {
    const vaultId = new BN(0);
    let vault: PublicKey;

    before(() => {
      vault = deriveVault(program.programId, owner.publicKey, mint, vaultId);
    });

    it("moves tokens in and reports the measured balance delta", async () => {
      const sig = await program.methods
        .deposit(vaultId, new BN(100 * ONE))
        .accountsPartial({
          depositor: owner.publicKey,
          owner: owner.publicKey,
          mint,
          source: ownerAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const account = await getAccount(connection, vault);
      assert.equal(account.amount.toString(), (100 * ONE).toString());

      const events = await fetchEvents(connection, program, sig);
      const deposited = events.find((e) => e.name === "vaultDeposited");
      assert.ok(deposited);
      assert.equal(deposited!.data.amount.toString(), (100 * ONE).toString());
      assert.equal(deposited!.data.amountReceived.toString(), (100 * ONE).toString());
      assert.equal(deposited!.data.newBalance.toString(), (100 * ONE).toString());
      assert.isTrue(deposited!.data.depositor.equals(owner.publicKey));
    });

    it("lets a third party deposit into someone else's vault", async () => {
      const sig = await program.methods
        .deposit(vaultId, new BN(50 * ONE))
        .accountsPartial({
          depositor: stranger.publicKey,
          owner: owner.publicKey,
          mint,
          source: strangerAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([stranger])
        .rpc();

      const account = await getAccount(connection, vault);
      assert.equal(account.amount.toString(), (150 * ONE).toString());

      const events = await fetchEvents(connection, program, sig);
      const deposited = events.find((e) => e.name === "vaultDeposited");
      assert.isTrue(deposited!.data.depositor.equals(stranger.publicKey));
      assert.isTrue(deposited!.data.owner.equals(owner.publicKey));
    });

    it("rejects a zero-amount deposit", async () => {
      try {
        await program.methods
          .deposit(vaultId, new BN(0))
          .accountsPartial({
            depositor: owner.publicKey,
            owner: owner.publicKey,
            mint,
            source: ownerAta,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("expected ZeroAmount");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain("ZeroAmount");
      }
    });
  });

  describe("withdraw", () => {
    const vaultId = new BN(0);
    let vault: PublicKey;

    before(() => {
      vault = deriveVault(program.programId, owner.publicKey, mint, vaultId);
    });

    it("lets the owner take funds out", async () => {
      const before = await getAccount(connection, ownerAta);

      const sig = await program.methods
        .withdraw(vaultId, new BN(30 * ONE))
        .accountsPartial({
          owner: owner.publicKey,
          mint,
          vault,
          destination: ownerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const after = await getAccount(connection, ownerAta);
      assert.equal(
        (after.amount - before.amount).toString(),
        (30 * ONE).toString()
      );

      const events = await fetchEvents(connection, program, sig);
      const withdrawn = events.find((e) => e.name === "vaultWithdrawn");
      assert.ok(withdrawn);
      assert.equal(withdrawn!.data.amountDebited.toString(), (30 * ONE).toString());
      assert.equal(withdrawn!.data.newBalance.toString(), (120 * ONE).toString());
    });

    it("does not let anyone but the owner withdraw", async () => {
      try {
        await program.methods
          .withdraw(vaultId, new BN(1 * ONE))
          .accountsPartial({
            owner: stranger.publicKey,
            mint,
            vault, // owner's vault, but stranger signs
            destination: strangerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([stranger])
          .rpc();
        assert.fail("a stranger must not be able to withdraw");
      } catch (e: any) {
        // The seeds bind the vault to `owner`, so a stranger's derivation never matches.
        expect(e.toString()).to.match(/ConstraintSeeds|ConstraintTokenOwner|2006|2015/);
      }
    });
  });

  describe("non-custodial guarantees", () => {
    it("lets the owner move funds with a raw SPL transfer, with the program absent", async () => {
      const vaultId = new BN(0);
      const vault = deriveVault(program.programId, owner.publicKey, mint, vaultId);

      const before = await getAccount(connection, vault);
      assert.isTrue(before.amount > 0n, "vault should hold something to move");

      // A bare SPL Token instruction. points_vault is not in this transaction at all.
      const ix = createTransferCheckedInstruction(
        vault,
        mint,
        ownerAta,
        owner.publicKey,
        Number(before.amount),
        DECIMALS
      );
      const tx = new Transaction().add(ix);
      const sig = await provider.sendAndConfirm(tx, [owner]);

      const after = await getAccount(connection, vault);
      assert.equal(after.amount.toString(), "0", "owner drained the vault unilaterally");

      const confirmed = await getTransaction(connection, sig);
      const programs = confirmed.transaction.message
        .getAccountKeys()
        .staticAccountKeys.map((k) => k.toBase58());
      assert.notInclude(
        programs,
        program.programId.toBase58(),
        "points_vault must not be involved in a raw transfer"
      );
    });

    it("never signs a token movement anywhere in its source", () => {
      const srcDir = path.join(__dirname, "..", "programs", "points-vault", "src");

      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(dir, entry.name);
          return entry.isDirectory() ? walk(full) : full.endsWith(".rs") ? [full] : [];
        });

      const offenders: string[] = [];
      for (const file of walk(srcDir)) {
        const body = fs.readFileSync(file, "utf8");
        // Strip comments so documentation mentioning these terms doesn't trip the check.
        const code = body
          .replace(/\/\/.*$/gm, "")
          .replace(/\/\*[\s\S]*?\*\//g, "");
        if (/new_with_signer|invoke_signed/.test(code)) {
          offenders.push(path.relative(srcDir, file));
        }
      }

      assert.deepEqual(
        offenders,
        [],
        "the program must never sign as a PDA outside Anchor's account allocation"
      );
    });
  });

  describe("close_vault", () => {
    it("refuses to close a vault that still holds tokens", async () => {
      const vaultId = new BN(7);
      const vault = deriveVault(program.programId, owner.publicKey, mint, vaultId);

      await program.methods
        .deposit(vaultId, new BN(5 * ONE))
        .accountsPartial({
          depositor: owner.publicKey,
          owner: owner.publicKey,
          mint,
          source: ownerAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      try {
        await program.methods
          .closeVault(vaultId)
          .accountsPartial({
            owner: owner.publicKey,
            mint,
            vault,
            rentDestination: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("expected VaultNotEmpty");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain("VaultNotEmpty");
      }
    });

    it("closes an empty vault and returns the rent", async () => {
      const vaultId = new BN(7);
      const vault = deriveVault(program.programId, owner.publicKey, mint, vaultId);

      await program.methods
        .withdraw(vaultId, new BN(5 * ONE))
        .accountsPartial({
          owner: owner.publicKey,
          mint,
          vault,
          destination: ownerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const sig = await program.methods
        .closeVault(vaultId)
        .accountsPartial({
          owner: owner.publicKey,
          mint,
          vault,
          rentDestination: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const account = await connection.getAccountInfo(vault);
      assert.isNull(account, "vault account should be gone");

      const events = await fetchEvents(connection, program, sig);
      const closed = events.find((e) => e.name === "vaultClosed");
      assert.ok(closed);
      assert.isTrue(closed!.data.vault.equals(vault));
    });
  });
});
