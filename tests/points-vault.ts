import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createInitializeNonTransferableMintInstruction,
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
import {
  deriveVault,
  deriveVaultTokenAccount,
  fetchEvents,
  getTransaction,
  newFundedKeypair,
} from "./helpers";

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
  let mintB: PublicKey;
  let owner: Keypair;
  let ownerAta: PublicKey;
  let ownerAtaB: PublicKey;
  let stranger: Keypair;
  let strangerAta: PublicKey;

  /** The owner's one and only vault, spanning every mint they hold. */
  let vault: PublicKey;
  /** Where that vault holds `mint`, and where it holds `mintB`. */
  let vaultAta: PublicKey;
  let vaultAtaB: PublicKey;

  async function mintFor(authority: Keypair): Promise<PublicKey> {
    return createMint(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      authority.publicKey,
      null,
      DECIMALS
    );
  }

  before(async () => {
    owner = await newFundedKeypair(provider);
    stranger = await newFundedKeypair(provider);

    const mintAuthority = Keypair.generate();
    mint = await mintFor(mintAuthority);
    mintB = await mintFor(mintAuthority);

    const payer = (provider.wallet as anchor.Wallet).payer;

    ownerAta = await createAssociatedTokenAccount(
      connection,
      payer,
      mint,
      owner.publicKey
    );
    ownerAtaB = await createAssociatedTokenAccount(
      connection,
      payer,
      mintB,
      owner.publicKey
    );
    strangerAta = await createAssociatedTokenAccount(
      connection,
      payer,
      mint,
      stranger.publicKey
    );

    for (const [target, which] of [
      [ownerAta, mint],
      [ownerAtaB, mintB],
      [strangerAta, mint],
    ] as const) {
      await mintTo(connection, payer, which, target, mintAuthority, 1000 * ONE);
    }

    vault = deriveVault(program.programId, owner.publicKey);
    vaultAta = deriveVaultTokenAccount(vault, mint);
    vaultAtaB = deriveVaultTokenAccount(vault, mintB);
  });

  describe("create_vault", () => {
    it("creates one account per wallet, recording its owner", async () => {
      const sig = await program.methods
        .createVault()
        .accountsPartial({
          payer: owner.publicKey,
          owner: owner.publicKey,
          vault,
        })
        .signers([owner])
        .rpc();

      const account = await program.account.vault.fetch(vault);
      assert.isTrue(account.owner.equals(owner.publicKey));

      const events = await fetchEvents(connection, program, sig);
      const created = events.find((e) => e.name === "vaultCreated");
      assert.ok(created, "VaultCreated event should be emitted");
      assert.isTrue(created!.data.vault.equals(vault));
      assert.isTrue(created!.data.owner.equals(owner.publicKey));
    });

    it("allows only one vault per wallet", async () => {
      // The address depends on nothing but the owner, so there is no second address to
      // create. Allocation fails because the account is already there.
      let failed = false;
      try {
        await program.methods
          .createVault()
          .accountsPartial({
            payer: owner.publicKey,
            owner: owner.publicKey,
            vault,
          })
          .signers([owner])
          .rpc();
      } catch (e) {
        failed = true;
      }
      assert.isTrue(
        failed,
        "a second vault for the same wallet must not be creatable"
      );
    });

    it("refuses to create a vault for a wallet that did not sign", async () => {
      const victim = Keypair.generate();
      const victimVault = deriveVault(program.programId, victim.publicKey);

      const ix = await program.methods
        .createVault()
        .accountsPartial({
          payer: stranger.publicKey,
          owner: victim.publicKey,
          vault: victimVault,
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
      assert.isTrue(
        failed,
        "creating a vault without the owner's signature must fail"
      );
      assert.isNull(await connection.getAccountInfo(victimVault));
    });
  });

  describe("open_token_account", () => {
    it("creates a token account whose authority is the vault, not the wallet", async () => {
      const sig = await program.methods
        .openTokenAccount()
        .accountsPartial({
          payer: owner.publicKey,
          owner: owner.publicKey,
          vault,
          mint,
          tokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const account = await getAccount(connection, vaultAta);
      assert.isTrue(
        account.owner.equals(vault),
        "the vault PDA holds the token authority; the wallet does not"
      );
      assert.isFalse(account.owner.equals(owner.publicKey));
      assert.isTrue(account.mint.equals(mint));

      const events = await fetchEvents(connection, program, sig);
      const opened = events.find((e) => e.name === "tokenAccountOpened");
      assert.ok(opened, "TokenAccountOpened event should be emitted");
      assert.isTrue(opened!.data.vault.equals(vault));
      assert.isTrue(opened!.data.tokenAccount.equals(vaultAta));
      assert.isTrue(opened!.data.mint.equals(mint));
      assert.equal(opened!.data.decimals, DECIMALS);
    });

    it("is idempotent, because anyone can create the same ATA without us", async () => {
      // This is not hypothetical: the address is an ordinary ATA, so the associated token
      // program will make it for anybody who asks. Create it out-of-band first, exactly as a
      // stranger would, and the program must still be able to register the mint.
      const ix = createAssociatedTokenAccountInstruction(
        stranger.publicKey,
        vaultAtaB,
        vault,
        mintB,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      await provider.sendAndConfirm(new Transaction().add(ix), [stranger]);
      assert.isNotNull(await connection.getAccountInfo(vaultAtaB));

      const sig = await program.methods
        .openTokenAccount()
        .accountsPartial({
          payer: owner.publicKey,
          owner: owner.publicKey,
          vault,
          mint: mintB,
          tokenAccount: vaultAtaB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const events = await fetchEvents(connection, program, sig);
      assert.ok(
        events.find((e) => e.name === "tokenAccountOpened"),
        "opening an account somebody else created must still announce it"
      );
    });

    it("lets one vault hold several mints at once", async () => {
      const a = await getAccount(connection, vaultAta);
      const b = await getAccount(connection, vaultAtaB);

      assert.isTrue(a.owner.equals(vault));
      assert.isTrue(b.owner.equals(vault));
      assert.isFalse(a.address.equals(b.address));
      assert.isTrue(a.mint.equals(mint));
      assert.isTrue(b.mint.equals(mintB));
    });
  });

  describe("unsupported Token-2022 extensions", () => {
    let unsupportedMint: PublicKey;
    let unsupportedOwnerAta: PublicKey;
    let unsupportedVaultAta: PublicKey;

    before(async () => {
      const payer = (provider.wallet as anchor.Wallet).payer;
      const mintKeypair = Keypair.generate();
      unsupportedMint = mintKeypair.publicKey;
      unsupportedVaultAta = deriveVaultTokenAccount(
        vault,
        unsupportedMint,
        TOKEN_2022_PROGRAM_ID
      );

      const space = getMintLen([ExtensionType.NonTransferable]);
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: unsupportedMint,
            space,
            lamports: await connection.getMinimumBalanceForRentExemption(space),
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          createInitializeNonTransferableMintInstruction(
            unsupportedMint,
            TOKEN_2022_PROGRAM_ID
          ),
          createInitializeMint2Instruction(
            unsupportedMint,
            DECIMALS,
            payer.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [mintKeypair]
      );

      unsupportedOwnerAta = await createAssociatedTokenAccount(
        connection,
        payer,
        unsupportedMint,
        owner.publicKey,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        unsupportedMint,
        unsupportedOwnerAta,
        payer,
        ONE,
        [],
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
    });

    it("rejects opening a vault account for an unsupported mint", async () => {
      try {
        await program.methods
          .openTokenAccount()
          .accountsPartial({
            payer: owner.publicKey,
            owner: owner.publicKey,
            vault,
            mint: unsupportedMint,
            tokenAccount: unsupportedVaultAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("an unsupported mint must not be opened");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain(
          "UnsupportedMintExtensions"
        );
      }

      assert.isNull(
        await connection.getAccountInfo(unsupportedVaultAta),
        "the account creation must roll back with the rejected instruction"
      );
    });

    it("rejects deposits when the vault ATA was created outside the program", async () => {
      const payer = (provider.wallet as anchor.Wallet).payer;
      await createAssociatedTokenAccount(
        connection,
        payer,
        unsupportedMint,
        vault,
        undefined,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        true
      );

      try {
        await program.methods
          .deposit(new BN(ONE))
          .accountsPartial({
            depositor: owner.publicKey,
            owner: owner.publicKey,
            vault,
            mint: unsupportedMint,
            source: unsupportedOwnerAta,
            tokenAccount: unsupportedVaultAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("an unsupported mint must not be deposited");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain(
          "UnsupportedMintExtensions"
        );
      }
    });
  });

  describe("deposit", () => {
    it("moves tokens in and reports the measured balance delta", async () => {
      const sig = await program.methods
        .deposit(new BN(100 * ONE))
        .accountsPartial({
          depositor: owner.publicKey,
          owner: owner.publicKey,
          vault,
          mint,
          source: ownerAta,
          tokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const account = await getAccount(connection, vaultAta);
      assert.equal(account.amount.toString(), (100 * ONE).toString());

      const events = await fetchEvents(connection, program, sig);
      const deposited = events.find((e) => e.name === "deposited");
      assert.ok(deposited);
      assert.equal(deposited!.data.amount.toString(), (100 * ONE).toString());
      assert.equal(
        deposited!.data.amountReceived.toString(),
        (100 * ONE).toString()
      );
      assert.equal(
        deposited!.data.newBalance.toString(),
        (100 * ONE).toString()
      );
      assert.isTrue(deposited!.data.depositor.equals(owner.publicKey));
      assert.isTrue(deposited!.data.tokenAccount.equals(vaultAta));
    });

    it("lets a third party deposit into someone else's vault", async () => {
      const sig = await program.methods
        .deposit(new BN(50 * ONE))
        .accountsPartial({
          depositor: stranger.publicKey,
          owner: owner.publicKey,
          vault,
          mint,
          source: strangerAta,
          tokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([stranger])
        .rpc();

      const account = await getAccount(connection, vaultAta);
      assert.equal(account.amount.toString(), (150 * ONE).toString());

      const events = await fetchEvents(connection, program, sig);
      const deposited = events.find((e) => e.name === "deposited");
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
            vault,
            mint,
            source: ownerAta,
            tokenAccount: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("a zero amount must be rejected");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain(
          "ZeroAmount"
        );
      }
    });

    it("rejects a deposit that names the vault's account as its own source", async () => {
      // The token program accepts a transfer from an account to itself and moves nothing, so
      // without the guard this would emit a deposit for an `amount` nobody ever sent.
      const before = await getAccount(connection, vaultAta);

      try {
        await program.methods
          .deposit(new BN(10 * ONE))
          .accountsPartial({
            depositor: owner.publicKey,
            owner: owner.publicKey,
            vault,
            mint,
            source: vaultAta,
            tokenAccount: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("a deposit from the vault to itself must be rejected");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.match(
          /SelfTransfer|ConstraintTokenOwner|2015/
        );
      }

      const after = await getAccount(connection, vaultAta);
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
          vault,
          mint,
          tokenAccount: vaultAta,
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
      const withdrawn = events.find((e) => e.name === "withdrawn");
      assert.ok(withdrawn);
      assert.equal(
        withdrawn!.data.amountDebited.toString(),
        (30 * ONE).toString()
      );
      assert.equal(
        withdrawn!.data.newBalance.toString(),
        (120 * ONE).toString()
      );
    });

    it("does not let anyone but the owner withdraw", async () => {
      try {
        await program.methods
          .withdraw(new BN(1 * ONE))
          .accountsPartial({
            owner: stranger.publicKey,
            vault, // the owner's vault, but the stranger signs
            mint,
            tokenAccount: vaultAta,
            destination: strangerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([stranger])
          .rpc();
        assert.fail("a stranger must not be able to withdraw");
      } catch (e: any) {
        // The seeds bind the vault to `owner`, so a stranger's derivation never matches and
        // the PDA signature the program would produce is for a different address entirely.
        expect(e.toString()).to.match(
          /ConstraintSeeds|ConstraintRaw|2006|2003/
        );
      }

      const account = await getAccount(connection, vaultAta);
      assert.equal(account.amount.toString(), (120 * ONE).toString());
    });

    it("rejects a withdrawal that names the vault's account as its own destination", async () => {
      const before = await getAccount(connection, vaultAta);

      try {
        await program.methods
          .withdraw(new BN(10 * ONE))
          .accountsPartial({
            owner: owner.publicKey,
            vault,
            mint,
            tokenAccount: vaultAta,
            destination: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("a withdrawal into the vault itself must be rejected");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain(
          "SelfTransfer"
        );
      }

      const after = await getAccount(connection, vaultAta);
      assert.equal(after.amount.toString(), before.amount.toString());
    });
  });

  // The old design left the token authority on the user's wallet, so the program could not
  // move funds at all and the user could ignore it entirely. That is no longer true, and
  // these are the guarantees that replace it: the program signs, but only ever on an exit the
  // owner has signed for, and only on the paths that need it.
  describe("custody invariants", () => {
    it("puts the token authority on the vault PDA, so the wallet cannot transfer directly", async () => {
      const before = await getAccount(connection, vaultAta);
      assert.isTrue(
        before.amount > 0n,
        "vault should hold something to try to move"
      );

      // A bare SPL Token instruction signed by the owner. It fails: the owner's wallet is not
      // the token authority any more, the vault PDA is.
      const ix = createTransferCheckedInstruction(
        vaultAta,
        mint,
        ownerAta,
        owner.publicKey,
        Number(before.amount),
        DECIMALS
      );

      let failed = false;
      try {
        await provider.sendAndConfirm(new Transaction().add(ix), [owner]);
      } catch (e) {
        failed = true;
      }
      assert.isTrue(
        failed,
        "only the program can move funds out of a vault token account"
      );

      const after = await getAccount(connection, vaultAta);
      assert.equal(after.amount.toString(), before.amount.toString());
    });

    it("signs as the vault only on the paths that move value out", () => {
      // An inverted version of the guarantee this design gives up. The program does sign now,
      // so the check is no longer "never" but "nowhere unexpected": a PDA signature appearing
      // in `deposit`, or in creating an account, would be a real finding.
      const srcDir = path.join(
        __dirname,
        "..",
        "programs",
        "points-vault",
        "src"
      );
      const expected = ["close_token_account.rs", "eject.rs", "withdraw.rs"];

      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(dir, entry.name);
          return entry.isDirectory()
            ? walk(full)
            : full.endsWith(".rs")
            ? [full]
            : [];
        });

      const signing: string[] = [];
      for (const file of walk(srcDir)) {
        // Strip comments so documentation mentioning these terms doesn't trip the check.
        const code = fs
          .readFileSync(file, "utf8")
          .replace(/\/\/.*$/gm, "")
          .replace(/\/\*[\s\S]*?\*\//g, "");
        if (/new_with_signer|invoke_signed/.test(code))
          signing.push(path.basename(file));
      }

      assert.deepEqual(
        signing.sort(),
        expected,
        "the set of PDA-signing paths changed"
      );
    });

    it("requires the owner's signature on every instruction where the program signs", () => {
      // The structural counterpart to the test above: signing as the vault is only safe
      // because the owner's key is both a required signer and the seed the vault is derived
      // from, so the two can never come apart.
      const idl = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "..", "target", "idl", "points_vault.json"),
          "utf8"
        )
      );

      for (const name of ["withdraw", "close_token_account", "eject"]) {
        const ix = idl.instructions.find((i: any) => i.name === name);
        assert.ok(ix, `${name} should exist in the IDL`);
        const owner = ix.accounts.find((a: any) => a.name === "owner");
        assert.ok(owner, `${name} should take an owner account`);
        assert.isTrue(
          owner.signer === true,
          `${name} must require the owner to sign`
        );
      }
    });

    it("has no admin key: no instruction takes an authority other than the owner", () => {
      const idl = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "..", "target", "idl", "points_vault.json"),
          "utf8"
        )
      );

      const allowed = new Set(["owner", "payer", "depositor"]);
      for (const ix of idl.instructions) {
        for (const account of ix.accounts) {
          if (!account.signer) continue;
          assert.isTrue(
            allowed.has(account.name),
            `${ix.name} takes an unexpected signer: ${account.name}`
          );
        }
      }
    });
  });

  describe("eject", () => {
    // Uses mintB throughout, so handing its authority away does not disturb anything else.
    before(async () => {
      await program.methods
        .deposit(new BN(40 * ONE))
        .accountsPartial({
          depositor: owner.publicKey,
          owner: owner.publicKey,
          vault,
          mint: mintB,
          source: ownerAtaB,
          tokenAccount: vaultAtaB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();
    });

    it("hands the token authority back to the owner's wallet", async () => {
      const sig = await program.methods
        .eject()
        .accountsPartial({
          owner: owner.publicKey,
          vault,
          mint: mintB,
          tokenAccount: vaultAtaB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const account = await getAccount(connection, vaultAtaB);
      assert.isTrue(
        account.owner.equals(owner.publicKey),
        "authority is the wallet again"
      );
      assert.equal(
        account.amount.toString(),
        (40 * ONE).toString(),
        "ejecting moves authority, not money"
      );

      const events = await fetchEvents(connection, program, sig);
      const ejected = events.find((e) => e.name === "tokenAccountEjected");
      assert.ok(ejected);
      assert.isTrue(ejected!.data.tokenAccount.equals(vaultAtaB));
      assert.isTrue(ejected!.data.newAuthority.equals(owner.publicKey));
    });

    it("restores the owner's ability to move funds with the program absent", async () => {
      // This is the property the design otherwise gives up, available on demand. It is what
      // makes a bug on the withdrawal path survivable once the program is immutable.
      const before = await getAccount(connection, ownerAtaB);

      const ix = createTransferCheckedInstruction(
        vaultAtaB,
        mintB,
        ownerAtaB,
        owner.publicKey,
        40 * ONE,
        DECIMALS
      );
      const sig = await provider.sendAndConfirm(new Transaction().add(ix), [
        owner,
      ]);

      const after = await getAccount(connection, ownerAtaB);
      assert.equal(
        (after.amount - before.amount).toString(),
        (40 * ONE).toString()
      );

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

    it("stops the vault's own instructions working on that account", async () => {
      try {
        await program.methods
          .deposit(new BN(1 * ONE))
          .accountsPartial({
            depositor: owner.publicKey,
            owner: owner.publicKey,
            vault,
            mint: mintB,
            source: ownerAtaB,
            tokenAccount: vaultAtaB,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("an ejected account is no longer part of the vault");
      } catch (e: any) {
        expect(e.toString()).to.match(
          /ConstraintTokenOwner|ConstraintAssociated|2015|2009/
        );
      }
    });
  });

  describe("close_token_account", () => {
    it("refuses to close one that still holds tokens", async () => {
      const held = await getAccount(connection, vaultAta);
      assert.isTrue(held.amount > 0n);

      try {
        await program.methods
          .closeTokenAccount()
          .accountsPartial({
            owner: owner.publicKey,
            vault,
            mint,
            tokenAccount: vaultAta,
            rentDestination: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
        assert.fail("an account holding tokens must not be closeable");
      } catch (e: any) {
        expect(e.error?.errorCode?.code ?? e.toString()).to.contain(
          "VaultNotEmpty"
        );
      }
    });

    it("closes an empty one and returns the rent", async () => {
      const held = await getAccount(connection, vaultAta);
      await program.methods
        .withdraw(new BN(held.amount.toString()))
        .accountsPartial({
          owner: owner.publicKey,
          vault,
          mint,
          tokenAccount: vaultAta,
          destination: ownerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const sig = await program.methods
        .closeTokenAccount()
        .accountsPartial({
          owner: owner.publicKey,
          vault,
          mint,
          tokenAccount: vaultAta,
          rentDestination: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      assert.isNull(
        await connection.getAccountInfo(vaultAta),
        "token account should be gone"
      );

      const events = await fetchEvents(connection, program, sig);
      const closed = events.find((e) => e.name === "tokenAccountClosed");
      assert.ok(closed);
      assert.isTrue(closed!.data.tokenAccount.equals(vaultAta));
      assert.isTrue(closed!.data.mint.equals(mint));
    });

    it("frees the address, so the same mint can be opened again", async () => {
      await program.methods
        .openTokenAccount()
        .accountsPartial({
          payer: owner.publicKey,
          owner: owner.publicKey,
          vault,
          mint,
          tokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const account = await getAccount(connection, vaultAta);
      assert.isTrue(account.owner.equals(vault));
      assert.equal(account.amount.toString(), "0");
    });
  });

  describe("close_vault", () => {
    it("closes the vault account and returns its rent", async () => {
      const sig = await program.methods
        .closeVault()
        .accountsPartial({
          owner: owner.publicKey,
          vault,
          rentDestination: owner.publicKey,
        })
        .signers([owner])
        .rpc();

      assert.isNull(
        await connection.getAccountInfo(vault),
        "vault account should be gone"
      );

      const events = await fetchEvents(connection, program, sig);
      const closed = events.find((e) => e.name === "vaultClosed");
      assert.ok(closed);
      assert.isTrue(closed!.data.vault.equals(vault));
    });

    it("leaves any token account behind reachable, because the address is deterministic", async () => {
      // Closing the vault account is not destructive: a PDA signs from its seeds, not from
      // stored state, so re-creating the vault restores control of everything under it. The
      // token account opened above outlived the vault and is still there.
      assert.isNotNull(
        await connection.getAccountInfo(vaultAta),
        "the token account should have survived its vault"
      );

      await program.methods
        .createVault()
        .accountsPartial({
          payer: owner.publicKey,
          owner: owner.publicKey,
          vault,
        })
        .signers([owner])
        .rpc();

      const account = await program.account.vault.fetch(vault);
      assert.isTrue(account.owner.equals(owner.publicKey));

      // And the recovered vault can move the funds again.
      await program.methods
        .deposit(new BN(7 * ONE))
        .accountsPartial({
          depositor: owner.publicKey,
          owner: owner.publicKey,
          vault,
          mint,
          source: ownerAta,
          tokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      await program.methods
        .withdraw(new BN(7 * ONE))
        .accountsPartial({
          owner: owner.publicKey,
          vault,
          mint,
          tokenAccount: vaultAta,
          destination: ownerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const account2 = await getAccount(connection, vaultAta);
      assert.equal(account2.amount.toString(), "0");
    });
  });

  // Everything above runs on a classic mint, where the amount sent and the amount received are
  // always the same number. A transfer fee is what makes them diverge, and it is the reason
  // both fields exist. It also parks value in an account that is not part of its balance.
  describe("token-2022 transfer fees", () => {
    const FEE_BPS = 100;
    /** Set high enough that the basis points, never the cap, decide the fees below. */
    const MAX_FEE = BigInt(1000 * ONE);

    const feeOn = (amount: number) => (amount * FEE_BPS) / 10_000;

    let feeMint: PublicKey;
    let feeOwnerAta: PublicKey;
    let feeVaultAta: PublicKey;

    /** Fees taken out of transfers into `address`, waiting to be swept to the mint. */
    async function withheldOn(address: PublicKey): Promise<bigint> {
      const account = await getAccount(
        connection,
        address,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      return getTransferFeeAmount(account)?.withheldAmount ?? 0n;
    }

    async function withheldOnMint(): Promise<bigint> {
      const info = await getMint(
        connection,
        feeMint,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
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

      // The same vault already holds a classic mint, so this also covers one wallet holding
      // two mints across two different token programs.
      feeVaultAta = deriveVaultTokenAccount(
        vault,
        feeMint,
        TOKEN_2022_PROGRAM_ID
      );
    });

    it("opens a token account sized for the extensions the mint requires", async () => {
      await program.methods
        .openTokenAccount()
        .accountsPartial({
          payer: owner.publicKey,
          owner: owner.publicKey,
          vault,
          mint: feeMint,
          tokenAccount: feeVaultAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      // A fee mint requires its token accounts to carry TransferFeeAmount, so allocating only
      // the base 165 bytes would have failed at initialisation.
      const account = await getAccount(
        connection,
        feeVaultAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      assert.isTrue(account.owner.equals(vault));
      assert.isNotNull(
        getTransferFeeAmount(account),
        "should carry the fee extension"
      );
    });

    it("reports the amount that arrived, not the amount that was sent", async () => {
      const sent = 100 * ONE;

      const sig = await program.methods
        .deposit(new BN(sent))
        .accountsPartial({
          depositor: owner.publicKey,
          owner: owner.publicKey,
          vault,
          mint: feeMint,
          source: feeOwnerAta,
          tokenAccount: feeVaultAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const events = await fetchEvents(connection, program, sig);
      const deposited = events.find((e) => e.name === "deposited");
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

      const account = await getAccount(
        connection,
        feeVaultAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      assert.equal(account.amount.toString(), (sent - feeOn(sent)).toString());
      assert.equal(
        (await withheldOn(feeVaultAta)).toString(),
        feeOn(sent).toString()
      );
    });

    it("debits the vault in full on the way out, the fee falling on the destination", async () => {
      const asked = 50 * ONE;
      const before = await getAccount(
        connection,
        feeOwnerAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const sig = await program.methods
        .withdraw(new BN(asked))
        .accountsPartial({
          owner: owner.publicKey,
          vault,
          mint: feeMint,
          tokenAccount: feeVaultAta,
          destination: feeOwnerAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      const events = await fetchEvents(connection, program, sig);
      const withdrawn = events.find((e) => e.name === "withdrawn");
      assert.ok(withdrawn);
      assert.equal(
        withdrawn!.data.amountDebited.toString(),
        asked.toString(),
        "the vault loses the whole amount; the fee comes out of what arrives"
      );

      const after = await getAccount(
        connection,
        feeOwnerAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      assert.equal(
        (after.amount - before.amount).toString(),
        (asked - feeOn(asked)).toString()
      );
    });

    it("closes a token account that is empty but still holds withheld fees", async () => {
      const remaining = await getAccount(
        connection,
        feeVaultAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      await program.methods
        .withdraw(new BN(remaining.amount.toString()))
        .accountsPartial({
          owner: owner.publicKey,
          vault,
          mint: feeMint,
          tokenAccount: feeVaultAta,
          destination: feeOwnerAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      // Fees are withheld in the account receiving a transfer, so the deposit above left them
      // here and no withdrawal takes them out again. The token program refuses to close an
      // account while they sit there.
      const withheld = await withheldOn(feeVaultAta);
      assert.isTrue(
        withheld > 0n,
        "the account must really hold fees or this proves nothing"
      );

      const mintBefore = await withheldOnMint();

      await program.methods
        .closeTokenAccount()
        .accountsPartial({
          owner: owner.publicKey,
          vault,
          mint: feeMint,
          tokenAccount: feeVaultAta,
          rentDestination: owner.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      assert.isNull(
        await connection.getAccountInfo(feeVaultAta),
        "account should be gone"
      );
      assert.equal(
        ((await withheldOnMint()) - mintBefore).toString(),
        withheld.toString(),
        "the fees were swept to the mint, not destroyed with the account"
      );
    });
  });
});
