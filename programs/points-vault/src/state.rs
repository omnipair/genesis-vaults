use anchor_lang::prelude::*;

/// One per wallet, at `["vault", owner]`.
///
/// Deliberately thin. The PDA can sign from its seeds alone, so nothing here is required to
/// move funds; the account exists to record that the owner opted in, to give the indexer a
/// per-wallet entity to hang token accounts off, and to leave somewhere for future state to
/// go. `bump` is stored only to save the runtime a `find_program_address` on every CPI.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub bump: u8,
    pub created_at: i64,
}

impl Vault {
    pub const SPACE: usize = 8 + Self::INIT_SPACE;
}
