# points_vault

Program ID: `qAtXGjatDymFUURzXLmc7ijNukSVk5aZbohtGANH8xw`

A wallet has one **vault**, a small state account at `["vault", owner]`, and beneath it one
associated token account per mint. The vault PDA is the SPL authority on every one of those
accounts, so tokens leave only when this program signs as the vault.

## What secures the funds

The program signs every exit, so the question is not whether it can move your money — it can —
but whether it will ever do so without you. It cannot, for three reasons that hold together:

**The owner must sign.** `withdraw`, `close_token_account` and `eject` all take `owner` as a
`Signer`, and the vault they operate on is constrained to `seeds = ["vault", owner]`. There is
no path where the program's signature is available and the owner's is not: a different signer
derives a different vault and never reaches these funds.

**There is nobody else.** No admin key, no pause switch, no upgrade authority once deployed
`--final`, and no instruction that takes a privileged account. The full list of ways tokens can
leave a vault is the three instructions above, and each starts with the owner's signature.

**You can leave.** `eject` hands one token account's SPL authority back to the owner's wallet.
After it, the account is an ordinary token account the owner moves with any SPL client, with
this program nowhere in the transaction:

```bash
spl-token transfer <MINT> <AMOUNT> <DEST> --from <TOKEN_ACCOUNT> --owner <THEIR_WALLET>
```

That escape hatch is what makes the immutability tolerable rather than frightening. A defect on
the withdrawal path in a program nobody can upgrade would otherwise be permanent; with `eject`,
the worst case is that everyone leaves through a different door.

What this design does not offer, unlike leaving the authority on the user's own wallet, is
independence from the program in the normal case. Funds leave through `withdraw` or they do not
leave. That is the trade being made, and it is the reason `eject` exists.

## Address derivation

```
vault          = PDA(["vault", owner])
token account  = associated token account of that PDA, per mint
                 (derived with the off-curve flag, since a PDA has no key)
```

A wallet therefore has exactly one vault, and a vault exactly one account per mint. Nothing
enforces either beyond the derivations themselves: they admit a single address, so a second
`create_vault` finds the account allocated and fails there, and `open_token_account` is
`init_if_needed` because the associated token program lets anyone create that same address
out-of-band.

Closing is not a teardown at either layer. `close_token_account` frees a mint's address so it
can be opened again; `close_vault` reclaims the state account's rent while the token accounts
beneath it keep their balances and their authority. `invoke_signed` derives from seeds and
never needed the state account to exist, so tokens in a still-open account remain reachable
even with the vault closed, and `create_vault` puts the vault back at the same address.

## Instructions

| Instruction | Signer | What it does |
| ----------- | ------ | ------------ |
| `create_vault()` | `payer`, `owner` | Allocates the vault account. Emits `VaultCreated`. |
| `open_token_account()` | `payer` | Creates the vault's associated token account for a mint, with the vault as authority. Permissionless and idempotent. Emits `TokenAccountOpened`. |
| `deposit(amount)` | `depositor` | `transfer_checked` in, signed by the depositor. Anyone may deposit into anyone's vault. Emits `Deposited`. |
| `withdraw(amount)` | `owner` | `transfer_checked` out, signed by the vault PDA. Emits `Withdrawn`. |
| `close_token_account()` | `owner` | Closes one empty token account, rent to `rent_destination`. Emits `TokenAccountClosed`. |
| `eject()` | `owner` | `set_authority` from the vault PDA to the owner's wallet. Emits `TokenAccountEjected`. |
| `close_vault()` | `owner` | Closes the vault account, rent to `rent_destination`. Emits `VaultClosed`. |

`owner` must sign `create_vault` so nobody can create vaults attributed to a wallet that never
asked for one. `open_token_account` deliberately does not require it: the address is derivable
by anyone anyway, so demanding a signature would buy nothing and would stop a depositor from
paying to open the account they are about to fund.

`deposit` is the one instruction with no program signature. The tokens are moving into an
account the depositor does not control, so there is nothing on that side to authorise.

Both transfer instructions reject a transfer whose other side is the token account itself. The
token program accepts such a transfer and moves nothing, which would leave an event reporting
an `amount` that never went anywhere.

## Events

All seven events are emitted with `emit_cpi!` (a self-CPI), not `emit!`. Program logs get
truncated under load; self-CPI events arrive as inner instructions and always survive, and the
Carbon decoder picks them up as instruction variants.

Events come in two grains, matching the two layers. `VaultCreated` and `VaultClosed` name a
vault and an owner and no mint, because they concern the wallet's vault rather than any one
holding. The other five carry `mint` and `token_account` as well.

`Deposited` carries both `amount` (what the caller asked to transfer) and `amount_received`
(the account's measured balance delta); `Withdrawn` carries `amount` and `amount_debited` the
same way. These differ for Token-2022 mints with a transfer fee, and the indexer records the
measured value.

## Token-2022

Built against `anchor_spl::token_interface`, so both SPL Token and Token-2022 mints work. Which
token program a holding uses is fixed when its account is opened and recorded in
`TokenAccountOpened`; it is also part of the associated token address derivation, so the two
cannot disagree.

Token-2022 support is limited to mints with `TransferFeeConfig`, `MetadataPointer`, and
`TokenMetadata` extensions. `open_token_account` and `deposit` reject every other extension.
In particular, transfer-hook mints are not accepted because the vault instructions do not take
or forward a hook program's extra accounts. The deposit check is repeated because anyone can
create the vault's deterministic ATA without calling `open_token_account`.

A transfer fee is withheld in the account *receiving* a transfer, so a vault token account
accumulates withheld fees as deposits arrive and no withdrawal takes them back out. They are
not part of the balance, and the token program refuses to close an account while any remain.
`close_token_account` therefore harvests them to the mint first, which needs no authority and
costs the owner nothing: the fees were deducted when they arrived and the mint is where they
were always headed. This is why `close_token_account` takes the mint as writable.

Note that on a fee-charging mint a withdrawal debits the account by the full `amount` while the
destination receives less. `amount_debited` is measured from the vault side, so it is the
figure the indexer's balance arithmetic uses.

## Building

```bash
./scripts/build.sh     # anchor build, then publish the IDL to ../idl/
anchor test            # spins up a local validator and runs tests/
```

The crate pins `package.metadata.solana.tools-version = "v1.54"`. Older platform-tools ship a
cargo that predates edition 2024 and cannot parse parts of the `anchor-spl` dependency tree.
