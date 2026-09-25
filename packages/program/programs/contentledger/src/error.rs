//! Коди помилок програми.
//!
//! Порядок варіантів — частина ABI: Anchor нумерує їх від 6000 у порядку
//! оголошення, і клієнт із `packages/chain` (T018) звіряється саме з числом.
//! Нові варіанти дописуються **в кінець**.

use anchor_lang::prelude::*;

#[error_code]
pub enum ContentLedgerError {
    #[msg("Частка в базисних пунктах перевищує 100%")]
    BpsOutOfRange,
    #[msg("Вікно на вивід поза дозволеними межами")]
    GraceOutOfRange,
    #[msg("Токен-акаунт скарбниці належить іншому мінту")]
    TreasuryMintMismatch,
    #[msg("Хост не в канонічній формі")]
    HostNotCanonical,
    #[msg("Підписант не має права на цю дію")]
    Unauthorized,
    #[msg("Хеш хоста не збігається з самим хостом")]
    HostHashMismatch,
    #[msg("Токен не є валютою протоколу")]
    MintMismatch,
    #[msg("Заявки на вивід немає")]
    WithdrawNotRequested,
    #[msg("Вікно на вивід ще не минуло")]
    WithdrawTooEarly,
    #[msg("No ed25519 verification instruction in this transaction")]
    VoucherSignatureMissing,
    #[msg("The verified signature does not cover this voucher")]
    VoucherSignatureMismatch,
    #[msg("The escrow has already settled this voucher")]
    StaleVoucher,
}
