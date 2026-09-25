//! Batch settlement: the voucher signature of the agent (FR-008b).
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

use anchor_lang::prelude::*;
use solana_instructions_sysvar::load_instruction_at_checked;

use crate::error::ContentLedgerError;
use crate::state::{Config, Escrow, CONFIG_SEED};

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

#[derive(Accounts)]
pub struct SettleBatch<'info> {
    /// The settler. The agent's consent lives in the verification instruction,
    /// not in this transaction — it is signed while the gateway serves content,
    /// hours before anyone settles.
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

    // Pinned by address rather than left to the loader's own check: the
    // instruction count is read straight out of these bytes. A one-line `CHECK`
    // on purpose — anchor drops that line and publishes whatever follows it.
    /// CHECK: the Instructions sysvar, read through `solana-instructions-sysvar`.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn settle_batch(
    ctx: Context<SettleBatch>,
    seq: u64,
    cumulative: u64,
    chain: [u8; 32],
) -> Result<()> {
    let escrow_key = ctx.accounts.escrow.key();
    let escrow = &mut ctx.accounts.escrow;

    require!(seq > escrow.last_seq, ContentLedgerError::StaleVoucher);

    let message = voucher_message(&escrow_key, seq, cumulative, &chain);
    require_verified_by(&ctx.accounts.instructions, &escrow.consumer, &message)?;

    escrow.last_seq = seq;
    escrow.last_chain = chain;

    Ok(())
}
