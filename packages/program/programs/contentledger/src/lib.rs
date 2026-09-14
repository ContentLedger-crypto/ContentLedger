use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use error::*;
pub use state::*;
// Не `pub use`: `#[program]` сам реекспортує імена обробників, і два глоби на те
// саме ім'я — це `ambiguous_glob_reexports`, тобто помилка під `-D warnings`.
use instructions::*;

declare_id!("HFoHycv5MSCFizdb4GhPSYgLWFfwu1MgEW8qx8zuWKh2");

#[program]
pub mod contentledger {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }

    pub fn init_config(
        ctx: Context<InitConfig>,
        protocol_fee_bps: u16,
        node_share_bps: u16,
        voucher_grace_s: i64,
    ) -> Result<()> {
        instructions::config::init_config(ctx, protocol_fee_bps, node_share_bps, voucher_grace_s)
    }
}

#[derive(Accounts)]
pub struct Ping {}
