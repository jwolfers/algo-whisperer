// Video player handling

const Player = {
  videoElement: null,

  init() {
    this.videoElement = document.getElementById('video-player');
  },

  loadVideo(path, fileInfo) {
    const uploadSection = document.getElementById('upload-section');
    const playerSection = document.getElementById('player-section');

    // Hide upload, show player
    uploadSection.classList.add('hidden');
    playerSection.classList.remove('hidden');

    // Load video
    this.videoElement.src = path;

    // Set video name
    document.getElementById('video-name').textContent = fileInfo.name;

    // Set file size
    document.getElementById('video-size').textContent = this.formatFileSize(fileInfo.size);

    // Set creation/modified date
    if (fileInfo.lastModified) {
      const date = new Date(fileInfo.lastModified);
      document.getElementById('video-date').textContent = this.formatDate(date);
    }

    // Get duration when loaded
    this.videoElement.addEventListener('loadedmetadata', () => {
      const duration = this.formatDuration(this.videoElement.duration);
      document.getElementById('video-duration').textContent = duration;
    });

    // Start both transcription and frame extraction in parallel
    this.startProcessing();
  },

  async startProcessing() {
    const transcribeStatus = document.getElementById('transcribe-status');
    const framesStatus = document.getElementById('frames-status');

    // Start both tasks in parallel
    const transcriptionPromise = Transcript.startTranscription()
      .then(() => {
        transcribeStatus.textContent = 'Transcription complete';
        transcribeStatus.classList.add('complete');
      })
      .catch((err) => {
        transcribeStatus.textContent = 'Transcription failed';
        transcribeStatus.classList.add('error');
      });

    const framesPromise = Thumbnails.extractFrames()
      .then(() => {
        framesStatus.textContent = 'Frames ready';
        framesStatus.classList.add('complete');
      })
      .catch((err) => {
        framesStatus.textContent = 'Frame extraction failed';
        framesStatus.classList.add('error');
      });

    // Wait for both to complete
    await Promise.allSettled([transcriptionPromise, framesPromise]);
  },

  formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  },

  formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  },

  formatDate(date) {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  },

  seekTo(seconds) {
    this.videoElement.currentTime = seconds;
    this.videoElement.play();
  },
};
