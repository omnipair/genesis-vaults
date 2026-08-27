//! # Points Vault
//!
//! A vault is a plain SPL token account living at a deterministic address derived from
//! `["vault", owner, mint]`, so a wallet has exactly one vault per mint. The program signs
//! exactly once in a vault's lifetime: to allocate the account. It immediately sets the token
//! authority to the owner's wallet and from that moment holds no privilege over the funds
//! whatsoever.
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
    ///
    /// The address is fixed by `owner` and `mint` alone, so a second call for the same pair
    /// fails at allocation: the account already exists.
    pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
        instructions::create_vault::handler(ctx)
    }

    /// Move tokens into a vault. Anyone may deposit into anyone's vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    /// Move tokens out of a vault. Only the owner can, because only the owner is the
    /// token authority; the program cannot sign for this.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }

    /// Close an empty vault and reclaim its rent.
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        instructions::close_vault::handler(ctx)
    }
}
