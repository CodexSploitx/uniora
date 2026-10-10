import { beforeEach } from "vitest";
import { createMemoryApiCredentialStorage, createMemoryStorage } from "@uniora/core";
import type { ApiCredentialStorage, UnioraStorage } from "@uniora/core";
import { defineAccessScenarios } from "./access-suite.js";
import { defineApiCredentialConformance } from "./api-suite.js";

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
