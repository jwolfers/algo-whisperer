// Thumbnail extraction, selection, and editing

const Thumbnails = {
  allFrames: [],
  rankedFrames: [],
  selectedFrames: [], // Each entry now has { ...frame, selectionId }
  editors: [],
  frameBatches: [], // Track batches of ranked frames for display with separators
  // Store overlay state keyed by selectionId to persist edits across rebuilds
  overlayStates: new Map(),
  nextSelectionId: 1, // Unique ID counter for each selection
  settings: {
    font: "'Bebas Neue', sans-serif",
    bgColor: '#ffeb3b',
    textColor: '#000000',
  },

  init() {
    document.getElementById('download-thumbnails-btn').addEventListener('click', () => {
      this.downloadAll();
    });

    // Settings listeners
    document.getElementById('thumbnail-font').addEventListener('change', (e) => {
      this.settings.font = e.target.value;
      this.updateAllOverlays();
    });

    document.getElementById('thumbnail-bg-color').addEventListener('input', (e) => {
      this.settings.bgColor = e.target.value;
      this.updateAllOverlays();
    });

    document.getElementById('thumbnail-text-color').addEventListener('input', (e) => {
      this.settings.textColor = e.target.value;
      this.updateAllOverlays();
    });
  },

  updateAllOverlays() {
    this.editors.forEach((editor) => {
      editor.textOverlay.style.fontFamily = this.settings.font;
      editor.textOverlay.style.background = this.settings.bgColor;
      editor.textOverlay.style.color = this.settings.textColor;
    });
  },

  async extractFrames(isAdditional = false) {
    const section = document.getElementById('frames-section');
    const loading = document.getElementById('frames-loading');
    const grid = document.getElementById('frames-grid');

    // Show section and loading
    section.classList.remove('hidden');
    loading.classList.remove('hidden');

    // Only clear grid on first extraction
    if (!isAdditional) {
      grid.innerHTML = '';
      this.allFrames = [];
      this.rankedFrames = [];
      this.frameBatches = [];
      this.overlayStates = new Map(); // Clear saved overlay states for fresh start
      this.nextSelectionId = 1;
    }

    try {
      const settings = Settings.get();
      const numFrames = isAdditional ? 12 : settings.numFrames; // Additional batches are 12 frames

      // Extract frames
      const extractResponse = await fetch('/api/extract-frames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: Uploader.sessionId,
          filename: Uploader.filename,
          numFrames: numFrames,
        }),
      });

      if (!extractResponse.ok) {
        const errorData = await extractResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Frame extraction failed');
      }

      const extractResult = await extractResponse.json();
      const newFrames = extractResult.frames;

      // Add new frames to allFrames (avoiding duplicates by index)
      const existingIndices = new Set(this.allFrames.map(f => f.index));
      const uniqueNewFrames = newFrames.filter(f => !existingIndices.has(f.index));
      this.allFrames = [...this.allFrames, ...uniqueNewFrames];

      // Analyze frames with GPT-4 Vision
      loading.querySelector('p').textContent = 'Analyzing frames with AI...';

      const analyzeResponse = await fetch('/api/analyze-frames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: Uploader.sessionId,
          frames: uniqueNewFrames.length > 0 ? uniqueNewFrames : newFrames,
          settings: {
            visionModel: settings.visionModel,
          },
        }),
      });

      const analyzeResult = await analyzeResponse.json();

      if (!analyzeResponse.ok) {
        const error = new Error(analyzeResult.error || 'Frame analysis failed');
        error.billingUrl = analyzeResult.billingUrl;
        error.isBillingError = analyzeResult.isBillingError;
        throw error;
      }
      const newRankedFrames = analyzeResult.rankedFrames;

      // Add new ranked frames as a new batch
      this.frameBatches.push(newRankedFrames);
      this.rankedFrames = [...this.rankedFrames, ...newRankedFrames];

      // Render frames in ranked order with batch separators
      this.renderFrameGrid();

      // Auto-select top 3 frames only on first extraction
      if (!isAdditional && this.rankedFrames.length > 0) {
        this.selectedFrames = this.rankedFrames.slice(0, 3).map(f => ({
          ...f,
          selectionId: this.nextSelectionId++
        }));
        this.updateFrameSelectionUI();
        this.showThumbnailEditor();
      } else {
        this.updateFrameSelectionUI();
      }
    } catch (error) {
      console.error('Frame extraction error:', error);
      if (error.billingUrl) {
        // Billing error - show link to add funds
        grid.innerHTML = `
          <div class="billing-error">
            <p class="error">${error.message}</p>
            <a href="${error.billingUrl}" target="_blank" class="btn btn-primary">Add Funds to OpenAI Account</a>
          </div>
        `;
      } else if (!isAdditional) {
        grid.innerHTML = `
          <div class="extraction-error">
            <p class="error">Frame extraction failed: ${error.message}</p>
            <button class="btn btn-primary retry-extraction-btn">Try Again</button>
          </div>
        `;
        grid.querySelector('.retry-extraction-btn').addEventListener('click', () => {
          this.extractFrames(false);
        });
      } else {
        // For additional batches, show error but keep existing frames
        const errorDiv = document.createElement('div');
        errorDiv.className = 'extraction-error';
        errorDiv.innerHTML = `
          <p class="error">Failed to load more images: ${error.message}</p>
          <button class="btn btn-secondary retry-extraction-btn">Try Again</button>
        `;
        errorDiv.querySelector('.retry-extraction-btn').addEventListener('click', () => {
          errorDiv.remove();
          this.extractFrames(true);
        });
        grid.appendChild(errorDiv);
      }
    } finally {
      loading.classList.add('hidden');
    }
  },

  renderFrameGrid() {
    const grid = document.getElementById('frames-grid');
    grid.innerHTML = '';

    let globalRank = 0;

    // Render each batch with a separator between them
    this.frameBatches.forEach((batch, batchIndex) => {
      // Add separator before additional batches
      if (batchIndex > 0) {
        const separator = document.createElement('div');
        separator.className = 'frames-batch-separator';
        separator.innerHTML = `<span>Additional images (batch ${batchIndex + 1})</span>`;
        grid.appendChild(separator);
      }

      // Render frames in this batch
      batch.forEach((frame) => {
        globalRank++;
        const div = document.createElement('div');
        div.className = 'frame-item';
        div.dataset.index = frame.index;

        div.innerHTML = `
          <img src="${frame.url}" alt="Frame ${frame.index}">
          <span class="frame-number">#${globalRank}</span>
          <span class="select-count"></span>
        `;

        div.addEventListener('click', (e) => {
          // If clicking on the checkmark/count badge, unselect all instances of this frame
          if (e.target.classList.contains('select-count')) {
            this.unselectFrame(frame);
          } else {
            this.addFrameSelection(frame);
          }
        });

        grid.appendChild(div);
      });
    });

    // Add "More images" button at the end
    const moreBtn = document.createElement('button');
    moreBtn.className = 'btn btn-secondary more-images-btn';
    moreBtn.innerHTML = '<span class="btn-text">More images</span><span class="btn-spinner hidden"></span>';
    moreBtn.addEventListener('click', async () => {
      // Show loading state
      moreBtn.disabled = true;
      moreBtn.classList.add('loading');
      moreBtn.querySelector('.btn-text').classList.add('hidden');
      moreBtn.querySelector('.btn-spinner').classList.remove('hidden');

      await this.extractFrames(true);

      // Note: extractFrames will re-render the grid including a new button,
      // so we don't need to reset this button's state
    });
    grid.appendChild(moreBtn);
  },

  getSelectionCount(frame) {
    return this.selectedFrames.filter((f) => f.index === frame.index).length;
  },

  updateFrameSelectionUI() {
    const grid = document.getElementById('frames-grid');
    grid.querySelectorAll('.frame-item').forEach((div) => {
      const frameIndex = parseInt(div.dataset.index);
      const count = this.selectedFrames.filter((f) => f.index === frameIndex).length;
      const countEl = div.querySelector('.select-count');

      if (count > 0) {
        div.classList.add('selected');
        countEl.textContent = count > 1 ? count : '\u2713';
      } else {
        div.classList.remove('selected');
        countEl.textContent = '';
      }
    });
  },

  addFrameSelection(frame) {
    const currentCount = this.getSelectionCount(frame);

    if (currentCount < 4) {
      // Add another instance of this frame with a unique selectionId
      this.selectedFrames.push({ ...frame, selectionId: this.nextSelectionId++ });
      this.updateFrameSelectionUI();
      this.showThumbnailEditor();
    }
    // If already at 4, do nothing (user must click checkmark to unselect)
  },

  unselectFrame(frame) {
    // Remove all instances of this frame
    this.selectedFrames = this.selectedFrames.filter((f) => f.index !== frame.index);

    // Update all frame UIs
    this.updateFrameSelectionUI();

    // Update thumbnail editor (or hide if none left)
    if (this.selectedFrames.length > 0) {
      this.showThumbnailEditor();
    } else {
      document.getElementById('thumbnail-section').classList.add('hidden');
    }
  },

  removeEditorAt(index) {
    // Save current overlay states before removing
    if (this.editors.length > 0) {
      this.saveOverlayStates();
    }

    // Get the selectionId of the frame being removed
    const removedSelectionId = this.selectedFrames[index]?.selectionId;

    // Remove the specific entry at the given index from selectedFrames
    this.selectedFrames.splice(index, 1);

    // Remove the state for the deleted selectionId
    if (removedSelectionId !== undefined) {
      this.overlayStates.delete(removedSelectionId);
    }

    // Update the frame grid UI to reflect new selection counts
    this.updateFrameSelectionUI();

    // Re-render thumbnail editors (or hide section if none left)
    if (this.selectedFrames.length > 0) {
      this.showThumbnailEditor();
    } else {
      document.getElementById('thumbnail-section').classList.add('hidden');
    }
  },

  // Save current overlay state for all editors before rebuilding
  saveOverlayStates() {
    this.editors.forEach((editor, editorIndex) => {
      // Editors are rendered in reverse order, so map back to selectedFrames index
      const selectedIndex = this.selectedFrames.length - 1 - editorIndex;
      const frame = this.selectedFrames[selectedIndex];
      if (!frame || frame.selectionId === undefined) return;

      const textOverlay = editor.textOverlay;

      // Extract text content (excluding resize handles)
      let text = '';
      const extractText = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent;
        } else if (node.nodeName === 'BR') {
          text += '\n';
        } else if (node.nodeName === 'DIV' && !node.classList.contains('text-overlay-resize-handle-top') &&
                   !node.classList.contains('text-overlay-resize-handle-left') &&
                   !node.classList.contains('text-overlay-resize-handle-right')) {
          if (text.length > 0 && !text.endsWith('\n')) {
            text += '\n';
          }
          node.childNodes.forEach(extractText);
        }
      };
      textOverlay.childNodes.forEach(extractText);

      // Get active alignment dot
      const activeDot = editor.element.querySelector('.alignment-dot.active');
      const alignment = activeDot ? activeDot.dataset.position : 'bottom-center';

      // Store by selectionId
      this.overlayStates.set(frame.selectionId, {
        text: text.trim(),
        top: textOverlay.style.top,
        left: textOverlay.style.left,
        width: textOverlay.style.width,
        height: textOverlay.style.height,
        fontSize: textOverlay.style.fontSize,
        textAlign: textOverlay.style.textAlign,
        whiteSpace: textOverlay.style.whiteSpace,
        lineHeight: textOverlay.style.lineHeight,
        alignment,
      });
    });
  },

  // Get saved state for a specific selectionId
  getSavedState(selectionId) {
    return this.overlayStates.get(selectionId);
  },

  showThumbnailEditor() {
    const section = document.getElementById('thumbnail-section');
    const container = document.getElementById('thumbnail-editors');

    // Save current overlay states before rebuilding
    if (this.editors.length > 0) {
      this.saveOverlayStates();
    }

    section.classList.remove('hidden');
    container.innerHTML = '';
    this.editors = [];

    // Get thumbnail titles, with fallback defaults if metadata hasn't loaded yet
    let thumbnailTitles = Metadata.getThumbnailTitles();
    if (!thumbnailTitles || thumbnailTitles.length === 0) {
      thumbnailTitles = [
        'Breaking News',
        'Must Watch',
        'The Truth About...',
        'What They Won\'t Tell You',
        'Explained',
        'Deep Dive',
        'Hot Take',
        'Analysis',
      ];
    }

    // Get video titles
    let videoTitles = Metadata.getTitles();
    if (!videoTitles || videoTitles.length === 0) {
      videoTitles = [
        'Sample Title 1',
        'Sample Title 2',
        'Sample Title 3',
      ];
    }

    // Render editors in reverse order (most recently selected first)
    // We iterate backwards through selectedFrames but use the original index for removeEditorAt
    for (let i = this.selectedFrames.length - 1; i >= 0; i--) {
      const frame = this.selectedFrames[i];
      const savedState = this.getSavedState(frame.selectionId);
      const editor = this.createEditor(frame, i, thumbnailTitles, videoTitles, savedState);
      container.appendChild(editor.element);
      this.editors.push(editor);
    }
  },

  createEditor(frame, index, thumbnailTitles, videoTitles, savedState = null) {
    const div = document.createElement('div');
    div.className = 'thumbnail-editor';

    // Create header with trash button
    const header = document.createElement('div');
    header.className = 'thumbnail-editor-header';

    // Create alignment control (3x3 grid)
    const alignControl = document.createElement('div');
    alignControl.className = 'alignment-control';
    alignControl.title = 'Text alignment';

    // Create 9 dots for the 3x3 grid
    const positions = [
      'top-left', 'top-center', 'top-right',
      'middle-left', 'middle-center', 'middle-right',
      'bottom-left', 'bottom-center', 'bottom-right'
    ];

    // Use saved alignment or default to bottom-center
    const activeAlignment = savedState?.alignment || 'bottom-center';

    positions.forEach(pos => {
      const dot = document.createElement('div');
      dot.className = 'alignment-dot' + (pos === activeAlignment ? ' active' : '');
      dot.dataset.position = pos;
      dot.title = pos.replace('-', ' ');
      alignControl.appendChild(dot);
    });

    const trashBtn = document.createElement('button');
    trashBtn.className = 'thumbnail-trash-btn';
    trashBtn.innerHTML = '🗑️';
    trashBtn.title = 'Remove this thumbnail';
    trashBtn.addEventListener('click', () => {
      this.removeEditorAt(index);
    });

    header.appendChild(alignControl);
    header.appendChild(trashBtn);
    div.appendChild(header);

    // Create canvas container
    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'thumbnail-canvas-container';
    canvasContainer.style.position = 'relative';

    const img = document.createElement('img');
    img.className = 'thumbnail-canvas';
    img.src = frame.url;

    const textOverlay = document.createElement('div');
    textOverlay.className = 'text-overlay';
    textOverlay.contentEditable = true;
    // Use saved text or default to first thumbnail title
    textOverlay.textContent = savedState?.text || thumbnailTitles[0] || 'Add text here';
    textOverlay.style.fontFamily = this.settings.font;
    textOverlay.style.background = this.settings.bgColor;
    textOverlay.style.color = this.settings.textColor;
    textOverlay.style.bottom = '0'; // Initial position at bottom until image loads

    // Add resize handles (top for vertical, left/right for horizontal)
    const resizeHandleTop = document.createElement('div');
    resizeHandleTop.className = 'text-overlay-resize-handle-top';
    const resizeHandleLeft = document.createElement('div');
    resizeHandleLeft.className = 'text-overlay-resize-handle-left';
    const resizeHandleRight = document.createElement('div');
    resizeHandleRight.className = 'text-overlay-resize-handle-right';
    textOverlay.appendChild(resizeHandleTop);
    textOverlay.appendChild(resizeHandleLeft);
    textOverlay.appendChild(resizeHandleRight);

    // Make text draggable and resizable
    this.makeDraggable(textOverlay, canvasContainer);
    this.makeResizableFromTop(textOverlay, resizeHandleTop, canvasContainer);
    this.makeHorizontalResizable(textOverlay, resizeHandleLeft, resizeHandleRight, canvasContainer);

    // Auto-scale font when image loads and position at bottom
    img.onload = () => {
      // Clear bottom positioning (for drag/resize to work properly)
      textOverlay.style.bottom = '';

      if (savedState) {
        // Restore saved state
        if (savedState.top) textOverlay.style.top = savedState.top;
        if (savedState.left) textOverlay.style.left = savedState.left;
        if (savedState.width) textOverlay.style.width = savedState.width;
        if (savedState.height) textOverlay.style.height = savedState.height;
        if (savedState.fontSize) textOverlay.style.fontSize = savedState.fontSize;
        if (savedState.textAlign) textOverlay.style.textAlign = savedState.textAlign;
        if (savedState.whiteSpace) textOverlay.style.whiteSpace = savedState.whiteSpace;
        if (savedState.lineHeight) textOverlay.style.lineHeight = savedState.lineHeight;
      } else {
        // Initial render: auto-scale and position at bottom
        this.autoScaleFont(textOverlay, canvasContainer, img, true); // isInitialRender = true
        // Position thumbnail title so its bottom edge aligns with the bottom of the image
        const imgHeight = img.clientHeight;
        const overlayHeight = textOverlay.offsetHeight;
        textOverlay.style.top = `${imgHeight - overlayHeight}px`;
      }
    };

    // Auto-scale font when user edits the text directly
    textOverlay.addEventListener('input', () => {
      // Rescale font to fit within current box dimensions
      this.autoScaleFont(textOverlay, canvasContainer, img, false);
    });

    canvasContainer.appendChild(img);
    canvasContainer.appendChild(textOverlay);

    // Add click handlers for alignment dots
    alignControl.querySelectorAll('.alignment-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        // Update active dot
        alignControl.querySelectorAll('.alignment-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        // Apply alignment
        this.alignTextOverlay(textOverlay, img, dot.dataset.position);
      });
    });

    // Create thumbnail title options in two columns
    const optionsDiv = document.createElement('div');
    optionsDiv.className = 'thumbnail-options';
    optionsDiv.innerHTML = '<h4>Thumbnail Titles (click to select)</h4>';

    const optionsGrid = document.createElement('div');
    optionsGrid.className = 'thumbnail-options-grid';

    thumbnailTitles.slice(0, 20).forEach((title, i) => {
      const option = document.createElement('div');
      option.className = 'thumbnail-option' + (i === 0 ? ' active' : '');
      option.textContent = title;

      // Click to apply this title to the overlay
      option.addEventListener('click', () => {
        // Preserve resize handles when setting text
        textOverlay.textContent = title;
        textOverlay.appendChild(resizeHandleTop);
        textOverlay.appendChild(resizeHandleLeft);
        textOverlay.appendChild(resizeHandleRight);
        optionsGrid.querySelectorAll('.thumbnail-option').forEach((o) => o.classList.remove('active'));
        option.classList.add('active');
        // Re-scale font and resize box for new text
        textOverlay.style.height = ''; // Reset height so it recalculates
        this.autoScaleFont(textOverlay, canvasContainer, img, true);
        // Re-position at bottom after height change
        const imgHeight = img.clientHeight;
        const overlayHeight = textOverlay.offsetHeight;
        textOverlay.style.top = `${imgHeight - overlayHeight}px`;
      });

      optionsGrid.appendChild(option);
    });

    optionsDiv.appendChild(optionsGrid);

    // Create video titles section (editable, copyable, two columns)
    const titlesDiv = document.createElement('div');
    titlesDiv.className = 'video-titles-section';
    titlesDiv.innerHTML = '<h4>Video Titles (click to copy, double-click to edit)</h4>';

    const titlesGrid = document.createElement('div');
    titlesGrid.className = 'video-titles-grid';

    videoTitles.forEach((title, i) => {
      const titleItem = document.createElement('div');
      titleItem.className = 'video-title-item';

      const titleText = document.createElement('span');
      titleText.className = 'video-title-text';
      titleText.textContent = title;
      titleText.contentEditable = false;

      const copyBtn = document.createElement('button');
      copyBtn.className = 'video-title-copy-btn';
      copyBtn.innerHTML = '📋';
      copyBtn.title = 'Copy to clipboard';

      // Single click to copy
      const copyTitle = () => {
        const text = titleText.textContent;
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.innerHTML = '✓';
          titleItem.classList.add('copied');
          setTimeout(() => {
            copyBtn.innerHTML = '📋';
            titleItem.classList.remove('copied');
          }, 1000);
        });
      };

      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyTitle();
      });

      titleText.addEventListener('click', () => {
        if (!titleText.isContentEditable) {
          copyTitle();
        }
      });

      // Double-click to edit
      titleText.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        titleText.contentEditable = true;
        titleText.classList.add('editing');
        titleText.focus();
        // Select all text
        const range = document.createRange();
        range.selectNodeContents(titleText);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });

      // Exit edit mode on blur or Enter
      titleText.addEventListener('blur', () => {
        titleText.contentEditable = false;
        titleText.classList.remove('editing');
      });

      titleText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          titleText.blur();
        }
        if (e.key === 'Escape') {
          titleText.blur();
        }
      });

      titleItem.appendChild(titleText);
      titleItem.appendChild(copyBtn);
      titlesGrid.appendChild(titleItem);
    });

    titlesDiv.appendChild(titlesGrid);

    div.appendChild(canvasContainer);
    div.appendChild(optionsDiv);
    div.appendChild(titlesDiv);

    return {
      element: div,
      frame,
      img,
      textOverlay,
      canvasContainer,
      resizeHandleTop,
      resizeHandleLeft,
      resizeHandleRight,
    };
  },

  makeDraggable(element, container) {
    let isDragging = false;
    let hasMoved = false;
    let startX, startY, startTop, startLeft;
    const DRAG_THRESHOLD = 5; // pixels to move before starting drag

    element.addEventListener('mousedown', (e) => {
      // Don't drag from resize handles
      if (e.target.classList.contains('text-overlay-resize-handle-top') ||
          e.target.classList.contains('text-overlay-resize-handle-left') ||
          e.target.classList.contains('text-overlay-resize-handle-right')) return;

      // Store initial position but don't start dragging yet
      startX = e.clientX;
      startY = e.clientY;
      startTop = element.offsetTop;
      startLeft = element.offsetLeft;
      hasMoved = false;
      isDragging = true;
      // Don't prevent default yet - allow click to focus for editing
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Only start actual dragging after moving past threshold
      if (!hasMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
        return;
      }

      // First movement past threshold - prevent text selection and start drag
      if (!hasMoved) {
        hasMoved = true;
        element.style.cursor = 'grabbing';
        // Blur to exit edit mode if we're dragging
        element.blur();
        // Prevent text selection during drag
        e.preventDefault();
      }

      // Calculate bounds - constrain to stay within image
      const containerWidth = container.offsetWidth;
      const containerHeight = container.offsetHeight;
      const elementWidth = element.offsetWidth;
      const elementHeight = element.offsetHeight;

      // Constrain both horizontal and vertical position to stay within frame
      const newLeft = Math.max(0, Math.min(startLeft + dx, containerWidth - elementWidth));
      const newTop = Math.max(0, Math.min(startTop + dy, containerHeight - elementHeight));
      element.style.left = `${newLeft}px`;
      element.style.top = `${newTop}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        hasMoved = false;
        element.style.cursor = '';
      }
    });
  },

  makeResizableFromTop(element, handle, container) {
    let isResizing = false;
    let startY, startHeight, startTop;
    const self = this;

    handle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      isResizing = true;
      startY = e.clientY;
      startHeight = element.offsetHeight;
      startTop = element.offsetTop;
      element.classList.add('resizing');
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;

      const dy = e.clientY - startY;
      // Resizing from top: move top up and increase height
      // dy negative = moving up = increase height, dy positive = moving down = decrease height
      const newTop = Math.max(0, startTop + dy);
      const newHeight = Math.max(40, startHeight - dy);
      // Make sure the box doesn't go above the container
      if (newTop >= 0) {
        element.style.top = `${newTop}px`;
        element.style.height = `${newHeight}px`;
        // Recalculate optimal font size for the new box dimensions (user resize mode)
        const img = container.querySelector('img');
        if (img) {
          self.autoScaleFont(element, container, img, false, true); // isUserResize = true
        }
      }
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        element.classList.remove('resizing');
      }
    });
  },

  makeHorizontalResizable(element, handleLeft, handleRight, container) {
    let isResizingLeft = false;
    let isResizingRight = false;
    let startX, startWidth, startLeft;
    const self = this;

    const startResize = (e, isLeft) => {
      e.stopPropagation();
      e.preventDefault();
      if (isLeft) {
        isResizingLeft = true;
      } else {
        isResizingRight = true;
      }
      startX = e.clientX;
      startWidth = element.offsetWidth;
      startLeft = element.offsetLeft;
      element.classList.add('resizing');
    };

    handleLeft.addEventListener('mousedown', (e) => startResize(e, true));
    handleRight.addEventListener('mousedown', (e) => startResize(e, false));

    document.addEventListener('mousemove', (e) => {
      if (!isResizingLeft && !isResizingRight) return;

      const containerWidth = container.offsetWidth;
      const dx = e.clientX - startX;

      if (isResizingLeft) {
        // Resizing from left: move left edge and adjust width
        const newLeft = Math.max(0, Math.min(startLeft + dx, startLeft + startWidth - 50));
        const newWidth = startWidth - (newLeft - startLeft);
        element.style.left = `${newLeft}px`;
        element.style.width = `${newWidth}px`;
      } else if (isResizingRight) {
        // Resizing from right: just adjust width
        const newWidth = Math.max(50, Math.min(startWidth + dx, containerWidth - startLeft));
        element.style.width = `${newWidth}px`;
      }

      // Recalculate optimal font size for the new width (user resize mode)
      const img = container.querySelector('img');
      if (img) {
        self.autoScaleFont(element, container, img, false, true); // isUserResize = true
      }
    });

    document.addEventListener('mouseup', () => {
      if (isResizingLeft || isResizingRight) {
        isResizingLeft = false;
        isResizingRight = false;
        element.classList.remove('resizing');
      }
    });
  },

  /**
   * Auto-scale font to fit within the text overlay box
   * @param {HTMLElement} textOverlay - The text overlay element
   * @param {HTMLElement} container - The container element
   * @param {HTMLImageElement} img - The image element
   * @param {boolean} isInitialRender - True if this is the first render (allows box resizing)
   * @param {boolean} isUserResize - True if user is manually resizing the box (use current box as fixed constraint)
   */
  autoScaleFont(textOverlay, container, img, isInitialRender = false, isUserResize = false) {
    // Get dimensions
    const containerHeight = img.clientHeight;
    const overlayWidth = textOverlay.offsetWidth;
    const horizontalPadding = 32; // 16px padding on each side
    const availableWidth = overlayWidth - horizontalPadding;
    const maxAllowedHeight = containerHeight * 0.25; // Allow up to 25% of image height

    // Get current box dimensions
    const currentOverlayHeight = textOverlay.offsetHeight;
    const currentTop = textOverlay.offsetTop;

    // Get text content (filter out resize handle elements)
    // Browsers may insert <div> or <br> when pressing Enter in contenteditable
    let text = '';
    const extractText = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeName === 'BR') {
        text += '\n';
      } else if (node.nodeName === 'DIV' && !node.classList.contains('text-overlay-resize-handle-top') &&
                 !node.classList.contains('text-overlay-resize-handle-left') &&
                 !node.classList.contains('text-overlay-resize-handle-right')) {
        // DIVs created by Enter key - add newline before content (except first)
        if (text.length > 0 && !text.endsWith('\n')) {
          text += '\n';
        }
        node.childNodes.forEach(extractText);
      }
    };
    textOverlay.childNodes.forEach(extractText);
    text = text.trim();
    if (!text) return;

    // Check if text has newlines (multi-line)
    const hasNewlines = text.includes('\n');
    const lines = text.split('\n');

    // Create a temporary element to measure text
    const tempEl = document.createElement('div');
    tempEl.style.visibility = 'hidden';
    tempEl.style.position = 'absolute';
    tempEl.style.fontFamily = this.settings.font;
    tempEl.style.fontWeight = '700';
    tempEl.style.lineHeight = hasNewlines ? '1.0' : 'normal';
    document.body.appendChild(tempEl);

    // Step 1: Find the largest font size that fits width for all lines
    let minSize = 8;
    let maxSize = 200;
    let widthOptimalSize = minSize;

    while (minSize <= maxSize) {
      const midSize = Math.floor((minSize + maxSize) / 2);
      tempEl.style.fontSize = `${midSize}px`;
      tempEl.style.whiteSpace = 'nowrap';

      let allLinesFit = true;
      for (const line of lines) {
        tempEl.textContent = line || ' ';
        if (tempEl.offsetWidth > availableWidth) {
          allLinesFit = false;
          break;
        }
      }

      if (allLinesFit) {
        widthOptimalSize = midSize;
        minSize = midSize + 1;
      } else {
        maxSize = midSize - 1;
      }
    }

    // Step 2: Measure height at the width-optimal font size
    tempEl.style.fontSize = `${widthOptimalSize}px`;
    tempEl.style.whiteSpace = hasNewlines ? 'pre' : 'nowrap';
    tempEl.style.lineHeight = hasNewlines ? '1.0' : 'normal';
    tempEl.textContent = text;
    const heightAtWidthOptimal = tempEl.offsetHeight;

    // Step 3: Determine target height and whether box should resize
    let targetHeight;
    let newBoxHeight = null; // Will be set if we need to resize the box

    // Calculate how much height the text needs (with padding)
    const neededHeight = heightAtWidthOptimal * 1.15;

    if (isUserResize) {
      // User is manually resizing - use current box height as fixed constraint
      targetHeight = currentOverlayHeight;
    } else if (isInitialRender) {
      // Initial render: size box to fit text (up to max)
      targetHeight = Math.min(neededHeight, maxAllowedHeight);
      newBoxHeight = targetHeight;
    } else {
      // Text editing: determine if we need to grow the box or shrink the font
      if (neededHeight <= currentOverlayHeight) {
        // Text fits in current box - use current height as target
        targetHeight = currentOverlayHeight;
      } else if (neededHeight <= maxAllowedHeight) {
        // Text needs more space but within max - grow the box
        targetHeight = neededHeight;
        newBoxHeight = neededHeight;
      } else {
        // Text needs more than max - box stays at current size, font must shrink
        // Use min of current height and max to ensure we never exceed max
        targetHeight = Math.min(currentOverlayHeight, maxAllowedHeight);
      }
    }

    // Step 4: Find font size that fits both width AND the determined target height
    let optimalSize = widthOptimalSize;

    // Check if text at width-optimal font size fits within target height
    // neededHeight includes padding factor; compare it to targetHeight
    if (neededHeight > targetHeight) {
      // Need to shrink font to fit height
      minSize = 8;
      maxSize = widthOptimalSize;
      optimalSize = minSize;

      while (minSize <= maxSize) {
        const midSize = Math.floor((minSize + maxSize) / 2);
        tempEl.style.fontSize = `${midSize}px`;
        tempEl.style.whiteSpace = hasNewlines ? 'pre' : 'nowrap';
        tempEl.style.lineHeight = hasNewlines ? '1.0' : 'normal';
        tempEl.textContent = text;

        // Font fits if text height (with padding) is within target
        const textHeightWithPadding = tempEl.offsetHeight * 1.15;
        if (textHeightWithPadding <= targetHeight) {
          optimalSize = midSize;
          minSize = midSize + 1;
        } else {
          maxSize = midSize - 1;
        }
      }
    }

    document.body.removeChild(tempEl);

    // Apply the optimal font size
    textOverlay.style.fontSize = `${optimalSize}px`;
    textOverlay.style.lineHeight = hasNewlines ? '1.0' : 'normal';
    textOverlay.style.whiteSpace = hasNewlines ? 'pre' : 'nowrap';
    // Ensure no scrollbars appear - text must fit within box
    textOverlay.style.overflow = 'hidden';

    // Resize the box if needed
    if (newBoxHeight !== null) {
      const oldHeight = currentOverlayHeight;
      textOverlay.style.height = `${newBoxHeight}px`;

      // For non-initial render, grow upward (adjust top position)
      if (!isInitialRender && newBoxHeight > oldHeight) {
        const heightDiff = newBoxHeight - oldHeight;
        const newTop = Math.max(0, currentTop - heightDiff);
        textOverlay.style.top = `${newTop}px`;
      }
    }
  },

  /**
   * Align the text overlay to a specific position within the image
   * @param {HTMLElement} textOverlay - The text overlay element
   * @param {HTMLImageElement} img - The image element
   * @param {string} position - Position like 'top-left', 'middle-center', 'bottom-right'
   */
  alignTextOverlay(textOverlay, img, position) {
    const imgWidth = img.clientWidth;
    const imgHeight = img.clientHeight;

    // Parse position
    const [vertical, horizontal] = position.split('-');

    // Special handling for middle-left and middle-right: vertical sidebar mode
    if (vertical === 'middle' && (horizontal === 'left' || horizontal === 'right')) {
      this.applyVerticalSidebarMode(textOverlay, img, horizontal);
      return;
    }

    const container = textOverlay.parentElement;
    const horizontalPadding = 32;

    // Get text content
    let text = '';
    const extractText = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeName === 'BR') {
        text += '\n';
      } else if (node.nodeName === 'DIV' && !node.classList.contains('text-overlay-resize-handle-top') &&
                 !node.classList.contains('text-overlay-resize-handle-left') &&
                 !node.classList.contains('text-overlay-resize-handle-right')) {
        if (text.length > 0 && !text.endsWith('\n')) {
          text += '\n';
        }
        node.childNodes.forEach(extractText);
      }
    };
    textOverlay.childNodes.forEach(extractText);
    text = text.trim();
    if (!text) return;

    // For center positions, use full width horizontal bar
    if (horizontal === 'center') {
      textOverlay.style.width = '100%';
      textOverlay.style.left = '0px';
      textOverlay.style.textAlign = 'center';

      // Recalculate font size for full width
      this.autoScaleFont(textOverlay, container, img, true);
    } else {
      // For left/right: first set full width to get proper font scaling
      textOverlay.style.width = '100%';
      textOverlay.style.left = '0px';

      // Recalculate font size at full width first
      this.autoScaleFont(textOverlay, container, img, true);

      // Now measure the actual text width at the new font size
      const tempEl = document.createElement('div');
      tempEl.style.visibility = 'hidden';
      tempEl.style.position = 'absolute';
      tempEl.style.fontFamily = this.settings.font;
      tempEl.style.fontWeight = '700';
      tempEl.style.whiteSpace = 'nowrap';
      document.body.appendChild(tempEl);

      const currentFontSize = parseInt(textOverlay.style.fontSize) || 24;
      tempEl.style.fontSize = `${currentFontSize}px`;

      const lines = text.split('\n');
      let maxTextWidth = 0;
      for (const line of lines) {
        tempEl.textContent = line || ' ';
        maxTextWidth = Math.max(maxTextWidth, tempEl.offsetWidth);
      }
      document.body.removeChild(tempEl);

      // Size box to fit text width (with padding)
      const boxWidth = Math.min(maxTextWidth + horizontalPadding, imgWidth);
      textOverlay.style.width = `${boxWidth}px`;
      textOverlay.style.textAlign = 'center'; // Center text within the box

      // Position box at the correct edge
      if (horizontal === 'left') {
        textOverlay.style.left = '0px';
      } else {
        textOverlay.style.left = `${imgWidth - boxWidth}px`;
      }
    }

    const overlayHeight = textOverlay.offsetHeight;

    // Calculate vertical position
    let top;
    switch (vertical) {
      case 'top':
        top = 0;
        break;
      case 'middle':
        top = (imgHeight - overlayHeight) / 2;
        break;
      case 'bottom':
      default:
        top = imgHeight - overlayHeight;
        break;
    }

    // Apply vertical position
    textOverlay.style.top = `${top}px`;
  },

  /**
   * Apply vertical sidebar mode for middle-left or middle-right alignment
   * Box spans full height, max 33% width, text wraps to new lines
   */
  applyVerticalSidebarMode(textOverlay, img, side) {
    const imgWidth = img.clientWidth;
    const imgHeight = img.clientHeight;
    const maxWidth = imgWidth * 0.33;
    const horizontalPadding = 32;

    // Get text content
    let text = '';
    const extractText = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeName === 'BR') {
        text += '\n';
      } else if (node.nodeName === 'DIV' && !node.classList.contains('text-overlay-resize-handle-top') &&
                 !node.classList.contains('text-overlay-resize-handle-left') &&
                 !node.classList.contains('text-overlay-resize-handle-right')) {
        if (text.length > 0 && !text.endsWith('\n')) {
          text += '\n';
        }
        node.childNodes.forEach(extractText);
      }
    };
    textOverlay.childNodes.forEach(extractText);
    text = text.trim();
    if (!text) return;

    // Split text into words for wrapping
    const words = text.replace(/\n/g, ' ').split(/\s+/);

    // Create temp element for measuring
    const tempEl = document.createElement('div');
    tempEl.style.visibility = 'hidden';
    tempEl.style.position = 'absolute';
    tempEl.style.fontFamily = this.settings.font;
    tempEl.style.fontWeight = '700';
    tempEl.style.whiteSpace = 'pre';
    tempEl.style.lineHeight = '1.0';
    document.body.appendChild(tempEl);

    // Binary search for optimal font size that fits text within constraints
    let minSize = 8;
    let maxSize = 200;
    let optimalSize = minSize;
    let optimalLines = words.join('\n'); // Start with one word per line
    let optimalWidth = maxWidth;

    while (minSize <= maxSize) {
      const midSize = Math.floor((minSize + maxSize) / 2);
      tempEl.style.fontSize = `${midSize}px`;

      // Try to wrap text to fit within maxWidth and imgHeight
      const result = this.wrapTextForVertical(tempEl, words, maxWidth - horizontalPadding, imgHeight, midSize);

      if (result.fits) {
        optimalSize = midSize;
        optimalLines = result.lines;
        optimalWidth = result.width + horizontalPadding;
        minSize = midSize + 1;
      } else {
        maxSize = midSize - 1;
      }
    }

    document.body.removeChild(tempEl);

    // Apply the vertical sidebar style
    textOverlay.style.top = '0px';
    textOverlay.style.height = `${imgHeight}px`;
    textOverlay.style.width = `${Math.min(optimalWidth, maxWidth)}px`;
    textOverlay.style.fontSize = `${optimalSize}px`;
    textOverlay.style.lineHeight = '1.0';
    textOverlay.style.whiteSpace = 'pre';
    textOverlay.style.textAlign = 'center';

    if (side === 'left') {
      textOverlay.style.left = '0px';
    } else {
      textOverlay.style.left = `${imgWidth - Math.min(optimalWidth, maxWidth)}px`;
    }

    // Update text content with line breaks (preserve resize handles)
    const handles = textOverlay.querySelectorAll('[class^="text-overlay-resize-handle"]');
    textOverlay.textContent = optimalLines;
    handles.forEach(h => textOverlay.appendChild(h));
  },

  /**
   * Wrap words to fit within width and height constraints for vertical mode
   */
  wrapTextForVertical(tempEl, words, maxWidth, maxHeight, fontSize) {
    // Try different wrapping strategies to find the best fit
    // Strategy: Put each word on its own line and measure
    const lines = [];
    let currentLine = '';
    let maxLineWidth = 0;

    for (const word of words) {
      if (currentLine) {
        // Try adding word to current line
        const testLine = currentLine + ' ' + word;
        tempEl.textContent = testLine;
        if (tempEl.offsetWidth <= maxWidth) {
          currentLine = testLine;
        } else {
          // Word doesn't fit, start new line
          tempEl.textContent = currentLine;
          maxLineWidth = Math.max(maxLineWidth, tempEl.offsetWidth);
          lines.push(currentLine);
          currentLine = word;
        }
      } else {
        currentLine = word;
      }
    }

    // Add last line
    if (currentLine) {
      tempEl.textContent = currentLine;
      maxLineWidth = Math.max(maxLineWidth, tempEl.offsetWidth);
      lines.push(currentLine);
    }

    // Measure total height
    const wrappedText = lines.join('\n');
    tempEl.textContent = wrappedText;
    const totalHeight = tempEl.offsetHeight;

    // Check if it fits with some padding
    const fits = totalHeight <= maxHeight * 0.9 && maxLineWidth <= maxWidth;

    return {
      fits,
      lines: wrappedText,
      width: maxLineWidth,
      height: totalHeight
    };
  },

  /**
   * Refresh thumbnail titles and video titles in all editors when metadata becomes available
   */
  refreshMetadataOptions() {
    const thumbnailTitles = Metadata.getThumbnailTitles();
    const videoTitles = Metadata.getTitles();

    if ((!thumbnailTitles || thumbnailTitles.length === 0) && (!videoTitles || videoTitles.length === 0)) {
      return; // No metadata available yet
    }

    this.editors.forEach((editor) => {
      const editorElement = editor.element;

      // Update thumbnail title options
      if (thumbnailTitles && thumbnailTitles.length > 0) {
        const optionsGrid = editorElement.querySelector('.thumbnail-options-grid');
        if (optionsGrid) {
          optionsGrid.innerHTML = '';

          thumbnailTitles.slice(0, 20).forEach((title, i) => {
            const option = document.createElement('div');
            option.className = 'thumbnail-option' + (i === 0 ? ' active' : '');
            option.textContent = title;

            option.addEventListener('click', () => {
              // Preserve resize handles when setting text
              const textOverlay = editor.textOverlay;
              const handles = textOverlay.querySelectorAll('[class^="text-overlay-resize-handle"]');
              textOverlay.textContent = title;
              handles.forEach(h => textOverlay.appendChild(h));

              optionsGrid.querySelectorAll('.thumbnail-option').forEach((o) => o.classList.remove('active'));
              option.classList.add('active');

              // Re-scale font and resize box for new text
              textOverlay.style.height = '';
              this.autoScaleFont(textOverlay, editor.canvasContainer, editor.img, true);

              // Re-position at bottom after height change
              const imgHeight = editor.img.clientHeight;
              const overlayHeight = textOverlay.offsetHeight;
              textOverlay.style.top = `${imgHeight - overlayHeight}px`;
            });

            optionsGrid.appendChild(option);
          });

          // Also update the text overlay with the first thumbnail title
          const textOverlay = editor.textOverlay;
          const handles = textOverlay.querySelectorAll('[class^="text-overlay-resize-handle"]');
          textOverlay.textContent = thumbnailTitles[0];
          handles.forEach(h => textOverlay.appendChild(h));
          this.autoScaleFont(textOverlay, editor.canvasContainer, editor.img, true);
          const imgHeight = editor.img.clientHeight;
          const overlayHeight = textOverlay.offsetHeight;
          textOverlay.style.top = `${imgHeight - overlayHeight}px`;
        }
      }

      // Update video titles
      if (videoTitles && videoTitles.length > 0) {
        const titlesGrid = editorElement.querySelector('.video-titles-grid');
        if (titlesGrid) {
          titlesGrid.innerHTML = '';

          videoTitles.forEach((title) => {
            const titleItem = document.createElement('div');
            titleItem.className = 'video-title-item';

            const titleText = document.createElement('span');
            titleText.className = 'video-title-text';
            titleText.textContent = title;
            titleText.contentEditable = false;

            const copyBtn = document.createElement('button');
            copyBtn.className = 'video-title-copy-btn';
            copyBtn.innerHTML = '📋';
            copyBtn.title = 'Copy to clipboard';

            const copyTitle = () => {
              const text = titleText.textContent;
              navigator.clipboard.writeText(text).then(() => {
                copyBtn.innerHTML = '✓';
                titleItem.classList.add('copied');
                setTimeout(() => {
                  copyBtn.innerHTML = '📋';
                  titleItem.classList.remove('copied');
                }, 1000);
              });
            };

            copyBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              copyTitle();
            });

            titleText.addEventListener('click', () => {
              if (!titleText.isContentEditable) {
                copyTitle();
              }
            });

            titleText.addEventListener('dblclick', (e) => {
              e.stopPropagation();
              titleText.contentEditable = true;
              titleText.classList.add('editing');
              titleText.focus();
              const range = document.createRange();
              range.selectNodeContents(titleText);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            });

            titleText.addEventListener('blur', () => {
              titleText.contentEditable = false;
              titleText.classList.remove('editing');
            });

            titleText.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                titleText.blur();
              }
              if (e.key === 'Escape') {
                titleText.blur();
              }
            });

            titleItem.appendChild(titleText);
            titleItem.appendChild(copyBtn);
            titlesGrid.appendChild(titleItem);
          });
        }
      }
    });
  },

  async downloadAll() {
    for (let i = 0; i < this.editors.length; i++) {
      await this.downloadThumbnail(this.editors[i], i + 1);
    }
  },

  async downloadThumbnail(editor, index) {
    const { img, textOverlay } = editor;

    // Create canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Wait for image to load
    await new Promise((resolve) => {
      if (img.complete) resolve();
      else img.onload = resolve;
    });

    // Set canvas size to image natural size
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    // Draw image
    ctx.drawImage(img, 0, 0);

    // Calculate scale factor
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;

    // Get text overlay dimensions and position
    const overlayTop = textOverlay.offsetTop * scaleY;
    const overlayLeft = textOverlay.offsetLeft * scaleX;
    const overlayWidth = textOverlay.offsetWidth * scaleX;
    const overlayHeight = textOverlay.offsetHeight * scaleY;

    // Get computed styles
    const computedStyle = window.getComputedStyle(textOverlay);
    const fontSizeNum = parseFloat(computedStyle.fontSize) * scaleX;
    const fontFamily = computedStyle.fontFamily;

    // Draw background (respecting width and position)
    ctx.fillStyle = this.settings.bgColor;
    ctx.fillRect(overlayLeft, overlayTop, overlayWidth, overlayHeight);

    // Get text content (exclude resize handle text if any)
    let text = textOverlay.textContent.trim();

    // Draw text centered within the overlay
    ctx.fillStyle = this.settings.textColor;
    ctx.font = `bold ${fontSizeNum}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, overlayLeft + overlayWidth / 2, overlayTop + overlayHeight / 2);

    // Download
    const link = document.createElement('a');
    link.download = `thumbnail_${index}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  },
};
