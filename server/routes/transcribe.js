const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { openai, loadPrompt, audioToDataUrl } = require('../lib/openai');
const { extractAudio, getAudioDuration, getFileSize, splitAudioIntoChunks } = require('../lib/ffmpeg');

// Hard limits for OpenAI transcription API (these always apply regardless of user settings)
const MAX_FILE_SIZE_MB = 24; // Stay under 25MB limit
const MAX_DURATION_SECONDS = 1200; // Stay under 1500 second (25 min) limit - using 20 min to be safe
const MAX_CHUNK_DURATION_SECONDS = 900; // Maximum 15 minutes per chunk (at 128kbps = ~14MB, safely under 25MB)
const CHUNK_OVERLAP_SECONDS = 30; // 30 second overlap to avoid cutting words
const DEFAULT_CHUNK_MINUTES = 4; // Default chunk size for parallel processing
const { safeUploadPath, isValidFilename, isValidSessionId, UPLOADS_DIR } = require('../lib/security');
const { aiRateLimit } = require('../lib/rate-limit');

const router = express.Router();

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const sessionId = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, `${sessionId}${ext}`);
  },
});

const upload = multer({
  storage,
  // No file size limit - let the system handle what it can
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|mov|avi|mkv|webm/;
    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    if (allowedTypes.test(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only video files are allowed.'));
    }
  },
});

// Upload video endpoint with error handling
router.post('/upload', (req, res, next) => {
  console.log('=== Video Upload Started ===');
  console.log('Content-Length:', req.headers['content-length']);

  // Handle multer upload with error catching
  upload.single('video')(req, res, (err) => {
    if (err) {
      console.error('=== Upload Error ===');
      console.error('Error type:', err.constructor.name);
      console.error('Error message:', err.message);
      console.error('Error code:', err.code);

      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large.' });
      }
      if (err.message === 'Invalid file type. Only video files are allowed.') {
        return res.status(400).json({ error: err.message });
      }
      return res.status(500).json({ error: `Upload failed: ${err.message}` });
    }

    if (!req.file) {
      console.log('Upload failed: No file received');
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const sessionId = path.basename(req.file.filename, path.extname(req.file.filename));

    console.log('=== Video Upload Complete ===');
    console.log('Session ID:', sessionId);
    console.log('Original name:', req.file.originalname);
    console.log('Size:', (req.file.size / 1024 / 1024).toFixed(2), 'MB');
    console.log('Saved as:', req.file.filename);

    res.json({
      success: true,
      sessionId,
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`,
      originalName: req.file.originalname,
      size: req.file.size,
    });
  });
});

// Transcribe video endpoint (rate limited - uses AI)
router.post('/transcribe', aiRateLimit, async (req, res) => {
  const { sessionId, filename, chunkMinutes } = req.body;

  if (!sessionId || !filename) {
    return res.status(400).json({ error: 'Missing sessionId or filename' });
  }

  // Validate inputs to prevent path traversal
  if (!isValidFilename(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const videoPath = safeUploadPath(filename);
  const audioPath = safeUploadPath(`${sessionId}.mp3`);

  if (!videoPath || !audioPath) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  const chunkFiles = []; // Track chunk files for cleanup

  try {
    // Extract audio from video
    console.log('Extracting audio from video...');
    await extractAudio(videoPath, audioPath);
    console.log('Audio extraction complete');

    // Check if we need to chunk the audio
    const audioDuration = await getAudioDuration(audioPath);
    const audioFileSize = getFileSize(audioPath);
    const audioFileSizeMB = audioFileSize / (1024 * 1024);

    console.log(`Audio duration: ${audioDuration.toFixed(1)} seconds (${(audioDuration / 60).toFixed(1)} minutes)`);
    console.log(`Audio file size: ${audioFileSizeMB.toFixed(2)} MB`);

    // Determine chunk duration: use user setting but cap at MAX_CHUNK_DURATION_SECONDS
    const userChunkMinutes = chunkMinutes || DEFAULT_CHUNK_MINUTES;
    const userChunkSeconds = userChunkMinutes * 60;
    const chunkDurationSeconds = Math.min(userChunkSeconds, MAX_CHUNK_DURATION_SECONDS);

    console.log(`Chunk duration setting: ${userChunkMinutes} minutes (${chunkDurationSeconds} seconds, max ${MAX_CHUNK_DURATION_SECONDS}s)`);

    // Always chunk if audio is long enough, or if it exceeds hard limits
    const exceedsHardLimits = audioDuration > MAX_DURATION_SECONDS || audioFileSizeMB > MAX_FILE_SIZE_MB;
    const benefitsFromParallel = audioDuration > chunkDurationSeconds * 1.5; // Chunk if > 1.5x chunk size
    const needsChunking = exceedsHardLimits || benefitsFromParallel;

    if (needsChunking) {
      if (exceedsHardLimits) {
        console.log(`Audio exceeds hard limits (duration: ${MAX_DURATION_SECONDS}s, size: ${MAX_FILE_SIZE_MB}MB) - will split into chunks`);
      } else {
        console.log(`Audio benefits from parallel processing - will split into ${chunkDurationSeconds/60} minute chunks`);
      }
    }

    // Load transcription config
    const config = loadPrompt('transcription.json');

    // Prepare known speaker references
    const knownSpeakerNames = config.known_speakers.map(s => s.name);
    const knownSpeakerReferences = [];

    for (const speaker of config.known_speakers) {
      const samplePath = path.join(__dirname, '../samples', speaker.sample_file);
      if (fs.existsSync(samplePath)) {
        knownSpeakerReferences.push(audioToDataUrl(samplePath));
      }
    }

    const model = req.body.model || 'gpt-4o-transcribe-diarize';
    let allSegments = [];
    let totalDuration = 0;

    if (needsChunking) {
      // Split audio into chunks
      const chunks = await splitAudioIntoChunks(
        audioPath,
        UPLOADS_DIR,
        chunkDurationSeconds,
        CHUNK_OVERLAP_SECONDS
      );

      console.log(`Split audio into ${chunks.length} chunks for parallel processing`);

      // Track chunk files for cleanup
      for (const chunk of chunks) {
        if (!chunk.isOriginal) {
          chunkFiles.push(chunk.path);
        }
      }

      // Log chunk info
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkSize = getFileSize(chunk.path);
        console.log(`Chunk ${i + 1}: ${chunk.startTime.toFixed(1)}s - ${chunk.endTime.toFixed(1)}s (${(chunkSize / (1024 * 1024)).toFixed(2)} MB)`);
      }

      // Transcribe all chunks in parallel
      console.log(`=== Starting parallel transcription of ${chunks.length} chunks ===`);
      const startTime = Date.now();

      const transcriptionPromises = chunks.map((chunk, i) => {
        console.log(`Launching transcription for chunk ${i + 1}/${chunks.length}`);
        return transcribeAudioFile(
          chunk.path,
          model,
          knownSpeakerNames,
          knownSpeakerReferences
        ).then(result => ({ index: i, chunk, result }));
      });

      const transcriptionResults = await Promise.all(transcriptionPromises);
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      console.log(`=== All ${chunks.length} chunks transcribed in ${elapsedSeconds.toFixed(1)}s ===`);

      // Sort results by chunk index and merge segments in order
      transcriptionResults.sort((a, b) => a.index - b.index);

      for (const { index, chunk, result } of transcriptionResults) {
        // Adjust segment timestamps to account for chunk offset
        const adjustedSegments = (result.segments || []).map(seg => ({
          ...seg,
          start: seg.start + chunk.startTime,
          end: seg.end + chunk.startTime,
        }));

        // Merge segments, handling overlap
        allSegments = mergeChunkSegments(allSegments, adjustedSegments, chunk.startTime, CHUNK_OVERLAP_SECONDS);
        totalDuration = Math.max(totalDuration, (result.duration || 0) + chunk.startTime);

        console.log(`Chunk ${index + 1} merged: ${adjustedSegments.length} segments`);
      }

      console.log(`Total segments after merging: ${allSegments.length}`);
    } else {
      // Single transcription for smaller files
      console.log('=== OpenAI Transcription API Call ===');
      console.log('Endpoint: POST /v1/audio/transcriptions');
      console.log('Model:', model);
      console.log('Response format: diarized_json');
      console.log('Chunking strategy: auto');
      console.log('Known speaker names:', knownSpeakerNames.join(', ') || 'none');
      console.log('Known speaker references:', knownSpeakerReferences.length, 'audio samples provided');
      console.log('Audio file:', audioPath);

      const transcription = await transcribeAudioFile(
        audioPath,
        model,
        knownSpeakerNames,
        knownSpeakerReferences
      );

      allSegments = transcription.segments || [];
      totalDuration = transcription.duration || audioDuration;

      console.log('=== OpenAI Transcription API Response ===');
      console.log('Segments received:', allSegments.length);
      console.log('Total duration:', totalDuration, 'seconds');
      console.log('Language detected:', transcription.language || 'unknown');
    }

    // Post-process to add speaker labels
    const processedTranscript = processTranscription({ segments: allSegments }, config);

    // Clean up audio file and any chunk files
    cleanupFiles([audioPath, ...chunkFiles]);

    res.json({
      success: true,
      transcript: processedTranscript,
      raw: { segments: allSegments, duration: totalDuration },
      chunked: needsChunking,
      chunksUsed: needsChunking ? Math.ceil(audioDuration / chunkDurationSeconds) : 1,
    });
  } catch (error) {
    console.error('Transcription error:', error);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    if (error.status) console.error('HTTP status:', error.status);
    if (error.code) console.error('Error code:', error.code);

    // Clean up audio file and any chunk files on error
    cleanupFiles([audioPath, ...chunkFiles]);

    // Provide more helpful error message
    let errorMessage = error.message;
    if (error.message.includes('timeout') || error.message.includes('Timeout')) {
      errorMessage = `Transcription timed out. The audio file may be too long. Try a shorter video.`;
    } else if (error.message.includes('too large') || error.message.includes('25 MB')) {
      errorMessage = `Audio file too large for transcription API. Try a shorter video.`;
    }

    res.status(500).json({ error: errorMessage });
  }
});

// Helper function to transcribe a single audio file
async function transcribeAudioFile(audioPath, model, knownSpeakerNames, knownSpeakerReferences) {
  const audioFile = fs.createReadStream(audioPath);

  const transcriptionParams = {
    file: audioFile,
    model: model,
    response_format: 'diarized_json',
    chunking_strategy: 'auto',
  };

  if (knownSpeakerNames.length > 0) {
    transcriptionParams.known_speaker_names = knownSpeakerNames;
  }
  if (knownSpeakerReferences.length > 0) {
    transcriptionParams.known_speaker_references = knownSpeakerReferences;
  }

  return await openai.audio.transcriptions.create(transcriptionParams);
}

// Merge segments from a new chunk, removing duplicates in overlap region
function mergeChunkSegments(existingSegments, newSegments, chunkStartTime, overlapSeconds) {
  if (existingSegments.length === 0) {
    return newSegments;
  }

  // Find where overlap region starts
  const overlapStart = chunkStartTime;

  // Remove segments from existing that fall within overlap region
  // These will be replaced by the new chunk's segments which are more accurate
  const filteredExisting = existingSegments.filter(seg => seg.end <= overlapStart + 1);

  // Add new segments that start after the overlap adjustment point
  const filteredNew = newSegments.filter(seg => seg.start >= overlapStart - 1);

  return [...filteredExisting, ...filteredNew];
}

// Clean up temporary files
function cleanupFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error(`Failed to clean up ${filePath}:`, err.message);
    }
  }
}

// Process transcription to normalize speaker labels
function processTranscription(transcription, config) {
  // gpt-4o-transcribe-diarize returns diarized_json format with speaker labels
  // Speaker labels may be known names or generic labels like "A:", "B:"
  const segments = transcription.segments || [];
  const unknownLabels = config.unknown_speaker_labels || ['Interviewer', 'Speaker A', 'Speaker B', 'Speaker C'];

  // Map generic speaker labels to more descriptive names
  const speakerMap = {};
  let unknownIndex = 0;

  return segments.map((segment, index) => {
    let speaker = segment.speaker || 'Unknown';

    // If speaker is a generic label like "A", "B", map it
    if (/^[A-Z]$/.test(speaker)) {
      if (!speakerMap[speaker]) {
        speakerMap[speaker] = unknownLabels[unknownIndex] || `Speaker ${speaker}`;
        unknownIndex++;
      }
      speaker = speakerMap[speaker];
    }

    return {
      id: index,
      start: segment.start,
      end: segment.end,
      text: segment.text,
      speaker: speaker,
    };
  });
}

module.exports = router;
