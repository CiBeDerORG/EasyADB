import { createApiClient } from '../core/api-client.js';
import { createDomHelpers } from '../shared/dom.js';
import { createDialogController } from '../shared/ui/dialog.js';
import { createToastController } from '../shared/ui/toast.js';

// One-time dependency injection into the existing inline compatibility adapter.
// No additional business global, automatic ADB connection or page polling.
const modules = {
  api: createApiClient({
    getToken: () => document.getElementById('token').value,
    request: (path, options) => fetch(path, options),
  }),
  dom: createDomHelpers({ documentRef: document }),
  dialog: createDialogController({ getElement: (id) => document.getElementById(id) }),
  toast: createToastController({
    host: document.getElementById('toastHost'),
    documentRef: document,
    windowRef: window,
  }),
};

document.dispatchEvent(new CustomEvent('easyadb:frontend-modules-ready', { detail: modules }));
