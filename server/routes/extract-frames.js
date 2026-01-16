const express = require('express');
const path = require('path');
const fs = require('fs');
const { openai, imageToDataUrl } = require('../lib/openai');
const { extractFrames } = require('../lib/ffmpeg');
const { safeUploadPath, safeFramesPath, isValidFilename, isValidSessionId } = require('../lib/security');
const { aiRateLimit } = require('../lib/rate-limit');

// Load prompts from library
const promptsLibraryPath = path.join(__dirname, '../prompts-library.json');
function getActiveVisionPrompt() {
  const library = JSON.parse(fs.readFileSync(promptsLibraryPath, 'utf8'));
  const activeId = library.vision.active;
  return library.vision.prompts[activeId];
}

const router = express.Router();

// Extract frames from video
router.post('/extract-frames', async (req, res) => {
  const { sessionId, filename, numFrames } = req.body;

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
  const framesDir = safeFramesPath(sessionId);

  if (!videoPath || !framesDir) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  try {
    // Create frames directory
    if (!fs.existsSync(framesDir)) {
      fs.mkdirSync(framesDir, { recursive: true });
    }

    // Extract frames
    console.log(`Extracting ${numFrames || 24} frames from video...`);
    const frames = await extractFrames(videoPath, framesDir, numFrames || 24);
    console.log('Frame extraction complete');

    // Return frame info
    res.json({
      success: true,
      frames: frames.map(f => ({
        ...f,
        url: `/uploads/${sessionId}_frames/${f.filename}`,
      })),
    });
  } catch (error) {
    console.error('Frame extraction error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Analyze frames with GPT Vision (rate limited - uses AI)
router.post('/analyze-frames', aiRateLimit, async (req, res) => {
  const { sessionId, frames, settings } = req.body;

  if (!sessionId || !frames || frames.length === 0) {
    return res.status(400).json({ error: 'Missing sessionId or frames' });
  }

  // Validate session ID
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const framesDir = safeFramesPath(sessionId);
  if (!framesDir) {
    return res.status(400).json({ error: 'Invalid session path' });
  }

  try {
    // Load thumbnail analysis prompts from library
    const prompts = getActiveVisionPrompt();
    const model = settings?.visionModel || 'gpt-4o'; // Default to latest vision model
    const imageDetail = settings?.imageDetail || 'auto'; // low, high, or auto

    // Convert frames to base64 for API
    const imageContents = frames.map((frame, index) => {
      // Validate each frame filename
      if (!isValidFilename(frame.filename)) {
        throw new Error(`Invalid frame filename: ${frame.filename}`);
      }
      const framePath = path.join(framesDir, frame.filename);
      const dataUrl = imageToDataUrl(framePath);
      return {
        type: 'image_url',
        image_url: {
          url: dataUrl,
          detail: imageDetail, // Control image processing detail level
        },
      };
    });

    // Build the message with all images
    const userContent = [
      { type: 'text', text: `${prompts.analysis_prompt}\n\nI'm sending you ${frames.length} frames numbered 1 through ${frames.length}. Rank ALL frames from best to worst for thumbnail potential.` },
      ...imageContents,
    ];

    console.log('=== OpenAI Vision API Call ===');
    console.log('Endpoint: POST /v1/chat/completions (with vision)');
    console.log('Model:', model);
    console.log('Image detail:', imageDetail);
    console.log('Number of frames:', frames.length);
    console.log('Max tokens: 2000');

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: prompts.system_prompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: 2000,
    });

    console.log('=== OpenAI Vision API Response ===');
    console.log('Model used:', response.model);
    console.log('Usage:', JSON.stringify(response.usage || {}));
    console.log('Finish reason:', response.choices[0]?.finish_reason);

    // Parse the response to get ranked frames
    const analysisText = response.choices[0].message.content;
    console.log('Analysis text length:', analysisText?.length || 0, 'characters');
    console.log('Analysis preview:', analysisText?.substring(0, 200) + '...');

    // Extract frame numbers from the response
    // The API should return something like "Top frames: 5, 12, 3, ..."
    const rankedFrameNumbers = extractRankedFrames(analysisText, 12, frames.length);
    console.log('Ranked frame numbers:', rankedFrameNumbers.join(', '));

    // Map to actual frame data
    const rankedFrames = rankedFrameNumbers.map(num => {
      const frame = frames.find(f => f.index === num);
      return frame || frames[num - 1]; // Fallback to index if not found
    }).filter(Boolean);

    res.json({
      success: true,
      rankedFrames,
      analysis: analysisText,
    });
  } catch (error) {
    console.error('Frame analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Extract ranked frame numbers from GPT response
function extractRankedFrames(text, count, totalFrames = 24) {
  // First, try to find a RANKING: line with comma-separated numbers
  const rankingMatch = text.match(/RANKING:\s*([\d,\s]+)/i);
  if (rankingMatch) {
    const numbers = rankingMatch[1].match(/\d+/g);
    if (numbers) {
      const seen = new Set();
      const validNumbers = numbers
        .map(n => parseInt(n, 10))
        .filter(n => n >= 1 && n <= totalFrames && !seen.has(n) && seen.add(n));
      if (validNumbers.length >= count) {
        return validNumbers.slice(0, count);
      }
    }
  }

  // Fallback: Look for numbers in the response
  const numbers = text.match(/\d+/g);
  if (!numbers) return Array.from({ length: count }, (_, i) => i + 1);

  // Filter to valid frame numbers (1 to totalFrames) and dedupe
  const seen = new Set();
  const validNumbers = numbers
    .map(n => parseInt(n, 10))
    .filter(n => n >= 1 && n <= totalFrames && !seen.has(n) && seen.add(n));

  // Return requested count
  return validNumbers.slice(0, count);
}

// Serve individual frame
router.get('/frames/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;

  // Validate inputs
  if (!isValidSessionId(sessionId) || !isValidFilename(filename)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const framesDir = safeFramesPath(sessionId);
  if (!framesDir) {
    return res.status(400).json({ error: 'Invalid session' });
  }

  const framePath = path.join(framesDir, filename);

  if (fs.existsSync(framePath)) {
    res.sendFile(framePath);
  } else {
    res.status(404).json({ error: 'Frame not found' });
  }
});

module.exports = router;
