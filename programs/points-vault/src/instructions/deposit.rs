use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{errors::PointsVaultError, events::VaultDeposited, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Funds the transfer and signs it. Need not be the vault owner: anyone can top up
    /// anyone else's vault.
    pub depositor: Signer<'info>,

    /// CHECK: only read as a pubkey, and pinned by both the vault's seeds and its
    /// `token::authority` constraint below.
    pub owner: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = depositor,
        token::token_program = token_program,
    )]
    pub source: InterfaceAccount<'info, TokenAccount>,

    /// Re-asserting `token::authority = owner` means a vault whose authority has been
    /// reassigned away can no longer be topped up through this program. Its owner still has
    /// full control of it via raw SPL Token instructions.
    ///
    /// The token program lets an account transfer to itself and reports success while moving
    /// nothing, which would leave a `VaultDeposited` claiming an `amount` that never arrived.
    /// The constraint sits here rather than on `source` because `source` is declared first and
    /// cannot refer to an account it has not seen yet.
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = owner,
        token::token_program = token_program,
        constraint = vault.key() != source.key() @ PointsVaultError::SelfTransfer,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, PointsVaultError::ZeroAmount);

    let balance_before = ctx.accounts.vault.amount;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    ctx.accounts.vault.reload()?;
    let new_balance = ctx.accounts.vault.amount;
    let amount_received = new_balance
        .checked_sub(balance_before)
        .ok_or(PointsVaultError::BalanceOverflow)?;

    emit_cpi!(VaultDeposited {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        mint: ctx.accounts.mint.key(),
        depositor: ctx.accounts.depositor.key(),
        amount,
        amount_received,
        new_balance,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
