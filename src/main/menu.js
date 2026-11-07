const { Menu } = require('electron');

/**
 * Every menu item maps to a semantic action id. The renderer owns the actual
 * behaviour, so keyboard shortcuts work identically whether they arrive from
 * the native menu, the command palette, or an on-screen button.
 *
 * Top-level order matches the Foxit ribbon tabs (Home, View, Comment, Edit,
 * Organize, Protect, Convert, Forms) plus our AI tab:
 *   File · Edit · View · Comment · Edit PDF · Organize · Protect · Convert · Forms · AI · Window · Help
 * It deliberately mirrors the ribbon modes so the menu bar and the ribbon never
 * disagree.
 */
const MENU_ACTIONS = [
  // File
  'file:new',
  'file:open',
  'file:openRecent',
  'recents:clear',
  'file:save',
  'file:saveAs',
  'file:saveCopy',
  'file:close',
  'file:images',
  'file:print',
  'file:properties',
  'export:text',
  'export:images',
  'export:comments',

  // Edit — cut/copy/paste use native roles and are never dispatched.
  'edit:undo',
  'edit:redo',
  'edit:selectAll',
  'edit:preferences',

  // View
  'view:zoomIn',
  'view:zoomOut',
  'view:actualSize',
  'view:fitPage',
  'view:fitWidth',
  'view:resetZoom',
  'view:single',
  'view:continuous',
  'view:facing',
  'view:cover',
  'view:reverse',
  'view:grid',
  'view:readAloud',
  'view:ribbonToggle',
  'view:chromeToggle',
  'view:rotateCW',
  'view:rotateCCW',
  'view:darkMode',
  'view:themeGallery',
  'view:theme:default',
  'view:theme:ocean',
  'view:theme:forest',
  'view:theme:amber',
  'view:theme:rose',
  'view:theme:violet',
  'view:theme:graphite',
  'view:theme:aurora',
  'view:theme:contrast',
  'view:presentation',
  'view:pages',
  'view:bookmarks',
  'view:comments',
  'view:attachments',
  'view:signatures',
  'view:layers',
  'view:search',
  'view:ai',
  'view:fonts',

  // Comment (annotation tools)
  'tool:hand',
  'tool:select',
  'tool:highlight',
  'tool:underline',
  'tool:strikeout',
  'tool:squiggly',
  'tool:note',
  'tool:callout',
  'tool:textbox',
  'tool:rect',
  'tool:ellipse',
  'tool:line',
  'tool:arrow',
  'tool:ink',
  'tool:brush',
  'tool:highlighter',
  'tool:formatPainter',
  'tool:eyedropper',
  'view:rulers',
  'tool:measure',
  'tool:eraser',
  'tool:stamp',
  'tool:image',
  'tool:signature',
  'tool:redact',
  // Also reachable from the complete Tools > catalogue
  'tool:editImage',
  'tool:roundRect',
  'tool:polygon',
  'tool:polyline',
  'tool:cloud',
  'tool:areaHighlight',
  'tool:caret',
  'tool:measureArea',
  'tool:editArea',
  'measure:scale',

  // Edit PDF (content modification)
  'tool:editText',
  'tool:whiteout',
  'ocr:page',
  'ocr:all',
  'stamp:watermark',
  'stamp:headerFooter',
  'stamp:bates',

  // Organize (page management)
  'page:insert',
  'page:extract',
  'page:delete',
  'page:rotate',
  'page:merge',
  'page:split',

  // Forms
  'form:addText',
  'form:addCheckbox',
  'form:addRadio',
  'form:addDropdown',
  'form:addSignature',
  'form:exportData',
  'form:importData',
  'form:reset',

  // Protect
  'protect:encrypt',
  'protect:redactAll',
  'protect:unlockForms',

  // Documents — Stirling-PDF batch tools
  'docs:compare',
  'docs:overlay',
  'docs:scale',
  'docs:removeBlanks',
  'docs:adjustColors',
  'docs:compress',
  'docs:flatten',
  'docs:sanitize',
  'docs:info',
  'docs:removeAnnots',
  'docs:nup',
  'docs:singlePage',
  'docs:poster',
  'docs:booklet',
  'docs:splitSize',
  'docs:autoRename',
  'docs:repair',
  'docs:attachments',
  'docs:pageNumbers',
  'docs:automate',

  // AI
  'ai:ask',
  'ai:agent',
  'ai:summarize',
  'ai:summarizeAll',
  'ai:extractData',
  'ai:translate',
  'ai:rewrite',
  'ai:proofread',
  'ai:settings',

  // Help
  'help:shortcuts',
  'help:about',
];

const isMac = process.platform === 'darwin';

/**
 * @param {(action: string, payload?: any) => void} send  forwards to the renderer
 * @param {{ recents?: Array<{path:string,name:string}> }} opts
 *   `recents` comes from settings.json. The `recentDocuments` role is macOS-only
 *   and renders as an inert submenu on Windows, so the list is built by hand and
 *   the menu is rebuilt whenever the renderer writes its recents.
 */
function buildMenu(send, opts = {}) {
  const recents = Array.isArray(opts.recents) ? opts.recents : [];
  // Persisted colour theme, so the View > Colour Theme radios reflect the
  // real selection instead of always checking the factory default.
  const skin = opts.skin || 'default';
  const recentSubmenu = recents.length
    ? recents.slice(0, 12).map((r) => ({
        label: r.name || r.path,
        toolTip: r.path,
        click: () => send('file:openRecent', r.path),
      }))
    : [{ label: 'No Recent Files', enabled: false }];

  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'New PDF  (Ctrl+N)', click: () => send('file:new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('file:open') },
        {
          label: 'Open Recent',
          submenu: [
            ...recentSubmenu,
            { type: 'separator' },
            { label: 'Clear Recent Files', enabled: recents.length > 0, click: () => send('recents:clear') },
          ],
        },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('file:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('file:saveAs') },
        { label: 'Save a Copy…', click: () => send('file:saveCopy') },
        { label: 'Restore Previous Version…', click: () => send('file:restoreBackup') },
        { type: 'separator' },
        { label: 'Create from Images…', click: () => send('file:images') },
        {
          label: 'Export',
          submenu: [
            { label: 'Text…', click: () => send('export:text') },
            { label: 'Pages as Images…', click: () => send('export:images') },
            { label: 'Comments…', click: () => send('export:comments') },
          ],
        },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => send('file:print') },
        { label: 'Document Properties…  (Ctrl+D)', click: () => send('file:properties') },
        { type: 'separator' },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => send('file:close') },
        { label: 'Exit', role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        /* Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z are driven from the renderer keymap,
           not from here. A native accelerator fires even while a text field or
           a Direct Editor surface has focus, so Ctrl+Z used to undo the DOCUMENT
           instead of the sentence being typed. Same reason for Ctrl+A/X/B/E/G/H
           /J/N/D below: they belong to the editor when it has focus and to the
           document when it does not, which only the renderer can tell apart. */
        { label: 'Undo  (Ctrl+Z)', click: () => send('edit:undo') },
        { label: 'Redo  (Ctrl+Y)', click: () => send('edit:redo') },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { type: 'separator' },
        { label: 'Select All  (Ctrl+A)', click: () => send('edit:selectAll') },
        { type: 'separator' },
        // The two universal tools, reachable here as well as from the ribbon and
        // the status-bar pair. Deliberately NO single-letter accelerator: the
        // renderer keymap owns bare letters (V = Select, H = Highlight) and a
        // native accelerator fires even while a text field has focus, which
        // would steal the keystroke from the find bar and every other input.
        { label: 'Select Tool', click: () => send('tool:select') },
        { label: 'Hand Tool', click: () => send('tool:hand') },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('view:search') },
        { type: 'separator' },
        // Ctrl+K belongs to the command palette (renderer keymap). Preferences
        // takes Ctrl+, on every platform — binding it to Ctrl+K here used to
        // fire both at once, leaving the palette unreachable from the keyboard.
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: () => send('edit:preferences'),
        },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('view:zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('view:zoomOut') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+Shift+0', click: () => send('view:actualSize') },
        { label: 'Fit Page', accelerator: 'CmdOrCtrl+0', click: () => send('view:fitPage') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+1', click: () => send('view:fitWidth') },
        { label: 'Reset Zoom', click: () => send('view:resetZoom') },
        { type: 'separator' },
        { label: 'Single Page', accelerator: 'CmdOrCtrl+2', click: () => send('view:single') },
        { label: 'Continuous Scroll', accelerator: 'CmdOrCtrl+3', click: () => send('view:continuous') },
        { label: 'Facing Pages', accelerator: 'CmdOrCtrl+4', click: () => send('view:facing') },
        { label: 'Cover Page', accelerator: 'CmdOrCtrl+5', click: () => send('view:cover') },
        { type: 'separator' },
        { label: 'Show Grid', accelerator: "CmdOrCtrl+'", click: () => send('view:grid') },
        { label: 'Reverse View', click: () => send('view:reverse') },
        { label: 'Read This Page Aloud', click: () => send('view:readAloud') },
        { label: 'Read Aloud Settings…', click: () => send('view:ttsSettings') },
        { type: 'separator' },
        { label: 'Collapse the Ribbon', accelerator: 'CmdOrCtrl+F1', type: 'checkbox', checked: false, click: (mi) => { send('view:ribbonToggle'); mi.checked = !mi.checked; } },
        { label: 'Show / Hide Toolbars', accelerator: 'CmdOrCtrl+F11', click: () => send('view:chromeToggle') },
        { type: 'separator' },
        { label: 'Rotate Clockwise', accelerator: 'CmdOrCtrl+Shift+=', click: () => send('view:rotateCW') },
        { label: 'Rotate Counter-clockwise', accelerator: 'CmdOrCtrl+Shift+-', click: () => send('view:rotateCCW') },
        { type: 'separator' },
        { label: 'Toggle Dark Mode', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('view:darkMode') },
        {
          label: 'Colour Theme',
          submenu: [
            { label: 'Slate Indigo', type: 'radio', checked: skin === 'default', click: () => send('view:theme:default') },
            { label: 'Ocean Teal', type: 'radio', checked: skin === 'ocean', click: () => send('view:theme:ocean') },
            { label: 'Forest Emerald', type: 'radio', checked: skin === 'forest', click: () => send('view:theme:forest') },
            { label: 'Amber Ember', type: 'radio', checked: skin === 'amber', click: () => send('view:theme:amber') },
            { label: 'Rose Quartz', type: 'radio', checked: skin === 'rose', click: () => send('view:theme:rose') },
            { label: 'Violet Ink', type: 'radio', checked: skin === 'violet', click: () => send('view:theme:violet') },
            { label: 'Graphite', type: 'radio', checked: skin === 'graphite', click: () => send('view:theme:graphite') },
            { label: 'Aurora', type: 'radio', checked: skin === 'aurora', click: () => send('view:theme:aurora') },
            { label: 'High Contrast (accessibility)', type: 'radio', checked: skin === 'contrast', click: () => send('view:theme:contrast') },
            { type: 'separator' },
            { label: 'Colour Theme Gallery…', click: () => send('view:themeGallery') },
          ],
        },
        { label: 'Show Rulers', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('view:rulers') },
        { label: 'Clear Guides', click: () => send('view:clearGuides') },
        { label: 'Presentation Mode', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('view:presentation') },
        { label: 'Focus Mode  (Ctrl+Alt+F)', click: () => send('view:focus') },
        { label: 'Cycle Appearance  (Ctrl+Alt+S)', click: () => send('view:cycleSkin') },
        { label: 'High Contrast  (Ctrl+Alt+C)', click: () => send('view:highContrast') },
        { label: 'Toggle Full Screen', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Page Thumbnails', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('view:pages') },
        { label: 'Bookmarks', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('view:bookmarks') },
        { label: 'Comments List', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('view:comments') },
        { label: 'Attachments', click: () => send('view:attachments') },
        { label: 'Signatures', click: () => send('view:signatures') },
        { label: 'Layers', click: () => send('view:layers') },
        { label: 'AI Assistant', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('view:ai') },
      ],
    },
    {
      // No bare-letter accelerators here on purpose. Native menu accelerators
      // fire before the page and cannot be guarded, so registering 'H'/'T'/'S'
      // natively switched tools and swallowed the keystroke whenever the user
      // was typing in the search bar, a form field or the inline text editor.
      // The renderer keymap (app.js) owns single-letter tool shortcuts and skips
      // them when the focus is in an editable field; the letter is shown in the
      // label so the shortcut stays discoverable.
      label: '&Comment',
      submenu: [
        { label: 'Hand — pan the document', click: () => send('tool:hand') },
        { label: 'Select  (V)', click: () => send('tool:select') },
        { type: 'separator' },
        { label: 'Highlight  (H)', click: () => send('tool:highlight') },
        { label: 'Underline  (U)', click: () => send('tool:underline') },
        { label: 'Strikethrough  (S)', click: () => send('tool:strikeout') },
        { label: 'Squiggly  (Q)', click: () => send('tool:squiggly') },
        { type: 'separator' },
        { label: 'Sticky Note  (N)', click: () => send('tool:note') },
        { label: 'Callout  (C)', click: () => send('tool:callout') },
        { label: 'Text Box  (T)', click: () => send('tool:textbox') },
        { type: 'separator' },
        { label: 'Rectangle  (R)', click: () => send('tool:rect') },
        { label: 'Ellipse  (O)', click: () => send('tool:ellipse') },
        { label: 'Line  (L)', click: () => send('tool:line') },
        { label: 'Arrow  (A)', click: () => send('tool:arrow') },
        { label: 'Pencil  (P)', click: () => send('tool:ink') },
        { label: 'Brush', click: () => send('tool:brush') },
        { label: 'Highlighter', click: () => send('tool:highlighter') },
        { type: 'separator' },
        { label: 'Format Painter', click: () => send('tool:formatPainter') },
        { label: 'Eyedropper — pick colour from page', click: () => send('tool:eyedropper') },
        { type: 'separator' },
        { label: 'Measure Distance  (M)', click: () => send('tool:measure') },
        { label: 'Calibrate Measure Scale…', click: () => send('measure:scale') },
        { label: 'Eraser  (E)', click: () => send('tool:eraser') },
        { type: 'separator' },
        { label: 'Stamp  (K)', click: () => send('tool:stamp') },
        { label: 'Image…  (I)', click: () => send('tool:image') },
        { label: 'Signature…', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('tool:signature') },
        { label: 'Redact  (X)', click: () => send('tool:redact') },
      ],
    },
    {
      // The complete tool catalogue. Ribbon groups are organised by task and
      // only show one tab at a time; this menu is the stable, universally
      // reachable index of EVERY tool in TOOLS (app.js), grouped the same way.
      // All entries dispatch through the shared action bus, so the native
      // menu, the ribbon and the command palette can never disagree.
      label: '&Tools',
      submenu: [
        {
          label: 'Select && navigate',
          submenu: [
            { label: 'Hand — pan the document', click: () => send('tool:hand') },
            { label: 'Select  (V)', click: () => send('tool:select') },
            { label: 'Edit object — placed images / XObjects', click: () => send('tool:editImage') },
          ],
        },
        {
          label: 'Text && markup',
          submenu: [
            { label: 'Highlight  (H)', click: () => send('tool:highlight') },
            { label: 'Underline  (U)', click: () => send('tool:underline') },
            { label: 'Strikethrough  (S)', click: () => send('tool:strikeout') },
            { label: 'Squiggly  (Q)', click: () => send('tool:squiggly') },
            { label: 'Area highlight', click: () => send('tool:areaHighlight') },
            { label: 'Insert text marker', click: () => send('tool:caret') },
            { type: 'separator' },
            { label: 'Sticky Note  (N)', click: () => send('tool:note') },
            { label: 'Callout  (C)', click: () => send('tool:callout') },
            { label: 'Text Box  (T)', click: () => send('tool:textbox') },
            { type: 'separator' },
            { label: 'Format Painter', click: () => send('tool:formatPainter') },
            { label: 'Colour picker (eyedropper)', click: () => send('tool:eyedropper') },
          ],
        },
        {
          label: 'Draw && shapes',
          submenu: [
            { label: 'Rectangle  (R)', click: () => send('tool:rect') },
            { label: 'Rounded rect', click: () => send('tool:roundRect') },
            { label: 'Ellipse  (O)', click: () => send('tool:ellipse') },
            { label: 'Line  (L)', click: () => send('tool:line') },
            { label: 'Arrow  (A)', click: () => send('tool:arrow') },
            { label: 'Polygon', click: () => send('tool:polygon') },
            { label: 'Polyline', click: () => send('tool:polyline') },
            { label: 'Cloud', click: () => send('tool:cloud') },
            { type: 'separator' },
            { label: 'Pencil  (P)', click: () => send('tool:ink') },
            { label: 'Brush', click: () => send('tool:brush') },
            { label: 'Marker / highlighter', click: () => send('tool:highlighter') },
            { label: 'Eraser  (E)', click: () => send('tool:eraser') },
            { type: 'separator' },
            { label: 'Stamp  (K)', click: () => send('tool:stamp') },
            { label: 'Image…  (I)', click: () => send('tool:image') },
            { label: 'Signature…', click: () => send('tool:signature') },
          ],
        },
        {
          label: 'Edit && measure',
          submenu: [
            { label: 'Direct Editor  (Ctrl+E)', click: () => send('tool:editText') },
            { label: 'Area Direct Edit', click: () => send('tool:editArea') },
            { label: 'Whiteout', click: () => send('tool:whiteout') },
            { label: 'Redact  (X)', click: () => send('tool:redact') },
            { label: 'Link', click: () => send('tool:link') },
            { type: 'separator' },
            { label: 'Measure distance  (M)', click: () => send('tool:measure') },
            { label: 'Perimeter && Area', click: () => send('tool:measureArea') },
          ],
        },
      ],
    },
    {
      label: 'Edit &PDF',
      submenu: [
        { label: 'Direct Editor  (Ctrl+E)', click: () => send('tool:editText') },
        { label: 'Whiteout', accelerator: 'CmdOrCtrl+Shift+X', click: () => send('tool:whiteout') },
        { type: 'separator' },
        { label: 'Add Link…', click: () => send('tool:link') },
        { label: 'Remove Added Links…', click: () => send('edit:removeLinks') },
        { type: 'separator' },
        { label: 'Find…', click: () => send('view:search') },
        { label: 'Find & Replace…  (Ctrl+H)', click: () => send('edit:replace') },
        { type: 'separator' },
        { label: 'Recognise Text (OCR) — Current Page', click: () => send('ocr:page') },
        { label: 'OCR — All Scanned Pages', click: () => send('ocr:all') },
        { label: 'Document Fonts', click: () => send('view:fonts') },
        { type: 'separator' },
        { label: 'Watermark…', accelerator: 'CmdOrCtrl+Shift+W', click: () => send('stamp:watermark') },
        { label: 'Header & Footer…', accelerator: 'CmdOrCtrl+Shift+H', click: () => send('stamp:headerFooter') },
        { label: 'Bates Numbering…  (Ctrl+B)', click: () => send('stamp:bates') },
      ],
    },
    {
      label: '&Organize',
      submenu: [
        { label: 'Insert Pages…  (Ctrl+G)', click: () => send('page:insert') },
        { label: 'Extract Pages…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('page:extract') },
        { label: 'Delete Page', click: () => send('page:delete') },
        { label: 'Rotate Page…', click: () => send('page:rotate') },
        { type: 'separator' },
        { label: 'Duplicate Page', click: () => send('page:duplicate') },
        { label: 'Replace Page…', click: () => send('page:replace') },
        { label: 'Reverse Page Order', click: () => send('page:reverse') },
        { label: 'Crop Pages…', click: () => send('page:crop') },
        { type: 'separator' },
        { label: 'Merge Documents…', accelerator: 'CmdOrCtrl+Shift+M', click: () => send('page:merge') },
        { label: 'Split Document…', click: () => send('page:split') },
        { label: 'Split by Top-Level Bookmarks', click: () => send('page:splitBookmarks') },
        { label: 'Split by Blank Pages', click: () => send('page:splitBlank') },
      ],
    },
    {
      label: '&Protect',
      submenu: [
        { label: 'AI Smart Redact…  (Ctrl+Alt+R)', accelerator: 'CmdOrCtrl+Alt+R', click: () => send('ai:smartredact') },
        { type: 'separator' },
        { label: 'Encrypt with Password…', click: () => send('protect:encrypt') },
        { label: 'Apply & Sanitize Redactions', click: () => send('protect:redactAll') },
        { type: 'separator' },
        { label: 'Unlock Form Fields…', click: () => send('protect:unlockForms') },
        { label: 'Sanitize Document…', click: () => send('docs:sanitize') },
      ],
    },
    {
      label: '&Documents',
      submenu: [
        { label: 'Compare with Another PDF…', click: () => send('docs:compare') },
        { label: 'Overlay PDF…', click: () => send('docs:overlay') },
        { label: 'Scale Pages…', click: () => send('docs:scale') },
        { type: 'separator' },
        { label: 'Compress…', click: () => send('docs:compress') },
        { label: 'Flatten Annotations…', click: () => send('docs:flatten') },
        { label: 'Remove Blank Pages…', click: () => send('docs:removeBlanks') },
        { label: 'Remove Annotations…', click: () => send('docs:removeAnnots') },
        { label: 'Adjust Colors…', click: () => send('docs:adjustColors') },
        { type: 'separator' },
        { label: 'Multi-Page Layout (N-up)…', click: () => send('docs:nup') },
        { label: 'Join into Single Page…', click: () => send('docs:singlePage') },
        { label: 'Poster Tiles…', click: () => send('docs:poster') },
        { label: 'Booklet Imposition…', click: () => send('docs:booklet') },
        { label: 'Add Page Numbers…', click: () => send('docs:pageNumbers') },
        { type: 'separator' },
        { label: 'Split by Size…', click: () => send('docs:splitSize') },
        { label: 'Auto-Rename…', click: () => send('docs:autoRename') },
        { label: 'Repair…', click: () => send('docs:repair') },
        { label: 'Manage Attachments…', click: () => send('docs:attachments') },
        { label: 'Document Information…', click: () => send('docs:info') },
        { type: 'separator' },
        { label: 'Automate (Pipeline)…', click: () => send('docs:automate') },
      ],
    },
    {
      label: '&Assurance',
      submenu: [
        { label: 'Security Inspector…', click: () => send('assurance:inspect') },
        { label: 'Accessibility Checker…', click: () => send('assurance:accessibility') },
        { type: 'separator' },
        { label: 'Flatten && Sanitize (remove hidden revisions)…', click: () => send('assurance:sanitize') },
        { label: 'Apply Safe Accessibility Fixes…', click: () => send('assurance:a11yFix') },
        { type: 'separator' },
        { label: 'Version Timeline…', click: () => send('assurance:timeline') },
        { label: 'New Checkpoint…', click: () => send('assurance:checkpoint') },
        { type: 'separator' },
        { label: 'Trust Center — local egress && audit ledger', click: () => send('assurance:trust') },
        { label: 'Assurance Panel', click: () => send('view:assurance') },
      ],
    },
    {
      label: '&Convert',
      submenu: [
        { label: 'PDF to Word (AI)…', click: () => send('convert:toWord') },
        { type: 'separator' },
        { label: 'PDF to HTML…', click: () => send('convert:toHtml') },
        { label: 'PDF to RTF…', click: () => send('convert:toRtf') },
        { label: 'PDF to EPUB…', click: () => send('convert:toEpub') },
        { label: 'PDF to Markdown…', click: () => send('convert:toMarkdown') },
        { label: 'PDF to Plain Text…', click: () => send('convert:toText') },
        { type: 'separator' },
        { label: 'PDF to Images (PNG/JPEG)…', click: () => send('convert:toImages') },
        { label: 'Images to PDF…', click: () => send('convert:fromImages') },
      ],
    },
    {
      label: '&Forms',
      submenu: [
        { label: 'Add Text Field', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('form:addText') },
        { label: 'Add Checkbox', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('form:addCheckbox') },
        { label: 'Add Radio Group', click: () => send('form:addRadio') },
        { label: 'Add Dropdown', click: () => send('form:addDropdown') },
        { label: 'Add Signature Field', click: () => send('form:addSignature') },
        { type: 'separator' },
        { label: 'Export Form Data…', click: () => send('form:exportData') },
        { label: 'Import Form Data…', click: () => send('form:importData') },
        { label: 'Reset Form…', click: () => send('form:reset') },
      ],
    },
    {
      label: '&AI',
      submenu: [
        { label: 'Ask AI  (Ctrl+J)', click: () => send('ai:ask') },
        { label: 'Verified Edit Plan — propose, preview, approve…', accelerator: 'CmdOrCtrl+Alt+E', click: () => send('ai:planEdit') },
        { label: 'AI Agent — Edit this PDF…', accelerator: 'CmdOrCtrl+Alt+A', click: () => send('ai:agent') },
        { label: 'Summarize Document', accelerator: 'CmdOrCtrl+Shift+J', click: () => send('ai:summarize') },
        { label: 'Summarize All Documents', click: () => send('ai:summarizeAll') },
        { label: 'Extract Structured Data…', click: () => send('ai:extractData') },
        { label: 'Translate…', click: () => send('ai:translate') },
        { label: 'Rewrite Selection…', click: () => send('ai:rewrite') },
        { label: 'Proofread', click: () => send('ai:proofread') },
        { type: 'separator' },
        { label: 'Contract Review…', click: () => send('ai:contract') },
        { label: 'Document Outline', click: () => send('ai:outline') },
        { type: 'separator' },
        { label: 'Configure AI…', click: () => send('ai:settings') },
      ],
    },
    // The `zoom` and `front` roles are macOS-only and are silent no-ops
    // elsewhere, so the whole menu is dropped on Windows/Linux rather than
    // shipping items that do nothing.
    ...(isMac
      ? [{
          label: '&Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' },
          ],
        }]
      : []),
    {
      label: '&Help',
      submenu: [
        { label: 'Start page  (Ctrl+Alt+H)', accelerator: 'CmdOrCtrl+Alt+H', click: () => send('help:startPage') },
        { type: 'separator' },
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('help:shortcuts') },
        { label: 'About AiPDF Editor', click: () => send('help:about') },
        { type: 'separator' },
        { label: 'Toggle Developer Tools', role: 'toggleDevTools' },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu, MENU_ACTIONS };
