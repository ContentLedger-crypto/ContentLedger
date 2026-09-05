use anchor_lang::InstructionData;
use mollusk_svm::result::{Check, ProgramResult};
use mollusk_svm::Mollusk;
use solana_instruction::Instruction;
use solana_pubkey::Pubkey;

// anchor 0.32 сидить на solana-pubkey 2.x, mollusk 0.15 — на 4.x, де Pubkey це Address.
// Спільного типу немає, тому міст тільки через байти.
fn program_id() -> Pubkey {
    Pubkey::new_from_array(contentledger::ID.to_bytes())
}

#[test]
fn ping_succeeds() {
    let id = program_id();
    let mollusk = Mollusk::new(&id, "contentledger");

    let instruction =
        Instruction::new_with_bytes(id, &contentledger::instruction::Ping {}.data(), vec![]);

    mollusk.process_and_validate_instruction(&instruction, &[], &[Check::success()]);
}

#[test]
fn unknown_discriminator_fails() {
    let id = program_id();
    let mollusk = Mollusk::new(&id, "contentledger");

    let instruction = Instruction::new_with_bytes(id, &[0u8; 8], vec![]);

    let result = mollusk.process_instruction(&instruction, &[]);
    assert!(!matches!(result.program_result, ProgramResult::Success));
}
