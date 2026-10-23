import { failure } from "./wire.mjs";

export const UPGRADE_URL =
  "https://cdn.kimi.com/kimi-computer-use/latest/setup_macos.sh";

function releaseVersion(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  return match ? match.slice(1, 4).map(BigInt) : null;
}

export function validateMinimumRuntimeVersion(value) {
  const parsed = releaseVersion(value);
  if (!parsed) {
    throw failure(
      "KIMI_CU_INVALID_CONFIG",
      "KimiCU trusted service requires minimum_runtime_version as a release version (major.minor.patch); repair the plugin installation",
    );
  }
  return parsed;
}

// The gate reads the UDS hello response (`runtime_version`), not an Agent
// status object: the connected runtime is checked, never a file on disk.
export function assertRuntimeCompatible(hello, minimumVersion) {
  const minimum = validateMinimumRuntimeVersion(minimumVersion);
  const actualVersion = hello?.runtime_version;
  const actual = releaseVersion(actualVersion);
  const upgrade = `Update KimiCU using ${UPGRADE_URL}, then restart the KimiCU service and retry`;
  if (!actual) {
    throw failure(
      "KIMI_CU_RUNTIME_VERSION_UNKNOWN",
      `Connected KimiCU runtime did not report a valid release version; required >= ${minimumVersion}. ${upgrade}`,
    );
  }
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index]) {
      throw failure(
        "KIMI_CU_RUNTIME_TOO_OLD",
        `Connected KimiCU runtime version ${actualVersion}; required >= ${minimumVersion}. ${upgrade}`,
      );
    }
  }
}
