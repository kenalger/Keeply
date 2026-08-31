/**
 * Return-key order for a form, solved once.
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 * The return key on a mobile keyboard is a navigation control, and the default
 * — every field saying "return", every submit dismissing the keyboard — costs
 * a tap-and-a-half per field. Getting it right by hand means a `ref` per input,
 * a `returnKeyType` that knows whether it is last, and a `submitBehavior` that
 * does not blur before the next field can take focus. Nobody does that per
 * screen, so nobody does it at all.
 *
 * ── HOW IT WORKS ───────────────────────────────────────────────────────────
 * `<FormScreen>` provides a tiny external store. Every focusable field
 * registers itself on mount, in mount order — which, for the static field
 * lists forms are made of, is document order — and reads the roster back
 * through `useSyncExternalStore`. The return key then says "next" until the
 * last field, where it says "done" and runs the form's submit.
 *
 * The roster is an external store rather than provider state on purpose: a
 * field registering in an effect would otherwise have to `setState` on its
 * parent during mount, cascading a re-render through every other field on the
 * screen. `useSyncExternalStore` is exactly the escape hatch for
 * "subscribe to something outside React", and it keeps the field's own
 * position readable during render, where `returnKeyType` needs it.
 *
 * A field that unmounts leaves the roster cleanly; positions renumber, because
 * they are derived from the array rather than captured at registration.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { Keyboard, type ReturnKeyTypeOptions, type SubmitBehavior } from 'react-native';

/**
 * A field's own input ref, and nothing else.
 *
 * The roster holds REFS rather than callbacks on purpose: a callback would
 * have to be built during render and would capture something, and reading
 * `.current` to build it is exactly the render-phase ref access React's rules
 * forbid. A ref object is stable from the first render, so the entry's
 * identity is too, and the actual `focus()` happens later — in an event
 * handler, where reading a ref is what refs are for.
 */
export type FormFocusEntry = RefObject<{ focus: () => void } | null>;

type Listener = () => void;

export interface FormFocusStore {
  /** Join the roster. Returns the function that leaves it. */
  register: (entry: FormFocusEntry) => () => void;
  subscribe: (listener: Listener) => () => void;
  /** Stable between changes, so `useSyncExternalStore` does not loop. */
  getEntries: () => readonly FormFocusEntry[];
  /** Focus the next registered field. `false` when `entry` is the last one. */
  advanceFrom: (entry: FormFocusEntry) => boolean;
  /** What the last field's return key does. */
  submit: () => void;
  /**
   * "This input just took focus — make sure it is visible."
   *
   * `FormScreen` answers by scrolling the input clear of the keyboard and of
   * its own pinned footer. RN's `ScrollView` does not do this on its own: it
   * exposes `scrollResponderScrollNativeHandleToKeyboard` and waits to be
   * asked, which is why so many RN forms leave the field you are typing in
   * underneath the keyboard.
   */
  reveal: (node: unknown) => void;
}

const EMPTY_ENTRIES: readonly FormFocusEntry[] = [];

/**
 * What a field talks to outside a `<FormScreen>`: a store that accepts
 * registrations and does nothing with them, so a field used on its own behaves
 * like a plain input instead of throwing.
 */
const DETACHED_STORE: FormFocusStore = {
  register: () => () => undefined,
  subscribe: () => () => undefined,
  getEntries: () => EMPTY_ENTRIES,
  advanceFrom: () => false,
  submit: () => undefined,
  reveal: () => undefined,
};

const FormFocusContext = createContext<FormFocusStore>(DETACHED_STORE);

interface MutableStore extends FormFocusStore {
  setSubmit: (fn: (() => void) | undefined) => void;
  setReveal: (fn: ((node: unknown) => void) | undefined) => void;
}

function createStore(): MutableStore {
  let entries: readonly FormFocusEntry[] = EMPTY_ENTRIES;
  const listeners = new Set<Listener>();
  let submitFn: (() => void) | undefined;
  let revealFn: ((node: unknown) => void) | undefined;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    register(entry) {
      entries = [...entries, entry];
      emit();
      return () => {
        entries = entries.filter((candidate) => candidate !== entry);
        emit();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getEntries: () => entries,
    advanceFrom(entry) {
      const at = entries.indexOf(entry);
      const next = at === -1 ? undefined : entries[at + 1];
      if (next === undefined) return false;
      next.current?.focus();
      return true;
    },
    submit: () => submitFn?.(),
    reveal: (node) => revealFn?.(node),
    setSubmit(fn) {
      submitFn = fn;
    },
    setReveal(fn) {
      revealFn = fn;
    },
  };
}

export interface FormFocusProviderProps {
  children: ReactNode;
  /** Run when the return key is pressed on the last field. */
  onSubmit?: () => void;
  /** Bring a newly focused input into view. */
  onReveal?: (node: unknown) => void;
}

export function FormFocusProvider({ children, onSubmit, onReveal }: FormFocusProviderProps) {
  // Lazy initial state, not a ref written during render: the store must exist
  // before the first child renders, and must never be rebuilt.
  const [store] = useState(createStore);

  // The callbacks change identity every render; the store must not, or every
  // field would resubscribe. Swap the functions inside it instead.
  useEffect(() => {
    store.setSubmit(onSubmit);
    store.setReveal(onReveal);
  }, [store, onSubmit, onReveal]);

  return <FormFocusContext.Provider value={store}>{children}</FormFocusContext.Provider>;
}

/**
 * Ends the enclosing form's return-key order for its subtree.
 *
 * A `<Sheet/>` opened *from* a field is not part of that field's form: the
 * search box inside a `SelectField`'s sheet must not become step four of the
 * form behind it, and its "next" must not focus something the user cannot see.
 */
export function FormFocusBoundary({ children }: { children: ReactNode }) {
  return <FormFocusContext.Provider value={DETACHED_STORE}>{children}</FormFocusContext.Provider>;
}

export interface FieldOrderOptions {
  /** The field's own input ref. Focused when the previous field says "next". */
  inputRef: FormFocusEntry;
  /** Skip registration — a disabled field is not a stop on the way through. */
  enabled?: boolean;
  /** Caller's override. Wins over the computed value. */
  returnKeyType?: ReturnKeyTypeOptions;
  /** Caller's override. Replaces advance-or-submit entirely. */
  onSubmitEditing?: () => void;
}

export interface FieldOrder {
  /** Tell the form this field has the keyboard, so it can scroll it into view. */
  reveal: (node: unknown) => void;
  returnKeyType: ReturnKeyTypeOptions;
  /**
   * `'submit'` while there is somewhere to go, so the keyboard never dips
   * between two fields; `'blurAndSubmit'` on the last one, so it retracts.
   */
  submitBehavior: SubmitBehavior;
  onSubmitEditing: () => void;
  /** True when there is a following field to jump to. */
  hasNext: boolean;
}

/**
 * Wire one input into the form's return-key order.
 *
 * Outside a `<FormScreen>` this degrades to a plain "done" key that dismisses
 * the keyboard, so a field is never broken by being used on its own.
 */
export function useFieldOrder({
  inputRef,
  enabled = true,
  returnKeyType,
  onSubmitEditing,
}: FieldOrderOptions): FieldOrder {
  const store = useContext(FormFocusContext);
  const entry = inputRef;

  useEffect(() => {
    if (!enabled) return;
    return store.register(entry);
  }, [store, entry, enabled]);

  const entries = useSyncExternalStore(store.subscribe, store.getEntries, store.getEntries);
  const index = entries.indexOf(entry);
  const hasNext = index >= 0 && index < entries.length - 1;

  const handleSubmit = useCallback(() => {
    if (onSubmitEditing !== undefined) {
      onSubmitEditing();
      return;
    }
    if (store.advanceFrom(entry)) return;
    Keyboard.dismiss();
    store.submit();
  }, [onSubmitEditing, store, entry]);

  const reveal = useCallback(
    (node: unknown) => {
      store.reveal(node);
    },
    [store],
  );

  return {
    reveal,
    returnKeyType: returnKeyType ?? (hasNext ? 'next' : 'done'),
    submitBehavior: hasNext ? 'submit' : 'blurAndSubmit',
    onSubmitEditing: handleSubmit,
    hasNext,
  };
}
