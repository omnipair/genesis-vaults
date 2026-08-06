use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{events::VaultCreated, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct CreateVault<'info> {
    /// Pays rent for the new token account. May be anyone.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Must sign so nobody can create vaults attributed to a wallet that did not ask for one.
    pub owner: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// The vault itself: an ordinary SPL token account that happens to live at a PDA.
    /// `token::authority = owner` is what makes this non-custodial.
    #[account(
        init,
        payer = payer,
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

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateVault>, vault_id: u64) -> Result<()> {
    emit_cpi!(VaultCreated {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        mint: ctx.accounts.mint.key(),
        vault_id,
        token_program: ctx.accounts.token_program.key(),
        decimals: ctx.accounts.mint.decimals,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
