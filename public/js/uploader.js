// Video upload handling

const Uploader = {
  sessionId: null,
  filename: null,

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

    const formData = new FormData();
    formData.append('video', file);

    console.log('Starting upload:', file.name, 'Size:', (file.size / 1024 / 1024).toFixed(2), 'MB');

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

    xhr.addEventListener('load', function() {
      console.log('Server responded with status:', xhr.status);
      if (xhr.status === 200) {
        try {
          const response = JSON.parse(xhr.responseText);
          console.log('Upload response:', response);
          self.sessionId = response.sessionId;
          self.filename = response.filename;

          progressText.textContent = 'Upload complete!';

          // Trigger video loaded event with file metadata
          setTimeout(() => {
            Player.loadVideo(response.path, {
              name: response.originalName,
              size: response.size,
              lastModified: file.lastModified,
            });
          }, 500);
        } catch (parseError) {
          console.error('Failed to parse response:', xhr.responseText);
          self.handleUploadError('Invalid server response', dropZoneContent, progressContainer);
        }
      } else {
        console.error('Upload failed with status:', xhr.status, xhr.responseText);
        self.handleUploadError(`Upload failed (${xhr.status})`, dropZoneContent, progressContainer);
      }
    });

    xhr.addEventListener('error', function() {
      console.error('XHR error event triggered');
      self.handleUploadError('Network error during upload', dropZoneContent, progressContainer);
    });

    xhr.addEventListener('timeout', function() {
      console.error('XHR timeout');
      self.handleUploadError('Upload timed out', dropZoneContent, progressContainer);
    });

    xhr.addEventListener('abort', function() {
      console.error('XHR aborted');
      self.handleUploadError('Upload was aborted', dropZoneContent, progressContainer);
    });

    // Set a long timeout for large files (10 minutes)
    xhr.timeout = 600000;

    xhr.open('POST', '/api/upload');
    xhr.send(formData);
  },

  handleUploadError(message, dropZoneContent, progressContainer) {
    alert(message);
    dropZoneContent.classList.remove('hidden');
    progressContainer.classList.add('hidden');
  },
};
