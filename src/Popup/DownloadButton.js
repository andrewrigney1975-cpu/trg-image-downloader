import html, { forwardRef } from '../html.js';

// TODO: Implement loading animation
export const DownloadButton = forwardRef(({ disabled, loading, ...props }, ref) => {
  const tooltipText = disabled
    ? 'Select some images to download first'
    : loading
    ? 'If you want, you can close the extension popup\nwhile the images are downloading!'
    : '';

  return html`
    <input
      ref=${ref}
      type="button"
      class="accent ${loading ? 'loading' : ''}"
      value=${loading ? '•••' : 'Download'}
      disabled=${disabled || loading}
      title=${tooltipText}
      ...${props}
    />
  `;
});
