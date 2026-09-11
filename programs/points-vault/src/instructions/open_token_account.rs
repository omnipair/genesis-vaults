use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    events::TokenAccountOpened, instructions::accounts::require_supported_asset_mint, state::Vault,
    VAULT_SEED,
};

#[event_cpi]
#[derive(Accounts)]
pub struct OpenTokenAccount<'info> {
    /// Pays the token account's rent. May be anyone: funding somebody else's vault with a
    /// place to receive a mint takes nothing from them.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: only read as a pubkey, and pinned by the vault's seeds and `has_one` below.
    pub owner: UncheckedAccount<'info>,

    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// `init_if_needed` rather than `init`: this address is an ordinary ATA, so the
    /// associated token program lets anyone create it without us. Failing in that case would
    /// leave a vault permanently unable to register a mint somebody else had already funded.
    /// Re-initialisation is not a risk here because Anchor still checks mint and authority
    /// against the constraints below when the account already exists.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<OpenTokenAccount>) -> Result<()> {
    require_supported_asset_mint(&ctx.accounts.mint)?;

    emit_cpi!(TokenAccountOpened {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        mint: ctx.accounts.mint.key(),
        token_account: ctx.accounts.token_account.key(),
        token_program: ctx.accounts.token_program.key(),
        decimals: ctx.accounts.mint.decimals,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
