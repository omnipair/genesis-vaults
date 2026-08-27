# points_vault

Program ID: `BfpWw4DFYvzAHJcRj3nYLBrosRrqJrfFTdPL2HYyw6Er`

A vault is a plain SPL token account at a program-derived address whose **token authority is
the user's wallet**. The program is a helper and an event emitter, nothing more.

## Why this is non-custodial

The program signs exactly once per vault: the `create_account` inside Anchor's `init`, which
allocates the token account at the PDA. `initialize_account3` immediately sets the authority
to `owner`. After that instruction returns, the program has no way to touch the funds — there
is no `invoke_signed` anywhere in `deposit`, `withdraw`, or `close_vault`, so the vault PDA
never signs a transfer.

Concretely, this means a user can ignore the program completely:

```bash
spl-token transfer <MINT> <AMOUNT> <DEST> --from <VAULT_ADDRESS> --owner <THEIR_WALLET>
```

works and the program is not in the transaction at all. The indexer's reconciler exists to
notice movements like this one.

There is no admin key, no pause switch, and no instruction that takes a privileged authority.

## Address derivation

```
seeds = ["vault", owner, mint]
```

A wallet therefore has exactly one vault per mint. Nothing enforces that beyond the seeds
themselves: they admit a single address per `(owner, mint)`, so a second `create_vault` finds
the account already allocated and fails there. There is no counter to keep and no uniqueness
check to get wrong.

The limit is on how many vaults exist at once, not how many a wallet may ever have. Closing a
vault deallocates the token account and frees the address, so the same pair can be created
again afterwards.

## Instructions

| Instruction | Signer | What it does |
| ----------- | ------ | ------------ |
| `create_vault()` | `payer`, `owner` | Allocates the token account at the PDA with `owner` as authority. Emits `VaultCreated`. |
| `deposit(amount)` | `depositor` | `transfer_checked` into the vault. Anyone may deposit into anyone's vault. Emits `VaultDeposited`. |
| `withdraw(amount)` | `owner` | `transfer_checked` out of the vault, authorised by the owner's signature. Emits `VaultWithdrawn`. |
| `close_vault()` | `owner` | Closes an empty vault, returning rent to `rent_destination`. Emits `VaultClosed`. |

`owner` must sign `create_vault` so nobody can create vaults attributed to a wallet that never
asked for one.

Both `deposit` and `withdraw` re-assert `token::authority = owner` on the vault. If an owner
reassigns the vault's authority with a raw `SetAuthority`, the program's helpers stop working
for that vault — but the owner keeps full control through raw SPL Token instructions.

Both also reject a transfer whose other side is the vault itself. The token program accepts
such a transfer and moves nothing, which would leave an event reporting an `amount` that never
went anywhere.

## Events

All four events are emitted with `emit_cpi!` (a self-CPI), not `emit!`. Program logs get
truncated under load; self-CPI events arrive as inner instructions and always survive, and the
Carbon decoder picks them up as instruction variants.

`VaultDeposited` carries both `amount` (what the caller asked to transfer) and
`amount_received` (the vault's measured balance delta). These differ for Token-2022 mints with
a transfer fee, and the indexer records the measured value.

## Token-2022

Built against `anchor_spl::token_interface`, so both SPL Token and Token-2022 mints work. The
token program used by a vault is fixed at creation and recorded in `VaultCreated`.

## Building

```bash
./scripts/build.sh     # anchor build, then publish the IDL to ../idl/
anchor test            # spins up a local validator and runs tests/
```

The crate pins `package.metadata.solana.tools-version = "v1.54"`. Older platform-tools ship a
cargo that predates edition 2024 and cannot parse parts of the `anchor-spl` dependency tree.
