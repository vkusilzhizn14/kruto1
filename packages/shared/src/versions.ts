/**
 * Supported Minecraft versions for seed search.
 *
 * 1.20.x and 1.21.x share the same overworld generation algorithm — only
 * available structure types differ (Trail Ruins added in 1.20, Trial Chambers
 * in 1.21). One precomputed cache is reused for both, with version-specific
 * structure filtering applied at query time.
 */

export type McVersion = "1.20" | "1.21";

export interface McVersionInfo {
  readonly id: McVersion;
  /** Human-friendly label shown in the UI. */
  readonly label: string;
  /** Constant name passed to cubiomes' `setupGenerator`. */
  readonly cubiomesEnum: string;
}

export const MC_VERSIONS: readonly McVersionInfo[] = [
  { id: "1.21", label: "1.21.x", cubiomesEnum: "MC_1_21_3" },
  { id: "1.20", label: "1.20.x", cubiomesEnum: "MC_1_20_6" },
] as const;

export function getVersion(id: McVersion): McVersionInfo {
  const v = MC_VERSIONS.find((x) => x.id === id);
  if (!v) throw new Error(`Unknown MC version: ${id}`);
  return v;
}
