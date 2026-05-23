/**
 * In-memory picker state for the /search wizard.
 *
 * grammY's storage API would also work, but a plain Map keyed on chatId is
 * sufficient: picker state is short-lived (lasts only while the user is
 * choosing filters) and a server restart simply forces the user to start the
 * picker again. State is intentionally NOT persisted to the database.
 */

import type { McVersion, RadiusInfo } from "@kruto52/shared";

export interface PickerState {
  version: McVersion;
  radius: RadiusInfo;
  biomes: Set<string>;
  structures: Set<string>;
  page: { biomes: number; structures: number };
  /** Seeds already returned to this user for this exact filter set. */
  excludeSeeds: Set<string>;
}

export type PickerKind = "biomes" | "structures";

const STATE: Map<number, PickerState> = new Map();

export function getState(chatId: number, init: () => PickerState): PickerState {
  const existing = STATE.get(chatId);
  if (existing) return existing;
  const fresh = init();
  STATE.set(chatId, fresh);
  return fresh;
}

export function setState(chatId: number, state: PickerState): void {
  STATE.set(chatId, state);
}

export function clearState(chatId: number): void {
  STATE.delete(chatId);
}
