const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 10 * 60 * 1000, // 10 minutes timeout for large file transcriptions
});

// Load prompt configurations from legacy prompts folder
function loadPrompt(promptFile) {
  const promptPath = path.join(__dirname, '../../prompts', promptFile);
  return JSON.parse(fs.readFileSync(promptPath, 'utf8'));
}

// Load active prompt from prompts library
function loadActivePrompt(type) {
  const libraryPath = path.join(__dirname, '../prompts-library.json');
  const library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));

  if (!library[type]) {
    throw new Error(`Prompt type '${type}' not found in prompts library`);
  }

  const activeId = library[type].active;
  const activePrompt = library[type].prompts[activeId];

  if (!activePrompt) {
    throw new Error(`Active prompt '${activeId}' not found for type '${type}'`);
  }

  return activePrompt;
}

// Convert audio file to base64 data URL
function audioToDataUrl(filePath) {
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeType = ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  return `data:${mimeType};base64,${base64}`;
}

// Convert image file to base64 data URL
function imageToDataUrl(filePath) {
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mimeType};base64,${base64}`;
}

// Parse OpenAI errors into user-friendly messages
function parseOpenAIError(error) {
  const errorMessage = error?.message || error?.error?.message || String(error);
  const errorCode = error?.code || error?.error?.code || error?.status;

  // Insufficient funds / billing errors
  if (
    errorMessage.includes('insufficient_quota') ||
    errorMessage.includes('billing') ||
    errorMessage.includes('exceeded your current quota') ||
    errorMessage.includes('insufficient funds') ||
    errorCode === 'insufficient_quota' ||
    error?.status === 429 && errorMessage.includes('quota')
  ) {
    return {
      userMessage: 'OpenAI API quota exceeded. Please add funds to your OpenAI account.',
      billingUrl: 'https://platform.openai.com/account/billing',
      isBillingError: true,
      originalError: errorMessage,
    };
  }

  // Rate limit errors (not billing related)
  if (error?.status === 429 || errorCode === 'rate_limit_exceeded') {
    return {
      userMessage: 'OpenAI API rate limit reached. Please wait a moment and try again.',
      isBillingError: false,
      originalError: errorMessage,
    };
  }

  // Invalid API key
  if (
    errorMessage.includes('invalid_api_key') ||
    errorMessage.includes('Incorrect API key') ||
    error?.status === 401
  ) {
    return {
      userMessage: 'Invalid OpenAI API key. Please check your API key configuration.',
      billingUrl: 'https://platform.openai.com/api-keys',
      isBillingError: false,
      originalError: errorMessage,
    };
  }

  // Model not found / access errors
  if (errorMessage.includes('model') && errorMessage.includes('not found')) {
    return {
      userMessage: 'The selected AI model is not available. Please try a different model in settings.',
      isBillingError: false,
      originalError: errorMessage,
    };
  }

  // Default error
  return {
    userMessage: errorMessage,
    isBillingError: false,
    originalError: errorMessage,
  };
}

module.exports = {
  openai,
  loadPrompt,
  loadActivePrompt,
  audioToDataUrl,
  imageToDataUrl,
  parseOpenAIError,
};
