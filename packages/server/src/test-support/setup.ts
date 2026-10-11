import { afterAll } from "vitest";
import { closePools } from "./harness.js";

afterAll(async () => {
  await closePools();
});
