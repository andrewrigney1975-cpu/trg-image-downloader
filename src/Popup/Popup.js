import html, {
  render,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from '../html.js';

import { useRunAfterUpdate } from '../hooks/useRunAfterUpdate.js';
import { isIncludedIn, removeSpecialCharacters, unique } from '../utils.js';

import * as actions from './actions.js';
import { AdvancedFilters } from './AdvancedFilters.js';
import { DownloadButton } from './DownloadButton.js';
import { DownloadConfirmation } from './DownloadConfirmation.js';
import { Images } from './Images.js';
import { UrlFilterMode } from './UrlFilterMode.js';

const initialOptions = localStorage;
var tabName = '';

function formatFolderExistsMessage(folderName, response) {
  const count = response.matches.length;
  return `A folder named "${folderName}" already exists (${count} match${count === 1 ? '' : 'es'}).`;
}

/**
 * Checks whether a folder named `folderName` already exists, via enfyl Explorer's Search Index
 * (see serviceWorker.js), and reports it through `onFolderExists`. Used once at popup load, against
 * the tab-derived default subfolder name - the debounced inline check further down (options.folder_name)
 * covers the case where the user then changes it. Silently no-ops if the native host isn't
 * installed/registered - that's an expected outcome for most users, not an error worth surfacing.
 */
function warnIfFolderExists(folderName, onFolderExists) {
  if (!folderName) return;

  console.log('[SearchIndex] warnIfFolderExists: checking', folderName);

  chrome.runtime.sendMessage(
    { type: 'checkFolderExists', folderName },
    (response) => {
      if (chrome.runtime.lastError) {
        console.log(
          '[SearchIndex] warnIfFolderExists: sendMessage lastError:',
          chrome.runtime.lastError.message,
        );
        return;
      }
      console.log('[SearchIndex] warnIfFolderExists: response', response);
      if (response && response.exists) {
        onFolderExists(formatFolderExistsMessage(folderName, response));
      }
    },
  );
}

const Popup = () => {
  const [options, setOptions] = useState(initialOptions);

  useEffect(() => {
    Object.assign(localStorage, options);
  }, [options]);

  const [allImages, setAllImages] = useState([]);
  const [linkedImages, setLinkedImages] = useState([]);
  const [selectedImages, setSelectedImages] = useState([]);
  const [visibleImages, setVisibleImages] = useState([]);
  const activeTabIdRef = useRef(null);

  // Checks the subfolder name against enfyl Explorer's local Search Index via Native Messaging
  // (see serviceWorker.js), debounced so it's not fired on every keystroke. Silently shows nothing
  // if the native host isn't installed/registered on this machine - that's an expected outcome for
  // most users, not an error worth surfacing.
  const [folderExistsWarning, setFolderExistsWarning] = useState(null);

  useEffect(() => {
    // Get images on the page
    chrome.windows.getCurrent((currentWindow) => {
      chrome.tabs.query(
        { active: true, windowId: currentWindow.id },
        (activeTabs) => {
          tabName = removeSpecialCharacters(activeTabs[0].title);
          activeTabIdRef.current = activeTabs[0].id;
          warnIfFolderExists(tabName, setFolderExistsWarning);
          chrome.scripting
            .executeScript({
              target: { tabId: activeTabs[0].id, allFrames: true },
              func: findImages,
            })
            .then((messages) => {
              setAllImages((allImages) =>
                unique([
                  ...allImages,
                  ...messages.flatMap((message) => message?.result?.allImages),
                ]),
              );

              setLinkedImages((linkedImages) =>
                unique([
                  ...linkedImages,
                  ...messages.flatMap((message) => message?.result?.linkedImages),
                ]),
              );

              localStorage.active_tab_origin = messages[0]?.result?.origin;
            });
        },
      );
    });
  }, []);

  const imagesCacheRef = useRef(null); // Not displayed; only used for filtering by natural width / height
  const filterImages = useCallback(() => {
    let visibleImages =
      options.only_images_from_links === 'true' ? linkedImages : allImages;

    let filterValue = options.filter_url;
    if (filterValue) {
      switch (options.filter_url_mode) {
        case 'normal':
          const terms = filterValue.split(/\s+/);
          visibleImages = visibleImages.filter((url) => {
            for (let index = 0; index < terms.length; index++) {
              let term = terms[index];
              if (term.length !== 0) {
                const expected = term[0] !== '-';
                if (!expected) {
                  term = term.substr(1);
                  if (term.length === 0) {
                    continue;
                  }
                }
                const found = url.indexOf(term) !== -1;
                if (found !== expected) {
                  return false;
                }
              }
            }
            return true;
          });
          break;
        case 'wildcard':
          filterValue = filterValue
            .replace(/([.^$[\]\\(){}|-])/g, '\\$1')
            .replace(/([?*+])/, '.$1');
        /* fall through */
        case 'regex':
          visibleImages = visibleImages.filter((url) => {
            try {
              return url.match(filterValue);
            } catch (error) {
              return false;
            }
          });
          break;
      }
    }

    visibleImages = visibleImages.filter((url) => {
      const image = imagesCacheRef.current.querySelector(
        `img[src="${encodeURI(url)}"]`,
      );

      return (
        (options.filter_min_width_enabled !== 'true' ||
          options.filter_min_width <= image.naturalWidth) &&
        (options.filter_max_width_enabled !== 'true' ||
          image.naturalWidth <= options.filter_max_width) &&
        (options.filter_min_height_enabled !== 'true' ||
          options.filter_min_height <= image.naturalHeight) &&
        (options.filter_max_height_enabled !== 'true' ||
          image.naturalHeight <= options.filter_max_height)
      );
    });

    setVisibleImages(visibleImages);
  }, [allImages, linkedImages, options]);

  useEffect(filterImages, [allImages, linkedImages, options]);

  const [downloadIsInProgress, setDownloadIsInProgress] = useState(false);
  const imagesToDownload = useMemo(
    () => visibleImages.filter(isIncludedIn(selectedImages)),
    [visibleImages, selectedImages],
  );

  const [downloadConfirmationIsShown, setDownloadConfirmationIsShown] =
    useState(false);

  useEffect(() => {
    const folderName = options.folder_name;
    if (!folderName) {
      setFolderExistsWarning(null);
      return;
    }

    let cancelled = false;
    const timeoutId = setTimeout(() => {
      console.log('[SearchIndex] inline check: checking', folderName);
      chrome.runtime.sendMessage(
        { type: 'checkFolderExists', folderName },
        (response) => {
          if (chrome.runtime.lastError) {
            console.log(
              '[SearchIndex] inline check: sendMessage lastError:',
              chrome.runtime.lastError.message,
            );
            return;
          }
          console.log('[SearchIndex] inline check: response', response);
          if (cancelled || !response) return;
          setFolderExistsWarning(
            response && response.exists
              ? formatFolderExistsMessage(folderName, response)
              : null,
          );
        },
      );
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [options.folder_name]);

  const [downloadedCount, setDownloadedCount] = useState(0);
  const [downloadTotalCount, setDownloadTotalCount] = useState(0);
  const allDownloadsCompleted =
    downloadTotalCount > 0 && downloadedCount === downloadTotalCount;
  useEffect(() => {
    function handleMessage(message) {
      if (message && message.type === 'downloadCompleted') {
        setDownloadedCount((downloadedCount) => downloadedCount + 1);
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  function closeCurrentTab() {
    if (activeTabIdRef.current != null) {
      chrome.tabs.remove(activeTabIdRef.current);
    }
  }

  function maybeDownloadImages() {
    if (options.show_download_confirmation === 'true') {
      setDownloadConfirmationIsShown(true);
    } else {
      downloadImages();
    }
  }

  async function downloadImages() {
    setDownloadedCount(0);
    setDownloadTotalCount(imagesToDownload.length);
    setDownloadIsInProgress(true);
    options.folder_name = tabName;
    await actions.downloadImages(imagesToDownload, options);
    setDownloadIsInProgress(false);
  }

  const runAfterUpdate = useRunAfterUpdate();

  const selectAllButtonRef = useRef(null);
  const downloadButtonRef = useRef(null);
  useEffect(() => {
    if (options.automation_select_all_enabled !== 'true') return;

    let downloadTimeoutId;
    const selectAllTimeoutId = setTimeout(() => {
      selectAllButtonRef.current?.click();

      if (options.automation_download_enabled === 'true') {
        downloadTimeoutId = setTimeout(() => {
          downloadButtonRef.current?.click();
        }, 500);
      }
    }, 300);

    return () => {
      clearTimeout(selectAllTimeoutId);
      clearTimeout(downloadTimeoutId);
    };
  }, [
    options.automation_select_all_enabled,
    options.automation_download_enabled,
  ]);

  const closeTabButtonRef = useRef(null);
  useEffect(() => {
    if (options.automation_close_tab_enabled !== 'true') return;
    if (!allDownloadsCompleted) return;

    const timeoutId = setTimeout(() => {
      closeTabButtonRef.current?.click();
    }, 1000);

    return () => clearTimeout(timeoutId);
  }, [allDownloadsCompleted, options.automation_close_tab_enabled]);

  const suppressUI = options.suppress_ui === 'true';
  useEffect(() => {
    document.body.classList.toggle('suppress_ui', suppressUI);
  }, [suppressUI]);

  return html`
    ${suppressUI &&
    html`
      <div class="suppress_ui_indicator" title="Automating image download…">
        <img src="/images/robot.svg" width="48" height="48" alt="Robot" />
      </div>
    `}
    <div style=${{ display: suppressUI ? 'none' : undefined }}>
    <div id="filters_container">
      <div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        ${allDownloadsCompleted &&
        html`
          <div class="download_queue_empty_alert bg-success inverse">
            All downloads have completed!
          </div>
        `}

        <div style=${{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: 'auto' }}>
          <button
            ref=${selectAllButtonRef}
            onClick=${() => {
              setSelectedImages(visibleImages);
            }}
          >
          <img src="/images/download.svg" />
          </button>

          <${DownloadButton}
            ref=${downloadButtonRef}
            disabled=${imagesToDownload.length === 0}
            loading=${downloadIsInProgress}
            onClick=${maybeDownloadImages}
          />

          ${(allDownloadsCompleted || folderExistsWarning) &&
          html`
            <button
              ref=${closeTabButtonRef}
              class="icon-button danger"
              title=${folderExistsWarning || 'Close this tab'}
              onClick=${closeCurrentTab}
            >
              <svg viewBox="0 0 320 512">
                <path
                  d="M207.6 256l107.72-107.72c6.23-6.23 6.23-16.34 0-22.58l-25.03-25.03c-6.23-6.23-16.34-6.23-22.58 0L160 208.4 52.28 100.68c-6.23-6.23-16.34-6.23-22.58 0L4.68 125.7c-6.23 6.23-6.23 16.34 0 22.58L112.4 256 4.68 363.72c-6.23 6.23-6.23 16.34 0 22.58l25.03 25.03c6.23 6.23 16.34 6.23 22.58 0L160 303.6l107.72 107.72c6.23 6.23 16.34 6.23 22.58 0l25.03-25.03c6.23-6.23 6.23-16.34 0-22.58L207.6 256z"
                />
              </svg>
            </button>
          `}
        </div>
      </div>

      ${options.show_advanced_filters === 'true' &&
      html`
        <${AdvancedFilters} options=${options} setOptions=${setOptions} />
      `}
    </div>

    <div ref=${imagesCacheRef} class="hidden">
      ${allImages.map(
        (url) => html`<img src=${encodeURI(url)} onLoad=${filterImages} />`,
      )}
    </div>

    ${!suppressUI &&
    html`
      <${Images}
        options=${options}
        visibleImages=${visibleImages}
        selectedImages=${selectedImages}
        imagesToDownload=${imagesToDownload}
        setSelectedImages=${setSelectedImages}
        downloadedCount=${downloadedCount}
        downloadTotalCount=${downloadTotalCount}
      />
    `}

    <div
      id="downloads_container"
      style=${{
        gridTemplateColumns: `${
          options.show_file_renaming === 'true' ? 'minmax(100px, 1fr)' : ''
        } minmax(100px, 1fr) 80px`,
      }}
    >
      <input
        type="text"
        id="myInput"
        placeholder="Save to subfolder"
        title="Set the name of the subfolder you want to download the images to."
        value=${tabName}
        onChange=${({ currentTarget: input }) => {
          const savedSelectionStart = removeSpecialCharacters(
            input.value.slice(0, input.selectionStart),
          ).length;

          runAfterUpdate(() => {
            input.selectionStart = input.selectionEnd = savedSelectionStart;
          });

          setOptions((options) => ({
            ...options,
            folder_name: removeSpecialCharacters(input.value),
          }));
        }}
      />

      ${folderExistsWarning &&
      html`
        <p
          class="danger"
          style=${{ gridColumn: '1 / -1', margin: '4px 0 0', fontSize: '0.9em' }}
        >
          ${folderExistsWarning}
        </p>
      `}

      ${options.show_file_renaming === 'true' &&
      html`
        <input
          type="text"
          placeholder="Rename files"
          title="Set a new file name for the images you want to download."
          value=${options.new_file_name}
          onChange=${({ currentTarget: input }) => {
            const savedSelectionStart = removeSpecialCharacters(
              input.value.slice(0, input.selectionStart),
            ).length;

            runAfterUpdate(() => {
              input.selectionStart = input.selectionEnd = savedSelectionStart;
            });

            setOptions((options) => ({
              ...options,
              new_file_name: removeSpecialCharacters(input.value),
            }));
          }}
        />
      `}

      

      ${downloadConfirmationIsShown &&
      html`
        <${DownloadConfirmation}
          onCheckboxChange=${({ currentTarget: { checked } }) => {
            setOptions((options) => ({
              ...options,
              show_download_confirmation: (!checked).toString(),
            }));
          }}
          onClose=${() => setDownloadConfirmationIsShown(false)}
          onConfirm=${downloadImages}
        />
      `}
    </div>
    </div>
  `;
};

function findImages() {
  // Source: https://support.google.com/webmasters/answer/2598805?hl=en
  const imageUrlRegex =
    /(?:([^:\/?#]+):)?(?:\/\/([^\/?#]*))?([^?#]*\.(?:bmp|gif|ico|jfif|jpe?g|png|svg|tiff?|webp|avif))(?:\?([^#]*))?(?:#(.*))?/i;

  function extractImagesFromSelector(selector) {
    return unique(
      toArray(document.querySelectorAll(selector))
        .map(extractImageFromElement)
        .filter(isTruthy)
        .map(relativeUrlToAbsolute),
    );
  }

  function extractImageFromElement(element) {
    if (element.tagName.toLowerCase() === 'img') {
      const src = element.src;
      const hashIndex = src.indexOf('#');
      return hashIndex >= 0 ? src.substr(0, hashIndex) : src;
    }

    if (element.tagName.toLowerCase() === 'image') {
      const src = element.getAttribute('xlink:href');
      const hashIndex = src.indexOf('#');
      return hashIndex >= 0 ? src.substr(0, hashIndex) : src;
    }

    if (element.tagName.toLowerCase() === 'a') {
      const href = element.href;
      if (isImageURL(href)) {
        return href;
      }
    }

    const backgroundImage = window.getComputedStyle(element).backgroundImage;
    if (backgroundImage) {
      const parsedURL = extractURLFromStyle(backgroundImage);
      if (isImageURL(parsedURL)) {
        return parsedURL;
      }
    }
  }

  function isImageURL(url) {
    return url.indexOf('data:image') === 0 || imageUrlRegex.test(url);
  }

  function extractURLFromStyle(style) {
    return style.replace(/^.*url\(["']?/, '').replace(/["']?\).*$/, '');
  }

  function relativeUrlToAbsolute(url) {
    return url.indexOf('/') === 0 ? `${window.location.origin}${url}` : url;
  }

  function unique(values) {
    return toArray(new Set(values));
  }

  function toArray(values) {
    return [...values];
  }

  function isTruthy(value) {
    return !!value;
  }

  return {
    allImages: extractImagesFromSelector('img, image, a, [class], [style]'),
    linkedImages: extractImagesFromSelector('a'),
    origin: window.location.origin,
  };
}

render(html`<${Popup} />`, document.querySelector('main'));
