//! T015 — `register_domain` і `register_work`.

use anchor_lang::{AccountDeserialize, AnchorSerialize, Discriminator, InstructionData, Space};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

use contentledger::error::ContentLedgerError;
use contentledger::instructions::registry::host_seed;
use contentledger::state::{Config, Domain, LicenceStatus, Work};

const HOST: &str = "example.com";
const RATE_TRAIN: u64 = 2_000;
const RATE_INFERENCE: u64 = 500;
const SOURCE_HASH: [u8; 32] = [0x11; 32];
const CONTENT_HASH: [u8; 32] = [0x22; 32];

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

/// Готовий `Config` байтами: проганяти `init_config` перед кожним тестом
/// реєстру означало б перевіряти тут ще й його.
fn config_account(authority: &Pubkey, bump: u8) -> Account {
    let state = Config {
        authority: anchor_key(authority),
        treasury_ata: anchor_key(&Pubkey::new_unique()),
        mint: anchor_key(&Pubkey::new_unique()),
        protocol_fee_bps: 250,
        node_share_bps: 0,
        voucher_grace_s: 900,
        paused: false,
        bump,
        reserved: [0; 64],
    };
    account_with(Config::DISCRIMINATOR, &state, 8 + Config::INIT_SPACE)
}

fn domain_account(owner: &Pubkey, bump: u8) -> Account {
    let state = Domain {
        owner: anchor_key(owner),
        payout_owner: anchor_key(owner),
        host: HOST.to_string(),
        rate_train: RATE_TRAIN,
        rate_inference: RATE_INFERENCE,
        status: LicenceStatus::Active,
        bump,
        reserved: [0; 32],
    };
    account_with(Domain::DISCRIMINATOR, &state, 8 + Domain::INIT_SPACE)
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
    operator: Pubkey,
    owner: Pubkey,
    config: Pubkey,
    domain: Pubkey,
}

impl World {
    fn new() -> Self {
        let id = program_id();
        let operator = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let (config, _) = Pubkey::find_program_address(&[b"config"], &id);
        let (domain, _) = Pubkey::find_program_address(&[b"domain", &host_seed(HOST)], &id);

        Self {
            mollusk: Mollusk::new(&id, "contentledger"),
            operator,
            owner,
            config,
            domain,
        }
    }

    fn config_bump(&self) -> u8 {
        Pubkey::find_program_address(&[b"config"], &program_id()).1
    }

    fn domain_bump(&self) -> u8 {
        Pubkey::find_program_address(&[b"domain", &host_seed(HOST)], &program_id()).1
    }

    /// Домен виводиться з переданого хоста, а не з канонічного: перевірка сідів
    /// іде **до** обробника, тож інакше некононічний хост давав би
    /// `ConstraintSeeds` замість нашої помилки, і тест доводив би не те.
    fn register_domain(&self, payer: &Pubkey, owner: &Pubkey, host: &str) -> InstructionResult {
        let (domain, _) =
            Pubkey::find_program_address(&[b"domain", &host_seed(host)], &program_id());
        let (system_id, system_account) = mollusk_svm::program::keyed_account_for_system_program();

        let instruction = Instruction::new_with_bytes(
            program_id(),
            &contentledger::instruction::RegisterDomain {
                host_hash: host_seed(host),
                host: host.to_string(),
                owner: anchor_key(owner),
                payout_owner: anchor_key(owner),
                rate_train: RATE_TRAIN,
                rate_inference: RATE_INFERENCE,
            }
            .data(),
            vec![
                AccountMeta::new(*payer, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(domain, false),
                AccountMeta::new_readonly(system_id, false),
            ],
        );

        self.mollusk.process_instruction(
            &instruction,
            &[
                (*payer, funded_wallet()),
                (
                    self.config,
                    config_account(&self.operator, self.config_bump()),
                ),
                (domain, Account::default()),
                (system_id, system_account),
            ],
        )
    }

    fn register_work(&self, payer: &Pubkey) -> (Pubkey, InstructionResult) {
        let (work, _) = Pubkey::find_program_address(
            &[b"work", self.domain.as_ref(), &SOURCE_HASH],
            &program_id(),
        );
        let (system_id, system_account) = mollusk_svm::program::keyed_account_for_system_program();

        let instruction = Instruction::new_with_bytes(
            program_id(),
            &contentledger::instruction::RegisterWork {
                source_hash: SOURCE_HASH,
                content_hash: CONTENT_HASH,
            }
            .data(),
            vec![
                AccountMeta::new(*payer, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(self.domain, false),
                AccountMeta::new(work, false),
                AccountMeta::new_readonly(system_id, false),
            ],
        );

        let result = self.mollusk.process_instruction(
            &instruction,
            &[
                (*payer, funded_wallet()),
                (
                    self.config,
                    config_account(&self.operator, self.config_bump()),
                ),
                (self.domain, domain_account(&self.owner, self.domain_bump())),
                (work, Account::default()),
                (system_id, system_account),
            ],
        );

        (work, result)
    }
}

#[test]
fn owner_registers_their_own_domain() {
    let w = World::new();
    let result = w.register_domain(&w.owner, &w.owner, HOST);
    assert!(matches!(result.program_result, ProgramResult::Success));

    let raw = result.get_account(&w.domain).expect("домен створений");
    let domain = Domain::try_deserialize(&mut raw.data.as_slice()).expect("Domain декодується");

    assert_eq!(domain.owner.to_bytes(), w.owner.to_bytes());
    assert_eq!(domain.payout_owner.to_bytes(), w.owner.to_bytes());
    assert_eq!(domain.host, HOST);
    assert_eq!(domain.rate_train, RATE_TRAIN);
    assert_eq!(domain.rate_inference, RATE_INFERENCE);
    assert_eq!(domain.status, LicenceStatus::Active);
    assert_eq!(domain.bump, w.domain_bump());
    assert_eq!(domain.reserved, [0u8; 32]);
}

/// Посів реєстру оператором (T022) до M4, поки атестації FR-005a немає.
#[test]
fn operator_registers_a_domain_for_someone_else() {
    let w = World::new();
    let result = w.register_domain(&w.operator, &w.owner, HOST);
    assert!(matches!(result.program_result, ProgramResult::Success));

    let raw = result.get_account(&w.domain).expect("домен створений");
    let domain = Domain::try_deserialize(&mut raw.data.as_slice()).unwrap();
    assert_eq!(domain.owner.to_bytes(), w.owner.to_bytes());
}

#[test]
fn stranger_cannot_register_a_domain_for_someone_else() {
    let w = World::new();
    let stranger = Pubkey::new_unique();
    let result = w.register_domain(&stranger, &w.owner, HOST);
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::Unauthorized)
    );
}

/// Хост поза канонічною формою не створює другий домен для того самого сайту.
#[test]
fn rejects_non_canonical_hosts() {
    let w = World::new();
    for host in ["Example.com", "example.com.", "example.com:443", "example"] {
        let result = w.register_domain(&w.owner, &w.owner, host);
        assert_eq!(
            error_code(&result),
            expected(ContentLedgerError::HostNotCanonical),
            "{host}"
        );
    }
}

#[test]
fn owner_registers_a_work_that_inherits_domain_rates() {
    let w = World::new();
    let (work_key, result) = w.register_work(&w.owner);
    assert!(matches!(result.program_result, ProgramResult::Success));

    let raw = result.get_account(&work_key).expect("твір створений");
    let work = Work::try_deserialize(&mut raw.data.as_slice()).expect("Work декодується");

    assert_eq!(work.domain.to_bytes(), w.domain.to_bytes());
    assert_eq!(work.source_hash, SOURCE_HASH);
    assert_eq!(work.content_hash, CONTENT_HASH);
    assert_eq!(work.rate_train, None, "твір успадковує ставку домену");
    assert_eq!(work.rate_inference, None);
    assert_eq!(work.status, LicenceStatus::Active);
    assert_eq!(work.attested_by, 0);
    assert_eq!(work.reserved, [0u8; 32]);
}

#[test]
fn operator_registers_a_work_for_the_domain_owner() {
    let w = World::new();
    let (_, result) = w.register_work(&w.operator);
    assert!(matches!(result.program_result, ProgramResult::Success));
}

#[test]
fn stranger_cannot_register_a_work_in_a_foreign_domain() {
    let w = World::new();
    let stranger = Pubkey::new_unique();
    let (_, result) = w.register_work(&stranger);
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::Unauthorized)
    );
}

/// Хеш приходить аргументом, тож окремо доводимо, що збрехати ним не можна:
/// акаунт із чужого сіду не стає доменом іншого хоста.
#[test]
fn rejects_a_host_hash_that_does_not_match_the_host() {
    let w = World::new();
    let (system_id, system_account) = mollusk_svm::program::keyed_account_for_system_program();
    let foreign = host_seed("other.example");
    let (domain, _) = Pubkey::find_program_address(&[b"domain", &foreign], &program_id());

    let instruction = Instruction::new_with_bytes(
        program_id(),
        &contentledger::instruction::RegisterDomain {
            host_hash: foreign,
            host: HOST.to_string(),
            owner: anchor_key(&w.owner),
            payout_owner: anchor_key(&w.owner),
            rate_train: RATE_TRAIN,
            rate_inference: RATE_INFERENCE,
        }
        .data(),
        vec![
            AccountMeta::new(w.owner, true),
            AccountMeta::new_readonly(w.config, false),
            AccountMeta::new(domain, false),
            AccountMeta::new_readonly(system_id, false),
        ],
    );

    let result = w.mollusk.process_instruction(
        &instruction,
        &[
            (w.owner, funded_wallet()),
            (w.config, config_account(&w.operator, w.config_bump())),
            (domain, Account::default()),
            (system_id, system_account),
        ],
    );

    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::HostHashMismatch)
    );
}
