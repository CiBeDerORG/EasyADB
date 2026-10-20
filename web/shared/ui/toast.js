// A single owner per mounted toast host; no document/window global publication.
export function createToastController({ host, documentRef, windowRef }) {
  const items = new Map();

  function selected(card) {
    const selection =
      typeof windowRef.getSelection === 'function' ? windowRef.getSelection() : null;
    return Boolean(
      selection &&
        !selection.isCollapsed &&
        (card.contains(selection.anchorNode) || card.contains(selection.focusNode)),
    );
  }

  function dismissToast(key) {
    const state = items.get(key);
    if (!state) return;
    if (state.timer !== null) clearTimeout(state.timer);
    items.delete(key);
    state.card.remove();
  }

  function pause(state) {
    if (state.timer === null) return;
    clearTimeout(state.timer);
    state.timer = null;
    state.remaining = Math.max(0, state.remaining - (Date.now() - state.startedAt));
  }

  function resume(state) {
    if (items.get(state.key) !== state || state.timer !== null) return;
    if (state.hovered || state.focused || state.selected) return;
    if (state.remaining <= 0) {
      dismissToast(state.key);
      return;
    }
    state.startedAt = Date.now();
    state.timer = setTimeout(() => dismissToast(state.key), state.remaining);
  }

  function showToast(content, { key = 'status', kind = '' } = {}) {
    dismissToast(key);
    const card = documentRef.createElement('section');
    card.className = 'global-toast' + (kind ? ' ' + kind : '');
    card.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const body = documentRef.createElement('div');
    body.className = 'toast-body';
    if (typeof content === 'string') body.textContent = content;
    else body.append(content);
    const closeButton = documentRef.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'toast-close';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', '关闭此条提示');
    card.append(body, closeButton);
    host.append(card);
    const state = {
      key,
      card,
      remaining: 10000,
      startedAt: 0,
      timer: null,
      hovered: false,
      focused: false,
      selected: false,
    };
    items.set(key, state);
    const syncSelection = () => {
      state.selected = selected(card);
      if (state.selected) pause(state);
      else resume(state);
    };
    card.addEventListener('pointerenter', () => {
      state.hovered = true;
      pause(state);
    });
    card.addEventListener('pointerleave', () => {
      state.hovered = false;
      syncSelection();
    });
    card.addEventListener('focusin', () => {
      state.focused = true;
      pause(state);
    });
    card.addEventListener('focusout', () => {
      state.focused = false;
      syncSelection();
    });
    closeButton.addEventListener('click', () => {
      if (items.get(key) === state) dismissToast(key);
    });
    resume(state);
    return card;
  }

  function onSelectionChange() {
    for (const state of items.values()) {
      state.selected = selected(state.card);
      if (state.selected) pause(state);
      else resume(state);
    }
  }

  documentRef.addEventListener('selectionchange', onSelectionChange);
  function dispose() {
    documentRef.removeEventListener('selectionchange', onSelectionChange);
    for (const key of [...items.keys()]) dismissToast(key);
  }
  return { showToast, dismissToast, dispose };
}
