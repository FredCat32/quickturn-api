# Migration Approval Request — `add_procedure_source_document`

## What This Migration Does

Currently when a PDF is uploaded to the QuickTurn API, the file is parsed and then discarded — nothing is saved. This migration adds a single new table (`ProcedureSourceDocument`) to track PDF uploads, their extraction status, and the resulting markdown. This is the foundation for the AI chatbot feature, allowing users to ask questions about procedures.

**No existing tables are modified. This migration is fully reversible with a single SQL statement.**

---

## Database Changes

### New Table: `ProcedureSourceDocument`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID | No | Primary key |
| `originalFileName` | Text | No | PDF filename as uploaded |
| `filePath` | Text | Yes | S3 object key — reserved for future S3 integration |
| `status` | Enum | No | Extraction progress: `PENDING` → `PROCESSING` → `COMPLETE` / `FAILED` |
| `contentMarkdown` | Text | Yes | Raw markdown output from docling PDF parser |
| `planeType` | Enum | Yes | Aircraft model (`PlaneType` enum) |
| `documentType` | Enum | Yes | Document category (`DocumentType` enum) |
| `tailNumber` | Text | Yes | Specific aircraft tail number (e.g. N12345) |
| `procedureTitle` | Text | Yes | Human-readable title for the procedure |
| `procedureId` | UUID | Yes | Links to the `Procedure` generated from this PDF |
| `documentId` | UUID | Yes | Links to the `Document` record used for vector search / chatbot |
| `organizationId` | UUID | Yes | Links to the `Organization` that owns this upload |
| `uploadedById` | UUID | Yes | Links to the `User` who uploaded the PDF |
| `createdAt` | Timestamp | No | |
| `updatedAt` | Timestamp | No | |

### New Enum: `ExtractionStatus`
Values: `PENDING`, `PROCESSING`, `COMPLETE`, `FAILED`

### Existing Enums Used
`PlaneType` and `DocumentType` were added to the schema by the dev team prior to this migration and are referenced here as foreign enum types.

### Existing Tables
The following models had Prisma back-references added so the ORM can navigate the relationship. **These generate no SQL — no columns are added to any existing table.**

| Table | Change |
|-------|--------|
| `Procedure` | Added `sourceDocuments` back-reference |
| `Document` | Added `procedureSourceDocs` back-reference |
| `Organization` | Added `procedureSourceDocs` back-reference |
| `User` | Added `uploadedProcedureDocs` back-reference |

---

## Rollback

If a rollback is needed, a single SQL statement removes all changes:

```sql
DROP TABLE "ProcedureSourceDocument";
```

No other tables are affected.

---

## Why a Dedicated Table vs Reusing `Document`

The existing `Document` table was considered. A dedicated table was chosen because:

- **Status tracking** — `PENDING → PROCESSING → COMPLETE / FAILED` lets the UI show progress during extraction
- **Aircraft type** — first-class field for filtering and reporting
- **Procedure link** — direct FK back to the `Procedure` generated from the PDF
- **S3 readiness** — `filePath` field is reserved for the planned S3 integration

The new table still links to `Document` via `documentId` so the existing vector search and chatbot pipeline is fully reused — no embedding infrastructure is duplicated.

---

*Schema file:* `C:\App\prisma\schema.prisma`  
*Migration has not been run — database is unchanged pending approval.*
