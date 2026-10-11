import { UnioraError } from "../shared/errors.js";

export type ApiCredentialErrorCode =
  | "api_invalid"
  | "api_client_invalid"
  | "api_client_exists"
  | "api_client_not_found"
  | "api_client_disabled"
  | "api_scope_invalid"
  | "api_organizations_invalid"
  | "api_key_invalid"
  | "api_key_not_found"
  | "api_key_limit"
  | "api_version_conflict";

/** Anything wrong with API clients and keys. Stable `code`s, only ever added. */
export class ApiCredentialError extends UnioraError {
  constructor(message: string, code: ApiCredentialErrorCode = "api_invalid") {
    super(message, code);
    this.name = "ApiCredentialError";
  }
}
