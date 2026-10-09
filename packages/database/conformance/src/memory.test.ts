import { beforeEach } from "vitest";
import { createMemoryStorage } from "@uniora/core";
import type { UnioraStorage } from "@uniora/core";
import { defineAccessScenarios } from "./access-suite.js";

let storage: UnioraStorage;
beforeEach(() => {
  storage = createMemoryStorage();
});

// The in-memory backend of @uniora/core runs the same scenarios as the databases.
defineAccessScenarios({ name: "memory", storage: () => storage });
