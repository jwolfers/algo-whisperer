const express = require('express');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { pipeline } = require('stream/promises');
const { v4: uuidv4 } = require('uuid');
const { UPLOADS_DIR, isValidSessionId } = require('../lib/security');

const router = express.Router();

// In-memory store for active uploads (in production, use Redis or similar)
const activeUploads = new Map();

// Cleanup stale uploads after 1 hour
const UPLOAD_TIMEOUT_MS = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [uploadId, upload] of activeUploads) {
    if (now - upload.createdAt > UPLOAD_TIMEOUT_MS) {
      console.log(`Cleaning up stale upload: ${uploadId}`);
      cleanupChunks(uploadId);
      activeUploads.delete(uploadId);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// Initialize a chunked upload session
router.post('/upload/init', (req, res) => {
  const { filename, fileSize, totalChunks } = req.body;

  if (!filename || !fileSize || !totalChunks) {
    return res.status(400).json({ error: 'Missing required fields: filename, fileSize, totalChunks' });
  }

  // Validate file extension
  const ext = path.extname(filename).toLowerCase().slice(1);
  const allowedTypes = /^(mp4|mov|avi|mkv|webm)$/;
  if (!allowedTypes.test(ext)) {
    return res.status(400).json({ error: 'Invalid file type. Only video files are allowed.' });
  }

  const uploadId = uuidv4();
  const sessionId = uuidv4();
  const chunksDir = path.join(UPLOADS_DIR, `${uploadId}_chunks`);

  // Create chunks directory
  if (!fs.existsSync(chunksDir)) {
    fs.mkdirSync(chunksDir, { recursive: true });
  }

  // Store upload metadata
  activeUploads.set(uploadId, {
    uploadId,
    sessionId,
    originalFilename: filename,
    fileSize,
    totalChunks,
    receivedChunks: new Set(),
    chunksDir,
    ext,
    createdAt: Date.now(),
  });

  console.log(`=== Chunked Upload Initialized ===`);
  console.log(`Upload ID: ${uploadId}`);
  console.log(`Session ID: ${sessionId}`);
  console.log(`File: ${filename} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Total chunks: ${totalChunks}`);

  res.json({
    success: true,
    uploadId,
    sessionId,
  });
});

// Receive a chunk
router.post('/upload/chunk', express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
  const uploadId = req.headers['x-upload-id'];
  const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);

  if (!uploadId || isNaN(chunkIndex)) {
    return res.status(400).json({ error: 'Missing upload ID or chunk index' });
  }

  const upload = activeUploads.get(uploadId);
  if (!upload) {
    return res.status(404).json({ error: 'Upload not found or expired' });
  }

  if (chunkIndex < 0 || chunkIndex >= upload.totalChunks) {
    return res.status(400).json({ error: 'Invalid chunk index' });
  }

  // Save chunk to disk
  const chunkPath = path.join(upload.chunksDir, `chunk_${chunkIndex.toString().padStart(6, '0')}`);

  try {
    await fsPromises.writeFile(chunkPath, req.body);
    upload.receivedChunks.add(chunkIndex);

    const progress = (upload.receivedChunks.size / upload.totalChunks * 100).toFixed(1);
    console.log(`Chunk ${chunkIndex + 1}/${upload.totalChunks} received (${progress}%)`);

    res.json({
      success: true,
      chunkIndex,
      receivedChunks: upload.receivedChunks.size,
      totalChunks: upload.totalChunks,
    });
  } catch (error) {
    console.error(`Error saving chunk ${chunkIndex}:`, error);
    res.status(500).json({ error: 'Failed to save chunk' });
  }
});

// Complete the upload - assemble chunks into final file
router.post('/upload/complete', async (req, res) => {
  const { uploadId } = req.body;

  if (!uploadId) {
    return res.status(400).json({ error: 'Missing upload ID' });
  }

  const upload = activeUploads.get(uploadId);
  if (!upload) {
    return res.status(404).json({ error: 'Upload not found or expired' });
  }

  // Check all chunks received
  if (upload.receivedChunks.size !== upload.totalChunks) {
    const missing = [];
    for (let i = 0; i < upload.totalChunks; i++) {
      if (!upload.receivedChunks.has(i)) {
        missing.push(i);
      }
    }
    return res.status(400).json({
      error: 'Not all chunks received',
      receivedChunks: upload.receivedChunks.size,
      totalChunks: upload.totalChunks,
      missingChunks: missing.slice(0, 10), // Only return first 10 missing
    });
  }

  console.log(`=== Assembling ${upload.totalChunks} chunks ===`);
  const finalFilename = `${upload.sessionId}.${upload.ext}`;
  const finalPath = path.join(UPLOADS_DIR, finalFilename);

  try {
    // Assemble chunks into final file using streams (memory efficient)
    const writeStream = fs.createWriteStream(finalPath);

    for (let i = 0; i < upload.totalChunks; i++) {
      const chunkPath = path.join(upload.chunksDir, `chunk_${i.toString().padStart(6, '0')}`);
      const readStream = fs.createReadStream(chunkPath);
      await pipeline(readStream, writeStream, { end: false });
    }

    writeStream.end();

    // Get final file size
    const stats = await fsPromises.stat(finalPath);

    console.log(`=== Upload Complete ===`);
    console.log(`Session ID: ${upload.sessionId}`);
    console.log(`Final file: ${finalFilename}`);
    console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // Cleanup chunks
    await cleanupChunks(uploadId);
    activeUploads.delete(uploadId);

    res.json({
      success: true,
      sessionId: upload.sessionId,
      filename: finalFilename,
      path: `/uploads/${finalFilename}`,
      originalName: upload.originalFilename,
      size: stats.size,
    });
  } catch (error) {
    console.error('Error assembling chunks:', error);
    res.status(500).json({ error: 'Failed to assemble file' });
  }
});

// Get upload status (for resuming)
router.get('/upload/status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const upload = activeUploads.get(uploadId);

  if (!upload) {
    return res.status(404).json({ error: 'Upload not found or expired' });
  }

  res.json({
    success: true,
    uploadId,
    receivedChunks: Array.from(upload.receivedChunks),
    totalChunks: upload.totalChunks,
    complete: upload.receivedChunks.size === upload.totalChunks,
  });
});

// Cancel an upload
router.delete('/upload/:uploadId', async (req, res) => {
  const { uploadId } = req.params;
  const upload = activeUploads.get(uploadId);

  if (!upload) {
    return res.status(404).json({ error: 'Upload not found' });
  }

  await cleanupChunks(uploadId);
  activeUploads.delete(uploadId);

  console.log(`Upload ${uploadId} cancelled`);
  res.json({ success: true });
});

// Cleanup chunk files
async function cleanupChunks(uploadId) {
  const upload = activeUploads.get(uploadId);
  if (!upload) return;

  try {
    const files = await fsPromises.readdir(upload.chunksDir);
    for (const file of files) {
      await fsPromises.unlink(path.join(upload.chunksDir, file));
    }
    await fsPromises.rmdir(upload.chunksDir);
  } catch (error) {
    console.error(`Error cleaning up chunks for ${uploadId}:`, error.message);
  }
}

module.exports = router;
