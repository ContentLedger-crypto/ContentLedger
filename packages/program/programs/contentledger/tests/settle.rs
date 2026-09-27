//! T024–T025 — `settle_batch`: the voucher signature of the agent, the payouts
//! it authorises and the settlement ring.
//!
//! What this file can and cannot prove. Mollusk executes a single instruction,
//! so the Ed25519 precompile never runs here and the Instructions sysvar is
//! assembled by hand. The signature bytes are therefore filler: validating them
//! is the runtime's job, and ours is to prove that the (key, message) pair the
//! precompile was asked about is *our* agent and *our* 88 bytes. Every route by
//! which a different pair could be smuggled past that check lives below.
//!
//! The money side runs for real: spl-token and the ATA program are loaded, so
//! every payout is an executed transfer and every created account a real one.

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
use contentledger::state::{
    Config, Domain, Escrow, LicenceStatus, SettlementEntry, SettlementLog, SETTLEMENT_RING_LEN,
};

const ED25519_ID: Pubkey = Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
const INSTRUCTIONS_ID: Pubkey =
    Pubkey::from_str_const("Sysvar1nstructions1111111111111111111111111");
const SYSVAR_OWNER: Pubkey = Pubkey::from_str_const("Sysvar1111111111111111111111111111111111111");
const SPL_TOKEN_ID: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const GRACE_S: i64 = 900;
const NOW: i64 = 1_772_000_000;
const FEE_BPS: u16 = 1_000;

/// Where the voucher stood before this batch.
const LAST_SEQ: u64 = 38;
const LAST_CHAIN: [u8; 32] = [0xaa; 32];
const SETTLED_TOTAL: u64 = 3_000_000;

/// The voucher presented by the settler: three receipts, seq 39..=41, of
/// 50 000, 30 000 and 1 base units — fees 5 000, 3 000 and 1, each rounded up
/// on its own. The first is publisher A's, the other two publisher B's.
const SEQ: u64 = 41;
const TARIFF_A: u64 = 50_000;
const TARIFF_B: u64 = 30_001;
const FEE: u64 = 8_001;
const CHARGED: u64 = TARIFF_A + TARIFF_B + FEE;
const CUMULATIVE: u64 = SETTLED_TOTAL + CHARGED;
const CHAIN: [u8; 32] = [0x5a; 32];
const ROOT: [u8; 32] = [0x3c; 32];

const VAULT_BALANCE: u64 = 1_000_000;
/// Publisher A already has a token account, with something in it.
const EXISTING_BALANCE_A: u64 = 7;
const TREASURY_BALANCE: u64 = 400;

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

/// `spl_token::state::Mint`, 82 bytes.
fn mint_account() -> Account {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(&[7u8; 32]);
    data[44] = 6; // decimals
    data[45] = 1; // is_initialized
    Account {
        lamports: 1_461_600,
        data,
        owner: SPL_TOKEN_ID,
        executable: false,
        rent_epoch: 0,
    }
}

/// `spl_token::state::Account`, 165 bytes.
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

fn token_owner(account: &Account) -> Pubkey {
    Pubkey::new_from_array(account.data[32..64].try_into().expect("owner"))
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), SPL_TOKEN_ID.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
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

fn config_account(
    authority: &Pubkey,
    treasury: &Pubkey,
    mint: &Pubkey,
    node_share_bps: u16,
    bump: u8,
) -> Account {
    let state = Config {
        authority: anchor_key(authority),
        treasury_ata: anchor_key(treasury),
        mint: anchor_key(mint),
        protocol_fee_bps: FEE_BPS,
        node_share_bps,
        voucher_grace_s: GRACE_S,
        paused: false,
        bump,
        reserved: [0; 64],
    };
    account_with(Config::DISCRIMINATOR, &state, 8 + Config::INIT_SPACE)
}

fn escrow_account(consumer: &Pubkey, vault: &Pubkey, bumps: (u8, u8), last_seq: u64) -> Account {
    let state = Escrow {
        consumer: anchor_key(consumer),
        vault: anchor_key(vault),
        settled_total: SETTLED_TOTAL,
        last_seq,
        last_chain: LAST_CHAIN,
        withdraw_after: 0,
        bump: bumps.0,
        vault_bump: bumps.1,
        reserved: [0; 32],
    };
    account_with(Escrow::DISCRIMINATOR, &state, 8 + Escrow::INIT_SPACE)
}

fn domain_account(host: &str, payout_owner: &Pubkey) -> Account {
    let state = Domain {
        owner: anchor_key(&Pubkey::new_unique()),
        payout_owner: anchor_key(payout_owner),
        host: host.to_string(),
        rate_train: 0,
        rate_inference: 50_000,
        status: LicenceStatus::Active,
        bump: 255,
        reserved: [0; 32],
    };
    account_with(Domain::DISCRIMINATOR, &state, 8 + Domain::INIT_SPACE)
}

/// A ring that already holds one settlement, as it would after the first.
fn ring_account(escrow: &Pubkey, bump: u8, previous: SettlementEntry) -> Account {
    let mut entries = [SettlementEntry::default(); SETTLEMENT_RING_LEN];
    entries[0] = previous;
    let log = SettlementLog {
        escrow: anchor_key(escrow),
        head: 1,
        bump,
        padding: [0; 6],
        entries,
    };
    let mut data = SettlementLog::DISCRIMINATOR.to_vec();
    data.extend_from_slice(bytemuck::bytes_of(&log));
    Account {
        lamports: 100_000_000,
        data,
        owner: program_id(),
        executable: false,
        rent_epoch: 0,
    }
}

fn read_ring(account: &Account) -> SettlementLog {
    bytemuck::pod_read_unaligned(&account.data[8..])
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

fn succeeded(result: &InstructionResult) -> bool {
    matches!(result.program_result, ProgramResult::Success)
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

/// One payout leg as the settler passes it.
struct Leg {
    domain: Pubkey,
    owner: Pubkey,
    payout: Pubkey,
}

struct World {
    mollusk: Mollusk,
    authority: Pubkey,
    consumer: Pubkey,
    config: Pubkey,
    config_bump: u8,
    escrow: Pubkey,
    vault: Pubkey,
    treasury: Pubkey,
    mint: Pubkey,
    log: Pubkey,
    log_bump: u8,
    bumps: (u8, u8),
    legs: Vec<Leg>,
    cumulative: u64,
    tariffs: Vec<u64>,
    accounts: Vec<(Pubkey, Account)>,
}

impl World {
    fn new() -> Self {
        let id = program_id();
        let authority = Pubkey::new_unique();
        let consumer = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let treasury = Pubkey::new_unique();

        let (config, config_bump) = Pubkey::find_program_address(&[b"config"], &id);
        let (escrow, escrow_bump) =
            Pubkey::find_program_address(&[b"escrow", consumer.as_ref()], &id);
        let (vault, vault_bump) = Pubkey::find_program_address(&[b"vault", escrow.as_ref()], &id);
        let (log, log_bump) = Pubkey::find_program_address(&[b"log", escrow.as_ref()], &id);

        let mut mollusk = Mollusk::new(&id, "contentledger");
        mollusk.sysvars.clock.unix_timestamp = NOW;
        mollusk_svm_programs_token::token::add_program(&mut mollusk);
        mollusk_svm_programs_token::associated_token::add_program(&mut mollusk);
        let (system_id, system_account) = mollusk_svm::program::keyed_account_for_system_program();

        let owner_a = Pubkey::new_unique();
        let owner_b = Pubkey::new_unique();
        let legs = vec![
            Leg {
                domain: Pubkey::new_unique(),
                owner: owner_a,
                payout: ata(&owner_a, &mint),
            },
            Leg {
                domain: Pubkey::new_unique(),
                owner: owner_b,
                payout: ata(&owner_b, &mint),
            },
        ];

        let accounts = vec![
            (authority, funded_wallet()),
            (
                config,
                config_account(&authority, &treasury, &mint, 0, config_bump),
            ),
            (
                escrow,
                escrow_account(&consumer, &vault, (escrow_bump, vault_bump), LAST_SEQ),
            ),
            (vault, token_account(&mint, &escrow, VAULT_BALANCE)),
            (treasury, token_account(&mint, &authority, TREASURY_BALANCE)),
            (mint, mint_account()),
            (log, Account::default()),
            (INSTRUCTIONS_ID, Account::default()),
            mollusk_svm_programs_token::token::keyed_account(),
            mollusk_svm_programs_token::associated_token::keyed_account(),
            (system_id, system_account),
            (legs[0].domain, domain_account("a.example", &owner_a)),
            (owner_a, Account::default()),
            (
                legs[0].payout,
                token_account(&mint, &owner_a, EXISTING_BALANCE_A),
            ),
            (legs[1].domain, domain_account("b.example", &owner_b)),
            (owner_b, Account::default()),
            (legs[1].payout, Account::default()),
        ];

        let mut world = Self {
            mollusk,
            authority,
            consumer,
            config,
            config_bump,
            escrow,
            vault,
            treasury,
            mint,
            log,
            log_bump,
            bumps: (escrow_bump, vault_bump),
            legs,
            cumulative: CUMULATIVE,
            tariffs: vec![TARIFF_A, TARIFF_B],
            accounts,
        };
        world.sign(CUMULATIVE);
        world
    }

    fn set(&mut self, key: Pubkey, account: Account) {
        match self.accounts.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = account,
            None => self.accounts.push((key, account)),
        }
    }

    /// The agent signs a voucher over `cumulative`, and the settler presents
    /// exactly that.
    fn sign(&mut self, cumulative: u64) {
        self.cumulative = cumulative;
        let signed = self.voucher_bytes();
        let consumer = self.consumer;
        self.with_transaction(&[RawInstruction {
            program_id: anchor_key(&ED25519_ID),
            data: Precompile::canonical(&consumer, &signed).data(),
        }]);
    }

    /// The 88 bytes the agent signs — rebuilt by the program in BPF, which is
    /// why the layout is pinned in `golden.rs` against the TypeScript client.
    fn voucher_bytes(&self) -> Vec<u8> {
        voucher_message(&anchor_key(&self.escrow), SEQ, self.cumulative, &CHAIN).to_vec()
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

        self.set(INSTRUCTIONS_ID, instructions_sysvar(&entries));
    }

    fn settle_batch(&self) -> Instruction {
        let mut metas = vec![
            AccountMeta::new(self.authority, true),
            AccountMeta::new_readonly(self.config, false),
            AccountMeta::new(self.escrow, false),
            AccountMeta::new(self.vault, false),
            AccountMeta::new(self.treasury, false),
            AccountMeta::new_readonly(self.mint, false),
            AccountMeta::new(self.log, false),
            AccountMeta::new_readonly(INSTRUCTIONS_ID, false),
            AccountMeta::new_readonly(SPL_TOKEN_ID, false),
            AccountMeta::new_readonly(ATA_PROGRAM_ID, false),
            AccountMeta::new_readonly(Pubkey::default(), false),
        ];
        for leg in &self.legs {
            metas.push(AccountMeta::new_readonly(leg.domain, false));
            metas.push(AccountMeta::new_readonly(leg.owner, false));
            metas.push(AccountMeta::new(leg.payout, false));
        }

        Instruction::new_with_bytes(
            program_id(),
            &contentledger::instruction::SettleBatch {
                seq: SEQ,
                cumulative: self.cumulative,
                chain: CHAIN,
                root: ROOT,
                tariffs: self.tariffs.clone(),
            }
            .data(),
            metas,
        )
    }

    fn run(&self) -> InstructionResult {
        self.mollusk
            .process_instruction(&self.settle_batch(), &self.accounts)
    }

    fn before(&self, key: &Pubkey) -> &Account {
        &self.accounts.iter().find(|(k, _)| k == key).expect("є").1
    }

    fn escrow_state(&self, result: &InstructionResult) -> Escrow {
        let raw = result.get_account(&self.escrow).expect("escrow існує");
        Escrow::try_deserialize(&mut raw.data.as_slice()).expect("Escrow декодується")
    }

    fn balance(&self, result: &InstructionResult, key: &Pubkey) -> u64 {
        token_amount(result.get_account(key).expect("токен-акаунт"))
    }
}

/// Золотий вектор 1: підпис агента під саме цим ваучером.
#[test]
fn settle_batch_accepts_the_voucher_signed_by_the_agent() {
    let world = World::new();
    let result = world.run();
    assert!(succeeded(&result), "{:?}", result.program_result);

    let escrow = world.escrow_state(&result);
    assert_eq!(escrow.last_seq, SEQ);
    assert_eq!(escrow.last_chain, CHAIN);
    assert_eq!(escrow.settled_total, CUMULATIVE);
}

/// SC-005: усе, що пішло зі сховища, прийшло отримувачам, до базової одиниці.
#[test]
fn settle_batch_pays_publishers_and_treasury_and_conserves_the_amount() {
    let world = World::new();
    let result = world.run();
    assert!(succeeded(&result), "{:?}", result.program_result);

    let paid_a = world.balance(&result, &world.legs[0].payout) - EXISTING_BALANCE_A;
    let paid_b = world.balance(&result, &world.legs[1].payout);
    let fee = world.balance(&result, &world.treasury) - TREASURY_BALANCE;
    let spent = VAULT_BALANCE - world.balance(&result, &world.vault);

    assert_eq!((paid_a, paid_b, fee), (TARIFF_A, TARIFF_B, FEE));
    assert_eq!(spent, CHARGED);
    assert_eq!(paid_a + paid_b + fee, CUMULATIVE - SETTLED_TOTAL);
}

/// FR-010a: у видавця B токен-акаунта не було. Його створено на його гаманець,
/// а платив оператор — сам видавець не втратив нічого.
#[test]
fn settle_batch_creates_a_missing_payout_account_at_the_operators_expense() {
    let world = World::new();
    let result = world.run();
    assert!(succeeded(&result), "{:?}", result.program_result);

    let created = result
        .get_account(&world.legs[1].payout)
        .expect("ATA створено");
    assert_eq!(created.owner, SPL_TOKEN_ID);
    assert_eq!(token_owner(created), world.legs[1].owner);

    let owner_after = result.get_account(&world.legs[1].owner).expect("гаманець");
    assert_eq!(owner_after.lamports, 0, "видавець за акаунт не платив");

    let rent = created.lamports + result.get_account(&world.log).expect("кільце").lamports;
    let operator_spent = world.before(&world.authority).lamports
        - result.get_account(&world.authority).unwrap().lamports;
    assert_eq!(
        operator_spent, rent,
        "рента ATA і кільця — з операторського ключа"
    );
}

/// Перший сетлмент створює кільце й кладе в нього корінь цього батча.
#[test]
fn settle_batch_creates_the_ring_on_the_first_settlement() {
    let world = World::new();
    let result = world.run();
    assert!(succeeded(&result), "{:?}", result.program_result);

    let raw = result.get_account(&world.log).expect("кільце");
    assert_eq!(raw.owner, program_id());
    assert_eq!(raw.data.len(), SettlementLog::SIZE);
    assert_eq!(&raw.data[..8], SettlementLog::DISCRIMINATOR);

    let ring = read_ring(raw);
    assert_eq!(ring.escrow, anchor_key(&world.escrow));
    assert_eq!(ring.bump, world.log_bump);
    assert_eq!(ring.head, 1);
    assert_eq!(
        ring.latest(),
        Some(&SettlementEntry {
            seq_end: SEQ,
            ts: NOW,
            root: ROOT,
            chain: CHAIN,
        })
    );
}

/// Наступний сетлмент дописує, а не перестворює: попередній корінь лишається.
#[test]
fn settle_batch_appends_to_an_existing_ring() {
    let mut world = World::new();
    let previous = SettlementEntry {
        seq_end: LAST_SEQ,
        ts: NOW - 60,
        root: [0x01; 32],
        chain: LAST_CHAIN,
    };
    let ring = ring_account(&world.escrow, world.log_bump, previous);
    world.set(world.log, ring);

    let result = world.run();
    assert!(succeeded(&result), "{:?}", result.program_result);

    let ring = read_ring(result.get_account(&world.log).expect("кільце"));
    assert_eq!(ring.head, 2);
    assert_eq!(ring.find(LAST_SEQ), Some(&previous));
    assert_eq!(ring.latest().map(|entry| entry.root), Some(ROOT));
}

/// Комісія на дві одиниці більша, ніж пояснює округлення кожної з трьох
/// квитанцій: settler перекладав би гроші видавця в скарбницю.
#[test]
fn settle_batch_rejects_a_fee_above_the_rate() {
    let mut world = World::new();
    world.tariffs = vec![TARIFF_A, TARIFF_B - 3];
    world.sign(CUMULATIVE);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::SplitMismatch)
    );
}

/// Тарифи понад підписану суму: платити нема з чого, крім чужого залишку.
#[test]
fn settle_batch_rejects_tariffs_above_the_signed_amount() {
    let mut world = World::new();
    world.tariffs = vec![TARIFF_A, TARIFF_B + FEE + 1];
    world.sign(CUMULATIVE);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::SplitMismatch)
    );
}

/// Ваучер, підписаний під сумою, меншою за вже списане, — не батч, а
/// переписування історії.
#[test]
fn settle_batch_rejects_a_cumulative_below_the_settled_total() {
    let mut world = World::new();
    world.tariffs = vec![];
    world.sign(SETTLED_TOTAL - 1);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::CumulativeBelowSettled)
    );
}

/// Ненульова частка вузла без атестатора, якому її платити, не мовчить:
/// інакше вона тихо дісталась би видавцю.
#[test]
fn settle_batch_refuses_a_node_share_it_cannot_pay() {
    let mut world = World::new();
    let config = config_account(
        &world.authority,
        &world.treasury,
        &world.mint,
        500,
        world.config_bump,
    );
    world.set(world.config, config);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::NodeShareNotPayable)
    );
}

/// Гаманець у нозі мусить бути тим, що записаний у домені, інакше виплата
/// видавцю йшла б на будь-яку адресу settler'а.
#[test]
fn settle_batch_rejects_a_payout_wallet_other_than_the_domains() {
    let mut world = World::new();
    let stranger = Pubkey::new_unique();
    world.legs[1].owner = stranger;
    world.legs[1].payout = ata(&stranger, &world.mint);
    world.set(stranger, Account::default());
    world.set(world.legs[1].payout, Account::default());
    world.sign(CUMULATIVE);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::PayoutAccountsMismatch)
    );
}

/// Тариф без своєї трійки акаунтів — розбіжність, а не «заплатимо, кому є».
#[test]
fn settle_batch_rejects_a_tariff_without_its_payout_accounts() {
    let mut world = World::new();
    world.legs.pop();
    world.sign(CUMULATIVE);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::PayoutAccountsMismatch)
    );
}

/// Токен-акаунт, не виведений із гаманця домену, відкидається явно, а не
/// падінням CPI: `create_idempotent` сам виводить адресу й ігнорує передану,
/// тож переказ пішов би на підставлену, щойно виведена теж є в транзакції.
#[test]
fn settle_batch_rejects_a_payout_account_not_derived_from_the_wallet() {
    let mut world = World::new();
    let elsewhere = Pubkey::new_unique();
    let mint = world.mint;
    world.set(elsewhere, token_account(&mint, &Pubkey::new_unique(), 0));
    world.legs[1].payout = elsewhere;
    world.sign(CUMULATIVE);

    assert_eq!(
        error_code(&world.run()),
        expected(ContentLedgerError::PayoutAccountsMismatch)
    );
}

/// Комісія йде лише в скарбницю з `Config`.
#[test]
fn settle_batch_rejects_a_treasury_other_than_the_configs() {
    let mut world = World::new();
    let other = Pubkey::new_unique();
    let owner = world.authority;
    let mint = world.mint;
    world.set(other, token_account(&mint, &owner, 0));
    world.treasury = other;
    world.sign(CUMULATIVE);

    assert_eq!(
        error_code(&world.run()),
        anchor_lang::error::ErrorCode::ConstraintAddress as u32
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
    let escrow = escrow_account(&world.consumer, &world.vault, world.bumps, SEQ);
    world.set(world.escrow, escrow);

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
    world.set(stranger, funded_wallet());

    let mut instruction = world.settle_batch();
    instruction.accounts[0] = AccountMeta::new(stranger, true);

    let result = world
        .mollusk
        .process_instruction(&instruction, &world.accounts);
    assert_eq!(
        error_code(&result),
        expected(ContentLedgerError::Unauthorized)
    );
}
