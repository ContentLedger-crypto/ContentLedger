//! `register_domain` і `register_work` — ончейн-запис реєстру (FR-001, FR-002).

use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

use crate::error::ContentLedgerError;
use crate::state::{
    Config, Domain, LicenceStatus, Work, CONFIG_SEED, DOMAIN_SEED, MAX_HOST_LEN, WORK_SEED,
};

/// Максимальна довжина однієї помітки DNS-імені.
const MAX_LABEL_LEN: usize = 63;

/// Ідентифікатор домену в сідах — sha256 канонічного хоста.
pub fn host_seed(host: &str) -> [u8; 32] {
    hash(host.as_bytes()).to_bytes()
}

/// Канонічна форма хоста: lowercase ASCII (IDNA A-label), без схеми, без порту,
/// без кінцевої крапки.
///
/// Перевірка тут, а не на клієнті, бо **хеш є сідом**: `Example.com` і
/// `example.com` дали б два різні `Domain` для одного сайту, і обидва були б
/// «чинні». Ловляться саме ті форми, якими реально розʼїжджається канонізація:
/// верхній регістр, `https://`, `:443`, кінцева крапка, порожня помітка.
pub fn is_canonical_host(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_HOST_LEN {
        return false;
    }

    let mut labels = 0usize;
    for label in host.split('.') {
        labels += 1;
        let bytes = label.as_bytes();
        if bytes.is_empty() || bytes.len() > MAX_LABEL_LEN {
            return false;
        }
        if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
            return false;
        }
        if !bytes
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        {
            return false;
        }
    }

    labels >= 2
}

#[derive(Accounts)]
#[instruction(host_hash: [u8; 32])]
pub struct RegisterDomain<'info> {
    /// Платник ренти. До M4 це або оператор (посів реєстру, T022), або сам
    /// власник домену — атестації, яку вимагає FR-005a, ще не існує.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = payer,
        space = 8 + Domain::INIT_SPACE,
        // Хеш приходить аргументом, а не рахується тут: під фічею `idl-build`
        // anchor не вміє представити виклик функції у виразі сідів, і аргумент
        // там просто не в області видимості. Довіри це не додає — обробник
        // перехешовує `host` і звіряє.
        seeds = [DOMAIN_SEED, host_hash.as_ref()],
        bump,
    )]
    pub domain: Account<'info, Domain>,

    pub system_program: Program<'info, System>,
}

pub fn register_domain(
    ctx: Context<RegisterDomain>,
    host_hash: [u8; 32],
    host: String,
    owner: Pubkey,
    payout_owner: Pubkey,
    rate_train: u64,
    rate_inference: u64,
) -> Result<()> {
    require!(
        is_canonical_host(&host),
        ContentLedgerError::HostNotCanonical
    );
    require!(
        host_seed(&host) == host_hash,
        ContentLedgerError::HostHashMismatch
    );

    let payer = ctx.accounts.payer.key();
    require!(
        payer == owner || payer == ctx.accounts.config.authority,
        ContentLedgerError::Unauthorized
    );

    let domain = &mut ctx.accounts.domain;
    domain.owner = owner;
    domain.payout_owner = payout_owner;
    domain.host = host;
    domain.rate_train = rate_train;
    domain.rate_inference = rate_inference;
    domain.status = LicenceStatus::Active;
    domain.bump = ctx.bumps.domain;
    domain.reserved = [0; 32];

    Ok(())
}

#[derive(Accounts)]
#[instruction(source_hash: [u8; 32])]
pub struct RegisterWork<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub domain: Account<'info, Domain>,

    /// Домен у сідах робить колізію джерела (FR-005) відмовою на рівні PDA:
    /// друга реєстрація того самого джерела бʼється об уже створений акаунт.
    #[account(
        init,
        payer = payer,
        space = 8 + Work::INIT_SPACE,
        seeds = [WORK_SEED, domain.key().as_ref(), source_hash.as_ref()],
        bump,
    )]
    pub work: Account<'info, Work>,

    pub system_program: Program<'info, System>,
}

pub fn register_work(
    ctx: Context<RegisterWork>,
    source_hash: [u8; 32],
    content_hash: [u8; 32],
) -> Result<()> {
    let payer = ctx.accounts.payer.key();
    require!(
        payer == ctx.accounts.domain.owner || payer == ctx.accounts.config.authority,
        ContentLedgerError::Unauthorized
    );

    let work = &mut ctx.accounts.work;
    work.domain = ctx.accounts.domain.key();
    work.source_hash = source_hash;
    work.content_hash = content_hash;
    // Ставки-перекриття не задаються при реєстрації: твір успадковує домен,
    // поки власник не викличе `set_rates` (T016).
    work.rate_train = None;
    work.rate_inference = None;
    work.status = LicenceStatus::Active;
    work.attested_by = 0;
    work.bump = ctx.bumps.work;
    work.reserved = [0; 32];

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_hosts() {
        for host in [
            "example.com",
            "a.b",
            "sub.domain.example.com",
            "xn--80ak6aa92e.com",
            "news-site.example.co.uk",
            "1.2.3.4",
        ] {
            assert!(is_canonical_host(host), "{host}");
        }
    }

    /// Кожен рядок — форма, якою реально розʼїжджається канонізація.
    #[test]
    fn rejects_every_non_canonical_form() {
        for host in [
            "",
            "Example.com",
            "EXAMPLE.COM",
            "example.com.",
            ".example.com",
            "example..com",
            "https://example.com",
            "example.com:443",
            "example.com/path",
            "example.com ",
            " example.com",
            "example",
            "-example.com",
            "example-.com",
            "приклад.com",
            "example.com?q=1",
        ] {
            assert!(!is_canonical_host(host), "{host}");
        }
    }

    #[test]
    fn rejects_hosts_over_the_length_limits() {
        let long_label = "a".repeat(MAX_LABEL_LEN + 1);
        assert!(!is_canonical_host(&format!("{long_label}.com")));

        let at_limit = "a".repeat(MAX_LABEL_LEN);
        assert!(is_canonical_host(&format!("{at_limit}.com")));

        let too_long = format!("{}.com", [at_limit.as_str(); 4].join("."));
        assert!(too_long.len() > MAX_HOST_LEN);
        assert!(!is_canonical_host(&too_long));
    }

    /// Хеш є сідом, тож різні хости мусять давати різні сіди, а той самий —
    /// той самий. Тривіально, але саме на цьому тримається весь реєстр.
    #[test]
    fn host_seed_is_stable_and_distinct() {
        assert_eq!(host_seed("example.com"), host_seed("example.com"));
        assert_ne!(host_seed("example.com"), host_seed("example.org"));
    }
}
