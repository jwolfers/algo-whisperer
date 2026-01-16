// Prompts management

const Prompts = {
  library: null,
  currentType: 'metadata',
  isEditing: false,
  editingPromptId: null,

  // Field definitions for each prompt type
  fieldDefinitions: {
    metadata: [
      { key: 'system_prompt', label: 'System Prompt', type: 'textarea', tall: true },
      { key: 'title_prompt', label: 'Title Generation Prompt', type: 'textarea', tall: true },
      { key: 'description_prompt', label: 'Description Generation Prompt', type: 'textarea', tall: true },
      { key: 'thumbnail_title_prompt', label: 'Thumbnail Title Prompt', type: 'textarea', tall: true },
    ],
    vision: [
      { key: 'system_prompt', label: 'System Prompt', type: 'textarea', tall: true },
      { key: 'analysis_prompt', label: 'Analysis Prompt', type: 'textarea', tall: true },
    ],
    transcription: [
      { key: 'instructions', label: 'Transcription Instructions', type: 'textarea' },
      { key: 'known_speakers', label: 'Known Speakers (JSON array)', type: 'textarea', isJson: true },
      { key: 'unknown_speaker_labels', label: 'Unknown Speaker Labels (JSON array)', type: 'textarea', isJson: true },
    ],
  },

  async init() {
    // Load prompts library
    await this.loadLibrary();

    // Set up event listeners
    this.setupEventListeners();
  },

  async loadLibrary() {
    try {
      const response = await fetch('/api/prompts');
      const data = await response.json();
      if (data.success) {
        this.library = data.library;
        console.log('Prompts library loaded:', this.library);
      }
    } catch (error) {
      console.error('Failed to load prompts library:', error);
    }
  },

  setupEventListeners() {
    // Open modal
    document.getElementById('prompts-btn').addEventListener('click', () => {
      this.openModal();
    });

    // Close modal
    document.getElementById('close-prompts').addEventListener('click', () => {
      this.closeModal();
    });

    // Close on backdrop click
    document.getElementById('prompts-modal').addEventListener('click', (e) => {
      if (e.target.id === 'prompts-modal') {
        this.closeModal();
      }
    });

    // Tab switching
    document.querySelectorAll('.prompt-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.switchTab(tab.dataset.type);
      });
    });

    // Active prompt selection
    document.getElementById('active-prompt-select').addEventListener('change', async (e) => {
      await this.setActivePrompt(e.target.value);
    });

    // Add new prompt
    document.getElementById('add-prompt-btn').addEventListener('click', () => {
      this.openEditor(null);
    });

    // Edit prompt
    document.getElementById('edit-prompt-btn').addEventListener('click', () => {
      const select = document.getElementById('active-prompt-select');
      this.openEditor(select.value);
    });

    // Delete prompt
    document.getElementById('delete-prompt-btn').addEventListener('click', async () => {
      const select = document.getElementById('active-prompt-select');
      await this.deletePrompt(select.value);
    });

    // Editor modal events
    document.getElementById('close-prompt-editor').addEventListener('click', () => {
      this.closeEditor();
    });

    document.getElementById('cancel-prompt-edit').addEventListener('click', () => {
      this.closeEditor();
    });

    document.getElementById('save-prompt-edit').addEventListener('click', async () => {
      await this.savePrompt();
    });

    document.getElementById('prompt-editor-modal').addEventListener('click', (e) => {
      if (e.target.id === 'prompt-editor-modal') {
        this.closeEditor();
      }
    });
  },

  openModal() {
    document.getElementById('prompts-modal').classList.remove('hidden');
    this.renderPromptSelector();
    this.renderPreview();
  },

  closeModal() {
    document.getElementById('prompts-modal').classList.add('hidden');
  },

  switchTab(type) {
    this.currentType = type;

    // Update tab appearance
    document.querySelectorAll('.prompt-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.type === type);
    });

    // Update UI
    this.renderPromptSelector();
    this.renderPreview();
  },

  renderPromptSelector() {
    const select = document.getElementById('active-prompt-select');
    const typeData = this.library[this.currentType];

    if (!typeData) {
      select.innerHTML = '<option>No prompts available</option>';
      return;
    }

    select.innerHTML = Object.entries(typeData.prompts)
      .map(([id, prompt]) => {
        const selected = id === typeData.active ? 'selected' : '';
        return `<option value="${id}" ${selected}>${prompt.name || id}</option>`;
      })
      .join('');

    // Update delete button state
    const deleteBtn = document.getElementById('delete-prompt-btn');
    const promptCount = Object.keys(typeData.prompts).length;
    deleteBtn.disabled = promptCount <= 1;
    deleteBtn.title = promptCount <= 1 ? 'Cannot delete the last prompt' : 'Delete this prompt';
  },

  renderPreview() {
    const container = document.getElementById('prompt-preview-content');
    const typeData = this.library[this.currentType];

    if (!typeData || !typeData.prompts[typeData.active]) {
      container.innerHTML = '<p>No prompt selected</p>';
      return;
    }

    const prompt = typeData.prompts[typeData.active];
    const fields = this.fieldDefinitions[this.currentType];

    container.innerHTML = fields
      .map((field) => {
        let value = prompt[field.key];
        if (field.isJson && typeof value !== 'string') {
          value = JSON.stringify(value, null, 2);
        }
        return `
          <div class="prompt-preview-field">
            <label>${field.label}</label>
            <pre>${this.escapeHtml(value || '(not set)')}</pre>
          </div>
        `;
      })
      .join('');
  },

  async setActivePrompt(promptId) {
    try {
      const response = await fetch(`/api/prompts/${this.currentType}/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId }),
      });

      if (response.ok) {
        this.library[this.currentType].active = promptId;
        console.log(`Active ${this.currentType} prompt set to: ${promptId}`);
        this.renderPreview();
      }
    } catch (error) {
      console.error('Failed to set active prompt:', error);
    }
  },

  openEditor(promptId) {
    this.isEditing = !!promptId;
    this.editingPromptId = promptId;

    const modal = document.getElementById('prompt-editor-modal');
    const title = document.getElementById('prompt-editor-title');
    const idInput = document.getElementById('prompt-id');
    const nameInput = document.getElementById('prompt-name');
    const fieldsContainer = document.getElementById('prompt-fields');

    title.textContent = this.isEditing ? 'Edit Prompt' : 'Add New Prompt';
    idInput.disabled = this.isEditing;

    const fields = this.fieldDefinitions[this.currentType];
    let prompt = null;

    if (this.isEditing) {
      prompt = this.library[this.currentType].prompts[promptId];
      idInput.value = promptId;
      nameInput.value = prompt.name || '';
    } else {
      idInput.value = '';
      nameInput.value = '';
    }

    // Render field editors
    fieldsContainer.innerHTML = fields
      .map((field) => {
        let value = prompt ? prompt[field.key] : '';
        if (field.isJson && typeof value !== 'string') {
          value = JSON.stringify(value, null, 2);
        }
        const tallClass = field.tall ? 'tall' : '';
        return `
          <div class="setting-group">
            <label for="field-${field.key}">${field.label}</label>
            <textarea id="field-${field.key}" class="${tallClass}">${this.escapeHtml(value || '')}</textarea>
          </div>
        `;
      })
      .join('');

    modal.classList.remove('hidden');
  },

  closeEditor() {
    document.getElementById('prompt-editor-modal').classList.add('hidden');
    this.isEditing = false;
    this.editingPromptId = null;
  },

  async savePrompt() {
    const idInput = document.getElementById('prompt-id');
    const nameInput = document.getElementById('prompt-name');
    const fields = this.fieldDefinitions[this.currentType];

    const promptId = idInput.value.trim().toLowerCase().replace(/\s+/g, '-');
    const promptName = nameInput.value.trim();

    if (!promptId) {
      alert('Please enter a prompt ID');
      return;
    }

    if (!promptName) {
      alert('Please enter a display name');
      return;
    }

    // Collect field values
    const prompt = { name: promptName };
    for (const field of fields) {
      const textarea = document.getElementById(`field-${field.key}`);
      let value = textarea.value;

      if (field.isJson) {
        try {
          value = JSON.parse(value);
        } catch (e) {
          alert(`Invalid JSON in ${field.label}`);
          return;
        }
      }

      prompt[field.key] = value;
    }

    try {
      let response;
      if (this.isEditing) {
        // Update existing prompt
        response = await fetch(`/api/prompts/${this.currentType}/${this.editingPromptId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
      } else {
        // Add new prompt
        response = await fetch(`/api/prompts/${this.currentType}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: promptId, prompt }),
        });
      }

      if (response.ok) {
        // Reload library and update UI
        await this.loadLibrary();
        this.renderPromptSelector();
        this.renderPreview();
        this.closeEditor();
        console.log(`Prompt ${this.isEditing ? 'updated' : 'added'}: ${promptId}`);
      } else {
        const error = await response.json();
        alert(error.error || 'Failed to save prompt');
      }
    } catch (error) {
      console.error('Failed to save prompt:', error);
      alert('Failed to save prompt');
    }
  },

  async deletePrompt(promptId) {
    if (!confirm(`Are you sure you want to delete the prompt "${promptId}"?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/prompts/${this.currentType}/${promptId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        const result = await response.json();
        await this.loadLibrary();
        this.renderPromptSelector();
        this.renderPreview();
        console.log(`Prompt deleted: ${promptId}, new active: ${result.newActive}`);
      } else {
        const error = await response.json();
        alert(error.error || 'Failed to delete prompt');
      }
    } catch (error) {
      console.error('Failed to delete prompt:', error);
      alert('Failed to delete prompt');
    }
  },

  // Get the active prompt for a given type
  getActivePrompt(type) {
    if (!this.library || !this.library[type]) {
      return null;
    }
    const typeData = this.library[type];
    return typeData.prompts[typeData.active];
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
