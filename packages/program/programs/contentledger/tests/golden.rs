//! Золоті вектори адрес — Rust-бік.
//!
//! Ті самі числа прибиті в `packages/chain/src/golden.test.ts`. TS і Rust
//! виводять адреси незалежно, тож зміна сіду — префікса, порядку, наявності
//! домену в сідах твору — розсипає рівно один бік, і розбіжність видно в
//! гейті, а не на devnet, де вона виглядає як «акаунт не знайдено».
//!
//! Значення оновлюються **тільки разом** із клієнтом і тільки свідомо.

use solana_pubkey::Pubkey;
use std::str::FromStr;

use contentledger::instructions::registry::host_seed;

const CONSUMER: &str = "7Xw3kQhVvVfN4dLpAqTzR9mBcJyU2sHnEgWxPd6ZaKtF";
const HOST: &str = "example.com";
const SOURCE: &str = "https://example.com/articles/1";

const HOST_HASH_HEX: &str = "a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947";
const SOURCE_HASH_HEX: &str = "60922123737102689c2e81d3c5c4ccd677dfa86f8336b4cc4f2d36bc75163453";

const CONFIG: (&str, u8) = ("APuw7hAys97GMS71GZqBcwAPZGNUqAXPsijKA3aqrzka", 255);
const DOMAIN: (&str, u8) = ("4ykZ4k6M3dBVkQE5uGT218TeZ9NjJ8iHATjm2yYzb4AG", 254);
const WORK: (&str, u8) = ("EiH5VpKYtWGy2CX4R1Chd68LXfygYS4S22ceaoDf3pfB", 253);
const ESCROW: (&str, u8) = ("8jpMQyQboQ22Xh1FjptmJKBvH7JHENHVT38B8FL1aoCa", 253);
const VAULT: (&str, u8) = ("2cHpQ3ESXdF5xineBKjcJjLmJSFbCpHB5Bhp3S8M7gDC", 254);
const LOG: (&str, u8) = ("J2qKbSJNNMX4P51RZwfMh5G7yk3zbC6x5yuDaoEmTAfd", 254);

fn program_id() -> Pubkey {
    Pubkey::new_from_array(contentledger::ID.to_bytes())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn assert_pda(expected: (&str, u8), seeds: &[&[u8]]) -> Pubkey {
    let (address, bump) = Pubkey::find_program_address(seeds, &program_id());
    assert_eq!(address.to_string(), expected.0);
    assert_eq!(bump, expected.1);
    address
}

#[test]
fn identifier_hashes_match_the_client() {
    assert_eq!(hex(&host_seed(HOST)), HOST_HASH_HEX);
    // Джерело програма хешує не сама — сюди приходять готові 32 байти, тож
    // вектор доводить тільки те, що клієнт хешує сам URL і нічого більше.
    assert_eq!(
        hex(&solana_sha256_hasher::hash(SOURCE.as_bytes()).to_bytes()),
        SOURCE_HASH_HEX
    );
}

#[test]
fn addresses_match_the_client() {
    let consumer = Pubkey::from_str(CONSUMER).expect("base58");
    let source_hash = solana_sha256_hasher::hash(SOURCE.as_bytes()).to_bytes();

    assert_pda(CONFIG, &[b"config"]);
    assert_pda(DOMAIN, &[b"domain", &host_seed(HOST)]);
    assert_pda(WORK, &[b"work", &source_hash]);

    let escrow = assert_pda(ESCROW, &[b"escrow", consumer.as_ref()]);
    assert_pda(VAULT, &[b"vault", escrow.as_ref()]);
    assert_pda(LOG, &[b"log", escrow.as_ref()]);
}
