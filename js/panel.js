// === panel.js ===
// The floating side panel, and the smaller resize popup below it: both
// are just dragging + show/hide, same pattern, two independent instances.

(function () {
  const panel = document.getElementById('panel');
  const head = document.getElementById('panelHead');
  const closeBtn = document.getElementById('panelClose');
  const menuToggle = document.getElementById('menuToggle');
  const hintBtn = document.getElementById('hintBtn');
  const hintReturnBtn = document.getElementById('hintReturnBtn');
  const defaultView = document.getElementById('panelDefaultView');
  const hintView = document.getElementById('panelHintView');

  hintBtn.addEventListener('click', () => {
    defaultView.classList.add('hidden');
    hintView.classList.remove('hidden');
  });

  hintReturnBtn.addEventListener('click', () => {
    hintView.classList.add('hidden');
    defaultView.classList.remove('hidden');
  });

  let dragging = false;
  let offX = 0, offY = 0;

  head.addEventListener('mousedown', (e) => {
    // Don't start a drag if clicked the close button
    if (e.target === closeBtn) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    let x = e.clientX - offX;
    let y = e.clientY - offY;

    // Keep it from getting dragged completely off-screen
    x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, x));
    y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, y));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  closeBtn.addEventListener('click', () => {
    panel.classList.add('hidden');
    menuToggle.classList.remove('hidden');
    hintView.classList.add('hidden');
    defaultView.classList.remove('hidden');
  });

  menuToggle.addEventListener('click', () => {
    panel.classList.remove('hidden');
    menuToggle.classList.add('hidden');
  });
})();

// Resize popup: the same drag-by-header + close-button behavior as the
// main panel above, just a second, independent instance of it.
(function () {
  const popup = document.getElementById('resizePopup');
  const head = document.getElementById('resizePopupHead');
  const closeBtn = document.getElementById('resizePopupClose');
  const toolBtn = document.getElementById('resizeToolBtn');

  let dragging = false;
  let offX = 0, offY = 0;

  head.addEventListener('mousedown', (e) => {
    if (e.target === closeBtn) return;
    dragging = true;
    const rect = popup.getBoundingClientRect();
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    let x = e.clientX - offX;
    let y = e.clientY - offY;
    x = Math.max(0, Math.min(window.innerWidth - popup.offsetWidth, x));
    y = Math.max(0, Math.min(window.innerHeight - popup.offsetHeight, y));
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  closeBtn.addEventListener('click', () => {
    popup.classList.add('hidden');
  });

  // The toolbar button toggles rather than just opening.
  toolBtn.addEventListener('click', () => {
    popup.classList.toggle('hidden');
  });
})();
