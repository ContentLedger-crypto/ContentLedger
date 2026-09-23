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

    pub fn register_domain(
        ctx: Context<RegisterDomain>,
        host_hash: [u8; 32],
        host: String,
        owner: Pubkey,
        payout_owner: Pubkey,
        rate_train: u64,
        rate_inference: u64,
    ) -> Result<()> {
        instructions::registry::register_domain(
            ctx,
            host_hash,
            host,
            owner,
            payout_owner,
            rate_train,
            rate_inference,
        )
    }

    pub fn register_work(
        ctx: Context<RegisterWork>,
        source_hash: [u8; 32],
        content_hash: [u8; 32],
    ) -> Result<()> {
        instructions::registry::register_work(ctx, source_hash, content_hash)
    }

    pub fn set_domain_rates(
        ctx: Context<UpdateDomain>,
        rate_train: u64,
        rate_inference: u64,
    ) -> Result<()> {
        instructions::registry::set_domain_rates(ctx, rate_train, rate_inference)
    }

    pub fn set_domain_status(ctx: Context<UpdateDomain>, status: LicenceStatus) -> Result<()> {
        instructions::registry::set_domain_status(ctx, status)
    }

    pub fn set_work_rates(
        ctx: Context<UpdateWork>,
        rate_train: Option<u64>,
        rate_inference: Option<u64>,
    ) -> Result<()> {
        instructions::registry::set_work_rates(ctx, rate_train, rate_inference)
    }

    pub fn set_work_status(ctx: Context<UpdateWork>, status: LicenceStatus) -> Result<()> {
        instructions::registry::set_work_status(ctx, status)
    }

    pub fn open_escrow(ctx: Context<OpenEscrow>) -> Result<()> {
        instructions::escrow::open_escrow(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::escrow::deposit(ctx, amount)
    }

    pub fn request_withdraw(ctx: Context<RequestWithdraw>) -> Result<()> {
        instructions::escrow::request_withdraw(ctx)
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        instructions::escrow::withdraw(ctx)
    }
}

#[derive(Accounts)]
pub struct Ping {}
