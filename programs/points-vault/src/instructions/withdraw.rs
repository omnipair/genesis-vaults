use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{errors::PointsVaultError, events::VaultWithdrawn, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// The token authority on the vault. The CPI below is a plain `invoke`, so this
    /// signature is the only thing that can move the funds.
    pub owner: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, PointsVaultError::ZeroAmount);

    let balance_before = ctx.accounts.vault.amount;

    // `CpiContext::new`, not `new_with_signer`: the program contributes no signature here.
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    ctx.accounts.vault.reload()?;
    let new_balance = ctx.accounts.vault.amount;
    let amount_debited = balance_before
        .checked_sub(new_balance)
        .ok_or(PointsVaultError::BalanceOverflow)?;

    emit_cpi!(VaultWithdrawn {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        mint: ctx.accounts.mint.key(),
        destination: ctx.accounts.destination.key(),
        amount,
        amount_debited,
        new_balance,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
