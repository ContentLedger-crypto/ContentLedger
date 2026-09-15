//! T017 — зайняте джерело відхиляється, а не створює другий запис (FR-005).
//!
//! Сіди твору — `["work", sha256(source_id)]`, без домену. Тому відмова не
//! залежить від того, під чиїм доменом роблять другу спробу: `source_id` це
//! URL, у якого рівно один хост, і другого власника в нього не буває.

use anchor_lang::{AccountDeserialize, AnchorSerialize, Discriminator, InstructionData, Space};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use contentledger::instructions::registry::host_seed;
use contentledger::state::{Config, Domain, LicenceStatus, Work};

const SOURCE_HASH: [u8; 32] = [0x11; 32];
const OTHER_SOURCE_HASH: [u8; 32] = [0x12; 32];

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

fn funded_wallet() -> Account {
    Account {
        lamports: 10_000_000_000,
        data: vec![],
        owner: Pubkey::default(),
        executable: false,
        rent_epoch: 0,
    }
}

fn config_key() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &program_id()).0
}

fn config_account(authority: &Pubkey) -> Account {
    let state = Config {
        authority: anchor_key(authority),
        treasury_ata: anchor_key(&Pubkey::new_unique()),
        mint: anchor_key(&Pubkey::new_unique()),
        protocol_fee_bps: 250,
        node_share_bps: 0,
        voucher_grace_s: 900,
        paused: false,
        bump: Pubkey::find_program_address(&[b"config"], &program_id()).1,
        reserved: [0; 64],
    };
    account_with(Config::DISCRIMINATOR, &state, 8 + Config::INIT_SPACE)
}

/// Зареєстрований домен разом із його ключем.
fn domain_with(host: &str, owner: &Pubkey) -> (Pubkey, Account) {
    let (key, bump) = Pubkey::find_program_address(&[b"domain", &host_seed(host)], &program_id());
    let state = Domain {
        owner: anchor_key(owner),
        payout_owner: anchor_key(owner),
        host: host.to_string(),
        rate_train: 2_000,
        rate_inference: 500,
        status: LicenceStatus::Active,
        bump,
        reserved: [0; 32],
    };
    (
        key,
        account_with(Domain::DISCRIMINATOR, &state, 8 + Domain::INIT_SPACE),
    )
}

/// Уже зайнятий твір: акаунт існує, належить програмі й несе свого власника.
fn taken_work(domain: &Pubkey, source_hash: [u8; 32]) -> (Pubkey, Account) {
    let (key, bump) = Pubkey::find_program_address(&[b"work", &source_hash], &program_id());
    let state = Work {
        domain: anchor_key(domain),
        source_hash,
        content_hash: [0xaa; 32],
        rate_train: Some(7_777),
        rate_inference: None,
        status: LicenceStatus::Active,
        attested_by: 0,
        bump,
        reserved: [0; 32],
    };
    (
        key,
        account_with(Work::DISCRIMINATOR, &state, 8 + Work::INIT_SPACE),
    )
}

fn register_work(
    mollusk: &Mollusk,
    payer: &Pubkey,
    domain: (Pubkey, Account),
    work: (Pubkey, Account),
    source_hash: [u8; 32],
    operator: &Pubkey,
) -> InstructionResult {
    let (system_id, system_account) = mollusk_svm::program::keyed_account_for_system_program();
    let instruction = Instruction::new_with_bytes(
        program_id(),
        &contentledger::instruction::RegisterWork {
            source_hash,
            content_hash: [0xbb; 32],
        }
        .data(),
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new_readonly(domain.0, false),
            AccountMeta::new(work.0, false),
            AccountMeta::new_readonly(system_id, false),
        ],
    );

    mollusk.process_instruction(
        &instruction,
        &[
            (*payer, funded_wallet()),
            (config_key(), config_account(operator)),
            domain,
            work,
            (system_id, system_account),
        ],
    )
}

/// Той самий власник, той самий домен: другий запис не створюється.
#[test]
fn the_same_source_cannot_be_registered_twice_in_its_own_domain() {
    let mollusk = Mollusk::new(&program_id(), "contentledger");
    let operator = Pubkey::new_unique();
    let owner = Pubkey::new_unique();
    let domain = domain_with("example.com", &owner);
    let work = taken_work(&domain.0, SOURCE_HASH);

    let result = register_work(&mollusk, &owner, domain, work, SOURCE_HASH, &operator);
    assert!(!matches!(result.program_result, ProgramResult::Success));
}

/// Головне, заради чого домен прибрано із сідів: чужий власник зі своїм
/// доменом б'ється об **той самий** акаунт, а не створює паралельний запис.
#[test]
fn a_foreign_owner_cannot_claim_a_taken_source_under_their_own_domain() {
    let mollusk = Mollusk::new(&program_id(), "contentledger");
    let operator = Pubkey::new_unique();
    let first_owner = Pubkey::new_unique();
    let squatter = Pubkey::new_unique();

    let first_domain = domain_with("example.com", &first_owner);
    let taken = taken_work(&first_domain.0, SOURCE_HASH);
    let squatter_domain = domain_with("squatter.example", &squatter);

    // Той самий ключ твору, хоча домен інший — саме це й доводить FR-005.
    let (squatter_work_key, _) =
        Pubkey::find_program_address(&[b"work", &SOURCE_HASH], &program_id());
    assert_eq!(squatter_work_key, taken.0);

    let result = register_work(
        &mollusk,
        &squatter,
        squatter_domain,
        taken,
        SOURCE_HASH,
        &operator,
    );
    assert!(!matches!(result.program_result, ProgramResult::Success));
}

/// Відмова нічого не псує: перший запис лишається з тим самим власником і тим
/// самим перекриттям ставки.
#[test]
fn a_rejected_second_registration_leaves_the_first_untouched() {
    let mollusk = Mollusk::new(&program_id(), "contentledger");
    let operator = Pubkey::new_unique();
    let first_owner = Pubkey::new_unique();
    let squatter = Pubkey::new_unique();

    let first_domain = domain_with("example.com", &first_owner);
    let taken = taken_work(&first_domain.0, SOURCE_HASH);
    let taken_key = taken.0;
    let before = taken.1.clone();
    let squatter_domain = domain_with("squatter.example", &squatter);

    let result = register_work(
        &mollusk,
        &squatter,
        squatter_domain,
        (taken_key, taken.1),
        SOURCE_HASH,
        &operator,
    );
    assert!(!matches!(result.program_result, ProgramResult::Success));

    let after = result.get_account(&taken_key).unwrap_or(&before);
    let work = Work::try_deserialize(&mut after.data.as_slice()).expect("Work декодується");
    assert_eq!(work.domain.to_bytes(), first_domain.0.to_bytes());
    assert_eq!(work.rate_train, Some(7_777));
    assert_eq!(work.content_hash, [0xaa; 32]);
}

/// Інше джерело того самого власника реєструється нормально — відмова
/// стосується саме зайнятого ідентифікатора, а не другої реєстрації взагалі.
#[test]
fn a_different_source_still_registers() {
    let mollusk = Mollusk::new(&program_id(), "contentledger");
    let operator = Pubkey::new_unique();
    let owner = Pubkey::new_unique();
    let domain = domain_with("example.com", &owner);

    let (free_key, _) = Pubkey::find_program_address(&[b"work", &OTHER_SOURCE_HASH], &program_id());
    let result = register_work(
        &mollusk,
        &owner,
        domain,
        (free_key, Account::default()),
        OTHER_SOURCE_HASH,
        &operator,
    );

    assert!(matches!(result.program_result, ProgramResult::Success));
    let raw = result.get_account(&free_key).expect("твір створений");
    let work = Work::try_deserialize(&mut raw.data.as_slice()).expect("Work декодується");
    assert_eq!(work.source_hash, OTHER_SOURCE_HASH);
}
