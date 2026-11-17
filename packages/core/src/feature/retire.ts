import type { UnioraStorage } from "../storage/types.js";
import { FeatureError } from "./repository.js";
import type { FeatureChangeMeta } from "./types.js";

export interface RetireFeatureOptions extends FeatureChangeMeta {
  /**
   * Also switch the feature off everywhere first (`features.disableEverywhere`), so a feature that is still on in some
   * organization can be retired in one call. Default `false`: a feature that is still enabled somewhere is refused
   * (`feature_in_use`) and nothing changes. Turning it on is what the organizations' admins chose; this is the explicit
   * "I am removing the feature from the product" switch.
   */
  disableEverywhere?: boolean;
}

export interface RetireFeatureResult {
  /** `true` when the definition existed and is now gone; `false` when it was already absent (nothing to do). */
  retired: boolean;
  /** Overrides that were on and were switched off (always `0` unless `disableEverywhere` was passed). */
  disabledOverrides: number;
  /** `true` when the feature was on by default for organizations without an override and `disableEverywhere` turned that off. */
  defaultWasEnabled: boolean;
}

/**
 * Retires a feature: removes its definition from the catalog, and the per-organization overrides that were left
 * switched off, in one transaction. Idempotent, so an app can run it on every start for the keys it dropped from its code.
 *
 * - Already absent → `{ retired: false, … }`, no error and no audit entry.
 * - Another feature still names it as parent → `FeatureError` `feature_has_children`; nothing changes.
 * - Still enabled in some organization → `FeatureError` `feature_in_use`, unless `disableEverywhere: true`; nothing changes.
 *
 * Everything runs in `storage.transaction`, so a refusal half-way (a child appears, an organization turns it on
 * concurrently) rolls the kill switch back too. Wrap the storage with `createAuditedStorage` to get
 * `feature.disabled_everywhere` and `feature.unregistered` in the audit log. Like the repository it uses, it does not
 * authorize the caller: guard it with `engine.can`.
 */
export async function retireFeature(
  storage: UnioraStorage,
  key: string,
  options: RetireFeatureOptions = {},
): Promise<RetireFeatureResult> {
  const { disableEverywhere, ...meta } = options;
  return storage.transaction(async (tx) => {
    try {
      const switchedOff = disableEverywhere === true ? await tx.features.disableEverywhere(key, meta) : undefined;
      await tx.features.unregister(key);
      return {
        retired: true,
        disabledOverrides: switchedOff?.disabledOverrides ?? 0,
        defaultWasEnabled: switchedOff?.defaultWasEnabled ?? false,
      };
    } catch (error) {
      // Both calls look the key up first and change nothing when it is unknown, so "already gone" is a success.
      if (error instanceof FeatureError && error.code === "feature_unknown") {
        return { retired: false, disabledOverrides: 0, defaultWasEnabled: false };
      }
      throw error;
    }
  });
}
