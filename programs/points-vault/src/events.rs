use anchor_lang::prelude::*;

/// Emitted once per vault, when its token account is allocated.
#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub vault_id: u64,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub timestamp: i64,
}

/// `amount` is what the depositor asked to send; `amount_received` is the vault's measured
/// balance delta, which differs under Token-2022 transfer fees.
#[event]
pub struct VaultDeposited {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub depositor: Pubkey,
    pub vault_id: u64,
    pub amount: u64,
    pub amount_received: u64,
    pub new_balance: u64,
    pub timestamp: i64,
}

#[event]
pub struct VaultWithdrawn {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub vault_id: u64,
    pub amount: u64,
    pub amount_debited: u64,
    pub new_balance: u64,
    pub timestamp: i64,
}

#[event]
pub struct VaultClosed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub vault_id: u64,
    pub rent_destination: Pubkey,
    pub timestamp: i64,
}
