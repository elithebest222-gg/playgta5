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

**Graphics (speed):** the setup screen has a **Graphics** choice. **Balanced** is picked automatically on Chromebooks and on computers with 4 or fewer CPU threads. It runs at 58 % resolution with the lowest world the game allows (shortest draw distance, fewest people and cars, no shadows, lower texture detail), the game's screen effects off (ambient occlusion, depth of field, motion blur, anti-aliasing) and reflections redrawn only every 30th frame. **Fast** (45 %) and **Fastest** (35 %) are the same at lower resolutions. **Full** is native resolution with the game's own settings. The choice is remembered.

**Chunks:** Balanced, Fast and Fastest also draw buildings, props and trees only in the 3x3 grid of map chunks around you, and people and cars only within a shorter distance. The ground, water and sky still reach the horizon. The chunk size follows the frame rate: once a second it shrinks (down to 40 % of its starting size) while the game is slower than its goal and drawing is what holds it back, and grows again (up to twice the starting size) when there is room. The goals are about 30 frames per second on Balanced, 40 on Fast and 50 on Fastest. The game still loads the world by its own rules (that part can't be changed from the browser), but what's far away is no longer drawn, and on a Chromebook the frame time follows the number of draws almost exactly. Add `?chunk=0` to the address to turn chunks off, or `?fpsgoal=45` to aim at another frame rate (`?fpsgoal=0` keeps the size fixed). On Fast and Fastest, distant trees' stand-ins (the far forest), trees and see-through glass and fences have shorter distances of their own, and no shaders are prepared in the background while you play (each is prepared when it's first needed). If the overlay's chunks line says *not working here*, the game's object positions weren't found on your computer, so nothing is being left out; a screenshot of it helps.

Some of those effects have no command-line switch, so Balanced, Fast and Fastest turn them off in the game's own settings file (kept in your browser) just before the game starts. The game writes that file on its first start, so they take effect from the second. Choosing **Full** puts the original values back. On a 4-thread CPU (such as an Intel N100) the game is told it has 2 cores, which leaves the rest to the graphics translation and the browser.

**Frame rate overlay:** press `=` in the game to show the frame rate and where each frame's time goes: *GPU busy* (from handing work to the graphics side until it's done: Chrome's GPU process handling each draw, plus the graphics chip itself), *translating* (turning the game's draw calls into WebGPU, on the CPU) and *waiting for the game* (the game's own threads, also on the CPU). A *most drawn* line lists what the draws are (the game's shader names: `ped` people, `vehicle_…` cars, `trees…`, `normal…`/`spec…` buildings and props, `im` blits and menus), a *reflections* line shows how many draws the reflections take and how many were skipped, a *chunks* line shows how many far draws were left out, a *graphics chip* line (measured every 2 seconds where the browser supports timestamp queries) shows how long the chip itself worked on a frame and which passes took longest, and a *saved* line counts the work avoided per frame (screen clears folded into the next drawing pass, constant uploads that matched the previous ones, empty draws). The last line names the slowest part. If it's the graphics side, fewer draws help most and fewer pixels (**Fast**, **Fastest**) help somewhat. If it's the CPU, a lower resolution won't help much: close other tabs and keep a Chromebook plugged in. When the frame rate is low the game itself runs slower than real time (cutscenes look like slow motion), because it limits how much game time passes per frame, so more frames is the only fix.

**Saving:** saves are kept in your browser for this site, and a "Game saved" notice shows each time the game saves. Story Mode saves by itself after each mission, but the first mission (the prologue) has to be finished before the first save. The next time you play, Story Mode continues from your newest save.

You don't have to use GitHub Pages: any web server works too. For example, run `python -m http.server 8000 --bind 127.0.0.1` in this folder and open `http://localhost:8000/`.

**If something goes wrong:**
- *Cross-origin isolation* is marked ✕: reload the page. Don't use a private window, and open the site over `https://`, not as a file on your disk.
- *WebGPU* is marked ✕: update your browser and graphics driver (`chrome://gpu` shows what's wrong).
- The picture looks wrong (too bright, black, missing things): yellow text in the top-right corner names the graphics errors. Take a screenshot of it, plus one of the setup screen (it shows your GPU), when you report the problem.
- It runs slowly: choose **Balanced**, **Fast** or **Fastest** under Graphics on the setup screen, close other tabs, and keep a Chromebook plugged in. Press `=` in the game and include a screenshot of the numbers when you report it.
- Parts of the world show as plain white: add `?nanhunt=1` to the site's address (for example `https://<your-github-username>.github.io/playgta5/?nanhunt=1`). About 10 seconds after the world appears, the top-right corner names the shader that produces the bad values. If it finds one, press Esc to free the mouse, click **Copy details for the developer** (or **Save as file**), and send that text with your report.
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
