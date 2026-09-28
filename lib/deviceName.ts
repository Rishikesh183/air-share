"use client";

const STORAGE_KEY = "gesturedrop:deviceName";
export const MAX_NAME_LENGTH = 40;

const ADJECTIVES = [
  "Blue", "Amber", "Swift", "Quiet", "Bright", "Lucky",
  "Brave", "Calm", "Coral", "Misty", "Sunny", "Frosty",
];
const ANIMALS = [
  "Otter", "Falcon", "Panda", "Fox", "Heron", "Lynx",
  "Koala", "Orca", "Robin", "Tiger", "Gecko", "Moose",
];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function generateDeviceName(): string {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

function clean(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
}

/** Returns the remembered name, generating and storing one on first use. */
export function getDeviceName(): string {
  try {
    const stored = clean(localStorage.getItem(STORAGE_KEY) ?? "");
    if (stored) return stored;
  } catch {
    // Storage blocked (private mode): fall through to a fresh name.
  }
  const name = generateDeviceName();
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* not persisted, still usable for this visit */
  }
  return name;
}

export function saveDeviceName(name: string): string {
  const next = clean(name) || generateDeviceName();
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* not persisted, still usable for this visit */
  }
  return next;
}
