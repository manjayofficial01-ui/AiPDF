# Installing AiPDF Editor — a step-by-step guide for everyone

You do **not** need to know anything about programming to install and run this
app. Every click and every command is written out below. If you can install a
program and copy/paste a line of text, you can do this.

> **AiPDF Editor is a Windows app** (Windows 10 or 11, 64-bit). It runs on your
> own computer — your documents never leave your machine unless you turn on the
> optional AI features with your own API key.

---

## What you need before you start

| Requirement | Details |
| --- | --- |
| **Computer** | Windows 10 or 11, 64-bit |
| **Free disk space** | About **1 GB** (the app itself is smaller; this covers the temporary download files) |
| **Internet** | Needed once, to download the app |
| **Time** | 5 minutes (installer) or 15–30 minutes (from source, mostly waiting) |

---

## Two ways to get the app

| | **Option A — the ready-made installer** | **Option B — run it from the source code** |
| --- | --- | --- |
| Difficulty | ⭐ Easiest — like installing any normal program | ⭐⭐ A little more, but still just copying/pasting |
| Speed to first launch | ~5 minutes | 15–30 minutes (one-time download) |
| Best for | Most people | People who want the newest code, or want to see how it works |

---

# Option A — Install the ready-made installer (recommended)

The author publishes a finished installer file named
`AiPDF-Editor-<version>-setup.exe` (for example `AiPDF-Editor-2.26.0-setup.exe`).

### Step 1 — Open the Releases page

1. Go to the project's GitHub page in your web browser.
2. On the **right side** of the page, find the section called **Releases** and
   click it. (If you don't see it, go directly to
   `https://github.com/manjayofficial01-ui/AiPDF/releases`.)

### Step 2 — Download the installer

1. Under the newest release, click the file ending in **`-setup.exe`**.
   Example: `AiPDF-Editor-2.26.0-setup.exe`.
2. Your browser downloads it (usually to your **Downloads** folder).

### Step 3 — Run the installer

1. Open your **Downloads** folder and **double-click** the `setup.exe` file.
2. If Windows shows a blue box saying **"Windows protected your PC"**:
   - This appears because the installer is not digitally signed (a paid
     certificate that companies buy). It does **not** mean a virus — but only
     ever do this next step for files you downloaded from **this official
     GitHub page**.
   - Click **More info**, then click **Run anyway**.
3. Follow the installer: click **Next**, choose where to install (the default
   is fine), then **Install**, then **Finish**.
4. A shortcut is placed on your **Desktop** — double-click it any time to open
   AiPDF Editor. **You are done!** Skip to
   [First launch](#first-launch--what-to-expect).

> **Your antivirus may also ask about it.** Same reasoning: unsigned installer,
> downloaded from the official page → choose *Allow*. If you prefer, you can
> instead use **Option B** below, where every file comes straight from the
> source code.

---

# Option B — Run it from the source code (no programming needed)

This runs the app straight from its files. There is **no build step** — after
the one-time setup, you start the app with one double-click.

## Step 1 — Install Node.js (one time only)

Node.js is a free program that the app needs to run. You install it once, like
any other program.

1. Open your browser and go to **https://nodejs.org**.
2. Click the big green button that says **"LTS"** (Long Term Support — the
   stable version). It downloads a file like `node-v22.x.x-x64.msi`.
3. **Double-click** the downloaded file. The installer opens.
4. Click through it:
   - **Next** → tick **"I accept the terms"** → **Next**.
   - Keep the default installation folder → **Next**.
   - Keep everything on the next screens as-is (default: full install) → **Next**.
   - On the **"Tools for Native Modules"** screen, you can **leave the checkbox
     unticked** — you don't need it → **Next**.
   - Click **Install** (allow the permission prompt), then **Finish**.

✅ **Check it worked:** click the **Start** button, type `cmd`, press **Enter**.
A black window (the *Command Prompt*) opens. Type this and press Enter:

```
node --version
```

If you see something like `v22.14.0` — it worked. If you see
`'node' is not recognized...`, close the black window, open it again and try
once more (Windows only learns about newly installed programs after a reopen).
If it still fails, restart your computer and try again.

You can close the black window now, or keep it open for Step 4.

## Step 2 — Download the project

1. Go to **https://github.com/manjayofficial01-ui/AiPDF**.
2. Click the green **`<> Code`** button.
3. In the small menu that opens, click **"Download ZIP"**.
4. Your browser downloads a file like `AiPDF-main.zip` (to your **Downloads**
   folder).

## Step 3 — Extract (unzip) it

1. Right-click `AiPDF-main.zip` → **Extract All…** → **Extract**.
2. You now have a folder, e.g. **`AiPDF-main`**. You can move it somewhere you
   like, for example `C:\Apps\AiPDF-main` or your Desktop.
3. Open the folder — you should see items like `src`, `package.json`,
   `README.md`. **Leave this folder open** for the next step.

## Step 4 — Open a Command Prompt *inside* that folder

There's a neat trick so you never have to type paths:

1. Click the **address bar** at the top of the folder window (the strip that
   shows the folder's location).
2. Type **`cmd`** there and press **Enter**.
3. A black Command Prompt window opens **already pointed at the right folder**.
   (You can tell because the path shown ends with `AiPDF-main`.)

## Step 5 — Download the app's building blocks (`npm install`)

In that black window, type this and press **Enter**:

```
npm install
```

- This downloads the parts the app needs (about 400–500 MB). Expect **2–10
  minutes** depending on your internet.
- You will see lots of scrolling text — that is normal.
- A few lines saying `npm warn ...` are **harmless warnings**, not errors.
- When it finishes, the prompt (`...AiPDF-main>`) comes back and you can type
  again. If you see lines starting with `npm error`, see
  [Troubleshooting](#troubleshooting).

> You only ever do this step **once**. The next times, you jump straight to
> Step 6.

## Step 6 — Start the app

In the same black window, type this and press **Enter**:

```
npm start
```

- After about **5–15 seconds** the AiPDF Editor window opens. 🎉
- **Keep the black window open while you use the app** — it is the app's
  engine. Closing the black window also closes the app.
- The next time you want the app: open the `AiPDF-main` folder, type `cmd` in
  the address bar, press Enter, then type `npm start`.

## Step 7 (optional) — Make it a one-double-click app

The project includes a file called **`Start AiPDF Editor.bat`**. After the
one-time setup above, you can simply:

- **Double-click** `Start AiPDF Editor.bat` inside the `AiPDF-main` folder —
  it starts the app for you.
- Want a desktop shortcut? Right-click the `.bat` file →
  **Show more options** → **Send to** → **Desktop (create shortcut)**.

---

## First launch — what to expect

- The app opens **directly into the editor workspace** (ribbon, tabs, status
  bar). Open a PDF with **File ▸ Open** (or drag a PDF onto the window), or
  click **Create blank PDF** / **Images → PDF** on the welcome card.
- Page drawing uses your computer's processor by default (this is deliberate —
  it is the most reliable mode and works on machines where graphics drivers
  are flaky, including virtual machines). You don't have to do anything.
- **Everything works without any account or API key**: viewing, commenting,
  editing, organizing pages, forms, encryption, redaction, and offline OCR
  (English, Hindi, Nepali).

## Using the AI features (optional)

The AI assistant is *bring-your-own-key*: the app talks to the AI provider
**you** choose, with **your** key. Nothing is sent anywhere until you configure
this — and the first time a document would leave your machine, the app asks
for permission and tells you exactly what is going where.

1. Open **AI ▸ Configure** (or click the AI chip in the title bar).
2. Pick a preset — for example **OpenAI**, **Google Gemini**, **OpenRouter**,
   **Groq**, or a local one (**Ollama**, **LM Studio** — no internet needed).
3. Paste your **API key** (you get one from that provider's website) and click
   **Test connection**.

No key? Skip this — all other features work fine.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `'npm' is not recognized` (or `'node' is not recognized`) | Node.js isn't installed, or the black window was opened **before** the install. Close the black window, open it again, retry. Still failing? Restart the PC. |
| `npm install` seems stuck for a long time | It may be downloading Electron (~100 MB+). Give it up to 10 minutes. Don't close the window. |
| `npm install` ends with `npm error` | Check your internet, then run `npm install` again. If it still fails: delete the `node_modules` folder inside `AiPDF-main`, then run `npm install` again. |
| `npm start` — nothing opens | Wait ~15 seconds. If still nothing, look at the black window for an error message and see the next row. |
| A window flashed and disappeared / error text appears | Take a screenshot of the text. The most common cause is a half-finished Step 5 — run `npm install` once more, then `npm start`. |
| Antivirus quarantines the installer | Unsigned-installer false alarm. Restore it and add an exception, **only** if you downloaded it from the official GitHub page. |
| The installer says a DLL or Windows version is missing | You need Windows 10 or 11 (64-bit) with current Windows updates installed. |
| Text in the app looks tiny/huge | Windows display scaling — try **View ▸ Zoom** in the app, or set Windows scaling to 100–150 %. |

Still stuck? Open an issue on the GitHub page
(`https://github.com/manjayofficial01-ui/AiPDF/issues`) — include the error
text from the black window and your Windows version.

---

## For advanced users

```bash
npm run dist        # build the Windows installer yourself → dist-build/AiPDF-Editor-<version>-setup.exe
npm run dev         # launch with DevTools + verbose console
npm start -- --gpu  # opt into hardware acceleration (default is software rendering)
```

The full developer documentation, architecture and test suite are in the
[README](README.md).
