const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR } = require('./security');

// Track active sessions to avoid cleaning up files in use
const activeSessions = new Set();

/**
 * Mark a session as active (prevents cleanup)
 * @param {string} sessionId
 */
function markSessionActive(sessionId) {
  activeSessions.add(sessionId);
}

/**
 * Mark a session as inactive (allows cleanup)
 * @param {string} sessionId
 */
function markSessionInactive(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Check if a session is active
 * @param {string} sessionId
 * @returns {boolean}
 */
function isSessionActive(sessionId) {
  return activeSessions.has(sessionId);
}

/**
 * Delete all files associated with a session
 * @param {string} sessionId - The session ID
 * @returns {Object} - Result with deleted files count
 */
function cleanupSession(sessionId) {
  const result = { deletedFiles: 0, errors: [] };

  try {
    const files = fs.readdirSync(UPLOADS_DIR);

    for (const file of files) {
      // Match files that start with the session ID
      if (file.startsWith(sessionId)) {
        const filePath = path.join(UPLOADS_DIR, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
          // Recursively delete directory (frames folder)
          fs.rmSync(filePath, { recursive: true, force: true });
          result.deletedFiles++;
        } else {
          // Delete file
          fs.unlinkSync(filePath);
          result.deletedFiles++;
        }
      }
    }
  } catch (error) {
    result.errors.push(error.message);
  }

  return result;
}

/**
 * Clean up old files that haven't been accessed in a while
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns {Object} - Result with deleted files count
 */
function cleanupOldFiles(maxAgeMs = 24 * 60 * 60 * 1000) {
  const result = { deletedFiles: 0, errors: [], skippedActive: 0 };
  const now = Date.now();

  try {
    if (!fs.existsSync(UPLOADS_DIR)) {
      return result;
    }

    const files = fs.readdirSync(UPLOADS_DIR);

    for (const file of files) {
      const filePath = path.join(UPLOADS_DIR, file);

      try {
        const stat = fs.statSync(filePath);
        const age = now - stat.mtimeMs;

        // Extract session ID from filename (UUID format at start)
        const sessionIdMatch = file.match(/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
        const sessionId = sessionIdMatch ? sessionIdMatch[1] : null;

        // Skip if session is active
        if (sessionId && isSessionActive(sessionId)) {
          result.skippedActive++;
          continue;
        }

        if (age > maxAgeMs) {
          if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
          }
          result.deletedFiles++;
        }
      } catch (err) {
        result.errors.push(`${file}: ${err.message}`);
      }
    }
  } catch (error) {
    result.errors.push(error.message);
  }

  return result;
}

/**
 * Get upload directory statistics
 * @returns {Object} - Stats about uploads directory
 */
function getUploadStats() {
  const stats = {
    totalFiles: 0,
    totalSize: 0,
    oldestFile: null,
    newestFile: null,
  };

  try {
    if (!fs.existsSync(UPLOADS_DIR)) {
      return stats;
    }

    const files = fs.readdirSync(UPLOADS_DIR);

    for (const file of files) {
      const filePath = path.join(UPLOADS_DIR, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        // Count files in directory
        const subFiles = fs.readdirSync(filePath);
        stats.totalFiles += subFiles.length;
        for (const subFile of subFiles) {
          const subStat = fs.statSync(path.join(filePath, subFile));
          stats.totalSize += subStat.size;
        }
      } else {
        stats.totalFiles++;
        stats.totalSize += stat.size;
      }

      if (!stats.oldestFile || stat.mtimeMs < stats.oldestFile.time) {
        stats.oldestFile = { name: file, time: stat.mtimeMs };
      }
      if (!stats.newestFile || stat.mtimeMs > stats.newestFile.time) {
        stats.newestFile = { name: file, time: stat.mtimeMs };
      }
    }
  } catch (error) {
    stats.error = error.message;
  }

  return stats;
}

module.exports = {
  markSessionActive,
  markSessionInactive,
  isSessionActive,
  cleanupSession,
  cleanupOldFiles,
  getUploadStats,
};
