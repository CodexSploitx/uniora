import { UnioraError } from "../shared/errors.js";

export type PolicyErrorCode =
  | "policy_not_found"
  | "policy_exists"
  | "policy_key_taken"
  | "policy_key_invalid"
  | "policy_name_invalid"
  | "policy_description_invalid"
  | "policy_definition_invalid"
  | "policy_organization_unknown"
  | "policy_update_empty"
  | "policy_transition_invalid"
  | "policy_retired"
  | "policy_not_draft"
  | "policy_limit_reached"
  | "policy_version_conflict"
  | "policy_revision_not_found"
  | "policy_separation_of_duties"
  | "policy_forbidden"
  | "policy_authorization_required"
  | "policy_invalid";

/** Every policy failure carries one of these stable codes (see `PolicyErrorCode`); the message may be reworded. */
export class PolicyError extends UnioraError {
  constructor(message: string, code: PolicyErrorCode = "policy_invalid") {
    super(message, code);
    this.name = "PolicyError";
  }
}
