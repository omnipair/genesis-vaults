use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{transfer_fee::TransferFeeAmount, BaseStateWithExtensions, StateWithExtensions},
        state::Account as Token2022Account,
    },
    token_2022_extensions::{harvest_withheld_tokens_to_mint, HarvestWithheldTokensToMint},
    token_interface::{close_account, CloseAccount, Mint, TokenAccount, TokenInterface},
};

use crate::{errors::PointsVaultError, events::TokenAccountClosed, state::Vault, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct CloseTokenAccount<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

    /// Writable because withheld transfer fees are swept here before the account is closed.
    /// Harmless for a mint without them: nothing writes to it in that case.
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: receives the reclaimed rent; the owner chooses where it goes.
    #[account(mut)]
    pub rent_destination: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Transfer fees taken out of transfers *into* this account and not yet swept to the mint.
///
/// Zero for a classic SPL token account, and for a Token-2022 account whose mint charges no
/// fee: neither carries the extension.
fn withheld_fees(token_account: &AccountInfo) -> Result<u64> {
    let data = token_account.try_borrow_data()?;
    let Ok(state) = StateWithExtensions::<Token2022Account>::unpack(&data) else {
        return Ok(0);
    };

    Ok(state
        .get_extension::<TransferFeeAmount>()
        .map(|fees| u64::from(fees.withheld_amount))
        .unwrap_or(0))
}

pub(crate) fn handler(ctx: Context<CloseTokenAccount>) -> Result<()> {
    require!(
        ctx.accounts.token_account.amount == 0,
        PointsVaultError::VaultNotEmpty
    );

    let vault = ctx.accounts.vault.key();
    let owner = ctx.accounts.owner.key();
    let mint = ctx.accounts.mint.key();
    let token_account = ctx.accounts.token_account.key();
    let rent_destination = ctx.accounts.rent_destination.key();

    // A balance can be zero while withheld fees remain, because Token-2022 withholds them in
    // the account that *receives* a transfer and no withdrawal takes them back out. The token
    // program refuses to close an account in that state, so sweep them first. This is
    // permissionless and takes nothing from the owner: the fees were deducted when they
    // arrived and the mint is where they were always going.
    if withheld_fees(&ctx.accounts.token_account.to_account_info())? > 0 {
        harvest_withheld_tokens_to_mint(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                HarvestWithheldTokensToMint {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            vec![ctx.accounts.token_account.to_account_info()],
        )?;
    }

    let bump = [ctx.accounts.vault.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner.as_ref(), &bump]];

    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.token_account.to_account_info(),
            destination: ctx.accounts.rent_destination.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    ))?;

    emit_cpi!(TokenAccountClosed {
        vault,
        owner,
        mint,
        token_account,
        rent_destination,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
