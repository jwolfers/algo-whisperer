const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

/**
 * Safely delete a file if it exists
 * @param {string} filePath
 */
function safeDelete(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`Failed to delete ${filePath}:`, err.message);
  }
}

// Extract audio from video file
function extractAudio(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        // Clean up partial output file on error
        safeDelete(outputPath);
        reject(err);
      })
      .run();
  });
}

// Get video duration in seconds
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

// Get audio file duration in seconds
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

// Get file size in bytes
function getFileSize(filePath) {
  const stats = fs.statSync(filePath);
  return stats.size;
}

// Split audio file into chunks
// Returns array of chunk file paths
async function splitAudioIntoChunks(audioPath, outputDir, chunkDurationSeconds = 1200, overlapSeconds = 30) {
  const duration = await getAudioDuration(audioPath);
  const chunks = [];
  const baseName = path.basename(audioPath, path.extname(audioPath));

  // If audio is shorter than chunk duration, no need to split
  if (duration <= chunkDurationSeconds) {
    return [{ path: audioPath, startTime: 0, endTime: duration, isOriginal: true }];
  }

  let startTime = 0;
  let chunkIndex = 0;

  while (startTime < duration) {
    const chunkPath = path.join(outputDir, `${baseName}_chunk_${chunkIndex}.mp3`);
    const endTime = Math.min(startTime + chunkDurationSeconds, duration);
    const chunkLength = endTime - startTime;

    await new Promise((resolve, reject) => {
      ffmpeg(audioPath)
        .setStartTime(startTime)
        .setDuration(chunkLength)
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .output(chunkPath)
        .on('end', resolve)
        .on('error', (err) => {
          safeDelete(chunkPath);
          reject(err);
        })
        .run();
    });

    chunks.push({
      path: chunkPath,
      startTime: startTime,
      endTime: endTime,
      isOriginal: false
    });

    chunkIndex++;
    // Move start time forward, with overlap to avoid cutting words
    startTime = endTime - overlapSeconds;

    // If remaining audio is very short, include it in last chunk
    if (duration - startTime < overlapSeconds * 2) {
      break;
    }
  }

  return chunks;
}

// Extract frames at random timestamps
async function extractFrames(videoPath, outputDir, numFrames = 24) {
  const duration = await getVideoDuration(videoPath);
  const frames = [];

  // Generate random timestamps, avoiding first and last 5% of video
  const startTime = duration * 0.05;
  const endTime = duration * 0.95;
  const timestamps = [];

  for (let i = 0; i < numFrames; i++) {
    timestamps.push(startTime + Math.random() * (endTime - startTime));
  }
  timestamps.sort((a, b) => a - b);

  // Extract each frame
  for (let i = 0; i < timestamps.length; i++) {
    const timestamp = timestamps[i];
    const outputPath = path.join(outputDir, `frame_${i + 1}.jpg`);

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .frames(1)
        .output(outputPath)
        .on('end', () => {
          frames.push({
            index: i + 1,
            timestamp,
            path: outputPath,
            filename: `frame_${i + 1}.jpg`
          });
          resolve();
        })
        .on('error', (err) => {
          // Clean up partial frame file on error
          safeDelete(outputPath);
          reject(err);
        })
        .run();
    });
  }

  return frames;
}

module.exports = {
  extractAudio,
  getVideoDuration,
  getAudioDuration,
  getFileSize,
  splitAudioIntoChunks,
  extractFrames,
};
