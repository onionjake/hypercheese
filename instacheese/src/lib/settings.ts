import * as LegacyFileSystem from 'expo-file-system/legacy';

export interface Settings {
  // Uploads normally require un-metered Wi-Fi; this opts in to cellular (and
  // metered Wi-Fi) uploads.
  uploadOnCellular: boolean;
  // SAF directory the user granted for saving debug logs on Android, so the
  // folder picker only appears once.
  logDownloadDirUri: string | null;
  // Nightly ~9pm notification when photos still need a Back up / Won't
  // upload decision (see mark-reminder.ts).
  nightlyMarkReminder: boolean;
  // When the reminder's background library rescan last ran, for throttling.
  reminderLastScan: number;
}

const DEFAULTS: Settings = {
  uploadOnCellular: false,
  logDownloadDirUri: null,
  nightlyMarkReminder: true,
  reminderLastScan: 0,
};

const SETTINGS_URI = `${LegacyFileSystem.documentDirectory}settings.json`;

let cached: Settings | null = null;
// The first read is shared: two concurrent first callers each assigning the
// file's contents could clobber an update that landed in between.
let loading: Promise<Settings> | null = null;
// Writes go out one at a time, each with the latest value, so an older write
// finishing last can't leave stale settings on disk.
let writeChain: Promise<void> = Promise.resolve();

export async function getSettings(): Promise<Settings> {
  if (cached) return cached;
  if (!loading) {
    loading = (async () => {
      try {
        const raw = await LegacyFileSystem.readAsStringAsync(SETTINGS_URI);
        cached = { ...DEFAULTS, ...JSON.parse(raw) };
      } catch {
        cached = { ...DEFAULTS };
      }
      return cached!;
    })();
  }
  return loading;
}

export async function updateSettings(changes: Partial<Settings>): Promise<Settings> {
  await getSettings();
  // Merge into the CURRENT value after the await: concurrent updates (the
  // background task's reminderLastScan vs. a Profile toggle) must not undo
  // each other.
  const next = { ...cached!, ...changes };
  cached = next;
  const write = writeChain.then(async () => {
    try {
      await LegacyFileSystem.writeAsStringAsync(SETTINGS_URI, JSON.stringify(cached));
    } catch {
      // keep the in-memory value; worst case the change doesn't survive restart
    }
  });
  writeChain = write;
  await write;
  return next;
}
