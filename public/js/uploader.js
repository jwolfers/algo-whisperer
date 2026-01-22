// Video upload handling with parallel chunked uploads

const Uploader = {
  sessionId: null,
  filename: null,

  // Configurable settings (tuned for fast connections)
  CHUNK_SIZE: 20 * 1024 * 1024, // 20MB chunks - fewer requests
  MAX_PARALLEL_UPLOADS: 10, // Number of concurrent chunk uploads
  MIN_FILE_SIZE_FOR_CHUNKING: 50 * 1024 * 1024, // Use chunked upload for files > 50MB

  init() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    // Drag and drop events
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        this.uploadFile(files[0]);
      }
    });

    // File input change
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.uploadFile(e.target.files[0]);
      }
    });
  },

  async uploadFile(file) {
    // Validate file type
    if (!file.type.startsWith('video/')) {
      alert('Please select a video file');
      return;
    }

    const progressContainer = document.getElementById('upload-progress');
    const progressFill = progressContainer.querySelector('.progress-fill');
    const progressText = progressContainer.querySelector('.progress-text');
    const dropZoneContent = document.querySelector('.drop-zone-content');

    // Show progress
    dropZoneContent.classList.add('hidden');
    progressContainer.classList.remove('hidden');

    console.log('Starting upload:', file.name, 'Size:', (file.size / 1024 / 1024).toFixed(2), 'MB');

    // Use chunked upload for large files, regular upload for small ones
    if (file.size > this.MIN_FILE_SIZE_FOR_CHUNKING) {
      console.log('Using chunked upload with parallel transfers');
      await this.chunkedUpload(file, progressFill, progressText, dropZoneContent, progressContainer);
    } else {
      console.log('Using standard upload');
      await this.standardUpload(file, progressFill, progressText, dropZoneContent, progressContainer);
    }
  },

  async chunkedUpload(file, progressFill, progressText, dropZoneContent, progressContainer) {
    const totalChunks = Math.ceil(file.size / this.CHUNK_SIZE);

    console.log(`Splitting into ${totalChunks} chunks of ${this.CHUNK_SIZE / 1024 / 1024}MB`);

    try {
      // Step 1: Initialize upload
      progressText.textContent = 'Initializing upload...';
      const initResponse = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          fileSize: file.size,
          totalChunks,
        }),
      });

      if (!initResponse.ok) {
        const error = await initResponse.json();
        throw new Error(error.error || 'Failed to initialize upload');
      }

      const { uploadId, sessionId } = await initResponse.json();
      console.log('Upload initialized:', uploadId);

      // Step 2: Upload chunks in parallel
      const chunkProgress = new Array(totalChunks).fill(0);
      let completedChunks = 0;

      const updateProgress = () => {
        const totalProgress = chunkProgress.reduce((a, b) => a + b, 0) / totalChunks;
        progressFill.style.width = `${totalProgress}%`;
        progressText.textContent = `Uploading... ${Math.round(totalProgress)}% (${completedChunks}/${totalChunks} chunks)`;
      };

      // Create chunk upload promises
      const uploadChunk = async (chunkIndex) => {
        const start = chunkIndex * this.CHUNK_SIZE;
        const end = Math.min(start + this.CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const response = await fetch('/api/upload/chunk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Upload-Id': uploadId,
            'X-Chunk-Index': chunkIndex.toString(),
          },
          body: chunk,
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(`Chunk ${chunkIndex} failed: ${error.error}`);
        }

        chunkProgress[chunkIndex] = 100;
        completedChunks++;
        updateProgress();

        return chunkIndex;
      };

      // Upload chunks with controlled parallelism
      const chunkIndices = Array.from({ length: totalChunks }, (_, i) => i);
      await this.parallelLimit(chunkIndices, this.MAX_PARALLEL_UPLOADS, uploadChunk);

      // Step 3: Complete upload
      progressText.textContent = 'Assembling file...';
      const completeResponse = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      });

      if (!completeResponse.ok) {
        const error = await completeResponse.json();
        throw new Error(error.error || 'Failed to complete upload');
      }

      const result = await completeResponse.json();
      console.log('Upload complete:', result);

      this.sessionId = result.sessionId;
      this.filename = result.filename;

      progressFill.style.width = '100%';
      progressText.textContent = 'Upload complete!';

      // Trigger video loaded event
      setTimeout(() => {
        Player.loadVideo(result.path, {
          name: result.originalName,
          size: result.size,
          lastModified: file.lastModified,
        });
      }, 500);

    } catch (error) {
      console.error('Chunked upload error:', error);
      this.handleUploadError(error.message, dropZoneContent, progressContainer);
    }
  },

  // Execute promises with a concurrency limit
  async parallelLimit(items, limit, fn) {
    const results = [];
    const executing = new Set();

    for (const item of items) {
      const promise = Promise.resolve().then(() => fn(item));
      results.push(promise);
      executing.add(promise);

      const clean = () => executing.delete(promise);
      promise.then(clean, clean);

      if (executing.size >= limit) {
        await Promise.race(executing);
      }
    }

    return Promise.all(results);
  },

  async standardUpload(file, progressFill, progressText, dropZoneContent, progressContainer) {
    const formData = new FormData();
    formData.append('video', file);

    const xhr = new XMLHttpRequest();
    const self = this;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = `${percent}%`;
        progressText.textContent = `Uploading... ${percent}%`;
        if (percent === 100) {
          progressText.textContent = 'Processing upload...';
          console.log('Upload data sent, waiting for server response...');
        }
      }
    });

    return new Promise((resolve, reject) => {
      xhr.addEventListener('load', function() {
        console.log('Server responded with status:', xhr.status);
        if (xhr.status === 200) {
          try {
            const response = JSON.parse(xhr.responseText);
            console.log('Upload response:', response);
            self.sessionId = response.sessionId;
            self.filename = response.filename;

            progressText.textContent = 'Upload complete!';

            // Trigger video loaded event
            setTimeout(() => {
              Player.loadVideo(response.path, {
                name: response.originalName,
                size: response.size,
                lastModified: file.lastModified,
              });
            }, 500);
            resolve(response);
          } catch (parseError) {
            console.error('Failed to parse response:', xhr.responseText);
            self.handleUploadError('Invalid server response', dropZoneContent, progressContainer);
            reject(parseError);
          }
        } else {
          console.error('Upload failed with status:', xhr.status, xhr.responseText);
          self.handleUploadError(`Upload failed (${xhr.status})`, dropZoneContent, progressContainer);
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', function() {
        console.error('XHR error event triggered');
        self.handleUploadError('Network error during upload', dropZoneContent, progressContainer);
        reject(new Error('Network error'));
      });

      xhr.addEventListener('timeout', function() {
        console.error('XHR timeout');
        self.handleUploadError('Upload timed out', dropZoneContent, progressContainer);
        reject(new Error('Timeout'));
      });

      xhr.addEventListener('abort', function() {
        console.error('XHR aborted');
        self.handleUploadError('Upload was aborted', dropZoneContent, progressContainer);
        reject(new Error('Aborted'));
      });

      // Set a long timeout for large files (10 minutes)
      xhr.timeout = 600000;

      xhr.open('POST', '/api/upload');
      xhr.send(formData);
    });
  },

  handleUploadError(message, dropZoneContent, progressContainer) {
    alert(message);
    dropZoneContent.classList.remove('hidden');
    progressContainer.classList.add('hidden');
  },
};
