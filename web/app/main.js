import { createApiClient } from '../core/api-client.js';
import { createDomHelpers } from '../shared/dom.js';
import { createDialogController } from '../shared/ui/dialog.js';
import { createToastController } from '../shared/ui/toast.js';
import { createLiveSessionController } from '../features/live/live-session-controller.js';
import { createLiveQualitySettings } from '../features/live/live-quality-settings.js';
import { createLiveBatchScheduler } from '../features/live/live-batch-scheduler.js';
import { createLiveCardView } from '../features/live/live-card-view.js';
import * as deviceConnection from '../features/devices/device-connection-controller.js';
import * as deviceManagement from '../features/devices/device-management-controller.js';
import * as deviceConfiguration from '../features/devices/device-configuration-controller.js';
import * as deviceDialogs from '../features/devices/device-dialog-controller.js';
import * as groupDialogs from '../features/devices/group-dialog-controller.js';
import * as groupDiscoveryView from '../features/devices/group-discovery-view.js';
import * as deviceList from '../features/devices/device-list-model.js';
import * as deviceListView from '../features/devices/device-list-view.js';

// One-time dependency injection into the existing inline compatibility adapter.
// No additional business global, automatic ADB connection or page polling.
const modules = {
  createLiveSessionController,
  createLiveQualitySettings,
  createLiveBatchScheduler,
  createLiveCardView,
  createDeviceConnectionController: deviceConnection.createDeviceConnectionController,
  createDeviceManagementController: deviceManagement.createDeviceManagementController,
  createDeviceConfigurationController: deviceConfiguration.createDeviceConfigurationController,
  createDeviceDialogController: deviceDialogs.createDeviceDialogController,
  createGroupDialogController: groupDialogs.createGroupDialogController,
  groupDiscoveryView,
  deviceList,
  deviceListView,
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
