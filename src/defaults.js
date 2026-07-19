// TODO: Convert to a module and split into 2 - the default values and setting `localStorage` based on the default values initially

const defaults = {
  // Filters
  folder_name: '',
  new_file_name: '',
  filter_url: '',
  filter_url_mode: 'normal',
  filter_min_width: 800,
  filter_min_width_enabled: true,
  filter_max_width: 9999,
  filter_max_width_enabled: false,
  filter_min_height: 0,
  filter_min_height_enabled: false,
  filter_max_height: 9999,
  filter_max_height_enabled: false,
  only_images_from_links: true,
  show_advanced_filters: true,
  // Options
  // General
  show_download_confirmation: false,
  show_file_renaming: true,
  // Images
  show_image_url: true,
  show_open_image_button: true,
  show_download_image_button: true,
  columns: 2,
  image_min_width: 50,
  image_max_width: 200,
  // Automation
  automation_select_all_enabled: true,
  automation_download_enabled: true,
  automation_close_tab_enabled: true,
  suppress_ui: false,
};

Object.keys(defaults).forEach((option) => {
  if (localStorage[option] === undefined) {
    localStorage[option] = defaults[option];
  }
  localStorage[`${option}_default`] = defaults[option];
});
