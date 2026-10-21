const TRANSPARENCY_KEY = 'easyadb.inventory-transparency';
const DEFAULT_TRANSPARENCY = 20;
const MAX_TRANSPARENCY = 60;
const TRANSPARENCY_STEP = 5;

// Drawer presentation only; editing dialogs protect ordinary outside presses.
// Projection/fullscreen actions may close it explicitly. No idle timer.
export function createInventoryDrawer({ documentRef, storage }) {
  const getElement = (id) => documentRef.getElementById(id);
  const drawer = getElement('inventoryDrawer');
  const panel = getElement('inventoryPanel');
  const toggle = getElement('inventoryToggle');
  const opacity = getElement('inventoryOpacity');

  function collapse(force = false) {
    if (!drawer.classList.contains('is-open')) return;
    if (!force && [...documentRef.querySelectorAll('dialog')].some((dialog) => dialog.open)) return;
    drawer.classList.remove('is-open');
    panel.inert = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', '展开设备管理');
    toggle.title = '展开设备管理';
  }

  function expand() {
    if (documentRef.fullscreenElement) return;
    panel.inert = false;
    drawer.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', '收起设备管理');
    toggle.title = '收起设备管理';
  }

  function syncFullscreen() {
    const active = Boolean(documentRef.fullscreenElement);
    documentRef.body.classList.toggle('video-fullscreen-active', active);
    toggle.disabled = active;
    if (active) collapse(true);
  }

  function updateOpacity(raw) {
    const amount = Number(raw);
    const value = Number.isFinite(amount)
      ? Math.max(
          0,
          Math.min(MAX_TRANSPARENCY, Math.round(amount / TRANSPARENCY_STEP) * TRANSPARENCY_STEP),
        )
      : DEFAULT_TRANSPARENCY;
    opacity.value = String(value);
    getElement('inventoryOpacityValue').textContent = value + '%';
    panel.style.setProperty('--inventory-panel-opacity', String(1 - value / 100));
    try {
      storage.setItem(TRANSPARENCY_KEY, String(value));
    } catch {
      // Storage may be blocked while drawer controls remain usable.
    }
  }

  toggle.addEventListener('click', () => {
    if (drawer.classList.contains('is-open')) collapse(true);
    else expand();
  });
  documentRef.addEventListener(
    'pointerdown',
    (event) => {
      if (!drawer.classList.contains('is-open') || drawer.contains(event.target)) return;
      collapse();
    },
    true,
  );
  documentRef.addEventListener('fullscreenchange', syncFullscreen);
  syncFullscreen();
  try {
    const previous = storage.getItem(TRANSPARENCY_KEY);
    updateOpacity(previous === null ? DEFAULT_TRANSPARENCY : previous);
  } catch {
    updateOpacity(DEFAULT_TRANSPARENCY);
  }
  opacity.addEventListener('input', () => updateOpacity(opacity.value));
  return { collapse, expand };
}
