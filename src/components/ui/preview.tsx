import { useMemo, useState } from 'react';
import { StyleSheet, View, type ListRenderItemInfo } from 'react-native';

import {
  formatDate,
  formatExpiry,
  formatMoney,
  formatRelativeDue,
  STATUS_KEYS,
  useTheme,
  useThemedStyles,
  useThemeMode,
  type ColorKey,
  type Theme,
  type ThemePreference,
  type TypeVariant,
} from '@/theme';

import type { MinorUnits } from '@/db';

import { Amount } from './amount';
import { AmountField } from './amount-field';
import { Badge, StatusPill, type BadgeTone } from './badge';
import { Button } from './button';
import { Card } from './card';
import { DateField } from './date-field';
import { Divider } from './divider';
import { EmptyState } from './empty-state';
import { FormActions, FormScreen, FormSection } from './form';
import { ErrorText, FieldLabel, HelperText } from './form-text';
import { Icon, ICONS, type IconName } from './icon';
import { List } from './list';
import { IconButton } from './icon-button';
import { parseAmountInput } from './money-input';
import { Row } from './row';
import { Screen } from './screen';
import { ScreenHeader } from './screen-header';
import { Section } from './section';
import { SegmentedField } from './segmented-field';
import { SelectField, type SelectOption } from './select-field';
import { Sheet } from './sheet';
import { Skeleton, SkeletonRow } from './skeleton';
import { SwitchField } from './switch-field';
import { Text } from './text';
import { TextField } from './text-field';

/**
 * Mint minor units for the fixtures below. `<Amount />` takes the branded
 * `MinorUnits` and nothing else, so a preview literal has to say so explicitly —
 * which is the point: a bare `1499` no longer compiles anywhere.
 */
const php = (centavos: number): MinorUnits => centavos as MinorUnits;

const TYPE_VARIANTS: readonly TypeVariant[] = [
  'display',
  'title',
  'heading',
  'subheading',
  'body',
  'bodyStrong',
  'label',
  'caption',
  'amountLg',
  'amountMd',
  'amountSm',
  'mono',
];

const SURFACE_KEYS: readonly ColorKey[] = [
  'bg',
  'bgElevated',
  'bgSunken',
  'surface',
  'surfaceAlt',
  'border',
  'borderStrong',
  'accent',
  'accentMuted',
  'success',
  'warning',
  'danger',
  'info',
];

const TONES: readonly BadgeTone[] = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'];

const PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** A fixed clock so the preview's relative-date copy never drifts. */
const NOW = new Date(2026, 7, 29);
const iso = (offsetDays: number): string => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const CATEGORIES: readonly SelectOption<string>[] = [
  { value: 'entertainment', label: 'Entertainment', hint: 'Streaming, games, music', icon: 'sparkle' },
  { value: 'utilities', label: 'Utilities', hint: 'Electricity, water, internet', icon: 'banknote' },
  { value: 'software', label: 'Software', hint: 'Tools and cloud storage', icon: 'doc' },
  { value: 'insurance', label: 'Insurance', icon: 'shield' },
  { value: 'transport', label: 'Transport', icon: 'car' },
  { value: 'health', label: 'Health', icon: 'person' },
  { value: 'education', label: 'Education', icon: 'folder' },
  { value: 'household', label: 'Household', icon: 'house' },
  { value: 'other', label: 'Other', icon: 'tag' },
];

/**
 * A SHORT option list. The case that proves a sheet sizes DOWN to its content
 * instead of stretching to fill the window.
 */
const PAYMENT_METHODS: readonly SelectOption<string>[] = [
  { value: 'cash', label: 'Cash', icon: 'banknote' },
  { value: 'card', label: 'Credit card', hint: 'Ends 4402', icon: 'creditcard' },
  { value: 'wallet', label: 'GCash', icon: 'wallet' },
];

/**
 * A LONG option list. The case that proves the sheet clamps at its `maxHeight`
 * and the list scrolls INSIDE it — and, past `SEARCH_THRESHOLD`, the case that
 * puts a search box and a keyboard over the same sheet.
 */
const PAYEES: readonly SelectOption<string>[] = [
  'Meralco', 'Maynilad', 'Manila Water', 'PLDT Home', 'Globe At Home', 'Converge',
  'Sky Cable', 'Cignal TV', 'Smart Postpaid', 'Globe Postpaid', 'DITO', 'Pag-IBIG',
  'PhilHealth', 'SSS', 'BIR', 'LTO', 'Prudential Life', 'Sun Life', 'Manulife',
  'AXA Philippines', 'BPI Credit Card', 'BDO Credit Card', 'Metrobank Card',
  'Security Bank', 'UnionBank', 'RCBC Bankard', 'HSBC Card', 'Citibank Card',
].map((name) => ({ value: name.toLowerCase().replace(/\s+/g, '-'), label: name }));

/** The §28 add-item menu, as DATA — so the sheet demo renders a real `<List/>`. */
interface RecordType {
  readonly key: string;
  readonly icon: IconName;
  readonly title: string;
  readonly subtitle: string;
}

const RECORD_TYPES: readonly RecordType[] = [
  { key: 'subscription', icon: 'repeat', title: 'Subscription', subtitle: 'Something that renews' },
  { key: 'bill', icon: 'banknote', title: 'Bill', subtitle: 'Electricity, water, internet' },
  { key: 'receipt', icon: 'receipt', title: 'Receipt', subtitle: 'Photograph and file it' },
  { key: 'vehicle', icon: 'fuel', title: 'Vehicle expense', subtitle: 'Fuel, repair, registration' },
  { key: 'document', icon: 'doc', title: 'Document', subtitle: 'Anything with an expiry date' },
];

const recordTypeKey = (item: RecordType): string => item.key;

const renderRecordType = ({ item }: ListRenderItemInfo<RecordType>) => (
  <Row icon={item.icon} title={item.title} subtitle={item.subtitle} onPress={() => {}} />
);

/**
 * Every surface in the system that OPENS, as one enumerable list.
 *
 * ── THE RULE THIS ENCODES ──────────────────────────────────────────────────
 * For anything that opens, expands or reveals, the render that proves it works
 * is the OPEN one. A closed `<SelectField/>` is a box with a chevron; it looks
 * identical whether the sheet behind it is perfect or renders nothing at all.
 * That is not hypothetical — it is exactly how a `<SelectField/>` that could not
 * display a single option shipped and survived a screenshot pass, because the
 * only capture of it was closed and the only preview of a sheet used plain
 * `<Row/>`s in a `<View/>` rather than the `<List/>` the real component uses.
 *
 * So: one piece of state drives every overlay here, each one is named, and each
 * is reachable in one tap. A screenshot pass walks this list; an automated one
 * sets `overlay` and needs to know nothing else.
 */
const OVERLAYS = [
  {
    key: 'select-short',
    title: 'Select · short list',
    subtitle: '3 options — the sheet must size to its content, not stretch',
  },
  {
    key: 'select-long',
    title: 'Select · long list',
    subtitle: `${PAYEES.length} options, no search — must scroll inside the sheet`,
  },
  {
    key: 'select-search',
    title: 'Select · searchable + keyboard',
    subtitle: 'Search box over a long list — the case most likely to regress',
  },
  { key: 'sheet-list', title: 'Sheet · list body', subtitle: 'A real <List/> inside a <Sheet/>' },
  {
    key: 'sheet-scroll',
    title: 'Sheet · scroll body',
    subtitle: 'Sheet scroll={true} with content taller than the sheet',
  },
] as const;

type Overlay = (typeof OVERLAYS)[number]['key'];

const CYCLES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
] as const;

/**
 * The inputs an amount field has to survive. Rendered live through
 * `parseAmountInput`, so this table is the real behaviour rather than a
 * description of it — if the parser regresses, the screen says so.
 */
const AMOUNT_CASES: readonly string[] = [
  '1499',
  '1,499.50',
  '1499.5',
  '1499.',
  '.',
  '.5',
  '0.01',
  '\u20b11,499.50',
  '1.499,50',
  '1499,50',
  '1,49,9',
  '1499.505',
  '1.2.3',
  '-250',
  '12abc',
  '99999999999999999999',
];

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, alignItems: 'center' },
    stack: { gap: t.space.sm },
    swatch: {
      width: 68,
      height: 44,
      borderRadius: t.radius.sm,
      borderWidth: t.hairline,
      borderColor: t.color.border,
    },
    swatchCell: { alignItems: 'center', gap: 2, width: 68 },
    listCard: { padding: 0, overflow: 'hidden' },
    typeRow: { paddingVertical: t.space.xs },
    emptyBox: {
      borderRadius: t.radius.lg,
      backgroundColor: t.color.surface,
      overflow: 'hidden',
    },
    kv: { flexDirection: 'row', justifyContent: 'space-between', gap: t.space.md },
    kvKey: { flex: 1 },
    fields: { gap: t.space.lg },
    sheetRows: { marginHorizontal: -t.space.lg },
    parseRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.sm,
      paddingVertical: 3,
    },
    parseIn: { flex: 1.1 },
    parseOut: { flex: 1, textAlign: 'right' },
  });

/**
 * Every primitive, every variant, every status — on one scrollable page.
 *
 * This is a development surface, not a route: it exists so the whole system can
 * be eyeballed in both themes at once and regressions are obvious. Toggle the
 * mode with the segmented control at the top.
 */
export function UIPreview() {
  const theme = useTheme();
  const { mode, preference, setPreference } = useThemeMode();
  const styles = useThemedStyles(makeStyles);
  const [loading, setLoading] = useState(false);
  const [showError, setShowError] = useState(true);

  /**
   * `'form'` swaps the gallery for a real `<FormScreen>`, which cannot be
   * nested inside this page's scroll view — two scrollers on one axis.
   */
  const [stage, setStage] = useState<'gallery' | 'form'>('gallery');
  /** Flip to `true` to capture the focused state of a field with a keyboard up. */
  const [focusDemo] = useState(false);

  const [name, setName] = useState('Netflix Premium');
  const [blank, setBlank] = useState('');
  const [plate, setPlate] = useState('NBC 1234');
  const [notes, setNotes] = useState('Shared family plan — four screens.');
  const [amount, setAmount] = useState<MinorUnits | null>(php(149950));
  const [amountBlank, setAmountBlank] = useState<MinorUnits | null>(null);
  const [due, setDue] = useState<string | null>(iso(3));
  const [dueBlank, setDueBlank] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>('entertainment');
  const [categoryBlank, setCategoryBlank] = useState<string | null>(null);
  const [cycle, setCycle] = useState<string>('monthly');
  const [method, setMethod] = useState<string | null>('card');
  const [payee, setPayee] = useState<string | null>(null);
  const [payeeSearch, setPayeeSearch] = useState<string | null>('meralco');
  const [remind, setRemind] = useState(true);
  const [autopay, setAutopay] = useState(false);

  /**
   * ONE piece of state for every overlay in the gallery — see `OVERLAYS`.
   * `openSeq` only exists so re-selecting the SAME overlay remounts the field
   * and reopens it: `<SelectField/>` owns its open state, and `defaultOpen`
   * seeds it at mount.
   */
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [openSeq, setOpenSeq] = useState(0);
  const showOverlay = (next: Overlay) => {
    setOverlay(next);
    setOpenSeq((n) => n + 1);
  };
  const closeOverlay = () => setOverlay(null);
  const overlayKey = `${overlay ?? 'none'}-${openSeq}`;

  const amountCases = useMemo(
    () => AMOUNT_CASES.map((input) => ({ input, parsed: parseAmountInput(input, { currency: 'PHP' }) })),
    [],
  );

  if (stage === 'form') {
    return (
      <FormScreen
        testID="ui-preview-form"
        onSubmit={() => setStage('gallery')}
        footer={
          <FormActions
            primaryLabel="Save subscription"
            primaryIcon="check"
            onPrimary={() => setStage('gallery')}
            secondaryLabel="Cancel"
            onSecondary={() => setStage('gallery')}
            destructiveLabel="Delete subscription"
            onDestructive={() => setStage('gallery')}
          />
        }>
        <ScreenHeader
          title="Add subscription"
          subtitle="FormScreen owns the keyboard: return-key order, scroll-to-field, and a footer that rides up."
          onBack={() => setStage('gallery')}
          backLabel="Back to the gallery"
        />
        <FormSection
          title="What renews"
          description="Field order follows how a subscription reads off a bank statement: what, how much, when.">
          <TextField
            label="Name"
            content="organization"
            required
            value={name}
            onChangeText={setName}
            placeholder="Netflix"
            autoFocus={focusDemo}
          />
          <AmountField label="Amount" required value={amount} onChangeValue={setAmount} />
          <SegmentedField
            label="Billing cycle"
            value={cycle}
            onChangeValue={setCycle}
            options={CYCLES}
          />
          <DateField label="Next renewal" required value={due} onChangeValue={setDue} />
          <SelectField
            label="Category"
            value={category}
            onChangeValue={setCategory}
            options={CATEGORIES}
            helper="Defaults to the one you used last."
          />
        </FormSection>
        <FormSection title="Reminders" footnote="Reminders are scheduled on this device. Nothing leaves it.">
          <SwitchField
            label="Remind me"
            description="A local notification three days before it renews."
            icon="bell"
            value={remind}
            onChangeValue={setRemind}
          />
          <SwitchField
            label="Autopay"
            description="Recorded for your reference only — Keeply never moves money."
            icon="repeat"
            value={autopay}
            onChangeValue={setAutopay}
          />
          <TextField
            label="Notes"
            content="notes"
            value={notes}
            onChangeText={setNotes}
            maxLength={200}
            showCount
          />
        </FormSection>
      </FormScreen>
    );
  }

  return (
    <Screen scroll testID="ui-preview">
      <ScreenHeader
        title="Keeply UI"
        subtitle={`${mode} mode · preference: ${preference}`}
        right={
          <IconButton
            name={mode === 'dark' ? 'sun' : 'moon'}
            accessibilityLabel="Toggle appearance"
            variant="tinted"
            onPress={() => setPreference(mode === 'dark' ? 'light' : 'dark')}
          />
        }
      />

      <Section title="Appearance" subtitle="ThemeProvider preference override">
        <View style={styles.wrap}>
          {PREFERENCES.map((p) => (
            <Button
              key={p}
              title={p}
              variant={preference === p ? 'primary' : 'secondary'}
              onPress={() => setPreference(p)}
            />
          ))}
        </View>
      </Section>

      <Section
        title="Open states"
        subtitle="An overlay is only proven by its OPEN render"
        footnote="Tap one, screenshot it, in both themes. A closed field proves nothing: it looks the same whether the sheet behind it works or renders nothing at all.">
        <Card style={styles.listCard}>
          {OVERLAYS.map((o) => (
            <Row
              key={o.key}
              icon="tray"
              title={o.title}
              subtitle={o.subtitle}
              onPress={() => showOverlay(o.key)}
              testID={`preview-overlay-${o.key}`}
            />
          ))}
        </Card>

        {/* The three selects live here, not in a scratch container: each one is
            the real component on the real code path, opened by the real state a
            tap sets. `key` remounts so `defaultOpen` takes effect again. */}
        <View style={styles.fields}>
          <SelectField
            key={`short-${overlayKey}`}
            label="Payment method"
            value={method}
            onChangeValue={setMethod}
            options={PAYMENT_METHODS}
            defaultOpen={overlay === 'select-short'}
            helper="Three options — the sheet should be short."
            testID="preview-select-short"
          />
          <SelectField
            key={`long-${overlayKey}`}
            label="Payee"
            value={payee}
            onChangeValue={setPayee}
            options={PAYEES}
            searchable={false}
            defaultOpen={overlay === 'select-long'}
            helper="Long, unsearchable — the list scrolls inside the sheet."
            testID="preview-select-long"
          />
          <SelectField
            key={`search-${overlayKey}`}
            label="Merchant"
            value={payeeSearch}
            onChangeValue={setPayeeSearch}
            options={PAYEES}
            defaultOpen={overlay === 'select-search'}
            helper="Search box plus a keyboard over the same sheet."
            testID="preview-select-search"
          />
        </View>
      </Section>

      <Section title="Typography" subtitle="theme.type">
        <Card>
          {TYPE_VARIANTS.map((variant) => (
            <View key={variant} style={styles.typeRow}>
              <Text variant="caption" color="textTertiary">
                {variant}
              </Text>
              <Text variant={variant}>
                {variant.startsWith('amount') ? '₱1,234,567.89' : 'Keeply ₱1,499 · 0123456789'}
              </Text>
            </View>
          ))}
        </Card>
      </Section>

      <Section title="Colour" subtitle="theme.color — every pair clears WCAG AA">
        <View style={styles.wrap}>
          {SURFACE_KEYS.map((key) => (
            <View key={key} style={styles.swatchCell}>
              <View style={[styles.swatch, { backgroundColor: theme.color[key] }]} />
              <Text variant="caption" color="textTertiary" numberOfLines={1}>
                {key}
              </Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="Status" subtitle="theme.status — the only source of state colour">
        <View style={styles.wrap}>
          {STATUS_KEYS.map((key) => (
            <StatusPill key={key} status={key} size="md" showIcon />
          ))}
        </View>
        <View style={[styles.wrap, { marginTop: theme.space.md }]}>
          {STATUS_KEYS.map((key) => (
            <StatusPill key={key} status={key} />
          ))}
        </View>
      </Section>

      <Section title="Badges" subtitle="Free-form chips">
        <View style={styles.wrap}>
          {TONES.map((tone) => (
            <Badge key={tone} label={tone} tone={tone} size="md" icon="tag" />
          ))}
        </View>
      </Section>

      <Section title="Buttons">
        <View style={styles.stack}>
          <View style={styles.wrap}>
            <Button title="Primary" onPress={() => {}} />
            <Button title="Secondary" variant="secondary" onPress={() => {}} />
            <Button title="Ghost" variant="ghost" onPress={() => {}} />
            <Button title="Danger" variant="danger" onPress={() => {}} />
            <Button title="Delete" variant="dangerGhost" icon="trash" onPress={() => {}} />
          </View>
          <Button title="Add subscription" size="lg" icon="plus" fullWidth onPress={() => {}} />
          <View style={styles.wrap}>
            <Button title="Loading" loading={loading} onPress={() => setLoading((v) => !v)} />
            <Button title="Disabled" disabled onPress={() => {}} />
            <Button title="Disabled" variant="secondary" disabled onPress={() => {}} />
          </View>
        </View>
      </Section>

      <Section title="Icon buttons">
        <View style={styles.wrap}>
          <IconButton name="plus" accessibilityLabel="Add" variant="filled" />
          <IconButton name="search" accessibilityLabel="Search" variant="tinted" />
          <IconButton name="ellipsis" accessibilityLabel="More" />
          <IconButton name="trash" accessibilityLabel="Delete" variant="danger" />
          <IconButton name="lock" accessibilityLabel="Lock" disabled />
        </View>
      </Section>

      <Section title="Icons" subtitle={`${Object.keys(ICONS).length} registered, iOS + Android`}>
        <View style={styles.wrap}>
          {(Object.keys(ICONS) as IconName[]).map((name) => (
            <Icon key={name} name={name} size={22} color="textSecondary" />
          ))}
        </View>
      </Section>

      <Section title="Amounts" subtitle="Integer minor units in, PHP out">
        <Card>
          <View style={styles.stack}>
            <Amount minor={php(1529900)} size="lg" />
            <Amount minor={php(54900)} size="md" />
            <Amount minor={php(189900)} size="sm" />
            <Amount minor={php(-54900)} signed />
            <Amount minor={php(320000)} signed />
            <Amount minor={php(1200000)} hideZeroDecimals />
            <Text variant="mono" color="textTertiary">
              formatMoney(154900) = {formatMoney(154900)}
            </Text>
          </View>
        </Card>
      </Section>

      <Section title="Rows" subtitle="44pt minimum, pressed state, trailing value">
        <Card style={styles.listCard}>
          <Row
            icon="creditcard"
            title="Netflix"
            subtitle={formatRelativeDue(iso(3), NOW)}
            value={<Amount minor={php(54900)} size="sm" />}
            onPress={() => {}}
          />
          <Divider />
          <Row
            icon="banknote"
            iconTint={theme.status.overdue.fg}
            title="Electricity"
            subtitle={formatRelativeDue(iso(-2), NOW)}
            value={<StatusPill status="overdue" />}
            valueCaption={formatMoney(345000)}
            onPress={() => {}}
          />
          <Divider />
          <Row
            icon="doc"
            title="Driver's License"
            subtitle={formatExpiry(iso(42), NOW)}
            value={<StatusPill status="expiringSoon" />}
            onPress={() => {}}
          />
          <Divider />
          <Row icon="repeat" title="Autopay" subtitle="No action needed" value="On" />
          <Divider />
          <Row icon="trash" title="Delete vehicle" destructive onPress={() => {}} />
          <Divider />
          <Row icon="lock" title="Disabled row" subtitle="Not available yet" disabled onPress={() => {}} />
        </Card>
      </Section>

      <Section title="Cards" subtitle="Fill only — no outline, no shadow">
        <View style={styles.stack}>
          <Card>
            <Text variant="label" color="textSecondary">
              THIS MONTH
            </Text>
            <Amount minor={php(1529900)} size="lg" />
            <Divider style={{ marginVertical: theme.space.md }} />
            <View style={styles.kv}>
              <Text color="textSecondary" style={styles.kvKey}>
                Subscriptions
              </Text>
              <Amount minor={php(149900)} size="sm" />
            </View>
            <View style={[styles.kv, { marginTop: theme.space.xs }]}>
              <Text color="textSecondary" style={styles.kvKey}>
                Bills
              </Text>
              <Amount minor={php(850000)} size="sm" />
            </View>
          </Card>
          <Card onPress={() => {}} accessibilityLabel="Open backups">
            <Text variant="bodyStrong">Pressable card</Text>
            <Text variant="caption" color="textSecondary">
              Tap to see the pressed surface.
            </Text>
          </Card>
          <Card flat>
            <Text variant="caption" color="textTertiary">
              Flat card — no fill either. For a card on a surface it would
              otherwise match, where a second fill would only read as a seam.
            </Text>
          </Card>
        </View>
      </Section>

      <Section
        title="Form fields"
        subtitle="Controlled, 44pt minimum, every state — empty, filled, error, disabled">
        <View style={styles.fields}>
          <TextField
            label="Name"
            content="organization"
            required
            value={name}
            onChangeText={setName}
            placeholder="Netflix"
            helper="Whatever you would recognise on a statement."
          />
          <TextField
            label="Email"
            content="email"
            value={blank}
            onChangeText={setBlank}
            placeholder="you@example.com"
            icon="person"
            clearable
          />
          <TextField
            label="Plate number"
            content="reference"
            value={plate}
            onChangeText={setPlate}
            helper="Uppercased, autocorrect off — a plate is not a word."
          />
          <TextField
            label="Provider"
            content="organization"
            required
            value=""
            onChangeText={() => {}}
            placeholder="Meralco"
            error="Enter who this bill is from."
          />
          <TextField
            label="Locked field"
            value="Cannot be edited"
            onChangeText={() => {}}
            disabled
            helper="Disabled: dimmed, sunken, and skipped by the return key."
          />
          <TextField
            label="Notes"
            content="notes"
            value={notes}
            onChangeText={setNotes}
            maxLength={200}
            showCount
          />
          {focusDemo ? (
            <TextField
              label="Focused"
              value={blank}
              onChangeText={setBlank}
              placeholder="The focus ring is an overlay — the layout never moves"
              autoFocus
            />
          ) : null}
        </View>
      </Section>

      <Section
        title="AmountField"
        subtitle="MinorUnits in, MinorUnits out — the only place text becomes money">
        <View style={styles.fields}>
          <AmountField
            label="Amount"
            required
            value={amount}
            onChangeValue={setAmount}
            helper="Grouped as you type. Stored as integer centavos."
          />
          <AmountField label="Amount" required value={amountBlank} onChangeValue={setAmountBlank} />
          <AmountField
            label="Amount"
            required
            value={amountBlank}
            onChangeValue={setAmountBlank}
            error="Enter an amount greater than zero."
          />
          <AmountField label="Amount" value={php(320000)} onChangeValue={() => {}} disabled />
        </View>
      </Section>

      <Section
        title="Amount parsing"
        subtitle="Live through parseAmountInput(). Left: what is typed or pasted. Right: the MinorUnits emitted, or why not."
        footnote="Nothing is rounded to make it fit. 1499.505 is refused rather than stored as 149950 or 149951.">
        <Card>
          {amountCases.map(({ input, parsed }) => (
            <View key={input} style={styles.parseRow}>
              <Text variant="mono" numberOfLines={1} style={styles.parseIn}>
                {JSON.stringify(input)}
              </Text>
              <Text
                variant="mono"
                color={parsed.problem === null ? 'text' : 'danger'}
                numberOfLines={2}
                style={styles.parseOut}>
                {parsed.problem === null ? String(parsed.minor) : parsed.problem}
              </Text>
            </View>
          ))}
        </Card>
      </Section>

      <Section title="DateField" subtitle="YYYY-MM-DD in and out — never a Date">
        <View style={styles.fields}>
          <DateField label="Next renewal" required value={due} onChangeValue={setDue} />
          <DateField
            label="Due date"
            required
            value={dueBlank}
            onChangeValue={setDueBlank}
            error="Pick the date this bill is due."
          />
          <DateField label="Purchased" value={iso(-400)} onChangeValue={() => {}} disabled />
        </View>
      </Section>

      <Section title="SelectField" subtitle="Opens a sheet; searchable past eight options">
        <View style={styles.fields}>
          <SelectField
            label="Category"
            value={category}
            onChangeValue={setCategory}
            options={CATEGORIES}
            helper="Defaults to the one you used last."
          />
          <SelectField
            label="Category"
            required
            value={categoryBlank}
            onChangeValue={setCategoryBlank}
            options={CATEGORIES}
            error="Choose a category."
          />
          <SelectField
            label="Vehicle"
            value="entertainment"
            onChangeValue={() => {}}
            options={CATEGORIES}
            disabled
          />
        </View>
      </Section>

      <Section title="SegmentedField" subtitle="Two to four choices, all visible, one tap">
        <View style={styles.fields}>
          <SegmentedField
            label="Billing cycle"
            value={cycle}
            onChangeValue={setCycle}
            options={CYCLES}
          />
          <SegmentedField
            label="Billing cycle"
            required
            value={cycle}
            onChangeValue={setCycle}
            options={CYCLES}
            error="Pick how often this renews."
          />
          <SegmentedField
            label="Billing cycle"
            value={cycle}
            onChangeValue={() => {}}
            options={CYCLES}
            disabled
          />
        </View>
      </Section>

      <Section title="SwitchField" subtitle="The whole row is the control, and one accessibility element">
        <Card>
          <SwitchField
            label="Remind me"
            description="A local notification three days before it renews."
            icon="bell"
            value={remind}
            onChangeValue={setRemind}
          />
          <Divider />
          <SwitchField
            label="Autopay"
            description="Recorded for your reference only — Keeply never moves money."
            icon="repeat"
            value={autopay}
            onChangeValue={setAutopay}
          />
          <Divider />
          <SwitchField
            label="App Lock"
            description="Needs a device passcode before it can be turned on."
            icon="lock"
            value={false}
            onChangeValue={() => {}}
            disabled
          />
          <Divider />
          <SwitchField
            label="Notifications"
            value={false}
            onChangeValue={() => {}}
            error="Keeply cannot schedule reminders until you allow notifications."
          />
        </Card>
      </Section>

      <Section title="Sheet + FormScreen" subtitle="The §28 add-item surfaces">
        <View style={styles.stack}>
          <Button
            title="Open bottom sheet"
            variant="secondary"
            icon="tray"
            fullWidth
            onPress={() => showOverlay('sheet-list')}
          />
          <Button
            title="Open the form screen"
            variant="secondary"
            icon="pencil"
            fullWidth
            onPress={() => setStage('form')}
          />
        </View>
      </Section>

      <Section title="FormActions" subtitle="Stacked by default; inline for a one-row sheet footer">
        <View style={styles.stack}>
          <FormActions
            primaryLabel="Save subscription"
            primaryIcon="check"
            onPrimary={() => {}}
            secondaryLabel="Cancel"
            onSecondary={() => {}}
            destructiveLabel="Delete subscription"
            onDestructive={() => {}}
          />
          <Divider style={{ marginVertical: theme.space.md }} />
          <FormActions
            layout="inline"
            primaryLabel="Save"
            onPrimary={() => {}}
            secondaryLabel="Cancel"
            onSecondary={() => {}}
          />
          <Divider style={{ marginVertical: theme.space.md }} />
          <FormActions primaryLabel="Saving" primaryLoading onPrimary={() => {}} />
          <FormActions primaryLabel="Save" primaryDisabled onPrimary={() => {}} />
        </View>
      </Section>

      <Section title="Form text" subtitle="FieldLabel · HelperText · ErrorText">
        <Card>
          <FieldLabel required accessory="PHP">
            Amount
          </FieldLabel>
          <HelperText>Stored in centavos. Formatted only for display.</HelperText>
          <ErrorText>{showError ? 'Enter an amount greater than zero.' : null}</ErrorText>
          <View style={{ marginTop: theme.space.md }}>
            <Button
              title={showError ? 'Clear error' : 'Show error'}
              variant="ghost"
              onPress={() => setShowError((v) => !v)}
            />
          </View>
        </Card>
      </Section>

      <Section title="Loading" subtitle="Skeleton placeholders">
        <Card style={styles.listCard}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow leading={false} />
        </Card>
        <View style={[styles.wrap, { marginTop: theme.space.md }]}>
          <Skeleton width={120} height={14} />
          <Skeleton shape="circle" height={44} />
          <Skeleton width={90} height={64} shape="block" />
        </View>
      </Section>

      <Section
        title="Empty state"
        subtitle="compact for a screen with more to say; hero only when emptiness IS the screen"
        footnote="A screen never stacks two heroes. Four of them was 1,665pt of placeholder on the More tab.">
        <View style={{ marginBottom: theme.space.lg }}>
          <EmptyState
            variant="compact"
            icon="receipt"
            title="No receipts yet"
            description="Photograph a receipt and it stays on this device — never uploaded."
            actionLabel="Add receipt"
            onAction={() => {}}
          />
        </View>
        <View style={styles.emptyBox}>
          <EmptyState
            icon="receipt"
            title="No receipts yet"
            description="Photograph a receipt and it stays on your phone — never uploaded. Add the amount and a category, and it counts towards this month's spending."
            actionLabel="Add receipt"
            onAction={() => {}}
            secondaryActionLabel="Import a backup"
            onSecondaryAction={() => {}}
            fill={false}
          />
        </View>
      </Section>

      <Section title="Formatters" subtitle="src/theme/format.ts, clock pinned to 29 Aug 2026">
        <Card>
          <View style={styles.stack}>
            <Text variant="mono">{formatDate(iso(0))}</Text>
            <Text variant="mono">{formatRelativeDue(iso(-2), NOW)}</Text>
            <Text variant="mono">{formatRelativeDue(iso(0), NOW)}</Text>
            <Text variant="mono">{formatRelativeDue(iso(1), NOW)}</Text>
            <Text variant="mono">{formatRelativeDue(iso(3), NOW)}</Text>
            <Text variant="mono">{formatExpiry(iso(42), NOW)}</Text>
            <Text variant="mono">{formatExpiry(iso(-1), NOW)}</Text>
            <Text variant="mono">{formatMoney(-54900)}</Text>
          </View>
        </Card>
      </Section>

      {/* ── A REAL `<List/>` IN A REAL `<Sheet/>` ──────────────────────────────
          This used to be five `<Row/>`s in a `<View/>`, which is not the
          composition any shipping sheet uses and is why a `<SelectField/>` whose
          list laid out at zero height inside a sheet was never caught here. The
          preview now renders what the components render. */}
      <Sheet
        visible={overlay === 'sheet-list'}
        onClose={closeOverlay}
        title="Add a record"
        subtitle="Drag the grabber down, tap the backdrop, or use Close — three ways out."
        testID="preview-sheet"
        footer={
          <FormActions
            layout="inline"
            primaryLabel="Add"
            primaryIcon="plus"
            onPrimary={closeOverlay}
            secondaryLabel="Cancel"
            onSecondary={closeOverlay}
          />
        }>
        <List<RecordType>
          data={RECORD_TYPES}
          renderItem={renderRecordType}
          keyExtractor={recordTypeKey}
          fill={false}
          style={styles.sheetRows}
          accessibilityLabel="Record types"
        />
      </Sheet>

      {/* `scroll` puts the body in a ScrollView instead. Content deliberately
          taller than the sheet's `maxHeightRatio`, so the clamp and the scroll
          are both visible rather than assumed. */}
      <Sheet
        visible={overlay === 'sheet-scroll'}
        onClose={closeOverlay}
        scroll
        title="Sheet scroll"
        subtitle="A body taller than the sheet — it clamps, then scrolls."
        testID="preview-sheet-scroll">
        <View style={styles.stack}>
          {TYPE_VARIANTS.map((variant) => (
            <View key={variant} style={styles.typeRow}>
              <Text variant="caption" color="textTertiary">
                {variant}
              </Text>
              <Text variant={variant} numberOfLines={1}>
                Keeply ₱1,499
              </Text>
            </View>
          ))}
        </View>
      </Sheet>
    </Screen>
  );
}

export default UIPreview;
