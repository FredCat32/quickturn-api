import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { readFile } from 'fs/promises'
import path from 'path'

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
})

const BUCKET = process.env.S3_BUCKET

export async function uploadPdfToS3(tmpPath, originalFileName) {
  const date = new Date().toISOString().slice(0, 10)
  const safeName = path.basename(originalFileName).replace(/[^a-zA-Z0-9._-]/g, '_')
  const key = `uploads/${date}/${Date.now()}-${safeName}`

  const fileBytes = await readFile(tmpPath)

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fileBytes,
    ContentType: 'application/pdf',
  }))

  return key
}
