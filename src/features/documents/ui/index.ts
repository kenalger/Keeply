/**
 * The documents feature's UI barrel (Phase 6).
 *
 * Screens import from here; nothing under `src/app` reaches into a file inside
 * this directory. Same contract as every other feature's.
 */
export {
  DOCUMENT_TYPE_DESCRIPTIONS,
  DOCUMENT_TYPE_ICONS,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPE_OPTIONS,
  EXPIRY_BUCKET_LABELS,
  EXPIRY_BUCKET_STATUS,
  describeDaysLeft,
  describeDocument,
} from './labels';
export {
  useDocument,
  useDocumentList,
  useExpiringDocuments,
  useExpirySummary,
  type AsyncStatus,
  type AsyncValue,
  type DocumentListView,
  type TypeFilter,
} from './hooks';
export {
  describeExpiry,
  groupByExpiry,
  type ExpirySection,
  type GroupableDocument,
  type GroupedDocument,
} from './grouping';
export { removeDocument, saveDocumentPatch, saveNewDocument } from './mutations';
export { DocumentForm } from './document-form';
export { DocumentFile } from './document-file';
export { useDocumentAttach, type DocumentAttach } from './attach';
export {
  DocumentStorageError,
  documentFileExists,
  storeDocumentFile,
  strayDocumentFiles,
  unlinkOrphanedFile,
  type StoredDocumentFile,
} from './storage';
