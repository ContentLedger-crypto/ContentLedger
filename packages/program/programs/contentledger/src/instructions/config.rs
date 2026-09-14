//! `init_config` — оголошення часток розподілу до першого платежу (FR-016).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::error::ContentLedgerError;
use crate::state::{Config, CONFIG_SEED, MAX_BPS};

/// Нижня межа вікна на вивід. Нуль означав би, що агент забирає залишок
/// швидше, ніж шлюз встигає відсетлити вже видані ваучери, — тобто безкоштовну
/// видачу вмісту, а не «гнучке налаштування».
pub const MIN_VOUCHER_GRACE_S: i64 = 60;

/// Верхня межа. За FR-008d кошти належать агенту, і місяць очікування виводу
/// був би вилученням у все, крім назви.
pub const MAX_VOUCHER_GRACE_S: i64 = 7 * 24 * 60 * 60;

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Хто викликав перший, той і `authority`. PDA не дає створити `Config`
    /// удруге, а деплой і `init` ідуть одним скриптом, тож вікно між ними
    /// вимірюється секундами. Для mainnet звірка з `upgrade_authority` —
    /// окремий крок hardening, свідомо не зроблений на M1.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// Валюта протоколу (FR-010). Тип пінить власника до legacy SPL Token:
    /// розширення Token-2022 (transfer-fee, transfer-hook) мовчки з'їдають
    /// частину переказу, а це ламає SC-005.
    pub mint: Account<'info, Mint>,

    /// Куди йде комісія протоколу. Перевіряється тут, а не на першому
    /// сетлменті: помилку в адресі краще ловити на init, ніж під час
    /// наскрізного прогону M1.
    #[account(
        constraint = treasury_ata.mint == mint.key() @ ContentLedgerError::TreasuryMintMismatch,
    )]
    pub treasury_ata: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
}

pub fn init_config(
    ctx: Context<InitConfig>,
    protocol_fee_bps: u16,
    node_share_bps: u16,
    voucher_grace_s: i64,
) -> Result<()> {
    require!(
        protocol_fee_bps <= MAX_BPS,
        ContentLedgerError::BpsOutOfRange
    );
    require!(node_share_bps <= MAX_BPS, ContentLedgerError::BpsOutOfRange);
    require!(
        (MIN_VOUCHER_GRACE_S..=MAX_VOUCHER_GRACE_S).contains(&voucher_grace_s),
        ContentLedgerError::GraceOutOfRange
    );

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.treasury_ata = ctx.accounts.treasury_ata.key();
    config.mint = ctx.accounts.mint.key();
    config.protocol_fee_bps = protocol_fee_bps;
    config.node_share_bps = node_share_bps;
    config.voucher_grace_s = voucher_grace_s;
    config.paused = false;
    config.bump = ctx.bumps.config;
    config.reserved = [0; 64];

    Ok(())
}
