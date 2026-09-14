//! T014 — `init_config`.
//!
//! Токен-акаунти складаються байтами вручну, а не крейтом `spl-token`: anchor
//! сидить на `solana-pubkey` 2.x, mollusk — на 4.x, і міст між ними тільки
//! через байти. Явні зсуви ще й читаються як специфікація формату.

use anchor_lang::{AccountDeserialize, InstructionData, Space};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

use contentledger::error::ContentLedgerError;
use contentledger::state::Config;

const SPL_TOKEN_ID: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const FEE_BPS: u16 = 250;
const NODE_BPS: u16 = 0;
const GRACE_S: i64 = 900;

fn program_id() -> Pubkey {
    Pubkey::new_from_array(contentledger::ID.to_bytes())
}

/// `spl_token::state::Mint`, 82 байти.
fn mint_account(decimals: u8) -> Account {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes()); // COption::Some(mint_authority)
    data[4..36].copy_from_slice(&[7u8; 32]);
    data[44] = decimals;
    data[45] = 1; // is_initialized
    Account {
        lamports: 1_461_600,
        data,
        owner: SPL_TOKEN_ID,
        executable: false,
        rent_epoch: 0,
    }
}

/// `spl_token::state::Account`, 165 байтів.
fn token_account(mint: &Pubkey, owner: &Pubkey, program: Pubkey) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[108] = 1; // AccountState::Initialized
    Account {
        lamports: 2_039_280,
        data,
        owner: program,
        executable: false,
        rent_epoch: 0,
    }
}

fn funded_wallet() -> Account {
    Account {
        lamports: 10_000_000_000,
        data: vec![],
        owner: Pubkey::default(), // system program
        executable: false,
        rent_epoch: 0,
    }
}

struct Fixture {
    mollusk: Mollusk,
    authority: Pubkey,
    config: Pubkey,
    mint: Pubkey,
    treasury: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

fn fixture() -> Fixture {
    let id = program_id();
    let authority = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let (config, _) = Pubkey::find_program_address(&[b"config"], &id);
    let (system_id, system_account) = mollusk_svm::program::keyed_account_for_system_program();

    Fixture {
        mollusk: Mollusk::new(&id, "contentledger"),
        authority,
        config,
        mint,
        treasury,
        accounts: vec![
            (authority, funded_wallet()),
            (config, Account::default()),
            (mint, mint_account(6)),
            (
                treasury,
                token_account(&mint, &Pubkey::new_unique(), SPL_TOKEN_ID),
            ),
            (system_id, system_account),
        ],
    }
}

impl Fixture {
    fn instruction(&self, fee_bps: u16, node_bps: u16, grace_s: i64) -> Instruction {
        let (system_id, _) = mollusk_svm::program::keyed_account_for_system_program();
        Instruction::new_with_bytes(
            program_id(),
            &contentledger::instruction::InitConfig {
                protocol_fee_bps: fee_bps,
                node_share_bps: node_bps,
                voucher_grace_s: grace_s,
            }
            .data(),
            vec![
                AccountMeta::new(self.authority, true),
                AccountMeta::new(self.config, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(self.treasury, false),
                AccountMeta::new_readonly(system_id, false),
            ],
        )
    }

    fn run(&self, fee_bps: u16, node_bps: u16, grace_s: i64) -> InstructionResult {
        self.mollusk.process_instruction(
            &self.instruction(fee_bps, node_bps, grace_s),
            &self.accounts,
        )
    }

    fn run_default(&self) -> InstructionResult {
        self.run(FEE_BPS, NODE_BPS, GRACE_S)
    }
}

/// Код помилки числом: рядок у Debug-виводі змінюється разом із формулюванням
/// `#[msg]`, а число — це те, з чим звірятиметься клієнт на T018.
fn error_code(result: &InstructionResult) -> u32 {
    match &result.program_result {
        ProgramResult::Failure(ProgramError::Custom(code)) => *code,
        other => panic!("очікувалась Custom-помилка, отримано {other:?}"),
    }
}

fn expected(error: ContentLedgerError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + error as u32
}

#[test]
fn init_config_declares_shares_publicly() {
    let f = fixture();
    let result = f.run_default();
    assert!(matches!(result.program_result, ProgramResult::Success));

    let raw = result.get_account(&f.config).expect("config створений");
    assert_eq!(raw.owner, program_id());
    assert_eq!(raw.data.len(), 8 + Config::INIT_SPACE);

    let config = Config::try_deserialize(&mut raw.data.as_slice()).expect("Config декодується");
    assert_eq!(config.authority.to_bytes(), f.authority.to_bytes());
    assert_eq!(config.treasury_ata.to_bytes(), f.treasury.to_bytes());
    assert_eq!(config.mint.to_bytes(), f.mint.to_bytes());
    assert_eq!(config.protocol_fee_bps, FEE_BPS);
    assert_eq!(config.node_share_bps, NODE_BPS);
    assert_eq!(config.voucher_grace_s, GRACE_S);
    assert!(!config.paused);
    assert_eq!(config.reserved, [0u8; 64]);

    let (_, bump) = Pubkey::find_program_address(&[b"config"], &program_id());
    assert_eq!(config.bump, bump, "канонічний bump збережений");
}

#[test]
fn rejects_fee_over_one_hundred_percent() {
    let f = fixture();
    let result = f.run(10_001, NODE_BPS, GRACE_S);
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::BpsOutOfRange)
    );
}

#[test]
fn rejects_node_share_over_one_hundred_percent() {
    let f = fixture();
    let result = f.run(FEE_BPS, 10_001, GRACE_S);
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::BpsOutOfRange)
    );
}

/// Нульове вікно — це безкоштовна видача вмісту: агент забирає залишок
/// раніше, ніж шлюз відсетлить видані ваучери.
#[test]
fn rejects_grace_outside_bounds() {
    let f = fixture();
    for grace in [0, 59, 7 * 24 * 60 * 60 + 1] {
        let result = f.run(FEE_BPS, NODE_BPS, grace);
        assert_eq!(
            error_code(&result),
            expected(ContentLedgerError::GraceOutOfRange),
            "grace = {grace}"
        );
    }
}

/// Межі включно — рівно 60 і рівно тиждень проходять.
#[test]
fn accepts_grace_at_the_bounds() {
    let f = fixture();
    for grace in [60, 7 * 24 * 60 * 60] {
        let result = f.run(FEE_BPS, NODE_BPS, grace);
        assert!(
            matches!(result.program_result, ProgramResult::Success),
            "grace = {grace}"
        );
    }
}

/// Скарбниця під чужим мінтом ловиться на init, а не на першому сетлменті.
#[test]
fn rejects_treasury_of_another_mint() {
    let mut f = fixture();
    let other_mint = Pubkey::new_unique();
    f.accounts[3].1 = token_account(&other_mint, &Pubkey::new_unique(), SPL_TOKEN_ID);

    let result = f.run_default();
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::TreasuryMintMismatch)
    );
}

/// Токен-акаунт чужої програми (у тому числі Token-2022) не приймається:
/// розширення transfer-fee ламало б SC-005.
#[test]
fn rejects_treasury_owned_by_a_foreign_program() {
    let mut f = fixture();
    f.accounts[3].1 = token_account(&f.mint, &Pubkey::new_unique(), Pubkey::new_unique());

    let result = f.run_default();
    assert!(!matches!(result.program_result, ProgramResult::Success));
}

/// Другий `init_config` не проходить: `Config` уже зайнятий, і це і є весь
/// захист «перший, хто викликав».
#[test]
fn second_init_finds_the_config_taken() {
    let mut f = fixture();
    f.accounts[1].1 = Account {
        lamports: 2_000_000,
        data: vec![0u8; 8 + Config::INIT_SPACE],
        owner: program_id(),
        executable: false,
        rent_epoch: 0,
    };

    let result = f.run_default();
    assert!(!matches!(result.program_result, ProgramResult::Success));
}

/// Підпис `authority` обов'язковий — інакше будь-хто оголошував би частки.
#[test]
fn rejects_unsigned_authority() {
    let f = fixture();
    let mut instruction = f.instruction(FEE_BPS, NODE_BPS, GRACE_S);
    instruction.accounts[0].is_signer = false;

    let result = f.mollusk.process_instruction(&instruction, &f.accounts);
    assert!(!matches!(result.program_result, ProgramResult::Success));
}
