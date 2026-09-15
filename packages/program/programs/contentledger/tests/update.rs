//! T016 — `set_domain_rates`, `set_domain_status`, `set_work_rates`, `set_work_status`.
//!
//! Правило «твір → домен» тут **не** перевіряється: воно живе в
//! `packages/shared/src/rates.ts`, бо ончейн ставку ніхто не читає (рішення
//! T016). Тут доводиться лише те, що зміни доходять до акаунтів і що чужий їх
//! зробити не може.

use anchor_lang::{AccountDeserialize, AnchorSerialize, Discriminator, InstructionData, Space};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

use contentledger::error::ContentLedgerError;
use contentledger::instructions::registry::host_seed;
use contentledger::state::{Domain, LicenceStatus, Work};

const HOST: &str = "example.com";
const SOURCE_HASH: [u8; 32] = [0x11; 32];

fn program_id() -> Pubkey {
    Pubkey::new_from_array(contentledger::ID.to_bytes())
}

fn anchor_key(key: &Pubkey) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(key.to_bytes())
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

fn signer_account() -> Account {
    Account {
        lamports: 1_000_000_000,
        data: vec![],
        owner: Pubkey::default(),
        executable: false,
        rent_epoch: 0,
    }
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
    owner: Pubkey,
    domain: Pubkey,
    work: Pubkey,
}

impl World {
    fn new() -> Self {
        let id = program_id();
        let owner = Pubkey::new_unique();
        let (domain, _) = Pubkey::find_program_address(&[b"domain", &host_seed(HOST)], &id);
        let (work, _) = Pubkey::find_program_address(&[b"work", &SOURCE_HASH], &id);

        Self {
            mollusk: Mollusk::new(&id, "contentledger"),
            owner,
            domain,
            work,
        }
    }

    fn domain_account(&self, status: LicenceStatus) -> Account {
        let bump = Pubkey::find_program_address(&[b"domain", &host_seed(HOST)], &program_id()).1;
        let state = Domain {
            owner: anchor_key(&self.owner),
            payout_owner: anchor_key(&self.owner),
            host: HOST.to_string(),
            rate_train: 2_000,
            rate_inference: 500,
            status,
            bump,
            reserved: [0; 32],
        };
        account_with(Domain::DISCRIMINATOR, &state, 8 + Domain::INIT_SPACE)
    }

    fn work_account(&self, rate_train: Option<u64>, status: LicenceStatus) -> Account {
        let bump = Pubkey::find_program_address(&[b"work", &SOURCE_HASH], &program_id()).1;
        let state = Work {
            domain: anchor_key(&self.domain),
            source_hash: SOURCE_HASH,
            content_hash: [0x22; 32],
            rate_train,
            rate_inference: None,
            status,
            attested_by: 0,
            bump,
            reserved: [0; 32],
        };
        account_with(Work::DISCRIMINATOR, &state, 8 + Work::INIT_SPACE)
    }

    fn update_domain(&self, signer: &Pubkey, data: Vec<u8>) -> InstructionResult {
        let instruction = Instruction::new_with_bytes(
            program_id(),
            &data,
            vec![
                AccountMeta::new_readonly(*signer, true),
                AccountMeta::new(self.domain, false),
            ],
        );
        self.mollusk.process_instruction(
            &instruction,
            &[
                (*signer, signer_account()),
                (self.domain, self.domain_account(LicenceStatus::Active)),
            ],
        )
    }

    fn update_work(&self, signer: &Pubkey, work: Account, data: Vec<u8>) -> InstructionResult {
        let instruction = Instruction::new_with_bytes(
            program_id(),
            &data,
            vec![
                AccountMeta::new_readonly(*signer, true),
                AccountMeta::new_readonly(self.domain, false),
                AccountMeta::new(self.work, false),
            ],
        );
        self.mollusk.process_instruction(
            &instruction,
            &[
                (*signer, signer_account()),
                (self.domain, self.domain_account(LicenceStatus::Active)),
                (self.work, work),
            ],
        )
    }
}

fn decode_domain(result: &InstructionResult, key: &Pubkey) -> Domain {
    let raw = result.get_account(key).expect("домен присутній");
    Domain::try_deserialize(&mut raw.data.as_slice()).expect("Domain декодується")
}

fn decode_work(result: &InstructionResult, key: &Pubkey) -> Work {
    let raw = result.get_account(key).expect("твір присутній");
    Work::try_deserialize(&mut raw.data.as_slice()).expect("Work декодується")
}

#[test]
fn owner_changes_domain_rates() {
    let w = World::new();
    let result = w.update_domain(
        &w.owner,
        contentledger::instruction::SetDomainRates {
            rate_train: 7_000,
            rate_inference: 1_250,
        }
        .data(),
    );
    assert!(matches!(result.program_result, ProgramResult::Success));

    let domain = decode_domain(&result, &w.domain);
    assert_eq!(domain.rate_train, 7_000);
    assert_eq!(domain.rate_inference, 1_250);
}

#[test]
fn stranger_cannot_change_domain_rates() {
    let w = World::new();
    let result = w.update_domain(
        &Pubkey::new_unique(),
        contentledger::instruction::SetDomainRates {
            rate_train: 7_000,
            rate_inference: 1_250,
        }
        .data(),
    );
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::Unauthorized)
    );
}

/// Зняття домену міняє **один** акаунт: закриття творів (FR-002b) — правило на
/// читанні, а не стан, який рознесли по тисячі творів. Твір навіть не входить
/// у транзакцію, тож зняття домену з тисячею творів лишається однією дією.
#[test]
fn suspending_a_domain_does_not_touch_its_works() {
    let w = World::new();
    let result = w.update_domain(
        &w.owner,
        contentledger::instruction::SetDomainStatus {
            status: LicenceStatus::Suspended,
        }
        .data(),
    );

    assert!(matches!(result.program_result, ProgramResult::Success));
    assert_eq!(
        decode_domain(&result, &w.domain).status,
        LicenceStatus::Suspended
    );
    assert!(result.get_account(&w.work).is_none());
}

#[test]
fn owner_sets_and_clears_a_work_rate_override() {
    let w = World::new();

    let set = w.update_work(
        &w.owner,
        w.work_account(None, LicenceStatus::Active),
        contentledger::instruction::SetWorkRates {
            rate_train: Some(9_000),
            rate_inference: None,
        }
        .data(),
    );
    assert!(matches!(set.program_result, ProgramResult::Success));
    let work = decode_work(&set, &w.work);
    assert_eq!(work.rate_train, Some(9_000));
    assert_eq!(work.rate_inference, None);

    let cleared = w.update_work(
        &w.owner,
        w.work_account(Some(9_000), LicenceStatus::Active),
        contentledger::instruction::SetWorkRates {
            rate_train: None,
            rate_inference: None,
        }
        .data(),
    );
    assert!(matches!(cleared.program_result, ProgramResult::Success));
    assert_eq!(
        decode_work(&cleared, &w.work).rate_train,
        None,
        "None повертає твір на ставку домену"
    );
}

/// Нуль — це ставка «безкоштовно», а не «перекриття прибрано».
#[test]
fn zero_is_a_rate_not_an_absent_override() {
    let w = World::new();
    let result = w.update_work(
        &w.owner,
        w.work_account(None, LicenceStatus::Active),
        contentledger::instruction::SetWorkRates {
            rate_train: Some(0),
            rate_inference: None,
        }
        .data(),
    );
    assert!(matches!(result.program_result, ProgramResult::Success));
    assert_eq!(decode_work(&result, &w.work).rate_train, Some(0));
}

#[test]
fn owner_suspends_a_single_work() {
    let w = World::new();
    let result = w.update_work(
        &w.owner,
        w.work_account(None, LicenceStatus::Active),
        contentledger::instruction::SetWorkStatus {
            status: LicenceStatus::Suspended,
        }
        .data(),
    );
    assert!(matches!(result.program_result, ProgramResult::Success));
    assert_eq!(
        decode_work(&result, &w.work).status,
        LicenceStatus::Suspended
    );
}

#[test]
fn stranger_cannot_change_a_work() {
    let w = World::new();
    let result = w.update_work(
        &Pubkey::new_unique(),
        w.work_account(None, LicenceStatus::Active),
        contentledger::instruction::SetWorkStatus {
            status: LicenceStatus::Suspended,
        }
        .data(),
    );
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::Unauthorized)
    );
}

/// Твір чужого домену не редагується власником цього домену.
#[test]
fn work_of_another_domain_is_rejected() {
    let w = World::new();
    let foreign_domain = Pubkey::new_unique();
    let state = Work {
        domain: anchor_key(&foreign_domain),
        source_hash: SOURCE_HASH,
        content_hash: [0x22; 32],
        rate_train: None,
        rate_inference: None,
        status: LicenceStatus::Active,
        attested_by: 0,
        bump: 255,
        reserved: [0; 32],
    };
    let work = account_with(Work::DISCRIMINATOR, &state, 8 + Work::INIT_SPACE);

    let result = w.update_work(
        &w.owner,
        work,
        contentledger::instruction::SetWorkStatus {
            status: LicenceStatus::Suspended,
        }
        .data(),
    );
    assert!(!matches!(result.program_result, ProgramResult::Success));
}
