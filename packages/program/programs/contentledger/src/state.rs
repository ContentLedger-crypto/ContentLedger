//! Акаунти програми та їхні PDA-сіди.
//!
//! Layout тут дорожчий за будь-який TS-файл: після деплою на devnet зміна поля
//! означає міграцію або новий program ID. Тому кожен акаунт несе `reserved`,
//! а розміри прибиті тестами — щоб додане поле було рішенням, а не наслідком.

use anchor_lang::prelude::*;

/// Сіди PDA. Прообрази ідентифікаторів (`host`, `source_id`) хешуються
/// на клієнті; програма бачить лише 32 байти.
pub const CONFIG_SEED: &[u8] = b"config";
pub const DOMAIN_SEED: &[u8] = b"domain";
pub const WORK_SEED: &[u8] = b"work";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const VAULT_SEED: &[u8] = b"vault";
pub const LOG_SEED: &[u8] = b"log";

/// Стеля довжини DNS-імені. Домени короткі й нечисленні, тому `host` лежить
/// ончейн прообразом: інакше реєстр «читається публічно» (FR-006) лише через
/// наш Postgres. Твори численні, а URL буває на тисячі символів — там
/// зберігається тільки хеш.
pub const MAX_HOST_LEN: usize = 253;

/// 100% у базисних пунктах.
pub const MAX_BPS: u16 = 10_000;

/// Довжина кільця `SettlementLog`.
///
/// Запис — 80 байтів, отже 120 записів + шапка = 9 648 байтів разом із
/// дискримінатором. Стеля для акаунта, який програма створює через CPI, —
/// `MAX_PERMITTED_DATA_INCREASE` = 10 240 байтів; хардовий максимум тут 127,
/// а 120 лишає запас на одне майбутнє поле шапки.
///
/// Що це купує: при сетлменті раз на хвилину кільце тримає ~2 години коренів
/// на споживача. Старіший корінь береться з історії транзакцій RPC — кільце
/// дає гарантовану нижню межу, а не повний архів.
pub const SETTLEMENT_RING_LEN: usize = 120;

/// Стеля розміру акаунта, створеного програмою через CPI.
pub const MAX_CPI_ACCOUNT_SIZE: usize = 10_240;

/// Статус ліцензування. Верифікація — **окрема вісь** (`Work::attested_by`):
/// за FR-011c розбіжність хешів робить твір неперевіреним, і твір, знятий
/// власником **і** неперевірений, мусить мати представлення.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum LicenceStatus {
    /// Ліцензується за чинним тарифом.
    Active,
    /// Знятий з ліцензування. За FR-002b знятий домен закриває всі свої твори
    /// незалежно від їхнього власного статусу.
    Suspended,
}

/// Глобальні параметри протоколу. Синглтон, сіди `["config"]`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Хто змінює цей акаунт.
    pub authority: Pubkey,
    /// Куди йде комісія протоколу. Токен-акаунт, не власник.
    pub treasury_ata: Pubkey,
    /// Єдина валюта тарифів, escrow і виплат (FR-010). Без цього піна програма
    /// прийняла б будь-який SPL-токен як USDC.
    pub mint: Pubkey,
    /// Комісія протоколу — надбавка **понад** тариф (FR-017), округлення вгору.
    pub protocol_fee_bps: u16,
    /// Частка вузла-атестатора — **всередині** тарифу (FR-017b), округлення
    /// вниз. Нульова до M4.
    pub node_share_bps: u16,
    /// Скільки секунд між заявкою на вивід і самим виводом: вікно, за яке
    /// шлюз мусить відсетлити вже видані ваучери. Глобальне значення безпечне
    /// саме тому, що `request_withdraw` знімає з нього знімок у
    /// `Escrow::withdraw_after`.
    pub voucher_grace_s: i64,
    /// Аварійна зупинка. Один байт проти апгрейду програми.
    pub paused: bool,
    pub bump: u8,
    /// Запас під майбутні поля; змінюється тільки разом із міграцією.
    pub reserved: [u8; 64],
}

/// Домен видавця. Сіди `["domain", sha256(host)]`.
///
/// Канонічна форма `host`, з якої береться хеш: lowercase, IDNA A-label,
/// без схеми, без порту, без кінцевої крапки. Хеш є сідом, тож будь-який дрейф
/// канонізації створює другий домен для того самого сайту. Перевірка форми
/// живе в `register_domain` (T015).
#[account]
#[derive(InitSpace)]
pub struct Domain {
    /// Гаманець видавця. Джерело правди про власника і для творів домену.
    pub owner: Pubkey,
    /// Токен-акаунт виплат видавцю.
    pub payout_ata: Pubkey,
    /// Прообраз ідентифікатора домену. Хеш не зберігається — він виводиться
    /// звідси, і два представлення одного ідентифікатора були б двома
    /// джерелами правди.
    #[max_len(MAX_HOST_LEN)]
    pub host: String,
    /// Базова ставка за тренування, базові одиниці USDC (FR-002).
    pub rate_train: u64,
    /// Базова ставка за inference-запит.
    pub rate_inference: u64,
    pub status: LicenceStatus,
    pub bump: u8,
    /// Запас під майбутні поля; змінюється тільки разом із міграцією.
    pub reserved: [u8; 32],
}

/// Твір. Сіди `["work", domain, sha256(source_id)]`.
///
/// Домен у сідах робить колізію джерела (FR-005) відмовою на рівні PDA:
/// повторна реєстрація того самого джерела в тому самому домені б'ється об
/// уже створений акаунт, а не створює другий запис.
#[account]
#[derive(InitSpace)]
pub struct Work {
    /// Домен-власник. `owner` тут не дублюється: він живе в `Domain`, і
    /// дублікат довелося б синхронізувати при передачі домену.
    pub domain: Pubkey,
    /// sha256 канонічного ідентифікатора джерела. Прообраз ончейн не лежить —
    /// URL буває на тисячі символів, а творів багато.
    pub source_hash: [u8; 32],
    /// sha256 вмісту твору на момент реєстрації (FR-011a).
    pub content_hash: [u8; 32],
    /// Перекриття базової ставки домену (FR-002a). `None` — «не задано»;
    /// сентинел `0` тут неможливий, бо нульова ставка легітимна.
    pub rate_train: Option<u64>,
    /// Перекриття базової ставки домену за inference-запит.
    pub rate_inference: Option<u64>,
    pub status: LicenceStatus,
    /// Скільки вузлів атестували твір, із насиченням на 255. Інертне до M4.
    pub attested_by: u8,
    pub bump: u8,
    /// Запас під майбутні поля; змінюється тільки разом із міграцією.
    pub reserved: [u8; 32],
}

/// Передплачений рахунок агента. Сіди `["escrow", consumer]`.
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    /// Гаманець агента. Кошти належать йому (FR-008d).
    pub consumer: Pubkey,
    /// Токен-акаунт із коштами, власний PDA `["vault", escrow]`, а не ATA:
    /// усі сіди лишаються всередині програми, а `vault_bump` поруч знімає
    /// `find_program_address` із кожної виплати.
    pub vault: Pubkey,
    /// Скільки вже списано сетлментами. Різниця з `cumulative` останнього
    /// ваучера і є сумою батча.
    pub settled_total: u64,
    /// Номер останнього відсетленого ваучера.
    pub last_seq: u64,
    /// Кумулятивний хеш-ланцюг на цьому ж ваучері (T011).
    pub last_chain: [u8; 32],
    /// Знімок `Config::voucher_grace_s` у момент заявки на вивід; нуль —
    /// заявки немає.
    pub withdraw_after: i64,
    pub bump: u8,
    pub vault_bump: u8,
    /// Запас під майбутні поля; змінюється тільки разом із міграцією.
    pub reserved: [u8; 32],
}

/// Один запис кільця: що саме було заякорено сетлментом.
#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct SettlementEntry {
    /// Номер останнього ваучера батча. `0` означає незайнятий слот —
    /// `seq` починається з 1, тож окреме поле «скільки заповнено» зайве.
    pub seq_end: u64,
    /// Час якоря за ончейн-годинником.
    pub ts: i64,
    /// Меркл-корінь батча квитанцій (FR-013).
    pub root: [u8; 32],
    /// Значення хеш-ланцюга на `seq_end`.
    pub chain: [u8; 32],
}

/// Кільце останніх сетлментів escrow. Сіди `["log", escrow]`.
///
/// `zero_copy`, а не звичайний `#[account]`: 9,6 КБ не десеріалізуються в
/// 4-КБ стек BPF. `AccountLoader` відображає памʼять напряму.
#[account(zero_copy)]
pub struct SettlementLog {
    pub escrow: Pubkey,
    /// Індекс **наступного** запису. Занулений акаунт — коректне порожнє
    /// кільце, і це те, що дає `init`.
    pub head: u8,
    pub bump: u8,
    /// Вирівнювання масиву на 8 байтів. `Pod` не терпить неявних дірок.
    pub padding: [u8; 6],
    pub entries: [SettlementEntry; SETTLEMENT_RING_LEN],
}

/// Кільце мусить створюватися однією інструкцією, тож перевірка стелі CPI
/// стоїть на компіляції, а не в тесті: додати запис у масив і дізнатися про це
/// на devnet — найдорожчий зі способів.
const _: () = assert!(SettlementLog::SIZE <= MAX_CPI_ACCOUNT_SIZE);

impl SettlementLog {
    /// Розмір акаунта разом із дискримінатором.
    pub const SIZE: usize = 8 + core::mem::size_of::<SettlementLog>();

    /// Записує сетлмент, перезаписуючи найстаріший.
    pub fn push(&mut self, entry: SettlementEntry) {
        let slot = self.head as usize % SETTLEMENT_RING_LEN;
        self.entries[slot] = entry;
        self.head = ((slot + 1) % SETTLEMENT_RING_LEN) as u8;
    }

    /// Останній записаний сетлмент, або `None` на порожньому кільці.
    pub fn latest(&self) -> Option<&SettlementEntry> {
        let slot = (self.head as usize + SETTLEMENT_RING_LEN - 1) % SETTLEMENT_RING_LEN;
        let entry = &self.entries[slot];
        if entry.seq_end == 0 {
            None
        } else {
            Some(entry)
        }
    }

    /// Корінь конкретного батча, поки його не витіснили з кільця.
    pub fn find(&self, seq_end: u64) -> Option<&SettlementEntry> {
        if seq_end == 0 {
            return None;
        }
        self.entries.iter().find(|entry| entry.seq_end == seq_end)
    }
}

#[cfg(test)]
impl Default for SettlementLog {
    fn default() -> Self {
        Self {
            escrow: Pubkey::default(),
            head: 0,
            bump: 0,
            padding: [0; 6],
            entries: [SettlementEntry::default(); SETTLEMENT_RING_LEN],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(seq_end: u64) -> SettlementEntry {
        SettlementEntry {
            seq_end,
            ts: 1_772_000_000,
            root: [seq_end as u8; 32],
            chain: [seq_end as u8 ^ 0xff; 32],
        }
    }

    /// Розміри прибиті числами: додане поле мусить бути видимою зміною цього
    /// тесту, а не тихим зсувом layout після деплою.
    #[test]
    fn account_sizes_are_pinned() {
        assert_eq!(8 + Config::INIT_SPACE, 182);
        assert_eq!(8 + Domain::INIT_SPACE, 379);
        assert_eq!(8 + Work::INIT_SPACE, 157);
        assert_eq!(8 + Escrow::INIT_SPACE, 162);
        assert_eq!(SettlementLog::SIZE, 9_648);
    }

    /// Скільки записів іще влізло б під стелю CPI. Число фіксується, щоб
    /// «збільшимо кільце» було рішенням із відомою межею, а не спробою.
    #[test]
    fn ring_has_a_known_hard_maximum() {
        let header = SettlementLog::SIZE - SETTLEMENT_RING_LEN * 80;
        assert_eq!((MAX_CPI_ACCOUNT_SIZE - header) / 80, 127);
    }

    /// `Pod` вимагає відсутності неявних дірок: розмір мусить дорівнювати сумі
    /// полів, інакше `padding` порахований неправильно.
    #[test]
    fn zero_copy_layout_has_no_implicit_holes() {
        assert_eq!(core::mem::size_of::<SettlementEntry>(), 8 + 8 + 32 + 32);
        assert_eq!(core::mem::align_of::<SettlementEntry>(), 8);
        assert_eq!(
            core::mem::size_of::<SettlementLog>(),
            32 + 1 + 1 + 6 + SETTLEMENT_RING_LEN * 80
        );
    }

    /// Занулений акаунт — коректне порожнє кільце.
    #[test]
    fn zeroed_ring_reads_as_empty() {
        let log = SettlementLog::default();
        assert_eq!(log.latest(), None);
        assert_eq!(log.find(1), None);
    }

    #[test]
    fn push_keeps_latest_and_finds_by_seq_end() {
        let mut log = SettlementLog::default();
        log.push(entry(7));
        log.push(entry(19));

        assert_eq!(log.latest(), Some(&entry(19)));
        assert_eq!(log.find(7), Some(&entry(7)));
        assert_eq!(log.find(8), None);
        assert_eq!(log.head, 2);
    }

    /// Кільце витісняє найстаріше, а не росте і не збивається на нуль.
    #[test]
    fn ring_wraps_and_evicts_the_oldest() {
        let mut log = SettlementLog::default();
        for seq in 1..=(SETTLEMENT_RING_LEN as u64 + 5) {
            log.push(entry(seq));
        }

        assert_eq!(log.head, 5);
        assert_eq!(log.latest(), Some(&entry(SETTLEMENT_RING_LEN as u64 + 5)));
        assert_eq!(
            log.find(SETTLEMENT_RING_LEN as u64 + 5 - 119),
            Some(&entry(6))
        );
        assert_eq!(log.find(5), None, "витіснений корінь більше не читається");
    }

    /// `seq_end == 0` — сентинел незайнятого слота, а не батч номер нуль.
    #[test]
    fn zero_seq_is_never_a_hit() {
        let mut log = SettlementLog::default();
        log.push(entry(3));
        assert_eq!(log.find(0), None);
    }

    /// Нульова ставка легітимна, тож `Some(0)` не є «не задано» (FR-002a).
    #[test]
    fn zero_rate_differs_from_absent_rate() {
        let free: Option<u64> = Some(0);
        let unset: Option<u64> = None;
        assert_ne!(free, unset);
        assert_eq!(free.try_to_vec().unwrap(), vec![1, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(unset.try_to_vec().unwrap(), vec![0]);
    }

    #[test]
    fn licence_status_round_trips_and_rejects_unknown() {
        for status in [LicenceStatus::Active, LicenceStatus::Suspended] {
            let bytes = status.try_to_vec().unwrap();
            assert_eq!(bytes.len(), 1);
            assert_eq!(LicenceStatus::try_from_slice(&bytes).unwrap(), status);
        }
        assert!(LicenceStatus::try_from_slice(&[2]).is_err());
    }

    /// Джерело з тим самим ідентифікатором у двох доменах — два різні акаунти;
    /// у тому самому домені — один і той самий (FR-005).
    #[test]
    fn work_pda_is_scoped_to_its_domain() {
        let program_id = crate::ID;
        let domain_a = Pubkey::new_unique();
        let domain_b = Pubkey::new_unique();
        let source = [9u8; 32];

        let derive = |domain: &Pubkey| {
            Pubkey::find_program_address(&[WORK_SEED, domain.as_ref(), &source], &program_id).0
        };

        assert_ne!(derive(&domain_a), derive(&domain_b));
        assert_eq!(derive(&domain_a), derive(&domain_a));
    }

    /// Сіди різних сімейств не перетинаються між собою.
    #[test]
    fn seed_families_are_distinct() {
        let program_id = crate::ID;
        let key = Pubkey::new_unique();

        let escrow = Pubkey::find_program_address(&[ESCROW_SEED, key.as_ref()], &program_id).0;
        let vault = Pubkey::find_program_address(&[VAULT_SEED, escrow.as_ref()], &program_id).0;
        let log = Pubkey::find_program_address(&[LOG_SEED, escrow.as_ref()], &program_id).0;
        let config = Pubkey::find_program_address(&[CONFIG_SEED], &program_id).0;

        let all = [escrow, vault, log, config];
        for (i, a) in all.iter().enumerate() {
            for b in all.iter().skip(i + 1) {
                assert_ne!(a, b);
            }
        }
    }
}
