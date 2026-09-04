import { File } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import {
  Button,
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
import { BackupUnreadableError, RestoreFailedError } from '@/db';
import {
  inspectBundle,
  looksLikeBundle,
  restoreBundle,
  restoreWarning,
  type BundlePreview,
} from '@/features/backup';
import { log } from '@/lib/log';
import { useThemedStyles, type Theme } from '@/theme';

/**
 * Restore from an encrypted backup (§20, Phase 8c).
 *
 * ── THREE STEPS, AND THE ORDER IS THE POINT ────────────────────────────────
 * Choose a file · unlock it · look at what is inside · then replace.
 *
 * The middle step is what makes this screen honest. A restore replaces
 * everything on the device, and the only defensible way to ask "are you sure?"
 * is with the contents of the actual file on screen — 12 expenses, 1
 * allowance, written by this version — rather than a generic warning about a
 * file nobody has looked in. So the passphrase is used twice: once to look
 * (`inspectBundle`, which writes nothing) and once to commit.
 *
 * ── WHY THE PICKER IS `File.pickFileAsync` ─────────────────────────────────
 * expo-file-system 57 has one. It needs no new dependency and no native
 * rebuild, and on iOS it hands back a temporary COPY of the chosen file, which
 * is what we want: the restore reads from that copy, and the user's own file —
 * wherever they keep it — is never opened, never locked, and never at risk.
 *
 * ── THE PASSPHRASE IS ASKED ONCE ───────────────────────────────────────────
 * Not twice, as on export. Here it is checked against the file rather than
 * against itself: a wrong one fails immediately and visibly. A confirmation
 * field would only ask the user to type their mistake twice.
 *
 * ── WHAT THIS SCREEN NEVER DOES ────────────────────────────────────────────
 * It never logs the file's name or URI (§10), never puts the passphrase in a
 * route param, and never reports success it did not achieve: a failed restore
 * says, in words, whether the previous data is back.
 */
export default function RestoreBackupScreen() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const [picked, setPicked] = useState<{ uri: string; name: string } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const choose = useCallback(() => {
    setFailure(null);
    void (async () => {
      try {
        // `'*/*'`: iOS has no registered UTI for `.keeply`, so filtering by
        // MIME type would grey out the very file the user came here for.
        const result = await File.pickFileAsync({ mimeTypes: '*/*' });
        if (result.canceled) return;

        // A new file invalidates anything read from the last one.
        setPreview(null);
        setPicked({ uri: result.result.uri, name: result.result.name });
      } catch (error) {
        // Not the URI and not the name (§10) — only that picking failed.
        log.error('backup: choosing a file failed', error);
        setFailure('That file could not be opened.');
      }
    })();
  }, []);

  const unlock = useCallback(() => {
    if (picked === null || passphrase.length === 0) return;
    setFailure(null);
    setBusy(true);
    void (async () => {
      try {
        setPreview(await inspectBundle(picked.uri, passphrase));
      } catch (error) {
        log.error('backup: opening a bundle failed', error);
        setPreview(null);
        setFailure(
          error instanceof BackupUnreadableError
            ? error.message
            : 'That file could not be read.',
        );
      } finally {
        setBusy(false);
      }
    })();
  }, [picked, passphrase]);

  const confirmRestore = useCallback(() => {
    if (picked === null || preview === null || !preview.verdict.canRestore) return;

    Alert.alert('Replace everything on this device?', restoreWarning(preview.report.counts), [
      { text: 'Keep what I have', style: 'cancel' },
      {
        text: 'Replace',
        style: 'destructive',
        onPress: () => {
          setFailure(null);
          setBusy(true);
          void (async () => {
            try {
              await restoreBundle(picked.uri, passphrase);
              // Everything below this screen is reading a database that no
              // longer exists. Go to the root rather than back into it.
              router.replace('/');
            } catch (error) {
              log.error('backup: restore failed', error);
              setFailure(
                error instanceof RestoreFailedError || error instanceof BackupUnreadableError
                  ? error.message
                  : 'The restore did not finish. Your data is unchanged.',
              );
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }, [picked, preview, passphrase, router]);

  const canUnlock = picked !== null && passphrase.length > 0;
  const ready = preview?.verdict.canRestore === true;

  return (
    <FormScreen
      footer={
        <FormActions
          primaryLabel={ready ? 'Replace everything' : 'Open backup'}
          onPrimary={ready ? confirmRestore : unlock}
          primaryLoading={busy}
          primaryDisabled={!canUnlock}
          secondaryLabel="Cancel"
          onSecondary={leave}
        />
      }
    >
      <ScreenHeader
        title="Restore a backup"
        subtitle="Replaces everything currently on this device."
        onBack={leave}
      />

      <FormSection
        title="Choose the file"
        description="The .keeply file you saved when you exported."
      >
        <Button
          variant="secondary"
          icon="upload"
          title={picked === null ? 'Choose a backup file' : 'Choose a different file'}
          fullWidth
          onPress={choose}
        />
        {picked === null ? null : (
          <View style={styles.picked}>
            <Text variant="bodyStrong">{picked.name}</Text>
            {looksLikeBundle(picked.name) ? null : (
              // Not a refusal: the extension proves nothing either way, and a
              // file renamed by a cloud drive is still a good backup. Whether
              // it opens is decided by opening it.
              <Text variant="caption" color="textSecondary">
                That does not look like a Keeply backup, but Keeply will try.
              </Text>
            )}
          </View>
        )}
      </FormSection>

      <FormSection
        title="Unlock it"
        description="The passphrase you chose when you made this backup."
      >
        <TextField
          label="Passphrase"
          content="passphrase"
          value={passphrase}
          onChangeText={(next) => {
            setPassphrase(next);
            // What is on screen was read with the OLD passphrase. Leaving the
            // summary up while the field says something else would let a user
            // press Replace against a file they are no longer unlocking.
            setPreview(null);
          }}
          required
          disabled={picked === null}
          testID="restore-passphrase"
        />
      </FormSection>

      {preview === null ? null : (
        <FormSection title="What is in this backup">
          <Card>
            {preview.verdict.lines.map((line, index) => (
              <Text
                key={line}
                variant={index === 0 ? 'bodyStrong' : 'caption'}
                color={index === 0 ? 'text' : 'textSecondary'}
                style={index === 0 ? undefined : styles.line}
              >
                {line}
              </Text>
            ))}
          </Card>
          {preview.verdict.needsMigration ? (
            <Text variant="caption" color="textSecondary" style={styles.note}>
              It was made by an earlier version of Keeply. It will be brought up to date as it is
              restored.
            </Text>
          ) : null}
        </FormSection>
      )}

      {ready ? (
        <View style={styles.warning}>
          <Text variant="caption" color="danger">
            {restoreWarning(preview.report.counts)}
          </Text>
        </View>
      ) : null}

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
    icon: 'upload',
    title: 'This replaces, it does not merge',
    body: 'Everything currently in Keeply on this device is removed and the backup takes its place. Anything added since the backup was made is gone.',
  },
  {
    icon: 'photo',
    title: 'Photos do not come back',
    body: 'A backup carries your records, not the image files. Restored expenses and documents show their photo as unavailable.',
  },
  {
    icon: 'lock',
    title: 'Only the right passphrase opens it',
    body: 'There is no account and no server, so there is nothing to reset. If the passphrase is lost the file cannot be opened by anyone.',
  },
];

/**
 * One warning, in full.
 *
 * NOT a `<Row/>`: its subtitle is `numberOfLines={2}`, which is what truncated
 * the most important sentence on the export screen. A consequence that does
 * not fit is not a consequence the user agreed to.
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

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // A block owns the gap above itself, never below.
    picked: { marginTop: t.space.md, gap: 2 },
    line: { marginTop: t.space.xs },
    note: { marginTop: t.space.sm },
    warning: { marginTop: t.space.lg },
    failure: { marginTop: t.space.lg },
    caveat: { flexDirection: 'row', gap: t.space.md, alignItems: 'flex-start' },
    caveatNext: { marginTop: t.space.lg },
    caveatText: { flex: 1, gap: 2 },
  });
