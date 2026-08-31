/**
 * Keeply — keep the encrypted database out of iCloud and device backups (iOS).
 *
 * ---------------------------------------------------------------------------
 * Why
 * ---------------------------------------------------------------------------
 * The SQLCipher key is minted into the Keychain as
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it never leaves the handset. If the
 * database travelled — iCloud backup, device-to-device migration, a Finder
 * restore — the new phone would receive an encrypted file that nothing on it
 * can open, and Keeply would boot straight into an unrecoverable error on a
 * device the user believes they just restored. Keeping file and key together
 * (both device-bound) means a restored phone opens a CLEAN app. Portability is
 * goal.md §20's user-driven encrypted export, not a silent OS backup (§19:
 * "Database → Device").
 *
 * `src/db/client.ts` puts the file in
 * `Library/Application Support/<directory>/keeply.db` on iOS. That is the right
 * *location* (Apple's home for app-managed data the user never browses) but it
 * is still INCLUDED in backups unless the URL carries
 * `NSURLIsExcludedFromBackupKey`. Android needs nothing: the file goes in
 * `<dataDir>/no_backup` (`Context.getNoBackupFilesDir()`), which Auto Backup
 * excludes by definition.
 *
 * ---------------------------------------------------------------------------
 * Why a config plugin, and why the AppDelegate
 * ---------------------------------------------------------------------------
 * No installed module exposes the flag: expo-file-system 57's `Paths`, `File`
 * and `Directory` have no backup API, and nothing else in `node_modules` binds
 * `NSURLIsExcludedFromBackupKey`. It is a *runtime* attribute on a *runtime*
 * directory, so it cannot be expressed in Info.plist or entitlements either —
 * it has to be set by native code that runs before the database is opened.
 *
 * `application(_:didFinishLaunchingWithOptions:)` is the earliest such point
 * and it runs before any JavaScript, therefore before op-sqlite's
 * `create_directories` and before the first `open()`. We create the directory
 * ourselves (idempotent; op-sqlite's own creation then becomes a no-op) and
 * stamp it. Setting the attribute on a DIRECTORY excludes the whole subtree,
 * which is what covers `keeply.db`, `keeply.db-wal` and `keeply.db-shm` on the
 * very first launch, when they do not exist yet. On every later launch we also
 * re-stamp each entry that is already inside, so the individual files carry the
 * attribute themselves and can be checked directly with
 * `xattr -l` (the flag surfaces as `com.apple.metadata:com_apple_backup_excludeItem`).
 *
 * ios/ is generated output: `npx expo prebuild --clean` deletes it and rewrites
 * AppDelegate.swift from the template, and this plugin re-applies on every
 * prebuild. Never hand-edit ios/.
 *
 * ---------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------------
 *   directory  Folder name under Library/Application Support. MUST match
 *              `DATABASE_DIRECTORY` in src/db/client.ts. Defaults to "Keeply".
 *
 * Changing this file requires
 * `npx expo prebuild --clean --platform ios && npx expo run:ios`.
 */
const { withAppDelegate, CodeGenerator } = require('expo/config-plugins');

const { mergeContents } = CodeGenerator;

const HELPER_TAG = 'keeply-backup-exclusion-helper';
const CALL_TAG = 'keeply-backup-exclusion-call';

/** Where prebuild's Swift template creates the RN delegate — inside didFinishLaunching. */
const CALL_ANCHOR = /let\s+delegate\s*=\s*ReactNativeDelegate\(\)/;
/** The `@main` attribute on the AppDelegate class; the helper goes above it, at file scope. */
const HELPER_ANCHOR = /^@main\b/m;

const DEFAULT_DIRECTORY = 'Keeply';

/** Swift string literal escaping for the one interpolated value. */
function swiftString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function helperSource(directory) {
  return `
/// Keeply: exclude the encrypted database directory from iCloud/device backups.
///
/// The SQLCipher key is device-bound (Keychain, WHEN_UNLOCKED_THIS_DEVICE_ONLY),
/// so a backed-up database would restore onto a phone that cannot decrypt it.
/// Runs before any JavaScript, therefore before op-sqlite creates the directory.
private func keeplyExcludeDatabaseDirectoryFromBackup() {
  let fileManager = FileManager.default
  guard
    let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
  else {
    NSLog("[keeply] no Application Support directory; backup exclusion skipped")
    return
  }

  var directory = support.appendingPathComponent(${swiftString(directory)}, isDirectory: true)
  var values = URLResourceValues()
  values.isExcludedFromBackup = true

  do {
    if !fileManager.fileExists(atPath: directory.path) {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    // The attribute on the directory covers everything inside it, including
    // files created later by SQLCipher on this launch.
    try directory.setResourceValues(values)

    // Belt and braces: re-stamp whatever is already there, so each existing
    // file carries the attribute itself and can be verified with \`xattr -l\`.
    let entries = try fileManager.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil)
    for entry in entries {
      var url = entry
      try? url.setResourceValues(values)
    }
  } catch {
    // Never fatal: a database that is backed up still works. Deliberately no
    // path in the message (see CLAUDE.md: never log file paths).
    NSLog("[keeply] could not exclude the database directory from backup: \\(error.localizedDescription)")
  }
}
`.trim();
}

const CALL_SOURCE = '    keeplyExcludeDatabaseDirectoryFromBackup()';

module.exports = function withDatabaseBackupExclusion(config, options = {}) {
  const directory = options.directory ?? DEFAULT_DIRECTORY;

  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== 'swift') {
      throw new Error(
        `with-database-backup-exclusion expected a Swift AppDelegate, got "${config.modResults.language}". ` +
          'Expo SDK 57 generates AppDelegate.swift; if that changed, this plugin has to be rewritten ' +
          'rather than silently skipped — the database would otherwise be included in iCloud backups.',
      );
    }

    let contents = config.modResults.contents;

    if (!HELPER_ANCHOR.test(contents)) {
      throw new Error(
        'with-database-backup-exclusion could not find "@main" in AppDelegate.swift; ' +
          'the prebuild template changed and the plugin needs updating.',
      );
    }
    if (!CALL_ANCHOR.test(contents)) {
      throw new Error(
        'with-database-backup-exclusion could not find "let delegate = ReactNativeDelegate()" in ' +
          'AppDelegate.swift; the prebuild template changed and the plugin needs updating.',
      );
    }

    contents = mergeContents({
      src: contents,
      newSrc: helperSource(directory),
      tag: HELPER_TAG,
      anchor: HELPER_ANCHOR,
      offset: 0, // above `@main`, at file scope
      comment: '//',
    }).contents;

    contents = mergeContents({
      src: contents,
      newSrc: CALL_SOURCE,
      tag: CALL_TAG,
      anchor: CALL_ANCHOR,
      offset: 0, // first statement of didFinishLaunchingWithOptions
      comment: '//',
    }).contents;

    config.modResults.contents = contents;
    return config;
  });
};
