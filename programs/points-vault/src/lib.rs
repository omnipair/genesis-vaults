//! # Points Vault
//!
//! A vault is a plain SPL token account living at a deterministic address derived from
//! `["vault", owner, mint, vault_id]`. The program signs exactly once in a vault's lifetime:
//! to allocate the account. It immediately sets the token authority to the owner's wallet
//! and from that moment holds no privilege over the funds whatsoever.
//!
//! `deposit`, `withdraw` and `close_vault` are conveniences. Each performs a CPI signed by
//! the *user*, never by the program, and emits an event so the indexer can follow along.
//! Nothing stops a user from bypassing this program entirely with raw SPL Token
//! instructions; that is the point.

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;

pub use errors::*;
pub use events::*;
pub use instructions::*;

declare_id!("BfpWw4DFYvzAHJcRj3nYLBrosRrqJrfFTdPL2HYyw6Er");

/// Seed prefix for the vault token account address.
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod points_vault {
    use super::*;

    /// Allocate a token account at the vault PDA and hand its authority to `owner`.
    pub fn create_vault(ctx: Context<CreateVault>, vault_id: u64) -> Result<()> {
        instructions::create_vault::handler(ctx, vault_id)
    }

    /// Move tokens into a vault. Anyone may deposit into anyone's vault.
    pub fn deposit(ctx: Context<Deposit>, vault_id: u64, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, vault_id, amount)
    }

    /// Move tokens out of a vault. Only the owner can, because only the owner is the
    /// token authority; the program cannot sign for this.
    pub fn withdraw(ctx: Context<Withdraw>, vault_id: u64, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, vault_id, amount)
    }

    /// Close an empty vault and reclaim its rent.
    pub fn close_vault(ctx: Context<CloseVault>, vault_id: u64) -> Result<()> {
        instructions::close_vault::handler(ctx, vault_id)
    }
}
