use anchor_lang::prelude::*;

#[error_code]
pub enum PointsVaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("Vault balance accounting overflowed")]
    BalanceOverflow,

    #[msg("Token account must be empty before it can be closed")]
    VaultNotEmpty,

    #[msg("A token account cannot be both sides of a transfer")]
    SelfTransfer,
}
