-- Offline migration input for remove-legacy-finance.py only.
-- Do not execute this file directly: the runner locks the database, verifies
-- every legacy table is empty, and creates a verified backup before applying it.
DROP TABLE IF EXISTS ug_ledger_finance_unlink_requests;
DROP TABLE IF EXISTS ug_ledger_finance_link_requests;
DROP TABLE IF EXISTS ug_ledger_finance_unlinks;
DROP TABLE IF EXISTS ug_ledger_finance_links;
DROP TABLE IF EXISTS ug_ledger_document_unlinks;
DROP TABLE IF EXISTS ug_ledger_document_links;
DROP TABLE IF EXISTS ug_ledger_journals;
DROP TABLE IF EXISTS ug_ledger_accounts;
DROP TABLE IF EXISTS finance_documents;
DROP TABLE IF EXISTS finance_settings_events;
DROP TABLE IF EXISTS finance_entries;
