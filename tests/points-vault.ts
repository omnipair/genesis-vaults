import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getMint,
  getMintLen,
  getTransferFeeAmount,
  getTransferFeeConfig,
  mintTo,
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
  // The owner's one and only vault for `mint`.
  let vault: PublicKey;

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

    vault = deriveVault(program.programId, owner.publicKey, mint);
  });

  describe("create_vault", () => {
    it("creates a token account whose authority is the user, not the program", async () => {
      const sig = await program.methods
        .createVault()
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
    });

    it("allows only one vault per mint", async () => {
      // The address depends on nothing but owner and mint, so there is no second address to
      // create. Allocation fails because the account is already there.
      let failed = false;
      try {
        await program.methods
          .createVault()
          .accountsPartial({
            payer: owner.publicKey,
            owner: owner.publicKey,
            mint,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
      } catch (e) {
        failed = true;
      }
      assert.isTrue(failed, "a second vault for the same mint must not be creatable");

      // And the original is untouched by the attempt.
      const account = await getAccount(connection, vault);
      assert.isTrue(account.owner.equals(owner.publicKey));
    });

    it("refuses to create a vault for a wallet that did not sign", async () => {
      // A wallet with no vault yet, so this fails on the missing signature rather than on the
      // address already being occupied.
      const victim = Keypair.generate();
      const victimVault = deriveVault(program.programId, victim.publicKey, mint);

      const ix = await program.methods
        .createVault()
        .accountsPartial({
          payer: stranger.publicKey,
          owner: victim.publicKey,
          mint,
          vault: victimVault,
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

      const account = await connection.getAccountInfo(victimVault);
      assert.isNull(account, "no vault should have been created");
    });
  });

  describe("deposit", () => {
    it("moves tokens in and reports the measured balance delta", async () => {
      const sig = await program.methods
        .deposit(new BN(100 * ONE))
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
        .deposit(new BN(50 * ONE))
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
          .deposit(new BN(0))
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
        assert.fail("a zero amount must be rejected");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain("ZeroAmount");
      }
    });

    it("rejects a deposit that names the vault as its own source", async () => {
      // The token program accepts a transfer from an account to itself and moves nothing, so
      // without the guard this would emit a deposit for an `amount` nobody ever sent.
      const before = await getAccount(connection, vault);

      try {
        await program.methods
          .deposit(new BN(10 * ONE))
          .accountsPartial({
            depositor: owner.publicKey,
            owner: owner.publicKey,
            mint,
            source: vault,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("a deposit from the vault to itself must be rejected");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain("SelfTransfer");
      }

      const after = await getAccount(connection, vault);
      assert.equal(after.amount.toString(), before.amount.toString());
    });
  });

  describe("withdraw", () => {
    it("lets the owner take funds out", async () => {
      const before = await getAccount(connection, ownerAta);

      const sig = await program.methods
        .withdraw(new BN(30 * ONE))
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
          .withdraw(new BN(1 * ONE))
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

    it("rejects a withdrawal that names the vault as its own destination", async () => {
      const before = await getAccount(connection, vault);

      try {
        await program.methods
          .withdraw(new BN(10 * ONE))
          .accountsPartial({
            owner: owner.publicKey,
            mint,
            vault,
            destination: vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("a withdrawal into the vault itself must be rejected");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain("SelfTransfer");
      }

      const after = await getAccount(connection, vault);
      assert.equal(after.amount.toString(), before.amount.toString());
    });
  });

  describe("non-custodial guarantees", () => {
    it("lets the owner move funds with a raw SPL transfer, with the program absent", async () => {
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
      await program.methods
        .deposit(new BN(5 * ONE))
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
          .closeVault()
          .accountsPartial({
            owner: owner.publicKey,
            mint,
            vault,
            rentDestination: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("a vault holding tokens must not be closeable");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain("VaultNotEmpty");
      }
    });

    it("closes an empty vault and returns the rent", async () => {
      await program.methods
        .withdraw(new BN(5 * ONE))
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
        .closeVault()
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

    it("frees the address for a new vault, so the limit is one at a time", async () => {
      // One vault per mint is a limit on how many exist at once, not on how many a wallet may
      // ever have. The indexer relies on this: a vault row can have several incarnations.
      await program.methods
        .createVault()
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
      assert.equal(account.amount.toString(), "0");
    });
  });

  // Everything above runs on a classic mint, where the amount sent and the amount received are
  // always the same number. A transfer fee is what makes them diverge, and it is the reason
  // both fields exist. It also parks value in a vault that is not part of its balance.
  describe("token-2022 transfer fees", () => {
    const FEE_BPS = 100;
    /** Set high enough that the basis points, never the cap, decide the fees below. */
    const MAX_FEE = BigInt(1000 * ONE);

    const feeOn = (amount: number) => (amount * FEE_BPS) / 10_000;

    let feeMint: PublicKey;
    let feeOwnerAta: PublicKey;
    let feeVault: PublicKey;

    /** Fees taken out of transfers into `address`, waiting to be swept to the mint. */
    async function withheldOn(address: PublicKey): Promise<bigint> {
      const account = await getAccount(connection, address, undefined, TOKEN_2022_PROGRAM_ID);
      return getTransferFeeAmount(account)?.withheldAmount ?? 0n;
    }

    async function withheldOnMint(): Promise<bigint> {
      const info = await getMint(connection, feeMint, undefined, TOKEN_2022_PROGRAM_ID);
      return getTransferFeeConfig(info)?.withheldAmount ?? 0n;
    }

    before(async () => {
      const payer = (provider.wallet as anchor.Wallet).payer;
      const mintKeypair = Keypair.generate();
      feeMint = mintKeypair.publicKey;

      // A mint carrying an extension has to be allocated and initialised by hand: the
      // extension must be in place before InitializeMint2 fixes the layout.
      const space = getMintLen([ExtensionType.TransferFeeConfig]);
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: feeMint,
            space,
            lamports: await connection.getMinimumBalanceForRentExemption(space),
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          createInitializeTransferFeeConfigInstruction(
            feeMint,
            payer.publicKey,
            payer.publicKey,
            FEE_BPS,
            MAX_FEE,
            TOKEN_2022_PROGRAM_ID
          ),
          createInitializeMint2Instruction(
            feeMint,
            DECIMALS,
            payer.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [mintKeypair]
      );

      feeOwnerAta = await createAssociatedTokenAccount(
        connection,
        payer,
        feeMint,
        owner.publicKey,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        feeMint,
        feeOwnerAta,
        payer,
        1000 * ONE,
        [],
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // The same wallet already has a vault for the classic mint, so this also covers one
      // wallet holding vaults for two different mints.
      feeVault = deriveVault(program.programId, owner.publicKey, feeMint);
    });

    it("creates a vault sized for the extensions the mint requires", async () => {
      await program.methods
        .createVault()
        .accountsPartial({
          payer: owner.publicKey,
          owner: owner.publicKey,
          mint: feeMint,
          vault: feeVault,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      // A fee mint requires its token accounts to carry TransferFeeAmount, so allocating only
      // the base 165 bytes would have failed at initialisation.
      const account = await getAccount(connection, feeVault, undefined, TOKEN_2022_PROGRAM_ID);
      assert.isTrue(account.owner.equals(owner.publicKey));
      assert.isNotNull(getTransferFeeAmount(account), "vault should carry the fee extension");
    });

    it("reports the amount that arrived, not the amount that was sent", async () => {
      const sent = 100 * ONE;

      const sig = await program.methods
        .deposit(new BN(sent))
        .accountsPartial({
          depositor: owner.publicKey,
          owner: owner.publicKey,
          mint: feeMint,
          source: feeOwnerAta,
          vault: feeVault,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const events = await fetchEvents(connection, program, sig);
      const deposited = events.find((e) => e.name === "vaultDeposited");
      assert.ok(deposited);
      assert.equal(deposited!.data.amount.toString(), sent.toString());
      assert.equal(
        deposited!.data.amountReceived.toString(),
        (sent - feeOn(sent)).toString(),
        "the fee is taken on the way in"
      );
      assert.isTrue(
        deposited!.data.amountReceived.lt(deposited!.data.amount),
        "a measured delta is the whole reason these are two fields"
      );

      const account = await getAccount(connection, feeVault, undefined, TOKEN_2022_PROGRAM_ID);
      assert.equal(account.amount.toString(), (sent - feeOn(sent)).toString());
      assert.equal((await withheldOn(feeVault)).toString(), feeOn(sent).toString());
    });

    it("debits the vault in full on the way out, the fee falling on the destination", async () => {
      const asked = 50 * ONE;
      const before = await getAccount(connection, feeOwnerAta, undefined, TOKEN_2022_PROGRAM_ID);

      const sig = await program.methods
        .withdraw(new BN(asked))
        .accountsPartial({
          owner: owner.publicKey,
          mint: feeMint,
          vault: feeVault,
          destination: feeOwnerAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const events = await fetchEvents(connection, program, sig);
      const withdrawn = events.find((e) => e.name === "vaultWithdrawn");
      assert.ok(withdrawn);
      assert.equal(
        withdrawn!.data.amountDebited.toString(),
        asked.toString(),
        "the vault loses the whole amount; the fee comes out of what arrives"
      );

      const after = await getAccount(connection, feeOwnerAta, undefined, TOKEN_2022_PROGRAM_ID);
      assert.equal((after.amount - before.amount).toString(), (asked - feeOn(asked)).toString());
    });

    it("closes a vault that is empty but still holds withheld fees", async () => {
      const remaining = await getAccount(connection, feeVault, undefined, TOKEN_2022_PROGRAM_ID);
      await program.methods
        .withdraw(new BN(remaining.amount.toString()))
        .accountsPartial({
          owner: owner.publicKey,
          mint: feeMint,
          vault: feeVault,
          destination: feeOwnerAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      // Fees are withheld in the account receiving a transfer, so the deposit above left them
      // in the vault and no withdrawal takes them out again. The token program refuses to
      // close an account while they sit there.
      const withheld = await withheldOn(feeVault);
      assert.isTrue(withheld > 0n, "vault must really hold fees or this proves nothing");

      const mintBefore = await withheldOnMint();

      await program.methods
        .closeVault()
        .accountsPartial({
          owner: owner.publicKey,
          mint: feeMint,
          vault: feeVault,
          rentDestination: owner.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      assert.isNull(await connection.getAccountInfo(feeVault), "vault should be gone");
      assert.equal(
        ((await withheldOnMint()) - mintBefore).toString(),
        withheld.toString(),
        "the fees were swept to the mint, not destroyed with the account"
      );
    });
  });
});
