// Metadata generation and display

const Metadata = {
  data: null,
  descriptionLabels: null,
  videoSummary: null,

  init() {
    // No additional initialization needed
  },

  async generate() {
    const section = document.getElementById('metadata-section');
    const loading = document.getElementById('metadata-loading');
    const container = document.getElementById('metadata-container');

    // Show section and loading
    section.classList.remove('hidden');
    loading.classList.remove('hidden');

    try {
      const settings = Settings.get();

      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: Transcript.data,
          settings: {
            numTitles: settings.numTitles,
            numDescriptions: settings.numDescriptions,
            numThumbnailTitles: settings.numThumbnailTitles,
            chatModel: settings.chatModel,
          },
        }),
      });

      if (!response.ok) {
        throw new Error('Metadata generation failed');
      }

      const result = await response.json();
      this.data = result.metadata;

      // Generate AI summaries for descriptions (runs in parallel with rendering initial state)
      this.generateDescriptionSummaries(this.data.descriptions, settings);

      // Render metadata with initial labels (will update when summaries arrive)
      this.render();

      // Update thumbnail editors if they were created before metadata was ready
      if (Thumbnails.editors.length > 0) {
        Thumbnails.refreshMetadataOptions();
      }
    } catch (error) {
      console.error('Metadata generation error:', error);
      alert('Metadata generation failed: ' + error.message);
    } finally {
      loading.classList.add('hidden');
    }
  },

  async generateDescriptionSummaries(descriptions, settings) {
    try {
      const response = await fetch('/api/generate/summarize-descriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          descriptions,
          settings: { chatModel: settings.chatModel },
        }),
      });

      if (!response.ok) {
        console.error('Description summary generation failed');
        return;
      }

      const result = await response.json();
      this.descriptionLabels = result.labels;
      this.videoSummary = result.videoSummary;

      // Update the UI with the new labels and summary
      this.updateDescriptionLabels();
      this.showVideoSummary();
    } catch (error) {
      console.error('Description summary error:', error);
    }
  },

  updateDescriptionLabels() {
    if (!this.descriptionLabels) return;

    const labels = document.querySelectorAll('.description-label');
    labels.forEach((label, index) => {
      if (this.descriptionLabels[index]) {
        label.textContent = this.descriptionLabels[index];
      }
    });
  },

  showVideoSummary() {
    const summaryEl = document.getElementById('video-summary');
    if (summaryEl && this.videoSummary) {
      summaryEl.textContent = this.videoSummary;
      summaryEl.classList.remove('hidden');
    }
    // Show the "Differentiated versions:" heading
    const headingEl = document.getElementById('descriptions-heading');
    if (headingEl) {
      headingEl.classList.remove('hidden');
    }
  },

  render() {
    if (!this.data) return;

    // Render descriptions with radio buttons
    this.renderDescriptions(this.data.descriptions);

    // Titles and thumbnail titles are only shown in the thumbnail editor, not in this section
  },

  renderDescriptions(descriptions) {
    const selectorContainer = document.getElementById('descriptions-selector');
    const contentContainer = document.getElementById('descriptions-content');

    selectorContainer.innerHTML = '';
    contentContainer.innerHTML = '';

    if (!descriptions || descriptions.length === 0) return;

    descriptions.forEach((desc, index) => {
      // Create a short summary (first 3-4 words or key phrase)
      const summary = this.createSummary(desc, index);

      // Create radio button
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'description-select';
      radio.id = `desc-${index}`;
      radio.className = 'description-radio';
      radio.value = index;
      if (index === 0) radio.checked = true;

      // Create label
      const label = document.createElement('label');
      label.htmlFor = `desc-${index}`;
      label.className = 'description-label';
      label.textContent = summary;

      radio.addEventListener('change', () => {
        this.showDescription(desc);
      });

      selectorContainer.appendChild(radio);
      selectorContainer.appendChild(label);
    });

    // Show first description by default
    this.showDescription(descriptions[0]);
  },

  createSummary(description, index) {
    // Extract first meaningful phrase (up to 3 words)
    const words = description.split(/\s+/);
    let summary = words.slice(0, 3).join(' ');

    // Remove trailing punctuation
    summary = summary.replace(/[,.:;]$/, '');

    // Fallback to numbered label if summary is too short
    if (summary.length < 5) {
      summary = `Option ${index + 1}`;
    }

    return summary;
  },

  showDescription(description) {
    const contentContainer = document.getElementById('descriptions-content');
    // Convert newlines to paragraphs for proper display
    const formattedDesc = description
      .split(/\n\n+/)  // Split on double newlines (paragraph breaks)
      .filter(p => p.trim())  // Remove empty paragraphs
      .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)  // Wrap in <p>, convert single newlines to <br>
      .join('');
    contentContainer.innerHTML = `
      <div class="description-text">${formattedDesc}</div>
      <button class="btn btn-secondary" style="margin-top: 12px;" onclick="Metadata.copyDescriptionToClipboard(this)">Copy to Clipboard</button>
    `;
    contentContainer.dataset.description = description;
  },

  copyDescriptionToClipboard(button) {
    const container = document.getElementById('descriptions-content');
    const text = container.dataset.description;
    navigator.clipboard.writeText(text).then(() => {
      button.textContent = 'Copied!';
      setTimeout(() => {
        button.textContent = 'Copy to Clipboard';
      }, 1000);
    });
  },

  renderList(containerId, items) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    items.forEach((item, index) => {
      const div = document.createElement('div');
      div.className = 'metadata-item';
      div.innerHTML = `
        <span class="item-text">${item}</span>
        <span class="copy-icon">📋</span>
      `;

      div.addEventListener('click', () => {
        this.copyToClipboard(item, div);
      });

      container.appendChild(div);
    });
  },

  copyToClipboard(text, element) {
    navigator.clipboard.writeText(text).then(() => {
      element.classList.add('copied');
      setTimeout(() => {
        element.classList.remove('copied');
      }, 1000);
    });
  },

  getThumbnailTitles() {
    return this.data?.thumbnailTitles || [];
  },

  getTitles() {
    return this.data?.titles || [];
  },
};
