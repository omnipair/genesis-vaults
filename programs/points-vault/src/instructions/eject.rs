use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::instruction::AuthorityType,
    token_interface::{set_authority, Mint, SetAuthority, TokenAccount, TokenInterface},
};

use crate::{events::TokenAccountEjected, state::Vault, VAULT_SEED};

/// The escape hatch.
///
/// Holding the token authority on the vault PDA makes this program the only way funds can
/// leave, which is a dependency on the program being correct — and once its upgrade authority
/// is revoked, a defect on the withdrawal path could not be patched. `eject` bounds that: the
/// owner can always hand a token account's SPL authority back to their own wallet in one
/// instruction and go on with raw SPL Token calls, exactly as they could before the vault
/// existed.
///
/// Nothing is destroyed. The account keeps its balance and its address; it simply stops being
/// governed by the vault, and the `associated_token::authority` constraint on every other
/// instruction stops matching until the owner assigns it back.
#[event_cpi]
#[derive(Accounts)]
pub struct Eject<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub(crate) fn handler(ctx: Context<Eject>) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    let bump = [ctx.accounts.vault.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner.as_ref(), &bump]];

    set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.vault.to_account_info(),
                account_or_mint: ctx.accounts.token_account.to_account_info(),
            },
            signer_seeds,
        ),
        AuthorityType::AccountOwner,
        Some(owner),
    )?;

    emit_cpi!(TokenAccountEjected {
        vault: ctx.accounts.vault.key(),
        owner,
        mint: ctx.accounts.mint.key(),
        token_account: ctx.accounts.token_account.key(),
        new_authority: owner,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
