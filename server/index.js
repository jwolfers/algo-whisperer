require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { openai } = require('./lib/openai');
const { cleanupOldFiles, cleanupSession, getUploadStats } = require('./lib/cleanup');
const { isValidSessionId } = require('./lib/security');
const { apiRateLimit, readRateLimit } = require('./lib/rate-limit');

// Environment check
const isProduction = process.env.NODE_ENV === 'production';

// Settings file paths
const settingsPath = path.join(__dirname, 'settings.json');
const defaultsPath = path.join(__dirname, 'defaults.json');
const promptsLibraryPath = path.join(__dirname, 'prompts-library.json');

const transcribeRoutes = require('./routes/transcribe');
const generateRoutes = require('./routes/generate');
const extractFramesRoutes = require('./routes/extract-frames');
const chunkedUploadRoutes = require('./routes/chunked-upload');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
// In production, set ALLOWED_ORIGINS env variable to restrict access
// e.g., ALLOWED_ORIGINS=https://yourdomain.com,https://app.yourdomain.com
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null; // null means allow all (development mode)

const corsOptions = allowedOrigins
  ? {
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
    }
  : {}; // Empty options = allow all origins

// Middleware
// Security headers (helmet)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow loading images from blob URLs
}));

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

// Apply rate limiting BEFORE routes
app.use('/api', apiRateLimit);

// Increase server timeout for large file uploads (10 minutes)
app.use((req, res, next) => {
  res.setTimeout(600000); // 10 minutes
  next();
});
app.use(express.static(path.join(__dirname, '../public')));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// API Routes
app.use('/api', transcribeRoutes);
app.use('/api', generateRoutes);
app.use('/api', extractFramesRoutes);
app.use('/api', chunkedUploadRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Get current settings
app.get('/api/settings', async (req, res) => {
  try {
    const data = await fsPromises.readFile(settingsPath, 'utf8');
    const settings = JSON.parse(data);
    res.json({ success: true, settings });
  } catch (error) {
    // If settings file doesn't exist, return defaults
    try {
      const data = await fsPromises.readFile(defaultsPath, 'utf8');
      const defaults = JSON.parse(data);
      res.json({ success: true, settings: defaults });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load settings' });
    }
  }
});

// Validate settings object
function validateSettings(settings) {
  const errors = [];

  // Check that settings is an object
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { valid: false, errors: ['Settings must be an object'] };
  }

  // Define allowed fields and their types/constraints
  const allowedFields = {
    numTitles: { type: 'number', min: 1, max: 100 },
    numDescriptions: { type: 'number', min: 1, max: 20 },
    numThumbnailTitles: { type: 'number', min: 1, max: 100 },
    numFrames: { type: 'number', min: 1, max: 100 },
    transcriptionModel: { type: 'string', maxLength: 100 },
    chatModel: { type: 'string', maxLength: 100 },
    visionModel: { type: 'string', maxLength: 100 },
    imageDetail: { type: 'string', allowed: ['low', 'high', 'auto'] },
    chunkMinutes: { type: 'number', min: 1, max: 15 },
  };

  // Check for unknown fields
  for (const key of Object.keys(settings)) {
    if (!allowedFields[key]) {
      errors.push(`Unknown setting: ${key}`);
    }
  }

  // Validate each field
  for (const [key, constraints] of Object.entries(allowedFields)) {
    if (settings[key] === undefined) continue;

    const value = settings[key];

    if (constraints.type === 'number') {
      if (typeof value !== 'number' || isNaN(value)) {
        errors.push(`${key} must be a number`);
      } else {
        if (constraints.min !== undefined && value < constraints.min) {
          errors.push(`${key} must be at least ${constraints.min}`);
        }
        if (constraints.max !== undefined && value > constraints.max) {
          errors.push(`${key} must be at most ${constraints.max}`);
        }
      }
    } else if (constraints.type === 'string') {
      if (typeof value !== 'string') {
        errors.push(`${key} must be a string`);
      } else {
        if (constraints.maxLength && value.length > constraints.maxLength) {
          errors.push(`${key} must be at most ${constraints.maxLength} characters`);
        }
        if (constraints.allowed && !constraints.allowed.includes(value)) {
          errors.push(`${key} must be one of: ${constraints.allowed.join(', ')}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// Save settings
app.post('/api/settings', async (req, res) => {
  try {
    const settings = req.body;

    // Validate settings
    const validation = validateSettings(settings);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid settings', details: validation.errors });
    }

    await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    console.log('Settings saved:', settings);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Get default settings
app.get('/api/settings/defaults', async (req, res) => {
  try {
    const data = await fsPromises.readFile(defaultsPath, 'utf8');
    const defaults = JSON.parse(data);
    res.json({ success: true, defaults });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load defaults' });
  }
});

// Reset settings to defaults
app.post('/api/settings/reset', async (req, res) => {
  try {
    const data = await fsPromises.readFile(defaultsPath, 'utf8');
    const defaults = JSON.parse(data);
    await fsPromises.writeFile(settingsPath, JSON.stringify(defaults, null, 2));
    console.log('Settings reset to defaults');
    res.json({ success: true, settings: defaults });
  } catch (error) {
    console.error('Error resetting settings:', error);
    res.status(500).json({ error: 'Failed to reset settings' });
  }
});

// ============== PROMPTS LIBRARY API ==============

// Get all prompts
app.get('/api/prompts', async (req, res) => {
  try {
    const data = await fsPromises.readFile(promptsLibraryPath, 'utf8');
    const library = JSON.parse(data);
    res.json({ success: true, library });
  } catch (error) {
    console.error('Error loading prompts:', error);
    res.status(500).json({ error: 'Failed to load prompts' });
  }
});

// Get prompts for a specific type (metadata, vision, transcription)
app.get('/api/prompts/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const data = await fsPromises.readFile(promptsLibraryPath, 'utf8');
    const library = JSON.parse(data);

    if (!library[type]) {
      return res.status(404).json({ error: `Prompt type '${type}' not found` });
    }

    res.json({
      success: true,
      type,
      active: library[type].active,
      prompts: library[type].prompts,
    });
  } catch (error) {
    console.error('Error loading prompts:', error);
    res.status(500).json({ error: 'Failed to load prompts' });
  }
});

// Set active prompt for a type
app.post('/api/prompts/:type/active', async (req, res) => {
  try {
    const { type } = req.params;
    const { promptId } = req.body;
    const data = await fsPromises.readFile(promptsLibraryPath, 'utf8');
    const library = JSON.parse(data);

    if (!library[type]) {
      return res.status(404).json({ error: `Prompt type '${type}' not found` });
    }

    if (!library[type].prompts[promptId]) {
      return res.status(404).json({ error: `Prompt '${promptId}' not found` });
    }

    library[type].active = promptId;
    await fsPromises.writeFile(promptsLibraryPath, JSON.stringify(library, null, 2));

    console.log(`Active prompt for ${type} set to: ${promptId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error setting active prompt:', error);
    res.status(500).json({ error: 'Failed to set active prompt' });
  }
});

// Add new prompt
app.post('/api/prompts/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { id, prompt } = req.body;
    const data = await fsPromises.readFile(promptsLibraryPath, 'utf8');
    const library = JSON.parse(data);

    if (!library[type]) {
      return res.status(404).json({ error: `Prompt type '${type}' not found` });
    }

    if (library[type].prompts[id]) {
      return res.status(400).json({ error: `Prompt '${id}' already exists` });
    }

    library[type].prompts[id] = prompt;
    await fsPromises.writeFile(promptsLibraryPath, JSON.stringify(library, null, 2));

    console.log(`Added new prompt '${id}' for ${type}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error adding prompt:', error);
    res.status(500).json({ error: 'Failed to add prompt' });
  }
});

// Update existing prompt
app.put('/api/prompts/:type/:promptId', async (req, res) => {
  try {
    const { type, promptId } = req.params;
    const { prompt } = req.body;
    const data = await fsPromises.readFile(promptsLibraryPath, 'utf8');
    const library = JSON.parse(data);

    if (!library[type]) {
      return res.status(404).json({ error: `Prompt type '${type}' not found` });
    }

    if (!library[type].prompts[promptId]) {
      return res.status(404).json({ error: `Prompt '${promptId}' not found` });
    }

    library[type].prompts[promptId] = prompt;
    await fsPromises.writeFile(promptsLibraryPath, JSON.stringify(library, null, 2));

    console.log(`Updated prompt '${promptId}' for ${type}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating prompt:', error);
    res.status(500).json({ error: 'Failed to update prompt' });
  }
});

// Delete prompt
app.delete('/api/prompts/:type/:promptId', async (req, res) => {
  try {
    const { type, promptId } = req.params;
    const data = await fsPromises.readFile(promptsLibraryPath, 'utf8');
    const library = JSON.parse(data);

    if (!library[type]) {
      return res.status(404).json({ error: `Prompt type '${type}' not found` });
    }

    if (!library[type].prompts[promptId]) {
      return res.status(404).json({ error: `Prompt '${promptId}' not found` });
    }

    // Don't allow deleting the last prompt
    if (Object.keys(library[type].prompts).length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last prompt' });
    }

    // If deleting the active prompt, switch to another one
    if (library[type].active === promptId) {
      const remainingIds = Object.keys(library[type].prompts).filter(id => id !== promptId);
      library[type].active = remainingIds[0];
    }

    delete library[type].prompts[promptId];
    await fsPromises.writeFile(promptsLibraryPath, JSON.stringify(library, null, 2));

    console.log(`Deleted prompt '${promptId}' from ${type}`);
    res.json({ success: true, newActive: library[type].active });
  } catch (error) {
    console.error('Error deleting prompt:', error);
    res.status(500).json({ error: 'Failed to delete prompt' });
  }
});

// ============== MODELS API ==============

// List available OpenAI models
app.get('/api/models', async (req, res) => {
  try {
    console.log('=== OpenAI Models API Call ===');
    console.log('Endpoint: GET /v1/models');

    const response = await openai.models.list();

    console.log('=== OpenAI Models API Response ===');
    console.log('Total models returned:', response.data?.length || 0);

    // Filter to GPT models (gpt-X.Y format) for chat/responses
    // Sort from latest to earliest (reverse alphabetical puts higher versions first)
    const gptModels = response.data
      .filter(m => /^gpt-\d/.test(m.id))
      .map(m => m.id)
      .sort()
      .reverse();

    // Find the latest chat model (ends with -chat-latest) and put it first
    const latestChatIndex = gptModels.findIndex(m => m.endsWith('-chat-latest'));
    if (latestChatIndex > 0) {
      const latestChat = gptModels.splice(latestChatIndex, 1)[0];
      gptModels.unshift(latestChat);
    }

    // Filter transcription models
    const transcriptionModels = response.data
      .filter(m => m.id.includes('transcribe') || m.id.includes('whisper'))
      .map(m => m.id)
      .sort();

    // Vision-capable models (gpt-4o, gpt-4.1, etc.)
    const visionModels = response.data
      .filter(m => /^gpt-(4o|4\.1|4\.5|5)/.test(m.id) && !m.id.includes('audio'))
      .map(m => m.id)
      .sort();

    console.log('GPT models:', gptModels.length);
    console.log('Transcription models:', transcriptionModels.length);
    console.log('Vision models:', visionModels.length);

    res.json({
      success: true,
      models: {
        chat: gptModels,
        transcription: transcriptionModels,
        vision: visionModels,
      },
    });
  } catch (error) {
    console.error('Models list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============== CLEANUP API ==============

// Get upload statistics
app.get('/api/uploads/stats', (req, res) => {
  try {
    const stats = getUploadStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error getting upload stats:', error);
    res.status(500).json({ error: 'Failed to get upload stats' });
  }
});

// Clean up a specific session's files
app.delete('/api/uploads/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const result = cleanupSession(sessionId);
    console.log(`Cleaned up session ${sessionId}:`, result);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error cleaning up session:', error);
    res.status(500).json({ error: 'Failed to clean up session' });
  }
});

// Clean up old files (files older than specified hours, default 24)
app.post('/api/uploads/cleanup', (req, res) => {
  const { maxAgeHours = 24 } = req.body;
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  try {
    const result = cleanupOldFiles(maxAgeMs);
    console.log('Cleanup completed:', result);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error during cleanup:', error);
    res.status(500).json({ error: 'Failed to clean up files' });
  }
});

// Automatic cleanup every 6 hours (cleanup files older than 24 hours)
setInterval(() => {
  console.log('Running automatic file cleanup...');
  const result = cleanupOldFiles(24 * 60 * 60 * 1000);
  if (result.deletedFiles > 0 || result.errors.length > 0) {
    console.log('Automatic cleanup result:', result);
  }
}, 6 * 60 * 60 * 1000);

// Global error handler
app.use((err, req, res, next) => {
  // Log error details in development, minimal in production
  if (isProduction) {
    console.error('Error:', err.message);
  } else {
    console.error('Error:', err);
  }

  // Don't leak error details in production
  res.status(err.status || 500).json({
    error: isProduction ? 'Internal server error' : err.message,
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (isProduction) {
    console.log('Running in production mode');
  }
});

// Graceful shutdown handling
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
