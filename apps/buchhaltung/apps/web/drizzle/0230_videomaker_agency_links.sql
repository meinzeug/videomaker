-- Agenturzuordnung ist Zusatzmetadatum; Buchungssätze und Belegdateien bleiben unverändert.
CREATE TABLE videomaker_agency_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('channel', 'project', 'platform')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 80),
  target_name text NOT NULL CHECK (length(target_name) BETWEEN 1 AND 160),
  target_platform text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT videomaker_agency_exact_subject CHECK (
    num_nonnulls(document_id, invoice_id, journal_entry_id) = 1
  ),
  CONSTRAINT videomaker_agency_target_platform CHECK (
    (target_kind = 'project' AND target_platform IS NULL) OR
    (target_kind IN ('channel', 'platform') AND target_platform IS NOT NULL AND length(target_platform) BETWEEN 1 AND 80)
  ),
  CONSTRAINT videomaker_agency_unique_target UNIQUE NULLS NOT DISTINCT
    (document_id, invoice_id, journal_entry_id, target_kind, target_id)
);
--> statement-breakpoint
CREATE INDEX videomaker_agency_document ON videomaker_agency_links(document_id) WHERE document_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX videomaker_agency_invoice ON videomaker_agency_links(invoice_id) WHERE invoice_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX videomaker_agency_journal ON videomaker_agency_links(journal_entry_id) WHERE journal_entry_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER videomaker_agency_links_audit AFTER INSERT OR UPDATE OR DELETE ON videomaker_agency_links
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
