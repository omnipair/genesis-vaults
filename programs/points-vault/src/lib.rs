//! # Points Vault
//!
//! A wallet has one vault, at `["vault", owner]`, and a vault holds one associated token
//! account per mint. The token authority on every one of them is the vault PDA, so the
//! program signs each transfer *out* while transfers *in* are signed by whoever owns the
//! money. The owner's signature is the only thing that authorises an exit: the vault's
//! address is derived from their key, so a different signer derives a different vault.
//!
//! There is no admin key, no pause switch, and no instruction that takes a privileged
//! authority. What the program cannot offer, unlike a design that leaves the authority on the
//! user's own wallet, is independence from itself — funds leave through `withdraw` or they do
//! not leave. `eject` is the concession to that: it hands a token account's authority back to
//! the owner's wallet, so a defect on the withdrawal path is survivable even after the
//! program is made immutable.

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("qAtXGjatDymFUURzXLmc7ijNukSVk5aZbohtGANH8xw");

/// Seed prefix for both the vault account and the PDA that signs for its token accounts.
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod points_vault {
    use super::*;

    /// Allocate the caller's vault. One per wallet; a second call fails at allocation.
    pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
        instructions::create_vault::handler(ctx)
    }

    /// Give a vault somewhere to hold one mint, by creating the vault PDA's associated token
    /// account for it. Permissionless, and tolerant of the account already existing.
    pub fn open_token_account(ctx: Context<OpenTokenAccount>) -> Result<()> {
        instructions::open_token_account::handler(ctx)
    }

    /// Move tokens into a vault. Anyone may deposit into anyone's vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    /// Move tokens out of a vault. The vault PDA signs the transfer, but only ever in an
    /// instruction the owner has signed.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }

    /// Close one empty token account and reclaim its rent.
    pub fn close_token_account(ctx: Context<CloseTokenAccount>) -> Result<()> {
        instructions::close_token_account::handler(ctx)
    }

    /// Hand a token account's authority back to the owner's wallet, taking it out of the
    /// vault's control without moving a lamport.
    pub fn eject(ctx: Context<Eject>) -> Result<()> {
        instructions::eject::handler(ctx)
    }

    /// Close the vault account itself and reclaim its rent. Reversible: the address is
    /// deterministic and `create_vault` puts it back.
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        instructions::close_vault::handler(ctx)
    }
}
