import { UnioraError } from "../shared/errors.js";

export type PlatformErrorCode =
  | "platform_invalid"
  | "platform_forbidden"
  | "platform_step_up_required"
  | "platform_authorization_required"
  | "platform_already_initialized"
  | "platform_not_initialized"
  | "platform_permission_invalid"
  | "platform_role_invalid"
  | "platform_role_exists"
  | "platform_role_not_found"
  | "platform_role_system"
  | "platform_role_in_use"
  | "platform_member_invalid"
  | "platform_member_exists"
  | "platform_member_not_found"
  | "platform_last_admin"
  | "platform_self_change"
  | "platform_escalation"
  | "platform_version_conflict"
  | "platform_support_unavailable";

export class PlatformError extends UnioraError {
  constructor(message: string, code: PlatformErrorCode = "platform_invalid") {
    super(message, code);
    this.name = "PlatformError";
  }
}
