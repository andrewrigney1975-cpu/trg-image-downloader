// @ts-check
// Handle updates
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Open the options page after install
    chrome.tabs.create({ url: 'src/Options/index.html' });
  }
});

// Download images
/** @typedef {{ numberOfProcessedImages: number, imagesToDownload: string[], options: any, next: () => void }} Task */

/** @type {Set<Task>} */
const tasks = new Set();

chrome.runtime.onMessage.addListener(startDownload);
chrome.runtime.onMessage.addListener(handleCheckFolderExists);
chrome.downloads.onDeterminingFilename.addListener(suggestNewFilename);
chrome.downloads.onChanged.addListener(handleDownloadChanged);

// Native Messaging host id registered by enfyl Explorer (F:/Src/winui3-fileexplorer) - Control
// Centre > Search Index > Browser Integration. Not installed/registered on every machine this
// extension runs on, so a missing-host error (via chrome.runtime.lastError) is an expected,
// non-fatal outcome, not a bug - the popup just shows no folder-exists warning in that case.
const SEARCH_INDEX_NATIVE_HOST = 'com.enfylexplorer.searchindex';

/**
 * Relays a "does a folder with this name already exist?" check to enfyl Explorer's local search
 * index via Native Messaging. Routed through the service worker (rather than calling
 * chrome.runtime.sendNativeMessage directly from the popup) to keep every native-messaging call
 * site in one place, matching how downloads are already centralized here.
 */
function handleCheckFolderExists(
  /** @type {any} */ message,
  /** @type {chrome.runtime.MessageSender} */ sender,
  /** @type {(response?: any) => void} */ sendResponse
) {
  if (!(message && message.type === 'checkFolderExists')) return;

  console.log('[SearchIndex] handleCheckFolderExists: received', message);

  chrome.runtime.sendNativeMessage(
    SEARCH_INDEX_NATIVE_HOST,
    { folderName: message.folderName },
    (response) => {
      if (chrome.runtime.lastError) {
        console.log(
          '[SearchIndex] sendNativeMessage lastError:',
          chrome.runtime.lastError.message,
        );
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      console.log('[SearchIndex] sendNativeMessage response:', response);
      sendResponse(response);
    }
  );

  return true; // Keeps the message channel open until sendResponse is called
}

// Download ids started by this extension that haven't finished (or failed) yet.
/** @type {Set<number>} */
const activeDownloadIds = new Set();

// NOTE: Don't directly use an `async` function as a listener for `onMessage`:
// https://stackoverflow.com/a/56483156
// https://developer.chrome.com/docs/extensions/reference/runtime/#event-onMessage
function startDownload(
  /** @type {any} */ message,
  /** @type {chrome.runtime.MessageSender} */ sender,
  /** @type {(response?: any) => void} */ resolve
) {
  if (!(message && message.type === 'downloadImages')) return;

  downloadImages({
    numberOfProcessedImages: 0,
    imagesToDownload: message.imagesToDownload,
    options: message.options,
    next() {
      this.numberOfProcessedImages += 1;
      if (this.numberOfProcessedImages === this.imagesToDownload.length) {
        tasks.delete(this);
      }
    },
  }).then(resolve);

  return true; // Keeps the message channel open until `resolve` is called
}

async function downloadImages(/** @type {Task} */ task) {
  tasks.add(task);
  for (const image of task.imagesToDownload) {
    await new Promise((resolve) => {
      chrome.downloads.download({ url: image }, (downloadId) => {
        if (downloadId == null) {
          if (chrome.runtime.lastError) {
            console.error(`${image}:`, chrome.runtime.lastError.message);
          }
          task.next();
        } else {
          activeDownloadIds.add(downloadId);
        }
        resolve();
      });
    });
  }
}

// https://developer.chrome.com/docs/extensions/reference/downloads/#event-onChanged
/** @type {Parameters<chrome.downloads.DownloadChangedEvent['addListener']>[0]} */
function handleDownloadChanged(delta) {
  if (!activeDownloadIds.has(delta.id)) return;
  if (!delta.state) return;

  if (delta.state.current === 'complete') {
    chrome.runtime.sendMessage({ type: 'downloadCompleted' }, () => {
      void chrome.runtime.lastError; // Ignore: no popup listening
    });
  }

  const finished =
    delta.state.current === 'complete' || delta.state.current === 'interrupted';
  if (!finished) return;

  activeDownloadIds.delete(delta.id);
}

// https://developer.chrome.com/docs/extensions/reference/downloads/#event-onDeterminingFilename
/** @type {Parameters<chrome.downloads.DownloadDeterminingFilenameEvent['addListener']>[0]} */
function suggestNewFilename(item, suggest) {
  const task = [...tasks][0];
  if (!task) {
    suggest();
    return;
  }

  let newFilename = '';
  if (task.options.folder_name) {
    newFilename += `${task.options.folder_name}/`;
  }
  if (task.options.new_file_name) {
    const regex = /(?:\.([^.]+))?$/;
    const extension = regex.exec(item.filename)?.[1];
    const numberOfDigits = task.imagesToDownload.length.toString().length;
    const formattedImageNumber = `${task.numberOfProcessedImages + 1}`.padStart(
      numberOfDigits,
      '0'
    );
    newFilename += `${task.options.new_file_name}${formattedImageNumber}.${extension}`;
  } else {
    newFilename += item.filename;
  }

  suggest({ filename: normalizeSlashes(newFilename) });
  task.next();
}

function normalizeSlashes(filename) {
  return filename.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}
