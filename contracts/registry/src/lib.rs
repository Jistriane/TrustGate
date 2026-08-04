#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, String};

const INSTANCE_TTL_THRESHOLD: u32 = 100;
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Executor(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    AlreadyRegistered = 1,
    NotRegistered = 2,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ExecutorInfo {
    pub metadata_uri: String,
}

#[contract]
pub struct RegistryContract;

fn refresh_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

#[contractimpl]
impl RegistryContract {
    pub fn register_executor(
        env: Env,
        executor: Address,
        metadata_uri: String,
    ) -> Result<(), RegistryError> {
        executor.require_auth();

        let key = DataKey::Executor(executor);
        if env.storage().persistent().has(&key) {
            return Err(RegistryError::AlreadyRegistered);
        }

        env.storage()
            .persistent()
            .set(&key, &ExecutorInfo { metadata_uri });
        refresh_instance_ttl(&env);

        Ok(())
    }

    pub fn is_registered(env: Env, executor: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Executor(executor))
    }

    pub fn get_executor(env: Env, executor: Address) -> Result<ExecutorInfo, RegistryError> {
        env.storage()
            .persistent()
            .get(&DataKey::Executor(executor))
            .ok_or(RegistryError::NotRegistered)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    #[test]
    fn registers_and_reads_executor() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(RegistryContract, ());
        let client = RegistryContractClient::new(&env, &contract_id);

        let executor = Address::generate(&env);
        let metadata_uri = String::from_str(&env, "https://example.com/executor.json");

        assert!(!client.is_registered(&executor));
        client.register_executor(&executor, &metadata_uri);
        assert!(client.is_registered(&executor));

        let info = client.get_executor(&executor);
        assert_eq!(info.metadata_uri, metadata_uri);
    }

    #[test]
    fn rejects_double_registration() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(RegistryContract, ());
        let client = RegistryContractClient::new(&env, &contract_id);

        let executor = Address::generate(&env);
        let metadata_uri = String::from_str(&env, "https://example.com/executor.json");

        client.register_executor(&executor, &metadata_uri);
        assert_eq!(
            client.try_register_executor(&executor, &metadata_uri),
            Err(Ok(RegistryError::AlreadyRegistered))
        );
    }

    #[test]
    fn unregistered_lookup_errors() {
        let env = Env::default();
        let contract_id = env.register(RegistryContract, ());
        let client = RegistryContractClient::new(&env, &contract_id);

        let executor = Address::generate(&env);
        assert_eq!(
            client.try_get_executor(&executor),
            Err(Ok(RegistryError::NotRegistered))
        );
    }
}
