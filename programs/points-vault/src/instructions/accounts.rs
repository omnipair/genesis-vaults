use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_interface::{
        spl_token_2022::{
            extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
            state::Mint as SplToken2022Mint,
        },
        Mint, Token2022,
    },
};

use crate::errors::PointsVaultError;

/// Reject Token-2022 mint extensions whose transfer semantics this program does not support.
///
/// Metadata extensions do not affect token movement. Transfer fees are supported explicitly:
/// deposits and withdrawals measure the vault-side balance delta, and account closure harvests
/// withheld fees. In particular, transfer hooks are not accepted because these instructions do
/// not take or forward the hook's extra accounts.
pub(crate) fn require_supported_asset_mint(mint: &InterfaceAccount<Mint>) -> Result<()> {
    let mint_info = mint.to_account_info();
    if *mint_info.owner == Token::id() {
        return Ok(());
    }

    require_keys_eq!(
        *mint_info.owner,
        Token2022::id(),
        PointsVaultError::UnsupportedMintExtensions
    );

    let mint_data = mint_info.try_borrow_data()?;
    let mint_state = StateWithExtensions::<SplToken2022Mint>::unpack(&mint_data)?;
    let supported = mint_state
        .get_extension_types()?
        .into_iter()
        .all(|extension| {
            matches!(
                extension,
                ExtensionType::TransferFeeConfig
                    | ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
            )
        });

    require!(supported, PointsVaultError::UnsupportedMintExtensions);
    Ok(())
}
