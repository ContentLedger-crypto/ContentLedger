//! T023 — escrow: `open_escrow`, `deposit`, `request_withdraw`, `withdraw`.
//!
//! Токен-акаунти складаються байтами вручну з тієї ж причини, що й у
//! `config.rs`: anchor сидить на `solana-pubkey` 2.x, mollusk — на 4.x.
//! А от програму spl-token mollusk вантажить справжню: інакше ні `init`
//! токен-акаунта, ні жоден переказ не виконались би взагалі, і тести доводили
//! б лише те, що ми правильно склали CPI-виклик.

use anchor_lang::{AccountDeserialize, AnchorSerialize, Discriminator, InstructionData, Space};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

use contentledger::error::ContentLedgerError;
use contentledger::state::{Config, Escrow};

const SPL_TOKEN_ID: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const GRACE_S: i64 = 900;
const NOW: i64 = 1_772_000_000;

const SOURCE_BALANCE: u64 = 12_000_000;
const VAULT_BALANCE: u64 = 7_000_000;
const DEPOSIT: u64 = 5_000_000;

/// Стан сетлменту, який `withdraw` не має права чіпати: інакше агент
/// повертався б із чистим лічильником і пред'являв уже відсетлені ваучери.
const SETTLED_TOTAL: u64 = 3_000_000;
const LAST_SEQ: u64 = 41;
const LAST_CHAIN: [u8; 32] = [0x5a; 32];

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

/// `spl_token::state::Mint`, 82 байти.
fn mint_account(decimals: u8) -> Account {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
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
fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    Account {
        lamports: 2_039_280,
        data,
        owner: SPL_TOKEN_ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn token_amount(account: &Account) -> u64 {
    u64::from_le_bytes(account.data[64..72].try_into().expect("amount"))
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

fn config_account(mint: &Pubkey, bump: u8) -> Account {
    let state = Config {
        authority: anchor_key(&Pubkey::new_unique()),
        treasury_ata: anchor_key(&Pubkey::new_unique()),
        mint: anchor_key(mint),
        protocol_fee_bps: 1_000,
        node_share_bps: 0,
        voucher_grace_s: GRACE_S,
        paused: false,
        bump,
        reserved: [0; 64],
    };
    account_with(Config::DISCRIMINATOR, &state, 8 + Config::INIT_SPACE)
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

struct World {
    mollusk: Mollusk,
    consumer: Pubkey,
    config: Pubkey,
    escrow: Pubkey,
    vault: Pubkey,
    mint: Pubkey,
    wallet_ata: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

impl World {
    fn new() -> Self {
        let id = program_id();
        let consumer = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let wallet_ata = Pubkey::new_unique();

        let (config, config_bump) = Pubkey::find_program_address(&[b"config"], &id);
        let (escrow, _) = Pubkey::find_program_address(&[b"escrow", consumer.as_ref()], &id);
        let (vault, _) = Pubkey::find_program_address(&[b"vault", escrow.as_ref()], &id);

        let mut mollusk = Mollusk::new(&id, "contentledger");
        mollusk.sysvars.clock.unix_timestamp = NOW;
        mollusk_svm_programs_token::token::add_program(&mut mollusk);

        let (system_id, system_account) = mollusk_svm::program::keyed_account_for_system_program();

        Self {
            mollusk,
            consumer,
            config,
            escrow,
            vault,
            mint,
            wallet_ata,
            accounts: vec![
                (consumer, funded_wallet()),
                (config, config_account(&mint, config_bump)),
                (escrow, Account::default()),
                (mint, mint_account(6)),
                (vault, Account::default()),
                (wallet_ata, token_account(&mint, &consumer, SOURCE_BALANCE)),
                (system_id, system_account),
                mollusk_svm_programs_token::token::keyed_account(),
            ],
        }
    }

    fn bumps(&self) -> (u8, u8) {
        let id = program_id();
        let (_, escrow_bump) =
            Pubkey::find_program_address(&[b"escrow", self.consumer.as_ref()], &id);
        let (_, vault_bump) = Pubkey::find_program_address(&[b"vault", self.escrow.as_ref()], &id);
        (escrow_bump, vault_bump)
    }

    /// Уже відкритий escrow байтами: проганяти `open_escrow` перед кожним
    /// тестом депозиту й виводу означало б перевіряти тут ще й його.
    fn opened(mut self, withdraw_after: i64, vault_balance: u64) -> Self {
        let (bump, vault_bump) = self.bumps();
        let state = Escrow {
            consumer: anchor_key(&self.consumer),
            vault: anchor_key(&self.vault),
            settled_total: SETTLED_TOTAL,
            last_seq: LAST_SEQ,
            last_chain: LAST_CHAIN,
            withdraw_after,
            bump,
            vault_bump,
            reserved: [0; 32],
        };
        self.accounts[2].1 = account_with(Escrow::DISCRIMINATOR, &state, 8 + Escrow::INIT_SPACE);
        self.accounts[4].1 = token_account(&self.mint, &self.escrow, vault_balance);
        self
    }

    fn open_escrow(&self) -> Instruction {
        let (system_id, _) = mollusk_svm::program::keyed_account_for_system_program();
        Instruction::new_with_bytes(
            program_id(),
            &contentledger::instruction::OpenEscrow {}.data(),
            vec![
                AccountMeta::new(self.consumer, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.escrow, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new_readonly(SPL_TOKEN_ID, false),
                AccountMeta::new_readonly(system_id, false),
            ],
        )
    }

    fn deposit(&self, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            program_id(),
            &contentledger::instruction::Deposit { amount }.data(),
            vec![
                AccountMeta::new_readonly(self.consumer, true),
                AccountMeta::new(self.escrow, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new(self.wallet_ata, false),
                AccountMeta::new_readonly(SPL_TOKEN_ID, false),
            ],
        )
    }

    fn request_withdraw(&self) -> Instruction {
        Instruction::new_with_bytes(
            program_id(),
            &contentledger::instruction::RequestWithdraw {}.data(),
            vec![
                AccountMeta::new_readonly(self.consumer, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.escrow, false),
            ],
        )
    }

    fn withdraw(&self) -> Instruction {
        Instruction::new_with_bytes(
            program_id(),
            &contentledger::instruction::Withdraw {}.data(),
            vec![
                AccountMeta::new_readonly(self.consumer, true),
                AccountMeta::new(self.escrow, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new(self.wallet_ata, false),
                AccountMeta::new_readonly(SPL_TOKEN_ID, false),
            ],
        )
    }

    fn run(&self, instruction: &Instruction) -> InstructionResult {
        self.mollusk
            .process_instruction(instruction, &self.accounts)
    }

    fn escrow_state(&self, result: &InstructionResult) -> Escrow {
        let raw = result.get_account(&self.escrow).expect("escrow існує");
        Escrow::try_deserialize(&mut raw.data.as_slice()).expect("Escrow декодується")
    }
}

#[test]
fn open_escrow_creates_the_account_and_its_vault() {
    let world = World::new();
    let result = world.run(&world.open_escrow());
    assert!(matches!(result.program_result, ProgramResult::Success));

    let (bump, vault_bump) = world.bumps();
    let escrow = world.escrow_state(&result);
    assert_eq!(escrow.consumer.to_bytes(), world.consumer.to_bytes());
    assert_eq!(escrow.vault.to_bytes(), world.vault.to_bytes());
    assert_eq!(escrow.settled_total, 0);
    assert_eq!(escrow.last_seq, 0);
    assert_eq!(escrow.last_chain, [0u8; 32]);
    assert_eq!(escrow.withdraw_after, 0, "заявки на вивід ще немає");
    assert_eq!(escrow.bump, bump);
    assert_eq!(escrow.vault_bump, vault_bump);
    assert_eq!(escrow.reserved, [0u8; 32]);

    let vault = result.get_account(&world.vault).expect("сховище створене");
    assert_eq!(vault.owner, SPL_TOKEN_ID);
    assert_eq!(vault.data[0..32], world.mint.to_bytes());
    assert_eq!(
        vault.data[32..64],
        world.escrow.to_bytes(),
        "розпоряджається сховищем сам escrow, не гаманець і не оператор"
    );
    assert_eq!(token_amount(vault), 0);
}

/// `Config::mint` пінить валюту протоколу (FR-010): escrow у чужому токені
/// прийняв би платежі, які сетлмент не зміг би розвести.
#[test]
fn open_escrow_rejects_a_foreign_mint() {
    let mut world = World::new();
    let foreign = Pubkey::new_unique();
    world.mint = foreign;
    world.accounts[3] = (foreign, mint_account(6));
    world.accounts[5].1 = token_account(&foreign, &world.consumer, SOURCE_BALANCE);

    let result = world.run(&world.open_escrow());
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::MintMismatch)
    );
}

#[test]
fn second_open_finds_the_escrow_taken() {
    let world = World::new().opened(0, 0);
    let result = world.run(&world.open_escrow());
    assert!(!matches!(result.program_result, ProgramResult::Success));
}

#[test]
fn deposit_moves_tokens_into_the_vault() {
    let world = World::new().opened(0, VAULT_BALANCE);
    let result = world.run(&world.deposit(DEPOSIT));
    assert!(matches!(result.program_result, ProgramResult::Success));

    let vault = result.get_account(&world.vault).expect("сховище");
    let wallet = result.get_account(&world.wallet_ata).expect("гаманець");
    assert_eq!(token_amount(vault), VAULT_BALANCE + DEPOSIT);
    assert_eq!(token_amount(wallet), SOURCE_BALANCE - DEPOSIT);
}

/// Поповнення — протилежність виходу. Без цього escrow, який колись подав
/// заявку, лишався б у стані «йду» назавжди: інструкції скасування немає.
#[test]
fn deposit_cancels_a_pending_withdrawal() {
    let world = World::new().opened(NOW + GRACE_S, VAULT_BALANCE);
    let result = world.run(&world.deposit(DEPOSIT));
    assert!(matches!(result.program_result, ProgramResult::Success));
    assert_eq!(world.escrow_state(&result).withdraw_after, 0);
}

/// Підпис агента тут не формальність: депозит скасовує заявку на вивід, тож
/// чужий «дарунок» продовжував би агентові строк проти його волі.
#[test]
fn deposit_requires_the_consumer_signature() {
    let world = World::new().opened(0, VAULT_BALANCE);
    let mut instruction = world.deposit(DEPOSIT);
    instruction.accounts[0].is_signer = false;

    let result = world.run(&instruction);
    assert!(!matches!(result.program_result, ProgramResult::Success));
}

#[test]
fn request_withdraw_snapshots_the_grace_window() {
    let world = World::new().opened(0, VAULT_BALANCE);
    let result = world.run(&world.request_withdraw());
    assert!(matches!(result.program_result, ProgramResult::Success));
    assert_eq!(world.escrow_state(&result).withdraw_after, NOW + GRACE_S);
}

/// Вікно — єдине, що захищає вже видані ваучери: за нього шлюз мусить устигнути
/// сетлмент. Вивід до строку робив би видачу вмісту безкоштовною.
#[test]
fn withdraw_before_the_window_is_rejected() {
    let world = World::new().opened(NOW + 1, VAULT_BALANCE);
    let result = world.run(&world.withdraw());
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::WithdrawTooEarly)
    );
}

#[test]
fn withdraw_without_a_request_is_rejected() {
    let world = World::new().opened(0, VAULT_BALANCE);
    let result = world.run(&world.withdraw());
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::WithdrawNotRequested)
    );
}

/// FR-008d. Доказ у списку акаунтів: ані оператора, ані `Config`, ані будь-чийого
/// другого підпису тут немає — інструкція фізично не має, де їх узяти.
#[test]
fn withdraw_returns_the_remainder_without_the_operator() {
    let world = World::new().opened(NOW, VAULT_BALANCE);
    let instruction = world.withdraw();

    let signers: Vec<Pubkey> = instruction
        .accounts
        .iter()
        .filter(|meta| meta.is_signer)
        .map(|meta| meta.pubkey)
        .collect();
    assert_eq!(signers, vec![world.consumer]);
    assert!(!instruction
        .accounts
        .iter()
        .any(|meta| meta.pubkey == world.config));

    let result = world.run(&instruction);
    assert!(matches!(result.program_result, ProgramResult::Success));

    let vault = result.get_account(&world.vault).expect("сховище");
    let wallet = result.get_account(&world.wallet_ata).expect("гаманець");
    assert_eq!(token_amount(vault), 0, "залишок повертається весь");
    assert_eq!(token_amount(wallet), SOURCE_BALANCE + VAULT_BALANCE);
}

/// Вивід забирає гроші, а не історію: інакше агент повернувся б із нульовим
/// лічильником і пред'явив уже відсетлені ваучери повторно (FR-009).
#[test]
fn withdraw_keeps_the_settlement_chain_and_consumes_the_request() {
    let world = World::new().opened(NOW, VAULT_BALANCE);
    let result = world.run(&world.withdraw());
    assert!(matches!(result.program_result, ProgramResult::Success));

    let escrow = world.escrow_state(&result);
    assert_eq!(escrow.settled_total, SETTLED_TOTAL);
    assert_eq!(escrow.last_seq, LAST_SEQ);
    assert_eq!(escrow.last_chain, LAST_CHAIN);
    assert_eq!(
        escrow.withdraw_after, 0,
        "заявка одноразова: наступний вивід — знову через вікно"
    );
}

/// Сіди escrow виводяться з гаманця агента, тож чужий підпис не відкриває
/// чужий рахунок навіть за повного набору акаунтів.
#[test]
fn withdraw_rejects_a_foreign_signer() {
    let mut world = World::new().opened(NOW, VAULT_BALANCE);
    let stranger = Pubkey::new_unique();
    world.accounts.push((stranger, funded_wallet()));

    let mut instruction = world.withdraw();
    instruction.accounts[0] = AccountMeta::new_readonly(stranger, true);

    let result = world.run(&instruction);
    assert!(!matches!(result.program_result, ProgramResult::Success));
}
