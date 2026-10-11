import { beforeEach } from "vitest";
import { createMemoryApiCredentialStorage, createMemoryStorage, createMemoryWebhookStorage } from "@uniora/core";
import type { ApiCredentialStorage, UnioraStorage, WebhookStorage } from "@uniora/core";
import { defineAccessScenarios } from "./access-suite.js";
import { defineApiCredentialConformance } from "./api-suite.js";
import { defineWebhookConformance } from "./webhook-suite.js";

let storage: UnioraStorage;
beforeEach(() => {
  storage = createMemoryStorage();
});

// The in-memory backend of @uniora/core runs the same scenarios as the databases.
defineAccessScenarios({ name: "memory", storage: () => storage });

// ...and so does the in-memory credential storage.
let apiStorage: ApiCredentialStorage;
defineApiCredentialConformance({
  name: "memory",
  async setup() {},
  async teardown() {},
  async reset() {
    apiStorage = createMemoryApiCredentialStorage();
  },
  storage: () => apiStorage,
});

let webhookStorage: WebhookStorage;
defineWebhookConformance({
  name: "memory",
  async setup() {},
  async teardown() {},
  async reset() {
    webhookStorage = createMemoryWebhookStorage();
  },
  storage: () => webhookStorage,
  probe: {
    async dumpWebhookText() {
      // The in-memory backend keeps the secret next to the endpoint; there is no table to dump, so the secret is read through the worker's door.
      const [endpoint] = await webhookStorage.endpoints.search();
      return (await webhookStorage.endpoints.signingSecrets(endpoint!.id)).join("\n");
    },
  },
});
