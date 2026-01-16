// Settings management with server-side persistence

const Settings = {
  current: null,

  availableModels: {
    chat: [],
    transcription: [],
    vision: [],
  },

  // Get current settings (cached)
  get() {
    return this.current || {
      numTitles: 20,
      numDescriptions: 5,
      numThumbnailTitles: 20,
      numFrames: 24,
      transcriptionModel: 'gpt-4o-transcribe-diarize',
      chatModel: 'gpt-4o',
      visionModel: 'gpt-4.1',
      imageDetail: 'auto',
      chunkMinutes: 4,
    };
  },

  // Fetch settings from server
  async fetchSettings() {
    try {
      const response = await fetch('/api/settings');
      const data = await response.json();
      if (data.success) {
        this.current = data.settings;
        this.populateFormFields();
      }
    } catch (error) {
      console.error('Failed to fetch settings:', error);
    }
  },

  // Save settings to server
  async save(settings) {
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await response.json();
      if (data.success) {
        this.current = settings;
        return true;
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
    return false;
  },

  // Reset to defaults
  async resetToDefaults() {
    try {
      const response = await fetch('/api/settings/reset', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        this.current = data.settings;
        this.populateFormFields();
        return true;
      }
    } catch (error) {
      console.error('Failed to reset settings:', error);
    }
    return false;
  },

  async fetchModels() {
    try {
      const response = await fetch('/api/models');
      const data = await response.json();
      if (data.success) {
        this.availableModels = data.models;
        this.populateModelDropdowns();
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
    }
  },

  populateModelDropdowns() {
    const settings = this.get();

    // Populate transcription models
    const transcriptionSelect = document.getElementById('transcription-model');
    if (this.availableModels.transcription.length > 0) {
      transcriptionSelect.innerHTML = this.availableModels.transcription
        .map(m => `<option value="${m}"${m === settings.transcriptionModel ? ' selected' : ''}>${m}</option>`)
        .join('');
    }

    // Populate chat models (first one is the -chat-latest default from server)
    const chatSelect = document.getElementById('chat-model');
    if (this.availableModels.chat.length > 0) {
      const defaultChatModel = settings.chatModel || this.availableModels.chat[0];
      chatSelect.innerHTML = this.availableModels.chat
        .map(m => `<option value="${m}"${m === defaultChatModel ? ' selected' : ''}>${m}</option>`)
        .join('');
    }

    // Populate vision models
    const visionSelect = document.getElementById('vision-model');
    if (this.availableModels.vision.length > 0) {
      visionSelect.innerHTML = this.availableModels.vision
        .map(m => `<option value="${m}"${m === settings.visionModel ? ' selected' : ''}>${m}</option>`)
        .join('');
    }
  },

  populateFormFields() {
    const settings = this.get();

    document.getElementById('num-titles').value = settings.numTitles;
    document.getElementById('num-descriptions').value = settings.numDescriptions;
    document.getElementById('num-thumbnail-titles').value = settings.numThumbnailTitles;
    document.getElementById('num-frames').value = settings.numFrames;
    document.getElementById('transcription-model').value = settings.transcriptionModel;
    document.getElementById('chat-model').value = settings.chatModel;
    document.getElementById('vision-model').value = settings.visionModel;

    const imageDetailSelect = document.getElementById('image-detail');
    if (imageDetailSelect) {
      imageDetailSelect.value = settings.imageDetail;
    }

    const chunkMinutesInput = document.getElementById('chunk-minutes');
    if (chunkMinutesInput) {
      chunkMinutesInput.value = settings.chunkMinutes || 4;
    }

    // Also update dropdowns if models are loaded
    if (this.availableModels.chat.length > 0) {
      this.populateModelDropdowns();
    }
  },

  async init() {
    // Fetch settings from server
    await this.fetchSettings();

    // Populate form fields
    this.populateFormFields();

    // Fetch available models from API
    await this.fetchModels();

    // Setup event listeners
    this.setupEventListeners();
  },

  setupEventListeners() {
    const settingsBtn = document.getElementById('settings-btn');
    const modal = document.getElementById('settings-modal');
    const closeBtn = document.getElementById('close-settings');
    const saveBtn = document.getElementById('save-settings');
    const resetBtn = document.getElementById('reset-defaults');

    settingsBtn.addEventListener('click', () => {
      modal.classList.remove('hidden');
    });

    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });

    saveBtn.addEventListener('click', async () => {
      const settings = {
        numTitles: parseInt(document.getElementById('num-titles').value),
        numDescriptions: parseInt(document.getElementById('num-descriptions').value),
        numThumbnailTitles: parseInt(document.getElementById('num-thumbnail-titles').value),
        numFrames: parseInt(document.getElementById('num-frames').value),
        transcriptionModel: document.getElementById('transcription-model').value,
        chatModel: document.getElementById('chat-model').value,
        visionModel: document.getElementById('vision-model').value,
        imageDetail: document.getElementById('image-detail')?.value || 'auto',
        chunkMinutes: parseInt(document.getElementById('chunk-minutes')?.value) || 4,
      };

      const success = await this.save(settings);
      if (success) {
        modal.classList.add('hidden');
      } else {
        alert('Failed to save settings');
      }
    });

    resetBtn.addEventListener('click', async () => {
      if (confirm('Reset all settings to defaults?')) {
        await this.resetToDefaults();
      }
    });
  },
};
