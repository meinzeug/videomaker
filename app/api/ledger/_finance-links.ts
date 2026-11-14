import type Database from 'better-sqlite3';
import {ensureFinanceSchema} from '@/lib/finance-store';
import {ensureUgLedgerSchema} from '@/lib/ug-ledger';
import {ensureLedgerFinanceLinksSchema} from '@/lib/ug-ledger-finance-links';
export function ensureAllLedgerFinanceLinks(database:Database.Database){ensureFinanceSchema(database);ensureUgLedgerSchema(database);ensureLedgerFinanceLinksSchema(database);}
