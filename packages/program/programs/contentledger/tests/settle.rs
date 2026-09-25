//! T024 — `settle_batch`: the voucher signature of the agent.
//!
//! What this file can and cannot prove. Mollusk executes a single instruction,
//! so the Ed25519 precompile never runs here and the Instructions sysvar is
//! assembled by hand. The signature bytes are therefore filler: validating them
//! is the runtime's job, and ours is to prove that the (key, message) pair the
//! precompile was asked about is *our* agent and *our* 88 bytes. Every route by
//! which a different pair could be smuggled past that check lives below.

use anchor_lang::solana_program::sysvar::instructions::{
    construct_instructions_data, BorrowedAccountMeta, BorrowedInstruction,
};
use anchor_lang::{AccountDeserialize, AnchorSerialize, Discriminator, InstructionData, Space};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

use contentledger::error::ContentLedgerError;
use contentledger::instructions::settle::voucher_message;
use contentledger::state::{Config, Escrow};

const ED25519_ID: Pubkey = Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
const INSTRUCTIONS_ID: Pubkey =
    Pubkey::from_str_const("Sysvar1nstructions1111111111111111111111111");
const SYSVAR_OWNER: Pubkey = Pubkey::from_str_const("Sysvar1111111111111111111111111111111111111");

const GRACE_S: i64 = 900;

/// Where the voucher stood before this batch.
const LAST_SEQ: u64 = 40;
const LAST_CHAIN: [u8; 32] = [0xaa; 32];
const SETTLED_TOTAL: u64 = 3_000_000;

/// The voucher presented by the settler.
const SEQ: u64 = 41;
const CUMULATIVE: u64 = 88_200;
const CHAIN: [u8; 32] = [0x5a; 32];

fn program_id() -> Pubkey {
    Pubkey::new_from_array(contentledger::ID.to_bytes())
}

fn anchor_key(key: &Pubkey) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(key.to_bytes())
}

fn funded_wallet() -> Account {
    Account {
        lamports: 10_000_000_000,
        data: vec![],
        owner: Pubkey::default(),
        executable: false,
        rent_epoch: 0,
    }
}

fn account_with<T: AnchorSerialize>(discriminator: &[u8], state: &T, space: usize) -> Account {
    let mut data = discriminator.to_vec();
    state.serialize(&mut data).expect("серіалізація");
    data.resize(space, 0);
    Account {
        lamports: 5_000_000,
        data,
        owner: program_id(),
        executable: false,
        rent_epoch: 0,
    }
}

fn config_account(authority: &Pubkey, bump: u8) -> Account {
    let state = Config {
        authority: anchor_key(authority),
        treasury_ata: anchor_key(&Pubkey::new_unique()),
        mint: anchor_key(&Pubkey::new_unique()),
        protocol_fee_bps: 1_000,
        node_share_bps: 0,
        voucher_grace_s: GRACE_S,
        paused: false,
        bump,
        reserved: [0; 64],
    };
    account_with(Config::DISCRIMINATOR, &state, 8 + Config::INIT_SPACE)
}

fn escrow_account(consumer: &Pubkey, vault: &Pubkey, bump: u8, last_seq: u64) -> Account {
    let state = Escrow {
        consumer: anchor_key(consumer),
        vault: anchor_key(vault),
        settled_total: SETTLED_TOTAL,
        last_seq,
        last_chain: LAST_CHAIN,
        withdraw_after: 0,
        bump,
        vault_bump: 255,
        reserved: [0; 32],
    };
    account_with(Escrow::DISCRIMINATOR, &state, 8 + Escrow::INIT_SPACE)
}

fn error_code(result: &InstructionResult) -> u32 {
    match &result.program_result {
        ProgramResult::Failure(ProgramError::Custom(code)) => *code,
        other => panic!("очікувалась Custom-помилка, отримано {other:?}"),
    }
}

fn expected(error: ContentLedgerError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + error as u32
}

/// The single-signature layout of the Ed25519 precompile, spelled out field by
/// field so a test can move exactly one of them. The payload always sits at the
/// canonical positions — it is the *declared* offsets that a forged instruction
/// shifts, and that gap is the whole attack.
struct Precompile {
    count: u8,
    signature_offset: u16,
    public_key_offset: u16,
    message_offset: u16,
    message_size: u16,
    instruction_index: u16,
    public_key: [u8; 32],
    message: Vec<u8>,
}

impl Precompile {
    fn canonical(public_key: &Pubkey, message: &[u8]) -> Self {
        Self {
            count: 1,
            signature_offset: 48,
            public_key_offset: 16,
            message_offset: 112,
            message_size: message.len() as u16,
            // `u16::MAX` reads the field out of the precompile instruction
            // itself — the only arrangement in which our own offsets describe
            // what was actually verified.
            instruction_index: u16::MAX,
            public_key: public_key.to_bytes(),
            message: message.to_vec(),
        }
    }

    fn data(&self) -> Vec<u8> {
        let mut data = vec![self.count, 0];
        for field in [
            self.signature_offset,
            self.instruction_index,
            self.public_key_offset,
            self.instruction_index,
            self.message_offset,
            self.message_size,
            self.instruction_index,
        ] {
            data.extend_from_slice(&field.to_le_bytes());
        }
        data.extend_from_slice(&self.public_key);
        data.extend_from_slice(&[0x11; 64]);
        data.extend_from_slice(&self.message);
        data
    }
}

/// One entry of the Instructions sysvar. Owned, because `BorrowedInstruction`
/// borrows and the sysvar has to outlive the borrow.
struct RawInstruction {
    program_id: anchor_lang::prelude::Pubkey,
    data: Vec<u8>,
}

/// Mollusk runs one instruction, so the transaction around it is assembled
/// here. The owner is not decoration: the runtime refuses to touch an
/// Instructions sysvar owned by anyone else, and it rewrites the trailing
/// current-index bytes itself — which is why nothing in this file depends on
/// where in the transaction the verification instruction sits.
fn instructions_sysvar(entries: &[RawInstruction]) -> Account {
    let borrowed: Vec<BorrowedInstruction> = entries
        .iter()
        .map(|entry| BorrowedInstruction {
            program_id: &entry.program_id,
            accounts: Vec::<BorrowedAccountMeta>::new(),
            data: &entry.data,
        })
        .collect();

    Account {
        lamports: 1,
        data: construct_instructions_data(&borrowed),
        owner: SYSVAR_OWNER,
        executable: false,
        rent_epoch: 0,
    }
}

struct World {
    mollusk: Mollusk,
    authority: Pubkey,
    consumer: Pubkey,
    config: Pubkey,
    escrow: Pubkey,
    vault: Pubkey,
    escrow_bump: u8,
    accounts: Vec<(Pubkey, Account)>,
}

impl World {
    fn new() -> Self {
        let id = program_id();
        let authority = Pubkey::new_unique();
        let consumer = Pubkey::new_unique();

        let (config, config_bump) = Pubkey::find_program_address(&[b"config"], &id);
        let (escrow, escrow_bump) =
            Pubkey::find_program_address(&[b"escrow", consumer.as_ref()], &id);
        let (vault, _) = Pubkey::find_program_address(&[b"vault", escrow.as_ref()], &id);

        let mollusk = Mollusk::new(&id, "contentledger");

        let mut world = Self {
            mollusk,
            authority,
            consumer,
            config,
            escrow,
            vault,
            escrow_bump,
            accounts: vec![
                (authority, funded_wallet()),
                (config, config_account(&authority, config_bump)),
                (
                    escrow,
                    escrow_account(&consumer, &vault, escrow_bump, LAST_SEQ),
                ),
                (INSTRUCTIONS_ID, Account::default()),
            ],
        };
        let signed = world.voucher_bytes();
        world.with_transaction(&[RawInstruction {
            program_id: anchor_key(&ED25519_ID),
            data: Precompile::canonical(&world.consumer, &signed).data(),
        }]);
        world
    }

    /// The 88 bytes the agent signs — rebuilt by the program in BPF, which is
    /// why the layout is pinned in `golden.rs` against the TypeScript client.
    fn voucher_bytes(&self) -> Vec<u8> {
        voucher_message(&anchor_key(&self.escrow), SEQ, CUMULATIVE, &CHAIN).to_vec()
    }

    /// `preceding` are the instructions before `settle_batch`; the settler's own
    /// instruction always comes last.
    fn with_transaction(&mut self, preceding: &[RawInstruction]) {
        let mut entries: Vec<RawInstruction> = Vec::new();
        for entry in preceding {
            entries.push(RawInstruction {
                program_id: entry.program_id,
                data: entry.data.clone(),
            });
        }
        entries.push(RawInstruction {
            program_id: anchor_key(&program_id()),
            data: self.settle_batch().data,
        });

        self.accounts[3].1 = instructions_sysvar(&entries);
    }

    fn settle_batch(&self) -> Instruction {
        Instruction::new_with_bytes(
            program_id(),
            &contentledger::instruction::SettleBatch {
                seq: SEQ,
                cumulative: CUMULATIVE,
                chain: CHAIN,
            }
            .data(),
            vec![
                AccountMeta::new_readonly(self.authority, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.escrow, false),
                AccountMeta::new_readonly(INSTRUCTIONS_ID, false),
            ],
        )
    }

    fn run(&self) -> InstructionResult {
        self.mollusk
            .process_instruction(&self.settle_batch(), &self.accounts)
    }

    fn escrow_state(&self, result: &InstructionResult) -> Escrow {
        let raw = result.get_account(&self.escrow).expect("escrow існує");
        Escrow::try_deserialize(&mut raw.data.as_slice()).expect("Escrow декодується")
    }
}

/// Золотий вектор 1: підпис агента під саме цим ваучером.
#[test]
fn settle_batch_accepts_the_voucher_signed_by_the_agent() {
    let world = World::new();
    let result = world.run();
    assert!(matches!(result.program_result, ProgramResult::Success));

    let escrow = world.escrow_state(&result);
    assert_eq!(escrow.last_seq, SEQ);
    assert_eq!(escrow.last_chain, CHAIN);
    assert_eq!(
        escrow.settled_total, SETTLED_TOTAL,
        "гроші рухає T025: тут рухається лише позиція ваучера"
    );
}

/// Золотий вектор 2: підпис існує й валідний, але чужого ключа. Приймати його
/// означало б списувати з рахунку агента за чужим дозволом.
#[test]
fn settle_batch_rejects_a_voucher_signed_by_another_key() {
    let mut world = World::new();
    let stranger = Pubkey::new_unique();
    let signed = world.voucher_bytes();
    world.with_transaction(&[RawInstruction {
        program_id: anchor_key(&ED25519_ID),
        data: Precompile::canonical(&stranger, &signed).data(),
    }]);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::VoucherSignatureMismatch)
    );
}

/// Золотий вектор 3: зсунутий офсет. Без піна заголовка програма читала б свої
/// 88 байтів зі 112-ї позиції, а precompile перевірив би зовсім інші — рівно
/// та помилка, заради якої вектори й заведені.
#[test]
fn settle_batch_rejects_shifted_precompile_offsets() {
    let mut world = World::new();
    let signed = world.voucher_bytes();
    let mut forged = Precompile::canonical(&world.consumer, &signed);
    forged.message_offset = 120;
    world.with_transaction(&[RawInstruction {
        program_id: anchor_key(&ED25519_ID),
        data: forged.data(),
    }]);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::VoucherSignatureMismatch)
    );
}

/// Золотий вектор 4: підпис агента, але під іншою сумою. Аргумент інструкції й
/// підписане повідомлення мусять сходитись до байта.
#[test]
fn settle_batch_rejects_a_signature_over_a_different_cumulative() {
    let mut world = World::new();
    let other = voucher_message(&anchor_key(&world.escrow), SEQ, CUMULATIVE + 1, &CHAIN).to_vec();
    world.with_transaction(&[RawInstruction {
        program_id: anchor_key(&ED25519_ID),
        data: Precompile::canonical(&world.consumer, &other).data(),
    }]);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::VoucherSignatureMismatch)
    );
}

/// Без precompile попереду сетлмент не має жодного доказу згоди агента.
#[test]
fn settle_batch_rejects_a_transaction_without_a_precompile() {
    let mut world = World::new();
    world.with_transaction(&[]);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::VoucherSignatureMissing)
    );
}

/// Попередня інструкція чужої програми може містити ті самі байти — доказом
/// вона від цього не стає.
#[test]
fn settle_batch_rejects_a_lookalike_from_another_program() {
    let mut world = World::new();
    let signed = world.voucher_bytes();
    world.with_transaction(&[RawInstruction {
        program_id: anchor_key(&Pubkey::new_unique()),
        data: Precompile::canonical(&world.consumer, &signed).data(),
    }]);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::VoucherSignatureMissing)
    );
}

/// Другий підпис у тій самій інструкції — класичний спосіб протягти пару, якої
/// ніхто не дивився: перевіряють перший офсет, а сплачують за другим.
#[test]
fn settle_batch_rejects_a_precompile_carrying_a_second_signature() {
    let mut world = World::new();
    let signed = world.voucher_bytes();
    let mut data = Precompile::canonical(&world.consumer, &signed).data();
    data[0] = 2;
    data.extend_from_slice(&Precompile::canonical(&Pubkey::new_unique(), &signed).data()[2..]);
    world.with_transaction(&[RawInstruction {
        program_id: anchor_key(&ED25519_ID),
        data,
    }]);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::VoucherSignatureMismatch)
    );
}

/// Ваучер рухається тільки вперед: інакше вже відсетлений батч пред'являвся б
/// удруге (FR-009).
#[test]
fn settle_batch_rejects_a_voucher_the_escrow_has_passed() {
    let mut world = World::new();
    world.accounts[2].1 = escrow_account(&world.consumer, &world.vault, world.escrow_bump, SEQ);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::StaleVoucher)
    );
}

/// Сетлмент підписує оператор і тільки він: підпис агента лежить у precompile,
/// а не в транзакції.
#[test]
fn settle_batch_rejects_a_foreign_settler() {
    let mut world = World::new();
    let stranger = Pubkey::new_unique();
    world.accounts.push((stranger, funded_wallet()));

    let mut instruction = world.settle_batch();
    instruction.accounts[0] = AccountMeta::new_readonly(stranger, true);

    let result = world
        .mollusk
        .process_instruction(&instruction, &world.accounts);
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::Unauthorized)
    );
}
