// Transcript handling

const Transcript = {
  data: null,

  init() {
    document.getElementById('generate-metadata-btn').addEventListener('click', () => {
      Metadata.generate();
    });

    // Copy transcript button
    document.getElementById('copy-transcript-btn').addEventListener('click', () => {
      this.copyToClipboard();
    });
  },

  copyToClipboard() {
    if (!this.data || this.data.length === 0) {
      return;
    }

    // Format transcript grouped by speaker (same format as API)
    const groups = this.groupBySpeaker();
    const text = groups
      .map(g => `${g.speaker}:\n${g.segments.map(s => s.text).join(' ')}`)
      .join('\n\n');

    const btn = document.getElementById('copy-transcript-btn');
    const btnText = btn.querySelector('.btn-text');

    navigator.clipboard.writeText(text).then(() => {
      btn.classList.add('copied');
      btnText.textContent = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        btnText.textContent = 'Copy';
      }, 1500);
    }).catch(err => {
      console.error('Failed to copy transcript:', err);
    });
  },

  async startTranscription() {
    const section = document.getElementById('transcript-section');
    const loading = document.getElementById('transcript-loading');
    const container = document.getElementById('transcript-container');
    const generateBtn = document.getElementById('generate-metadata-btn');

    // Show section and loading
    section.classList.remove('hidden');
    loading.classList.remove('hidden');
    container.innerHTML = '';
    generateBtn.disabled = true;

    try {
      const settings = Settings.get();

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: Uploader.sessionId,
          filename: Uploader.filename,
          model: settings.transcriptionModel,
          chunkMinutes: settings.chunkMinutes,
        }),
      });

      if (!response.ok) {
        throw new Error('Transcription failed');
      }

      const result = await response.json();
      this.data = result.transcript;

      // Render transcript
      this.render();

      // Enable generate button
      generateBtn.disabled = false;

      // Auto-start metadata generation
      console.log('Transcript complete, auto-starting metadata generation...');
      Metadata.generate();
    } catch (error) {
      console.error('Transcription error:', error);
      container.innerHTML = `<p class="error">Transcription failed: ${error.message}</p>`;
    } finally {
      loading.classList.add('hidden');
    }
  },

  // Group continuous segments by the same speaker
  groupBySpeaker() {
    if (!this.data || this.data.length === 0) return [];

    const groups = [];
    let currentGroup = null;

    this.data.forEach((segment) => {
      if (!currentGroup || currentGroup.speaker !== segment.speaker) {
        // Start a new group
        currentGroup = {
          speaker: segment.speaker,
          start: segment.start,
          end: segment.end,
          segments: [segment],
        };
        groups.push(currentGroup);
      } else {
        // Add to current group
        currentGroup.segments.push(segment);
        currentGroup.end = segment.end;
      }
    });

    return groups;
  },

  // Convert segments to paragraphs (split on natural breaks)
  segmentsToParagraphs(segments) {
    const paragraphs = [];
    let currentParagraph = [];

    segments.forEach((segment, index) => {
      currentParagraph.push(segment.text);

      // Start a new paragraph after:
      // - Sentences ending with . ! ?
      // - Long pauses (gap > 2 seconds)
      // - Every ~150 words
      const text = segment.text.trim();
      const endsWithPunctuation = /[.!?]$/.test(text);
      const nextSegment = segments[index + 1];
      const hasLongPause = nextSegment && (nextSegment.start - segment.end) > 2;
      const wordCount = currentParagraph.join(' ').split(/\s+/).length;

      if ((endsWithPunctuation && wordCount > 30) || hasLongPause || wordCount > 150 || index === segments.length - 1) {
        paragraphs.push(currentParagraph.join(' '));
        currentParagraph = [];
      }
    });

    // Don't forget remaining text
    if (currentParagraph.length > 0) {
      paragraphs.push(currentParagraph.join(' '));
    }

    return paragraphs;
  },

  render() {
    const container = document.getElementById('transcript-container');
    container.innerHTML = '';

    if (!this.data || this.data.length === 0) {
      container.innerHTML = '<p>No transcript data available</p>';
      return;
    }

    // Group continuous speech by speaker
    const speakerGroups = this.groupBySpeaker();

    speakerGroups.forEach((group) => {
      const div = document.createElement('div');
      div.className = `transcript-segment ${this.getSpeakerClass(group.speaker)}`;

      const timestamp = this.formatTimestamp(group.start);
      const paragraphs = this.segmentsToParagraphs(group.segments);

      div.innerHTML = `
        <div class="speaker">
          ${group.speaker}
          <span class="timestamp">${timestamp}</span>
        </div>
        <div class="text">
          ${paragraphs.map(p => `<p>${p}</p>`).join('')}
        </div>
      `;

      // Click to seek video
      div.addEventListener('click', () => {
        Player.seekTo(group.start);
      });

      container.appendChild(div);
    });
  },

  getSpeakerClass(speaker) {
    const name = speaker.toLowerCase().replace(/\s+/g, '-');
    if (name.includes('justin') || name.includes('wolfers')) return 'justin-wolfers';
    if (name.includes('betsey') || name.includes('stevenson')) return 'betsey-stevenson';
    if (name.includes('interviewer')) return 'interviewer';
    return '';
  },

  formatTimestamp(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  },
};
