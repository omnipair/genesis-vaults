use anchor_lang::prelude::*;

use crate::{events::VaultCreated, state::Vault, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct CreateVault<'info> {
    /// Pays rent for the new account. May be anyone.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Must sign so nobody can create a vault attributed to a wallet that did not ask for one.
    pub owner: Signer<'info>,

    /// One address per wallet, so a second creation finds the account already allocated and
    /// fails here.
    #[account(
        init,
        payer = payer,
        space = Vault::SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<CreateVault>) -> Result<()> {
    let timestamp = Clock::get()?.unix_timestamp;

    ctx.accounts.vault.set_inner(Vault {
        owner: ctx.accounts.owner.key(),
        bump: ctx.bumps.vault,
        created_at: timestamp,
    });

    emit_cpi!(VaultCreated {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        timestamp,
    });

    Ok(())
}
