import * as LegacyFileSystem from 'expo-file-system/legacy';

export interface Settings {
  // Uploads normally require un-metered Wi-Fi; this opts in to cellular (and
  // metered Wi-Fi) uploads.
  uploadOnCellular: boolean;
}

const DEFAULTS: Settings = {
  uploadOnCellular: false,
};

const SETTINGS_URI = `${LegacyFileSystem.documentDirectory}settings.json`;

let cached: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (!cached) {
    try {
      const raw = await LegacyFileSystem.readAsStringAsync(SETTINGS_URI);
      cached = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      cached = { ...DEFAULTS };
    }
  }
  return cached!;
}

export async function updateSettings(changes: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...changes };
  cached = next;
  try {
    await LegacyFileSystem.writeAsStringAsync(SETTINGS_URI, JSON.stringify(next));
  } catch {
    // keep the in-memory value; worst case the change doesn't survive restart
  }
  return next;
}
