use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{errors::PointsVaultError, events::Withdrawn, state::Vault, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// The only thing that authorises an exit. The vault PDA holds the token authority and
    /// signs the transfer below, but its address is derived from this key, so a different
    /// signer derives a different vault and never reaches these funds.
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

    /// The token program lets an account transfer to itself and reports success while moving
    /// nothing, which would leave a `Withdrawn` claiming an `amount` that never left.
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = destination.key() != token_account.key() @ PointsVaultError::SelfTransfer,
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub(crate) fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, PointsVaultError::ZeroAmount);

    let balance_before = ctx.accounts.token_account.amount;

    let owner_key = ctx.accounts.owner.key();
    let bump = [ctx.accounts.vault.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner_key.as_ref(), &bump]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    ctx.accounts.token_account.reload()?;
    let new_balance = ctx.accounts.token_account.amount;
    let amount_debited = balance_before
        .checked_sub(new_balance)
        .ok_or(PointsVaultError::BalanceOverflow)?;

    emit_cpi!(Withdrawn {
        vault: ctx.accounts.vault.key(),
        owner: owner_key,
        mint: ctx.accounts.mint.key(),
        token_account: ctx.accounts.token_account.key(),
        destination: ctx.accounts.destination.key(),
        amount,
        amount_debited,
        new_balance,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
