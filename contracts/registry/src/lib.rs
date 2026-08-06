#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Bytes, BytesN, Env, Symbol, vec,
};

const INSTANCE_TTL_THRESHOLD: u32 = 100;
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400; // ~30 days ledger

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Executor(Address),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ExecutorRecord {
    pub profile_uri: Bytes,
    pub registered_at_ledger: u32,
    pub updated_at_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    ExecutorNotFound = 1,
    ExecutorAlreadyRegistered = 2,
    ProfileUriTooLong = 3,
    ProfileUriEmpty = 4,
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
        profile_uri: Bytes,
    ) -> Result<(), RegistryError> {
        executor.require_auth();
        Self::validate_profile_uri(&profile_uri)?;
        let key = DataKey::Executor(executor.clone());
        if env.storage().persistent().has(&key) {
            return Err(RegistryError::ExecutorAlreadyRegistered);
        }
        let now = env.ledger().sequence();
        let rec = ExecutorRecord {
            profile_uri,
            registered_at_ledger: now,
            updated_at_ledger: now,
        };
        let storage_key = DataKey::Executor(executor.clone());
        env.storage().persistent().set(&storage_key, &rec);
        env.storage()
            .persistent()
            .extend_ttl(&storage_key, 100, INSTANCE_TTL_EXTEND_TO);
        refresh_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "executor_registered"),),
            (executor, rec.registered_at_ledger),
        );
        Ok(())
    }

    /// P1-1: update_executor — updates profile of already registered executor.
    /// Always require_auth() from the executor itself (security: nobody alters third-party profile).
    pub fn update_executor(
        env: Env,
        executor: Address,
        new_profile_uri: Bytes,
    ) -> Result<(), RegistryError> {
        executor.require_auth();
        Self::validate_profile_uri(&new_profile_uri)?;
        let key = DataKey::Executor(executor.clone());
        let mut rec: ExecutorRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(RegistryError::ExecutorNotFound)?;
        rec.profile_uri = new_profile_uri;
        rec.updated_at_ledger = env.ledger().sequence();
        env.storage().persistent().set(&key, &rec);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100, INSTANCE_TTL_EXTEND_TO);
        refresh_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "executor_updated"),),
            (executor, rec.updated_at_ledger),
        );
        Ok(())
    }

    /// P1-1: unregister_executor — executor decides to leave the platform.
    /// Require_auth() from executor. Data is preserved (until TTL) for history of past disputes,
    /// however is_registered returns false going forward. We can add a tombstone
    /// if needed; today absence in storage == unregistered.
    pub fn unregister_executor(env: Env, executor: Address) -> Result<(), RegistryError> {
        executor.require_auth();
        let key = DataKey::Executor(executor.clone());
        if !env.storage().persistent().has(&key) {
            return Err(RegistryError::ExecutorNotFound);
        }
        let now = env.ledger().sequence();
        env.storage().persistent().remove(&key);
        refresh_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "executor_unregistered"),),
            (executor, now),
        );
        Ok(())
    }

    pub fn get_executor(
        env: Env,
        executor: Address,
    ) -> Result<ExecutorRecord, RegistryError> {
        let key = DataKey::Executor(executor);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(RegistryError::ExecutorNotFound)
    }

    pub fn is_registered(env: Env, executor: Address) -> bool {
        let key = DataKey::Executor(executor);
        env.storage().persistent().has(&key)
    }

    pub fn __version() -> u32 {
        2
    }
}

impl RegistryContract {
    fn validate_profile_uri(uri: &Bytes) -> Result<(), RegistryError> {
        if uri.is_empty() {
            return Err(RegistryError::ProfileUriEmpty);
        }
        const MAX_LEN: u32 = 4096;
        if uri.len() > MAX_LEN {
            return Err(RegistryError::ProfileUriTooLong);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, RegistryContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register(RegistryContract, ());
        let client = RegistryContractClient::new(&env, &cid);
        (env, client)
    }

    #[test]
    fn register_and_update_and_unregister_lifecycle() {
        let (_env, client) = setup();
        let ex = Address::generate(&_env);
        let uri_v1 = Bytes::from_slice(&_env, b"https://ex.com/v1");
        client.register_executor(&ex, &uri_v1);
        let r1 = client.get_executor(&ex);
        assert_eq!(r1.profile_uri, uri_v1);
        assert!(client.is_registered(&ex));
        // Update
        let uri_v2 = Bytes::from_slice(&_env, b"ipfs://QmNewProfile");
        client.update_executor(&ex, &uri_v2);
        let r2 = client.get_executor(&ex);
        assert_eq!(r2.profile_uri, uri_v2);
        assert!(r2.updated_at_ledger >= r2.registered_at_ledger);
        assert_eq!(r2.registered_at_ledger, r1.registered_at_ledger);
        // Unregister
        client.unregister_executor(&ex);
        assert!(!client.is_registered(&ex));
        // get_executor fails
        let r3 = client.try_get_executor(&ex);
        assert_eq!(r3, Err(Ok(RegistryError::ExecutorNotFound)));
        // Second unregister → not found (idempotency denied, clear error)
        let r4 = client.try_unregister_executor(&ex);
        assert_eq!(r4, Err(Ok(RegistryError::ExecutorNotFound)));
    }

    #[test]
    fn update_unregistered_fails_notfound() {
        let (env, client) = setup();
        let ex = Address::generate(&env);
        let uri = Bytes::from_slice(&env, b"http://a");
        let r = client.try_update_executor(&ex, &uri);
        assert_eq!(r, Err(Ok(RegistryError::ExecutorNotFound)));
    }

    #[test]
    fn update_or_register_uri_empty_4k_maxlength_fails() {
        let (env, client) = setup();
        let ex = Address::generate(&env);
        let empty = Bytes::from_slice(&env, b"");
        assert_eq!(
            client.try_register_executor(&ex, &empty),
            Err(Ok(RegistryError::ProfileUriEmpty))
        );
        let mut big_uri = Bytes::new(&env);
        for _ in 0..4097 {
            big_uri.push_back(b'x');
        }
        assert_eq!(
            client.try_register_executor(&ex, &big_uri),
            Err(Ok(RegistryError::ProfileUriTooLong))
        );
    }

    #[test]
    fn register_twice_fails_already() {
        let (env, client) = setup();
        let ex = Address::generate(&env);
        let u = Bytes::from_slice(&env, b"a");
        client.register_executor(&ex, &u);
        assert_eq!(
            client.try_register_executor(&ex, &u),
            Err(Ok(RegistryError::ExecutorAlreadyRegistered))
        );
    }
}
