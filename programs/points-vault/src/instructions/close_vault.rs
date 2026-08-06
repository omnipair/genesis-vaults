use anchor_lang::prelude::*;
use anchor_spl::token_interface::{close_account, CloseAccount, Mint, TokenAccount, TokenInterface};

use crate::{errors::PointsVaultError, events::VaultClosed, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct CloseVault<'info> {
    pub owner: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [
            VAULT_SEED,
            owner.key().as_ref(),
            mint.key().as_ref(),
            &vault_id.to_le_bytes(),
        ],
        bump,
        token::mint = mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: receives the reclaimed rent; the owner chooses where it goes.
    #[account(mut)]
    pub rent_destination: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<CloseVault>, vault_id: u64) -> Result<()> {
    require!(
        ctx.accounts.vault.amount == 0,
        PointsVaultError::VaultNotEmpty
    );

    let vault = ctx.accounts.vault.key();
    let owner = ctx.accounts.owner.key();
    let mint = ctx.accounts.mint.key();
    let rent_destination = ctx.accounts.rent_destination.key();

    close_account(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.rent_destination.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        },
    ))?;

    emit_cpi!(VaultClosed {
        vault,
        owner,
        mint,
        vault_id,
        rent_destination,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
