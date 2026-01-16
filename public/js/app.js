// Main application initialization

document.addEventListener('DOMContentLoaded', () => {
  // Initialize all modules
  Prompts.init();
  Settings.init();
  Uploader.init();
  Player.init();
  Transcript.init();
  Metadata.init();
  Thumbnails.init();

  // Reset button
  document.getElementById('reset-btn').addEventListener('click', resetApp);

  // Update version info with current time
  updateVersionTime();

  console.log('The Algo Whisperer app initialized');
});

// Reset the entire app to initial state - just reload the page
function resetApp() {
  window.location.reload();
}

// Update the version footer with current time
function updateVersionTime() {
  const versionEl = document.getElementById('version-info');
  if (versionEl) {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const ampm = hours >= 12 ? 'pm' : 'am';
    const hour12 = hours % 12 || 12;
    const timeStr = `${hour12}:${minutes.toString().padStart(2, '0')}${ampm}`;
    versionEl.textContent = `Updated January 12, 2025 at ${timeStr}`;
  }
}
