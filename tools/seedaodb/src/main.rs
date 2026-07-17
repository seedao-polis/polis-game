//! Binary entry point. All real logic lives in the library crate (`src/lib.rs` and its
//! modules) so integration tests can drive the router in-process without a real TCP listener.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    seedaodb::run().await
}
