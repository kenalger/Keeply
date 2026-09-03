import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import {
  Card,
  FormActions,
  FormScreen,
  FormSection,
  Icon,
  ScreenHeader,
  Text,
  TextField,
  type IconName,
} from '@/components/ui';
import {
  MIN_PASSPHRASE_LENGTH,
  checkPassphrase,
  clearStagedBundles,
  exportBundle,
  passphraseMessage,
  type ExportedBundle,
} from '@/features/backup';
import { log } from '@/lib/log';
import { useThemedStyles, type Theme } from '@/theme';

/**
 * Export an encrypted backup (§20).
 *
 * ── WHAT THE USER IS AGREEING TO ───────────────────────────────────────────
 * Two things they cannot undo, both said BEFORE the button rather than in a
 * toast afterwards:
 *
 *  1. **The passphrase is not recoverable.** There is no account and no server,
 *     so it cannot be reset, mailed or escrowed. A forgotten passphrase is a
 *     lost backup, and the only honest time to say that is while they are
 *     choosing one.
 *  2. **Photos are not in it.** §20 puts receipt and document *metadata* in the
 *     bundle, not the files. A restore brings every record back and every image
 *     back as "unavailable". Discovering that on a new phone would be the worst
 *     possible moment.
 *
 * ── WHY THE PASSPHRASE IS ASKED TWICE ──────────────────────────────────────
 * Because it is write-only. Every other field in this app can be checked later
 * by looking at the record; this one is verified for the first and only time
 * when the user needs the backup most. The reveal toggle on the field is the
 * other half of that — see `TextField`'s `passphrase` content type.
 *
 * ── THE FILE ───────────────────────────────────────────────────────────────
 * Written to the cache, then handed straight to the share sheet, then deleted.
 * It is a complete copy of everything the user has; leaving copies in the cache
 * is the accumulation §19 exists to prevent. Encryption is not a reason to be
 * careless with where the ciphertext sits.
 */
export default function ExportBackupScreen() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [written, setWritten] = useState<ExportedBundle | null>(null);

  const problems = checkPassphrase(passphrase, confirmation);
  // Nothing is red until the user has tried once. A form that shouts "too
  // short" at an empty field is scolding someone for not having typed yet.
  const message = touched ? passphraseMessage(problems) : null;

  const leave = useCallback(() => {
    void clearStagedBundles();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const run = useCallback(() => {
    setTouched(true);
    if (checkPassphrase(passphrase, confirmation).length > 0) return;

    setFailure(null);
    setBusy(true);
    void (async () => {
      try {
        const bundle = await exportBundle(passphrase);
        setWritten(bundle);

        // Straight to the share sheet: the file is in a cache directory the
        // user cannot browse, so a backup they cannot move is not a backup.
        await Share.share({ url: bundle.uri, title: bundle.fileName });
      } catch (error) {
        // The message never carries the path or the passphrase — the data layer
        // does not put them in one, and `log.error` redacts by key regardless.
        log.error('backup: export failed', error);
        setFailure('The backup could not be written. Nothing was changed.');
      } finally {
        setBusy(false);
      }
    })();
  }, [passphrase, confirmation]);

  return (
    <FormScreen
      footer={
        <FormActions
          primaryLabel={written === null ? 'Create backup' : 'Share again'}
          onPrimary={run}
          primaryLoading={busy}
          secondaryLabel={written === null ? 'Cancel' : 'Done'}
          onSecondary={leave}
        />
      }
    >
      <ScreenHeader
        title="Export a backup"
        subtitle="One encrypted file you keep yourself."
        onBack={leave}
      />

      <FormSection
        title="Choose a passphrase"
        description="It encrypts the file. You will need it to restore."
      >
        <TextField
          label="Passphrase"
          content="passphrase"
          value={passphrase}
          onChangeText={setPassphrase}
          required
          autoFocus
          helper={`At least ${MIN_PASSPHRASE_LENGTH} characters. Several words works well.`}
          error={message}
          testID="backup-passphrase"
        />
        <TextField
          label="Passphrase again"
          content="passphrase"
          value={confirmation}
          onChangeText={setConfirmation}
          required
          testID="backup-passphrase-confirm"
        />
      </FormSection>

      <FormSection title="Before you do this">
        <Card>
          {CAVEATS.map((caveat, index) => (
            <Caveat key={caveat.title} caveat={caveat} first={index === 0} />
          ))}
        </Card>
      </FormSection>

      {failure === null ? null : (
        <View style={styles.failure}>
          <Text variant="caption" color="danger">
            {failure}
          </Text>
        </View>
      )}

      {written === null ? null : (
        <View style={styles.done}>
          <Text variant="bodyStrong">Backup ready</Text>
          <Text variant="caption" color="textSecondary">
            {`${written.fileName} · ${formatBytes(written.size)}`}
          </Text>
          <Text variant="caption" color="textSecondary" style={styles.doneNote}>
            Save it somewhere you control. Keeply deletes its copy when you leave this screen.
          </Text>
        </View>
      )}
    </FormScreen>
  );
}

interface CaveatCopy {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
}

const CAVEATS: readonly CaveatCopy[] = [
  {
    icon: 'lock',
    title: 'There is no way to reset it',
    body: 'Keeply has no account and no server, so a forgotten passphrase means a backup nobody can open — not even us.',
  },
  {
    icon: 'photo',
    title: 'Photos are not included',
    body: 'The backup carries your records, not the image files. Restored expenses and documents will show their photo as unavailable.',
  },
  {
    icon: 'download',
    title: 'Everything else is in it',
    body: 'Subscriptions, bills, payments, expenses, allowances, maintenance, documents and your settings.',
  },
];

/**
 * One warning, in full.
 *
 * NOT a `<Row/>`. Its subtitle is `numberOfLines={2}`, which truncated the most
 * important sentence on this screen to "…means a backup nobod…". A row is for a
 * label and a value; these are three consequences the user is agreeing to, and
 * a consequence that does not fit is not a consequence they agreed to.
 */
function Caveat({ caveat, first }: { caveat: CaveatCopy; first: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={first ? styles.caveat : [styles.caveat, styles.caveatNext]}>
      <Icon name={caveat.icon} size={17} color="textSecondary" />
      <View style={styles.caveatText}>
        <Text variant="bodyStrong">{caveat.title}</Text>
        <Text variant="caption" color="textSecondary">
          {caveat.body}
        </Text>
      </View>
    </View>
  );
}

/** "1.2 MB". Not money, so no `formatMoney`; not a date, so no formatter exists. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // A block owns the gap above itself, never below.
    caveat: { flexDirection: 'row', gap: t.space.md, alignItems: 'flex-start' },
    // A block owns the gap above itself, never below.
    caveatNext: { marginTop: t.space.lg },
    caveatText: { flex: 1, gap: 2 },
    failure: { marginTop: t.space.lg },
    done: { marginTop: t.space.lg, gap: t.space.xs },
    doneNote: { marginTop: t.space.xs },
  });
