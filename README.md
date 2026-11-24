# playgta5 Source Code
This code is grabbed from playgta5.com before it got took down. You can run this locally or make it public hehe.

# Credits
Shoutout to Sebas Furbastian on Telegram for scrapping this code. Idk what is his GitHub but here's the Telegram and X.

Telegram: @SebasKitten

X: @Sebas_Kitten

# Link
Telegram: https://t.me/reGRANDTA

Discord: https://discord.gg/hrbcPjjZfj


# Disclaimer
I don't host the `.\mirror` folder since it has copyrighted content from Rockstar Games. Please find the files by yourself.

No copyrighted file is included in this repo. If Rockstar Games or any affiliated group think this repo has copyright infringement things, email me at shadany7824@gmail.com for me to took it down.

And don't email me for asking the mirror folder. I will not reply to the email.

# How to use

## Option A: play in the browser (GitHub Pages)
The site only hosts the runtime scripts (`index.html`, `loader.js`, `game.js` and the workers). Every player brings their own `mirror` folder, or a .zip of it: the page reads the game files straight from their disk. Nothing is uploaded, and no game files are downloaded from the site.

**Turn on the site (once, in this repo):**
1. Open the repo's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose the **main** branch and the **/ (root)** folder, then click **Save**.
3. After a minute or two the site is live at `https://<your-github-username>.github.io/playgta5/`.

**Play:**
1. Open the site in a recent **Chrome** or **Edge** on a desktop computer. On the first visit the page reloads itself once. That reload turns on the shared memory the engine needs, which GitHub Pages can't enable by itself.
2. Click **Choose your mirror folder** and pick your `mirror` folder (the one that contains `playgta5.com`), or the `playgta5.com` folder itself.
   - **Have the zip instead?** Click **Choose a .zip instead** and pick it (for example `playgta5-offline-2026-10-06.zip`). There's no need to extract it: the page reads the game files straight out of the zip.
   - You can also drag the folder or the zip onto the page.
   - If the browser asks whether to "upload" the files or to let the site "view files", that's only how browsers word giving a page read access to a folder or file. Nothing is sent anywhere.
3. The page checks your files against the game's file list and starts the game. If something is missing or looks incomplete, it tells you what, and you can still try with **Start anyway**.
4. On your next visit, Chrome and Edge remember the folder or zip, so you only need to click **Continue with …**.

You don't have to use GitHub Pages: any web server works too. For example, run `python -m http.server 8000 --bind 127.0.0.1` in this folder and open `http://localhost:8000/`.

**If something goes wrong:**
- *Cross-origin isolation* is marked ✕: reload the page. Don't use a private window, and open the site over `https://`, not as a file on your disk.
- *WebGPU* is marked ✕: update your browser and graphics driver (`chrome://gpu` shows what's wrong).
- The game stops with "could not read … from your game folder": the folder or zip was moved, or some files are missing. Reload and pick it again.
- "Big game files are compressed inside the zip": the game reads small pieces from the middle of its big files, which a compressed zip can't give it. Zips made with no compression (like `playgta5-offline-2026-10-06.zip`) work in place. For a compressed zip, either extract it and pick the extracted folder, or make the zip again without compression (7-Zip: compression level "Store").
  - On a Chromebook, you can skip extracting: open the zip in the Files app (it opens like a folder), then use **Choose your mirror folder** and pick the `mirror` folder inside it.

## Option B: run it locally (Windows)
1. Download the ZIP or just `git clone` it. It should have all this file and folders.
<p align="center">
  <img src="media/Screenshot 2026-10-07 172103.png" alt="playgta5 SC">
</p>

2. Paste your `mirror` folder into the repo folder, next to `serve_local.py`. (It should have 19.7 GB of file size. Check the pic below.)
<p align="center">
  <img src="media/Screenshot 2026-10-07 172216.png" alt="Folder Properties">
</p>
<p align="center">
  <img src="media/Screenshot 2026-10-07 172718.png" alt="Folder Properties">
</p>
<p align="center">
  <img src="media/Screenshot 2026-10-07 172758.png" alt="Folder Properties">
</p>

3. Run the `Launch-Local.cmd` and it will automatically open the URL at `http://localhost:8000/`.

4. Voila!

# Requirement
The game itself needs a desktop browser with WebGPU (a recent Chrome or Edge), and 8 GB of memory or more is recommended. Close other tabs before you start.

Scripts require standard-library Python 3.11 or newer. The bundled Python path
in the commands above is specific to the original PC; the portable ZIP instead
provides `runtime\python.exe` and the double-click launcher.
Completed files and `.part` transfers are retained for resumption. Final checks
cover inventory sizes, runtime hash samples, WASM signature, HTTP isolation,
range reads and both batch formats. Actual gameplay requires separate browser
validation. A public client snapshot is not the site's original development repository.

To resume with the current uncapped settings, append `--workers 32 --rate-mib 0`
to the downloader command. Content lengths from HTTP take precedence over the
source manifest when it is stale; mismatches are recorded explicitly.
