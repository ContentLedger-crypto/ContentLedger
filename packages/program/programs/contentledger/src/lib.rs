use anchor_lang::prelude::*;

declare_id!("HFoHycv5MSCFizdb4GhPSYgLWFfwu1MgEW8qx8zuWKh2");

#[program]
pub mod contentledger {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
