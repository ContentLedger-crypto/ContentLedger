//! Batch settlement: the voucher signature of the agent (FR-008b), the payouts
//! it authorises (FR-014, FR-015, FR-015a) and the anchored root (FR-013).
//!
//! The agent never signs the settlement transaction — the settler does. What
//! authorises the spend is an Ed25519 verification instruction carried by the
//! same transaction: the runtime checks the signature itself, and this module
//! checks that the pair it was asked about is this escrow's agent and the exact
//! 88 bytes rebuilt here.
//!
//! That second half is where a settlement program is usually broken. The
//! precompile reports nothing back; it only fails the transaction. So a forged
//! instruction that verifies *some* valid signature over *some* bytes lands in
//! the same transaction and looks, to a program that only checks "an ed25519
//! instruction is present", exactly like consent. Hence the whole layout is
//! pinned byte for byte, offsets included: nothing is re-derived from numbers
//! the caller supplies.
//!
//! Position is deliberately not pinned. Once the key, the message and every
//! offset are fixed, an instruction that carries them is proof wherever it sits
//! — and a rule like "directly in front of us" would only couple the program to
//! how the settler happens to order compute-budget instructions today.
//!
//! The split is computed here from `Config`, not accepted from the settler. The
//! program cannot see receipt bodies, so what it gets is one tariff per payout
//! leg; the fee is whatever the signed total leaves over, and it must be what
//! `protocol_fee_bps` produces up to per-receipt rounding. Who inside the batch
//! earned which tariff is still the gateway's word — checkable by anyone
//! against the published batch, not enforceable here.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use solana_instructions_sysvar::load_instruction_at_checked;

use crate::error::ContentLedgerError;
use crate::state::{
    Config, Domain, Escrow, SettlementEntry, SettlementLog, CONFIG_SEED, ESCROW_SEED, LOG_SEED,
    MAX_BPS, VAULT_SEED,
};

const ED25519_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
const INSTRUCTIONS_SYSVAR_ID: Pubkey =
    Pubkey::from_str_const("Sysvar1nstructions1111111111111111111111111");

const VOUCHER_DOMAIN: &[u8; 8] = b"CLDGR:v1";

/// `"CLDGR:v1" ‖ escrow ‖ seq ‖ cumulative ‖ chain`, little-endian u64s. The
/// same layout is produced by `voucherMessage` in `packages/shared`; JSON is
/// not an option here, because this is rebuilt in BPF.
pub const VOUCHER_MESSAGE_LEN: usize = 88;

/// Offsets inside the verification instruction, fixed by the precompile's own
/// encoder: a 2-byte count, one 14-byte offsets record, then public key,
/// signature and message back to back.
const HEADER_LEN: usize = 16;
const PUBLIC_KEY_OFFSET: usize = HEADER_LEN;
const SIGNATURE_OFFSET: usize = PUBLIC_KEY_OFFSET + 32;
const MESSAGE_OFFSET: usize = SIGNATURE_OFFSET + 64;
const VERIFICATION_DATA_LEN: usize = MESSAGE_OFFSET + VOUCHER_MESSAGE_LEN;

/// The only header this program accepts: exactly one signature, every field
/// read out of the verification instruction itself (`u16::MAX`), every offset
/// at its canonical place. Anything else and the bytes the runtime verified
/// are not the bytes read below.
#[rustfmt::skip]
const EXPECTED_HEADER: [u8; HEADER_LEN] = [
    1, 0, // count, padding
    SIGNATURE_OFFSET as u8, 0, 0xff, 0xff, // signature
    PUBLIC_KEY_OFFSET as u8, 0, 0xff, 0xff, // public key
    MESSAGE_OFFSET as u8, 0, VOUCHER_MESSAGE_LEN as u8, 0, 0xff, 0xff, // message
];

/// Remaining accounts per payout leg: the registered `Domain`, its
/// `payout_owner` wallet and that wallet's associated token account.
const ACCOUNTS_PER_LEG: usize = 3;

pub fn voucher_message(
    escrow: &Pubkey,
    seq: u64,
    cumulative: u64,
    chain: &[u8; 32],
) -> [u8; VOUCHER_MESSAGE_LEN] {
    let mut message = [0u8; VOUCHER_MESSAGE_LEN];
    message[..8].copy_from_slice(VOUCHER_DOMAIN);
    message[8..40].copy_from_slice(escrow.as_ref());
    message[40..48].copy_from_slice(&seq.to_le_bytes());
    message[48..56].copy_from_slice(&cumulative.to_le_bytes());
    message[56..].copy_from_slice(chain);
    message
}

fn covers(data: &[u8], signer: &Pubkey, message: &[u8; VOUCHER_MESSAGE_LEN]) -> bool {
    data.len() == VERIFICATION_DATA_LEN
        && data[..HEADER_LEN] == EXPECTED_HEADER
        && data[PUBLIC_KEY_OFFSET..SIGNATURE_OFFSET] == signer.to_bytes()
        && data[MESSAGE_OFFSET..] == *message
}

fn require_verified_by(
    instructions: &AccountInfo,
    signer: &Pubkey,
    message: &[u8; VOUCHER_MESSAGE_LEN],
) -> Result<()> {
    let count = instructions
        .try_borrow_data()?
        .get(..2)
        .and_then(|bytes| <[u8; 2]>::try_from(bytes).ok())
        .map(u16::from_le_bytes)
        .ok_or(ContentLedgerError::VoucherSignatureMissing)?;

    let mut saw_verification = false;
    for index in 0..count {
        let candidate = load_instruction_at_checked(index as usize, instructions)?;
        if candidate.program_id != ED25519_PROGRAM_ID {
            continue;
        }
        saw_verification = true;
        if covers(&candidate.data, signer, message) {
            return Ok(());
        }
    }

    // Two errors, not one: "nobody asked the runtime to verify anything" and
    // "it verified something else" are different operational failures, and the
    // settler retries only the first.
    if saw_verification {
        err!(ContentLedgerError::VoucherSignatureMismatch)
    } else {
        err!(ContentLedgerError::VoucherSignatureMissing)
    }
}

/// The fee this batch carries, or `None` if the tariffs cannot come from
/// receipts priced at `fee_bps`.
///
/// Rounding happens per receipt, because each fee sits in a signed receipt body
/// (FR-015a rounds it up). Only the batch total reaches the program, so the
/// exact fee cannot be recomputed — but it is bounded: at least the fee on the
/// summed tariffs, and at most one base unit more per receipt beyond the first.
/// `receipts` is `seq − last_seq`: every voucher is one receipt.
pub fn batch_fee(charged: u64, tariffs: u64, receipts: u64, fee_bps: u16) -> Option<u64> {
    let fee = charged.checked_sub(tariffs)?;
    let lowest = (u128::from(tariffs) * u128::from(fee_bps)).div_ceil(u128::from(MAX_BPS));
    // A zero rate never rounds, so there is no slack to hide a skim in.
    let slack = if fee_bps == 0 {
        0
    } else {
        receipts.checked_sub(1)?
    };
    let excess = u128::from(fee).checked_sub(lowest)?;
    (excess <= u128::from(slack)).then_some(fee)
}

/// Emitted so a verifier can tell, after the fact, at which rates a batch was
/// split: `Config` may change later, and the ring has no room for them — a
/// wider entry would push 120 of them past the CPI account-size ceiling.
#[event]
pub struct BatchSettled {
    pub escrow: Pubkey,
    pub seq_end: u64,
    pub protocol_fee_bps: u16,
    pub node_share_bps: u16,
}

#[derive(Accounts)]
pub struct SettleBatch<'info> {
    /// The settler. The agent's consent lives in the verification instruction,
    /// not in this transaction — it is signed while the gateway serves content,
    /// hours before anyone settles. Also the payer of every account this
    /// settlement creates (FR-010a): neither the agent nor a publisher is.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ ContentLedgerError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    // No seed constraint on purpose: `Escrow` already pins owner and
    // discriminator, and the account's own `consumer` is the key the voucher
    // must be signed by — a substituted escrow fails on its own signature.
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, address = config.treasury_ata)]
    pub treasury: Account<'info, TokenAccount>,

    #[account(address = config.mint @ ContentLedgerError::MintMismatch)]
    pub mint: Account<'info, Mint>,

    // Created on the first settlement rather than at `open_escrow`: the rent is
    // a cost of settling, and an agent that is never served should not pay for
    // a ring it never fills.
    #[account(
        init_if_needed,
        payer = authority,
        space = SettlementLog::SIZE,
        seeds = [LOG_SEED, escrow.key().as_ref()],
        bump,
    )]
    pub settlement_log: AccountLoader<'info, SettlementLog>,

    // Pinned by address rather than left to the loader's own check: the
    // instruction count is read straight out of these bytes. A one-line `CHECK`
    // on purpose — anchor drops that line and publishes whatever follows it.
    /// CHECK: the Instructions sysvar, read through `solana-instructions-sysvar`.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn settle_batch<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleBatch<'info>>,
    seq: u64,
    cumulative: u64,
    chain: [u8; 32],
    root: [u8; 32],
    tariffs: Vec<u64>,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let escrow_key = accounts.escrow.key();
    let escrow = &accounts.escrow;
    let config = &accounts.config;

    require!(seq > escrow.last_seq, ContentLedgerError::StaleVoucher);

    let message = voucher_message(&escrow_key, seq, cumulative, &chain);
    require_verified_by(&accounts.instructions, &escrow.consumer, &message)?;

    let charged = cumulative
        .checked_sub(escrow.settled_total)
        .ok_or(ContentLedgerError::CumulativeBelowSettled)?;

    // The node cut is taken inside the tariff, and there is no attestor to pay
    // it to yet. Settling anyway would hand it to the publisher — silently
    // reading a non-zero rate as zero.
    require!(
        config.node_share_bps == 0,
        ContentLedgerError::NodeShareNotPayable
    );

    let tariff_total = tariffs
        .iter()
        .try_fold(0u64, |total, tariff| total.checked_add(*tariff))
        .ok_or(ContentLedgerError::SplitMismatch)?;
    let fee = batch_fee(
        charged,
        tariff_total,
        seq - escrow.last_seq,
        config.protocol_fee_bps,
    )
    .ok_or(ContentLedgerError::SplitMismatch)?;

    let legs = ctx.remaining_accounts;
    require!(
        legs.len() == tariffs.len() * ACCOUNTS_PER_LEG,
        ContentLedgerError::PayoutAccountsMismatch
    );

    let consumer = escrow.consumer;
    let signer_seeds: &[&[u8]] = &[ESCROW_SEED, consumer.as_ref(), &[escrow.bump]];
    let signer = &[signer_seeds];
    let pay = |to: AccountInfo<'info>, amount: u64| {
        token::transfer(
            CpiContext::new_with_signer(
                accounts.token_program.to_account_info(),
                Transfer {
                    from: accounts.vault.to_account_info(),
                    to,
                    authority: accounts.escrow.to_account_info(),
                },
                signer,
            ),
            amount,
        )
    };

    for (tariff, leg) in tariffs.iter().zip(legs.chunks_exact(ACCOUNTS_PER_LEG)) {
        let (domain_info, owner_info, payout_info) = (&leg[0], &leg[1], &leg[2]);
        let domain = Account::<Domain>::try_from(domain_info)?;
        require_keys_eq!(
            owner_info.key(),
            domain.payout_owner,
            ContentLedgerError::PayoutAccountsMismatch
        );
        // `create_idempotent` derives the address itself and ignores the one it
        // is handed, while the transfer below goes to the one handed in. Without
        // this, a leg could create the right account and pay a different one.
        require_keys_eq!(
            payout_info.key(),
            associated_token::get_associated_token_address(&owner_info.key(), &accounts.mint.key()),
            ContentLedgerError::PayoutAccountsMismatch
        );

        associated_token::create_idempotent(CpiContext::new(
            accounts.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: accounts.authority.to_account_info(),
                associated_token: payout_info.clone(),
                authority: owner_info.clone(),
                mint: accounts.mint.to_account_info(),
                system_program: accounts.system_program.to_account_info(),
                token_program: accounts.token_program.to_account_info(),
            },
        ))?;

        pay(payout_info.clone(), *tariff)?;
    }
    pay(accounts.treasury.to_account_info(), fee)?;

    let entry = SettlementEntry {
        seq_end: seq,
        ts: Clock::get()?.unix_timestamp,
        root,
        chain,
    };
    let log_loader = &accounts.settlement_log;
    let is_new = log_loader.to_account_info().try_borrow_data()?[..8] == [0u8; 8];
    if is_new {
        let mut log = log_loader.load_init()?;
        log.escrow = escrow_key;
        log.bump = ctx.bumps.settlement_log;
        log.push(entry);
    } else {
        log_loader.load_mut()?.push(entry);
    }

    emit!(BatchSettled {
        escrow: escrow_key,
        seq_end: seq,
        protocol_fee_bps: config.protocol_fee_bps,
        node_share_bps: config.node_share_bps,
    });

    let escrow = &mut ctx.accounts.escrow;
    escrow.settled_total = cumulative;
    escrow.last_seq = seq;
    escrow.last_chain = chain;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::batch_fee;

    const FEE_BPS: u16 = 1_000;

    /// Three receipts of 50 000, 30 000 and 1, each with its own rounded-up
    /// fee: 5 000 + 3 000 + 1.
    #[test]
    fn accepts_the_fee_of_receipts_priced_at_the_rate() {
        assert_eq!(batch_fee(88_002, 80_001, 3, FEE_BPS), Some(8_001));
    }

    /// Three receipts of one base unit: each rounds 0.1 up to 1, so the batch
    /// fee is 3 while the rate on the total gives 1. That gap is legitimate.
    #[test]
    fn accepts_rounding_up_on_every_receipt() {
        assert_eq!(batch_fee(6, 3, 3, FEE_BPS), Some(3));
    }

    /// One unit past what per-receipt rounding explains is the settler moving
    /// a publisher's money to the treasury.
    #[test]
    fn rejects_a_fee_above_what_rounding_explains() {
        assert_eq!(batch_fee(7, 3, 3, FEE_BPS), None);
        assert_eq!(batch_fee(88_003, 80_001, 1, FEE_BPS), None);
    }

    /// Below the rate on the total, publishers are paid out of the fee the
    /// agent signed for.
    #[test]
    fn rejects_a_fee_below_the_rate() {
        assert_eq!(batch_fee(88_000, 80_001, 3, FEE_BPS), None);
    }

    #[test]
    fn rejects_tariffs_above_what_the_agent_signed_for() {
        assert_eq!(batch_fee(80_000, 80_001, 3, FEE_BPS), None);
    }

    /// A zero rate leaves no rounding to excuse even a single unit.
    #[test]
    fn a_zero_rate_admits_no_fee_at_all() {
        assert_eq!(batch_fee(80_001, 80_001, 3, 0), Some(0));
        assert_eq!(batch_fee(80_002, 80_001, 3, 0), None);
    }

    #[test]
    fn large_tariffs_do_not_overflow() {
        let tariff = u64::MAX / 2;
        let fee = (u128::from(tariff) * 1_000).div_ceil(10_000) as u64;
        assert_eq!(batch_fee(tariff + fee, tariff, 1, FEE_BPS), Some(fee));
    }
}
