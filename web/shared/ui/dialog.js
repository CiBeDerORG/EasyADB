// Dialog mechanics only. Business validation/permission remains at the call site.
export function createDialogController({ getElement }) {
  function showDialog(id, focusId = null) {
    const dialog = getElement(id);
    dialog.showModal();
    if (focusId) getElement(focusId).focus();
  }

  function closeDialog(id) {
    getElement(id).close();
  }

  function modalMessage(text, kind = 'error', id = 'formMessage') {
    const element = getElement(id);
    element.hidden = false;
    element.textContent = text;
    element.className = 'status modal-status ' + kind;
  }

  return { showDialog, closeDialog, modalMessage };
}
