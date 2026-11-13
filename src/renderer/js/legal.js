/**
 * Publisher, website and licence information for AiPDF Editor.
 *
 * This module is the single source of truth for the identity shown in the UI.
 * The same values are written into the Windows executable's version resource
 * and the installer by package.json (author / copyright / win.publisherName /
 * win.legalTrademarks), and shipped as resources/NOTICE.txt + LICENSE.txt.
 * Keeping the full MIT text here means security software and users can see the
 * exact terms without leaving the application.
 */
import { el } from './util.js';
import { showModal } from './dialog.js';

export const APP_LEGAL = Object.freeze({
  product: 'AiPDF Editor',
  author: 'Manjay Dongol',
  publisher: 'Manjay Dongol',
  website: 'https://github.com/manjayofficial01-ui/AiPDF',
  license: 'MIT License',
  copyright: 'Copyright (c) 2026 Manjay Dongol',
});

/** Verbatim copy of the repository LICENSE file. */
export const MIT_LICENSE_TEXT = `MIT License

Copyright (c) 2026 Manjay Dongol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** Open an allowlisted URL in the OS browser / Windows settings (main process). */
function openExternal(url) {
  try { window.api.openExternal(url); } catch { /* bridge missing in headless probes */ }
}

function factRow(label, value) {
  return el('div', { class: 'lg-row' }, [
    el('span', { class: 'lg-key', text: label }),
    el('span', { class: 'lg-val', text: value }),
  ]);
}

function websiteRow() {
  const link = el('a', {
    class: 'lg-link',
    href: APP_LEGAL.website,
    text: APP_LEGAL.website,
    rel: 'noopener noreferrer',
    onclick: (e) => { e.preventDefault(); openExternal(APP_LEGAL.website); },
  });
  return el('div', { class: 'lg-row' }, [
    el('span', { class: 'lg-key', text: 'Website' }),
    el('span', { class: 'lg-val' }, [link]),
  ]);
}

/** Help ▸ About AiPDF Editor — identity, publisher, website and licence. */
export async function showAboutDialog(version = '') {
  const choice = await showModal({
    title: 'About AiPDF Editor',
    width: '',
    body: (b) => {
      b.appendChild(el('div', { class: 'lg-about' }, [
        el('div', { class: 'lg-brand' }, [
          el('span', { class: 'lg-mark', text: 'A' }),
          el('div', { class: 'lg-brand-txt' }, [
            el('div', { class: 'lg-name', text: APP_LEGAL.product }),
            el('div', { class: 'lg-ver', text: version ? `Version ${version}` : 'Local-first PDF viewer & editor' }),
          ]),
        ]),
        el('p', { class: 'lg-desc', text: 'A fast, local-first PDF viewer and editor with an AI assistant that cites the page it used. Built with Electron, pdf.js and pdf-lib.' }),
      ]));

      b.appendChild(el('div', { class: 'lg-facts' }, [
        factRow('Author', APP_LEGAL.author),
        factRow('Publisher', APP_LEGAL.publisher),
        websiteRow(),
        factRow('Licence', APP_LEGAL.license),
        factRow('Copyright', APP_LEGAL.copyright),
      ]));

      b.appendChild(el('p', {
        class: 'hint',
        style: { flex: '0 0 auto' },
        text: 'The full MIT licence text is available below, in the installed resources/LICENSE.txt and at the website above.',
      }));
    },
    buttons: [
      { label: 'License & attribution', value: 'license', kind: 'ghost' },
      { label: 'OK', value: 'ok', kind: 'primary', default: true },
    ],
  });
  if (choice === 'license') await showLicenseDialog();
}

/** Help ▸ License & attribution — the complete MIT terms. */
export async function showLicenseDialog() {
  await showModal({
    title: 'License & attribution',
    width: '',
    body: (b) => {
      b.appendChild(el('div', { class: 'lg-lic-head', text: `${APP_LEGAL.product} is distributed under the ${APP_LEGAL.license}.` }));
      b.appendChild(el('pre', { class: 'lg-lic-text', text: MIT_LICENSE_TEXT }));
      b.appendChild(el('div', { class: 'lg-facts' }, [
        factRow('Author', APP_LEGAL.author),
        factRow('Publisher', APP_LEGAL.publisher),
        websiteRow(),
      ]));
    },
    buttons: [{ label: 'Close', value: true, kind: 'primary', default: true }],
  });
}
