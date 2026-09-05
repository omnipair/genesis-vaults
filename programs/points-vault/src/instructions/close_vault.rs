use anchor_lang::prelude::*;

use crate::{events::VaultClosed, state::Vault, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct CloseVault<'info> {
    pub owner: Signer<'info>,

    /// No emptiness check, because closing this is not destructive. The address is derived
    /// from the owner alone, so `create_vault` puts it back at the same place, and a PDA
    /// signs from its seeds rather than from any stored state — token accounts left behind
    /// stay reachable either way.
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
        close = rent_destination,
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: receives the reclaimed rent; the owner chooses where it goes.
    #[account(mut)]
    pub rent_destination: UncheckedAccount<'info>,
}

pub(crate) fn handler(ctx: Context<CloseVault>) -> Result<()> {
    emit_cpi!(VaultClosed {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        rent_destination: ctx.accounts.rent_destination.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
