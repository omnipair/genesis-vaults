use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    errors::PointsVaultError, events::Deposited,
    instructions::accounts::require_supported_asset_mint, state::Vault, VAULT_SEED,
};

#[event_cpi]
#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Funds the transfer and signs it. Need not be the vault owner: anyone can top up
    /// anyone else's vault.
    pub depositor: Signer<'info>,

    /// CHECK: only read as a pubkey, and pinned by the vault's seeds and `has_one` below.
    pub owner: UncheckedAccount<'info>,

    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = depositor,
        token::token_program = token_program,
    )]
    pub source: InterfaceAccount<'info, TokenAccount>,

    /// The token program lets an account transfer to itself and reports success while moving
    /// nothing, which would leave a `Deposited` claiming an `amount` that never arrived. The
    /// constraint sits here rather than on `source` because `source` is declared first and
    /// cannot refer to an account it has not seen yet.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
        constraint = token_account.key() != source.key() @ PointsVaultError::SelfTransfer,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub(crate) fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, PointsVaultError::ZeroAmount);
    require_supported_asset_mint(&ctx.accounts.mint)?;

    let balance_before = ctx.accounts.token_account.amount;

    // `CpiContext::new`, not `new_with_signer`: money moving *in* is authorised by whoever
    // owns it, so the vault contributes no signature on this path.
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.token_account.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    ctx.accounts.token_account.reload()?;
    let new_balance = ctx.accounts.token_account.amount;
    let amount_received = new_balance
        .checked_sub(balance_before)
        .ok_or(PointsVaultError::BalanceOverflow)?;

    emit_cpi!(Deposited {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        mint: ctx.accounts.mint.key(),
        token_account: ctx.accounts.token_account.key(),
        depositor: ctx.accounts.depositor.key(),
        amount,
        amount_received,
        new_balance,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
