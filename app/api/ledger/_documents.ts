import type Database from 'better-sqlite3';
import {ensureFinanceSchema} from '@/lib/finance-store';
import {ensureFinanceDocumentsSchema} from '@/lib/finance-documents';
import {ensureUgLedgerSchema} from '@/lib/ug-ledger';
import {ensureLedgerDocumentsSchema} from '@/lib/ug-ledger-documents';
export function ensureAllLedgerDocuments(database:Database.Database){ensureFinanceSchema(database);ensureFinanceDocumentsSchema(database);ensureUgLedgerSchema(database);ensureLedgerDocumentsSchema(database);}
