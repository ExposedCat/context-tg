// Preloaded by bun test (bunfig.toml). Each test file runs isolated, so give
// every file the required config instead of relying on another file having
// set it first. Files that need different values still assign their own.
const defaults = {
  BOT_TOKEN: "test",
  ADMIN_ID: "1",
  SQLITE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_API_KEY: "test",
  KEENABLE_API_KEY: "test",
  EMBEDDER_BASE_URL: "https://embedder.test/v1",
  EMBEDDER_API_KEY: "test",
  EMBEDDING_MODEL: "test",
  QDRANT_URL: "https://qdrant.test",
};
for (const [key, value] of Object.entries(defaults)) Bun.env[key] ??= value;
