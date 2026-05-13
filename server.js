import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { unlink } from 'fs/promises'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { saveMarkdownAndVector, requiresStepExtraction } from './vectorize.js'
import { uploadPdfToS3 } from './s3.js'
import pool from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)

const app = express()
app.use(cors())
app.use(express.json())

const upload = multer({ dest: os.tmpdir() })

const DOCLING_SCRIPT = path.resolve(__dirname, 'scripts/parse.py')
const PYTHON = process.env.PYTHON_PATH || 'python'
const GPU_EC2_URL = process.env.GPU_EC2_URL

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// ---------------------------------------------------------------------------
// POST /documents/markdown
// Called by docling / GPU EC2 to save extracted markdown and trigger vectorization.
//
// Body (JSON):
// {
//   "markdown":         string  — required
//   "originalFileName": string  — required
//   "organizationId":   uuid
//   "planeType":        string  — e.g. "E_2D_ADVANCED_HAWKEYE"
//   "documentType":     string  — e.g. "MAINTENANCE_REQUIREMENT_CARD"
//   "tailNumber":       string  — e.g. "N12345"
//   "procedureTitle":   string
//   "procedureId":      uuid
//   "uploadedById":     uuid
//   "filePath":         string
//   "metadata":         object
// }
// ---------------------------------------------------------------------------
app.post('/documents/markdown', async (req, res) => {
  const {
    markdown,
    originalFileName,
    organizationId = null,
    planeType = null,
    documentType = null,
    tailNumber = null,
    procedureTitle = null,
    procedureId = null,
    uploadedById = null,
    filePath = null,
    metadata: extraMetadata = null,
  } = req.body

  if (!markdown || !originalFileName) {
    return res.status(400).json({ error: '`markdown` and `originalFileName` are required' })
  }

  try {
    const { sourceDocId, documentId } = await saveMarkdownAndVector({
      originalFileName,
      markdown,
      organizationId,
      planeType,
      documentType,
      tailNumber,
      procedureTitle,
      procedureId,
      uploadedById,
      filePath,
      extraMetadata,
    })

    res.status(201).json({
      sourceDocId,
      documentId,
      message: 'Markdown saved and vectorized successfully',
    })
  } catch (err) {
    console.error('POST /documents/markdown error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// GET /documents/:id
// ---------------------------------------------------------------------------
app.get('/documents/:id', async (req, res) => {
  const { id } = req.params

  try {
    const result = await pool.query(
      `SELECT
         id, "originalFileName", "filePath", status,
         "contentMarkdown", "planeType", "documentType", "tailNumber", "procedureTitle",
         "organizationId", "uploadedById", "procedureId", "documentId",
         "createdAt", "updatedAt"
       FROM "ProcedureSourceDocument"
       WHERE id = $1`,
      [id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' })
    }

    res.json(result.rows[0])
  } catch (err) {
    console.error('GET /documents/:id error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// GET /documents
// Query params: organizationId, planeType, documentType, tailNumber, procedureId
// ---------------------------------------------------------------------------
app.get('/documents', async (req, res) => {
  const { organizationId, planeType, documentType, tailNumber, procedureId } = req.query

  const conditions = []
  const values = []

  if (organizationId) { conditions.push(`"organizationId" = $${values.push(organizationId)}`) }
  if (planeType)      { conditions.push(`"planeType"      = $${values.push(planeType)}`) }
  if (documentType)   { conditions.push(`"documentType"   = $${values.push(documentType)}`) }
  if (tailNumber)     { conditions.push(`"tailNumber"     = $${values.push(tailNumber)}`) }
  if (procedureId)    { conditions.push(`"procedureId"    = $${values.push(procedureId)}`) }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const result = await pool.query(
      `SELECT
         id, "originalFileName", status, "planeType", "documentType", "tailNumber",
         "procedureTitle", "organizationId", "uploadedById", "procedureId",
         "documentId", "createdAt", "updatedAt"
       FROM "ProcedureSourceDocument"
       ${where}
       ORDER BY "createdAt" DESC`,
      values
    )

    res.json(result.rows)
  } catch (err) {
    console.error('GET /documents error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// POST /upload
// Accepts a PDF + form fields, runs docling, saves to DB, optionally sends
// to GPU EC2 for step extraction (MRC and NAVY_IETM types only).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GET /organizations
// Returns id + name for all organizations — used to populate the upload form.
// ---------------------------------------------------------------------------
app.get('/organizations', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name FROM "Organization" WHERE "deletedAt" IS NULL ORDER BY name ASC`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET /organizations error:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/upload', upload.single('pdf'), async (req, res) => {
  const tmpPath = req.file?.path

  if (!tmpPath) {
    return res.status(400).json({ error: 'No PDF file provided' })
  }

  const { planeType, documentType, organizationId, tailNumber, procedureTitle, uploadedById, procedureId } = req.body

  try {
    // 1. Run Docling — parse PDF into markdown
    console.log(`Parsing PDF: ${req.file.originalname}`)
    const { stdout } = await execFileAsync(PYTHON, [DOCLING_SCRIPT, tmpPath])

    const parsed = JSON.parse(stdout)
    if (parsed.error) {
      return res.status(500).json({ error: `Docling failed: ${parsed.error}` })
    }

    const { markdown } = parsed
    console.log(`Docling done — ${markdown.length} chars of markdown`)

    // 2. Upload raw PDF to S3 (best-effort — don't fail the request if S3 is unavailable)
    let s3Key = null
    if (process.env.AWS_ACCESS_KEY_ID && process.env.S3_BUCKET) {
      try {
        s3Key = await uploadPdfToS3(tmpPath, req.file.originalname)
        console.log(`PDF uploaded to S3: ${s3Key}`)
      } catch (s3Err) {
        console.error('S3 upload failed (non-fatal):', s3Err.message)
      }
    }

    // 3. Save markdown + trigger vector embedding (best-effort)
    let sourceDocId = null
    let documentId = null
    try {
      ;({ sourceDocId, documentId } = await saveMarkdownAndVector({
        originalFileName: req.file.originalname,
        markdown,
        planeType: planeType || null,
        documentType: documentType || null,
        organizationId: organizationId || null,
        tailNumber: tailNumber || null,
        procedureTitle: procedureTitle || null,
        uploadedById: uploadedById || null,
        procedureId: procedureId || null,
        filePath: s3Key,
      }))
      console.log(`Saved — sourceDocId: ${sourceDocId}, documentId: ${documentId}`)
    } catch (dbErr) {
      console.error('DB save failed (non-fatal):', dbErr.message)
    }

    // 4. MRC and NAVY_IETM → send to GPU for step extraction
    //    All other types → return markdown only (stored for AI/chatbot use)
    if (GPU_EC2_URL && requiresStepExtraction(documentType)) {
      console.log(`Sending to GPU EC2: ${GPU_EC2_URL}`)
      const gpuResponse = await fetch(`${GPU_EC2_URL}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown,
          metadata: { planeType, documentType, organizationId, fileName: req.file.originalname }
        })
      })

      if (!gpuResponse.ok) {
        return res.status(502).json({ error: 'GPU processing failed' })
      }

      const procedure = await gpuResponse.json()
      return res.json({ procedure, sourcePdfName: req.file.originalname, sourceDocId, documentId })
    }

    // Markdown-only response (GPU not configured, or doc type doesn't need step extraction)
    res.json({ markdown, sourcePdfName: req.file.originalname, sourceDocId, status: 'docling_only' })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  } finally {
    if (tmpPath) await unlink(tmpPath).catch(() => {})
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`quickturn-api running on http://localhost:${PORT}`))
