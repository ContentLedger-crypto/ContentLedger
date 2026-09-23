//! Передплачений рахунок агента: `open_escrow`, `deposit`, `request_withdraw`,
//! `withdraw` (FR-008a, FR-008d).
//!
//! Уся сімʼя тримається на одному рішенні: **вихід агента не потребує жодного
//! чужого підпису**. Оператор не з'являється в жодному з чотирьох контекстів, а
//! `withdraw` не бачить навіть `Config` — вікно очікування він бере зі знімка,
//! який зробив сам агент у `request_withdraw`. Отже ні піднята комісія, ні
//! аварійна зупинка, ні зміна `voucher_grace_s` не подовжують уже початого
//! відліку: FR-008d виконується складом акаунтів, а не перевіркою всередині.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::ContentLedgerError;
use crate::state::{Config, Escrow, CONFIG_SEED, ESCROW_SEED, VAULT_SEED};

#[derive(Accounts)]
pub struct OpenEscrow<'info> {
    /// Він же платник ренти: рахунок відкривається агентом і належить агенту.
    #[account(mut)]
    pub consumer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = consumer,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, consumer.key().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    /// Валюта протоколу (FR-010). Escrow у чужому токені прийняв би платежі,
    /// яких сетлмент не зміг би розвести отримувачам.
    #[account(constraint = mint.key() == config.mint @ ContentLedgerError::MintMismatch)]
    pub mint: Account<'info, Mint>,

    /// Розпоряджається сховищем сам `escrow`: ключа від нього не існує ні в
    /// агента, ні в оператора, а рух коштів лишається всередині програми.
    #[account(
        init,
        payer = consumer,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn open_escrow(ctx: Context<OpenEscrow>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    escrow.consumer = ctx.accounts.consumer.key();
    escrow.vault = ctx.accounts.vault.key();
    escrow.settled_total = 0;
    escrow.last_seq = 0;
    escrow.last_chain = [0; 32];
    escrow.withdraw_after = 0;
    escrow.bump = ctx.bumps.escrow;
    escrow.vault_bump = ctx.bumps.vault;
    escrow.reserved = [0; 32];

    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Поповнює тільки власник рахунку — не з міркувань доступу до коштів
    /// (чужі гроші тут нікому не зашкодять), а тому що депозит скасовує заявку
    /// на вивід: інакше сторонній «дарунок» продовжував би агентові строк.
    pub consumer: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, consumer.key().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub source: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.consumer.to_account_info(),
            },
        ),
        amount,
    )?;

    // Поповнення — протилежність виходу. Окремої інструкції скасування немає,
    // тож без цього рядка escrow, який колись подав заявку, лишався б у стані
    // «йду» назавжди, і шлюз більше ніколи його не обслуговував би.
    ctx.accounts.escrow.withdraw_after = 0;

    Ok(())
}

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    pub consumer: Signer<'info>,

    /// Єдине місце, де читається `voucher_grace_s`. Далі діє знімок в
    /// `Escrow::withdraw_after`, тож зміна глобального значення не рухає вже
    /// початий відлік у жоден бік.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, consumer.key().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,
}

pub fn request_withdraw(ctx: Context<RequestWithdraw>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.escrow.withdraw_after = now.saturating_add(ctx.accounts.config.voucher_grace_s);

    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub consumer: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, consumer.key().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Куди саме забирати залишок — вибір агента: кошти його (FR-008d).
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Забирає **весь** залишок: FR-008d говорить про невитрачений залишок, а не
/// про довільну суму, і часткові виводи давали б стан, у якому вікно вже
/// витрачене, а гроші ще в сховищі.
pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let withdraw_after = ctx.accounts.escrow.withdraw_after;
    require!(
        withdraw_after != 0,
        ContentLedgerError::WithdrawNotRequested
    );
    require!(
        Clock::get()?.unix_timestamp >= withdraw_after,
        ContentLedgerError::WithdrawTooEarly
    );

    let consumer = ctx.accounts.consumer.key();
    let seeds: &[&[u8]] = &[ESCROW_SEED, consumer.as_ref(), &[ctx.accounts.escrow.bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            &[seeds],
        ),
        ctx.accounts.vault.amount,
    )?;

    // Заявка одноразова. Інакше один запит давав би безстрокове право спорожнити
    // сховище будь-якої миті — тобто вікно переставало б бути вікном.
    ctx.accounts.escrow.withdraw_after = 0;

    // `settled_total`, `last_seq` і `last_chain` навмисно не чіпаються: агент,
    // який вийшов і повернувся, не має права пред'явити вже відсетлені
    // ваучери повторно (FR-009).
    Ok(())
}
