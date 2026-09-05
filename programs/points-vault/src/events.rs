use anchor_lang::prelude::*;

/// Emitted once per wallet, when its vault account is allocated.
///
/// Carries no mint: a vault spans every mint its owner holds, and the per-mint layer arrives
/// with `TokenAccountOpened`. This is the one event the indexer cannot filter by mint.
#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub timestamp: i64,
}

/// A mint's token account under a vault. `token_account` is the vault PDA's associated token
/// account for `mint`, which is where the balance for that mint actually lives.
#[event]
pub struct TokenAccountOpened {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub timestamp: i64,
}

/// `amount` is what the depositor asked to send; `amount_received` is the token account's
/// measured balance delta, which differs under Token-2022 transfer fees.
#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub amount_received: u64,
    pub new_balance: u64,
    pub timestamp: i64,
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub amount_debited: u64,
    pub new_balance: u64,
    pub timestamp: i64,
}

#[event]
pub struct TokenAccountClosed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub rent_destination: Pubkey,
    pub timestamp: i64,
}

/// The owner took a token account back out of the vault's control, reassigning its SPL
/// authority to their own wallet. The account still exists and still holds its balance, but
/// the vault no longer governs it and the indexer should stop counting it.
#[event]
pub struct TokenAccountEjected {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub new_authority: Pubkey,
    pub timestamp: i64,
}

/// The vault account itself was deallocated. Its address is deterministic, so this is
/// reversible: `create_vault` puts it back and any token accounts left behind are reachable
/// again.
#[event]
pub struct VaultClosed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub rent_destination: Pubkey,
    pub timestamp: i64,
}
