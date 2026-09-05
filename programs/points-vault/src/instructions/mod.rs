pub mod close_token_account;
pub mod close_vault;
pub mod create_vault;
pub mod deposit;
pub mod eject;
pub mod open_token_account;
pub mod withdraw;

// Globs rather than named re-exports of the `Accounts` structs: `#[program]` also expects the
// `__client_accounts_*` modules that `#[derive(Accounts)]` generates alongside them. The
// handlers are `pub(crate)` so that seven functions named `handler` do not collide here.
pub use close_token_account::*;
pub use close_vault::*;
pub use create_vault::*;
pub use deposit::*;
pub use eject::*;
pub use open_token_account::*;
pub use withdraw::*;
