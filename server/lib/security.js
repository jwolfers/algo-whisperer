const path = require('path');

// Base uploads directory
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');

/**
 * Validates that a filename is safe and doesn't contain path traversal
 * @param {string} filename - The filename to validate
 * @returns {boolean} - True if safe, false if potentially malicious
 */
function isValidFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return false;
  }

  // Check for path traversal attempts
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return false;
  }

  // Check for null bytes (can bypass some checks)
  if (filename.includes('\0')) {
    return false;
  }

  // Ensure filename has reasonable length
  if (filename.length > 255) {
    return false;
  }

  return true;
}

/**
 * Safely resolves a filename to a full path within uploads directory
 * @param {string} filename - The filename to resolve
 * @returns {string|null} - Full path if safe, null if invalid
 */
function safeUploadPath(filename) {
  if (!isValidFilename(filename)) {
    return null;
  }

  const fullPath = path.join(UPLOADS_DIR, filename);

  // Double-check that resolved path is still within uploads directory
  if (!fullPath.startsWith(UPLOADS_DIR)) {
    return null;
  }

  return fullPath;
}

/**
 * Safely resolves a session frames directory path
 * @param {string} sessionId - The session ID
 * @returns {string|null} - Full path if safe, null if invalid
 */
function safeFramesPath(sessionId) {
  if (!isValidFilename(sessionId)) {
    return null;
  }

  const framesDir = path.join(UPLOADS_DIR, `${sessionId}_frames`);

  if (!framesDir.startsWith(UPLOADS_DIR)) {
    return null;
  }

  return framesDir;
}

/**
 * Validates a session ID format (should be a UUID)
 * @param {string} sessionId - The session ID to validate
 * @returns {boolean} - True if valid UUID format
 */
function isValidSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return false;
  }

  // UUID v4 format: 8-4-4-4-12 hex characters
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(sessionId);
}

module.exports = {
  UPLOADS_DIR,
  isValidFilename,
  safeUploadPath,
  safeFramesPath,
  isValidSessionId,
};
