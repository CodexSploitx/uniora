import { UnioraError } from "../shared/errors.js";

export type WebhookErrorCode =
  | "webhook_invalid"
  | "webhook_url_invalid"
  | "webhook_events_invalid"
  | "webhook_organizations_invalid"
  | "webhook_endpoint_not_found"
  | "webhook_delivery_not_found"
  | "webhook_endpoint_limit"
  | "webhook_version_conflict";

/** Anything wrong with webhook endpoints and deliveries. Stable `code`s, only ever added. */
export class WebhookError extends UnioraError {
  constructor(message: string, code: WebhookErrorCode = "webhook_invalid") {
    super(message, code);
    this.name = "WebhookError";
  }
}
