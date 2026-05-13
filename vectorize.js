import pool from './db.js'

const BACKEND_GRAPHQL_URL = process.env.BACKEND_GRAPHQL_URL || 'http://localhost:4000/graphql'
const STATIC_API_TOKEN = process.env.STATIC_API_TOKEN
const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID ?? null

// These document types get sent to the GPU for step extraction.
// All others are saved as markdown only (for AI/chatbot use).
const STEP_EXTRACTION_TYPES = new Set(['MAINTENANCE_REQUIREMENT_CARD', 'NAVY_IETM'])

export function requiresStepExtraction(documentType) {
  return STEP_EXTRACTION_TYPES.has(documentType)
}

export async function saveMarkdownAndVector({
  originalFileName,
  markdown,
  organizationId = null,
  planeType = null,
  documentType = null,
  tailNumber = null,
  procedureTitle = null,
  procedureId = null,
  uploadedById = null,
  filePath = null,
  extraMetadata = null,
}) {
  // Insert the source document record and begin processing
  const resolvedUploadedById = uploadedById ?? SYSTEM_USER_ID

  const insertResult = await pool.query(
    `INSERT INTO "ProcedureSourceDocument"
       (id, "originalFileName", "filePath", status, "contentMarkdown",
        "planeType", "documentType", "tailNumber", "procedureTitle",
        "organizationId", "uploadedById", "procedureId", "createdAt", "updatedAt")
     VALUES
       (gen_random_uuid(), $1, $2, 'PROCESSING', $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
     RETURNING id`,
    [originalFileName, filePath, markdown, planeType, documentType, tailNumber, procedureTitle, organizationId, resolvedUploadedById, procedureId]
  )

  const sourceDocId = insertResult.rows[0].id
  let documentId = null

  // Ingest into vector DB via backend — requires org + token to be configured
  if (organizationId && STATIC_API_TOKEN) {
    try {
      const title = procedureTitle || originalFileName
      const gqlResponse = await fetch(BACKEND_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${STATIC_API_TOKEN}`,
        },
        body: JSON.stringify({
          query: `mutation IngestDocument($input: IngestDocumentInput!) {
            ingestDocument(input: $input) { id }
          }`,
          variables: {
            input: {
              organizationId,
              title,
              contentMarkdown: markdown,
              planeType,
              documentType,
              metadata: extraMetadata,
            },
          },
        }),
      })

      const gqlData = await gqlResponse.json()
      documentId = gqlData?.data?.ingestDocument?.id ?? null

      if (documentId) {
        await pool.query(
          `UPDATE "ProcedureSourceDocument" SET "documentId" = $1, status = 'COMPLETE', "updatedAt" = now() WHERE id = $2`,
          [documentId, sourceDocId]
        )
      } else {
        const msg = `ingestDocument returned no id: ${JSON.stringify(gqlData?.errors)}`
        console.warn(msg)
        await pool.query(
          `UPDATE "ProcedureSourceDocument" SET status = 'FAILED', "errorMessage" = $1, "updatedAt" = now() WHERE id = $2`,
          [msg, sourceDocId]
        )
      }
    } catch (err) {
      console.error('Vector ingest failed:', err.message)
      await pool.query(
        `UPDATE "ProcedureSourceDocument" SET status = 'FAILED', "errorMessage" = $1, "updatedAt" = now() WHERE id = $2`,
        [err.message, sourceDocId]
      )
    }
  } else {
    // No org or token — save markdown but skip vector embedding
    await pool.query(
      `UPDATE "ProcedureSourceDocument" SET status = 'COMPLETE', "updatedAt" = now() WHERE id = $1`,
      [sourceDocId]
    )
  }

  return { sourceDocId, documentId }
}
