/**
 * Keeply — the documents feature's barrel (Phase 6).
 *
 * The only module here that touches `@/db`. Everything else in this directory
 * loads in plain Node, which is what lets `node --test` run the SQL, the
 * validation and §15's ladder without a simulator.
 *
 * `withTransaction()` rather than drizzle's `db.transaction()`: the latter
 * dispatches `begin`/`commit` without awaiting, so an async body runs after
 * COMMIT and a throw never rolls back. `KeeplyDatabase` omits the method so it
 * will not compile, and eslint bans the member name outside `src/db`.
 */
import { getDb, newId, nowMs, withTransaction, type KeeplyDatabase } from '@/db';
import { bindStatement } from '@/features/subscriptions';
import { todayCalendarString } from '@/theme/format';

import { createDocumentsApi } from './queries';
import type { DocumentStore, SqlStatement } from './store';

/** A store over one drizzle handle. Same shape as every other feature's. */
function storeFor(db: KeeplyDatabase, inTransaction: boolean): DocumentStore {
  return {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.all<TRow>(bindStatement(statement));
    },
    async execute(statement: SqlStatement): Promise<void> {
      await db.run(bindStatement(statement));
    },
    async atomically<T>(body: (store: DocumentStore) => Promise<T>): Promise<T> {
      // Already inside one: op-sqlite serialises transactions through a lock
      // queue, so an inner transaction would wait forever for a slot the outer
      // one holds. Compose by passing the transaction-bound store down.
      if (inTransaction) return body(storeFor(db, true));
      return withTransaction((tx) => body(storeFor(tx, true)));
    },
  };
}

/** The live store, resolved lazily so importing this module never opens the db. */
const liveStore: DocumentStore = {
  all: (statement) => storeFor(getDb(), false).all(statement),
  execute: (statement) => storeFor(getDb(), false).execute(statement),
  atomically: (body) => storeFor(getDb(), false).atomically(body),
};

/** A documents API over an arbitrary store. */
export function documentsApiFor(store: DocumentStore) {
  return createDocumentsApi({
    store,
    newId,
    nowMs,
    todayISO: () => todayCalendarString(),
  });
}

const api = documentsApiFor(liveStore);

export const {
  listDocuments,
  getDocument,
  createDocument,
  answerRenewal,
  updateDocument,
  deleteDocument,
  expirySummary,
  expiringDocuments,
  referencedFileUris,
} = api;

export { liveStore as liveDocumentStore };

export { createDocumentsApi, documentReminderEntity, mapDocumentRow } from './queries';
export type { DocumentsApi, DocumentsApiDeps, DocumentWriteResult } from './queries';
export type { DocumentStore, SqlStatement, SqlValue } from './store';
export { validateDocumentPatch, validateNewDocument } from './validation';
export type { ValidatedDocument } from './validation';
export {
  ACCEPTED_MIME_TYPES,
  extensionForMimeType,
  extensionOfUri,
  isAcceptedMimeType,
  isImageMimeType,
  resolveDocumentMimeType,
  type DocumentMimeType,
} from './file-types';
export {
  EXPIRY_BUCKETS,
  daysUntilExpiry,
  expiryBucket,
  needsAttention,
  type ExpiryBucket,
} from './expiry';
export {
  DEFAULT_PAGE_SIZE,
  DOCUMENT_NUMBER_MAX_LENGTH,
  DOCUMENT_TYPES,
  DocumentError,
  MAX_PAGE_SIZE,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  TYPE_LIST_IS_COMPLETE,
  isDocumentType,
} from './types';
export type {
  DocumentErrorCode,
  DocumentExpirySummary,
  DocumentFilter,
  DocumentPage,
  DocumentPatch,
  DocumentRecord,
  DocumentSort,
  DocumentType,
  NewDocumentInput,
} from './types';

export {
  RENEWAL_SNOOZE_DAYS,
  canOfferRenewal,
  patchForAnswer,
  shouldPrompt,
  shouldPromptForRenewal,
  type RenewalAnswer,
  type RenewalPatch,
  type RenewalSubject,
} from './renewal';
export {
  DOCUMENT_RENEWAL_STATES,
  isDocumentRenewalState,
  type DocumentRenewalState,
} from './types';
