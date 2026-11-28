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
The page is **GTA V Browser From GN-MATH / Elijah Whisler**. The site only hosts the runtime scripts (`index.html`, `loader.js`, `game.js` and the workers). Every player brings their own copy of the game files as a .zip: the page reads them straight out of the zip on their disk. Nothing is uploaded, and no game files are downloaded from the site.

**Turn on the site (once, in this repo):**
1. Open the repo's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose the **main** branch and the **/ (root)** folder, then click **Save**.
3. After a minute or two the site is live at `https://<your-github-username>.github.io/playgta5/`.

**Play:**
1. Open the site in a recent **Chrome** or **Edge** on a desktop computer. On the first visit the page reloads itself once. That reload turns on the shared memory the engine needs, which GitHub Pages can't enable by itself.
2. Click **Choose your .zip** and pick your zip of the game files (for example `GTA5Webport.zip`), or drop it on the page. There's no need to extract it: the page reads the game files straight out of the zip.
   - It loads fastest when the zip is on the computer itself (not on Google Drive) and was made without compression: compressed files have to be unpacked while you play, which takes CPU time from the game. The overlay's *zip* line (see below) shows how long reads take.
   - An extracted `mirror` folder still works: add `?folder=1` to the address and click **Choose a folder instead**.
   - If the browser asks whether to "upload" the files or to let the site "view files", that's only how browsers word giving a page read access to a folder or file. Nothing is sent anywhere.
3. The page checks your files against the game's file list and starts the game. If something is missing or looks incomplete, it tells you what, and you can still try with **Start anyway**.
4. On your next visit, Chrome and Edge remember the folder or zip, so you only need to click **Continue with …**.

**Graphics (speed):** the setup screen has a **Graphics** choice. **Fastest** is picked automatically on Chromebooks and on computers with 4 or fewer CPU threads; **Balanced** is the step up. It runs at 58 % resolution with the lowest world the game allows (shortest draw distance, fewest people and cars, no shadows, lower texture detail), the game's screen effects off (ambient occlusion, depth of field, motion blur, anti-aliasing) and reflections redrawn only every 30th frame. **Fast** (45 %) is the same at a lower resolution, and **Fastest** cuts the most: it renders at 270p at most (480x270; add `?scale=0.25` to the address to go lower still), keeps at most 2 people (passers-by and the ones sitting or standing about, such as on the beach) and 4 traffic cars around you, as do Fast and Balanced (the `=` overlay's *people and traffic* line shows whether the game has read the limit; add `?pop=0` for the game's own numbers, or `?pop=5,8` for 5 people and 8 cars; mission characters and mission cars are made by the story and are never affected), the shortest draw distance, the fewest reflections and no furry lawn grass (add `?skipfx=none` to the address to bring it back). (On a Chromebook the graphics chip itself is mostly idle, so Fastest keeps a sharper picture than Fast; what slows it down is Chrome handling the commands, see below.) **Full** is native resolution with the game's own settings. The choice is remembered.

**Draw distance and hidden objects:** Balanced, Fast and Fastest draw buildings, props and trees only within a set distance of you: 200 m on Balanced, 120 m on Fast, 60 m on Fastest. The distance is measured to the nearest part of each object, worked out from the object's own shape (read once from the graphics card the first time it's drawn), so a long road or a big block of buildings stays as long as any part of it is near. Things too small to see at their distance are left out too, and so is anything hidden behind a building or a hill: the depth of the frame or two before shows what's covered, and an object entirely behind it isn't drawn. Objects come out from behind a corner a frame or two late at most; when the camera jumps (a cut, a respawn), everything is drawn until the next frame shows what's hidden. People, cars and anything that can break (lamp posts, signs, fences) are always drawn, except their small rigid parts far away (a car's wheels beyond 50 m or so on Fastest, where they're a pixel or two); the ground, water and sky still reach the horizon, though ground hidden behind buildings or hills isn't drawn. The distance follows the frame rate: once a second it shrinks (down to 40 % of its starting value, but never below 40 m, or 30 m on Fastest) while the game is slower than its goal and drawing is what holds it back, and grows again (up to twice the starting value) when there is room. The goals are about 30 frames per second on Balanced, 40 on Fast and 50 on Fastest. The game still loads the world by its own rules (that part can't be changed from the browser), but what's far away or hidden is no longer drawn, and on a Chromebook the frame time follows the number of draws almost exactly. Add `?chunk=0` to the address to turn the distance off, `?chunk=150,5` to set it (metres, then the smallest size drawn in thousandths of its distance), `?occl=0` to draw hidden objects again, or `?fpsgoal=45` to aim at another frame rate (`?fpsgoal=0` keeps the distance fixed). On Fast and Fastest no shaders are prepared in the background while you play (each is prepared when it's first needed). If the overlay's draw distance line says *not working here*, the game's object positions weren't found on your computer, so nothing is being left out; a screenshot of it helps.

Some of those effects have no command-line switch, so Balanced, Fast and Fastest turn them off in the game's own settings file (kept in your browser) just before the game starts. The game writes that file on its first start, so they take effect from the second. Choosing **Full** puts the original values back. On a 4-thread CPU (such as an Intel N100) the game is told it has 2 cores, which leaves the rest to the graphics translation and the browser.

**Less work for the graphics side:** on a Chromebook, most of a frame's time goes to Chrome's GPU process handling the commands, not to the graphics chip (an N100 Chromebook's overlay showed the chip busy 10 ms of an 80 ms frame). So the port avoids commands that change nothing: mipmaps the game regenerates every frame for pictures that haven't changed (the car-reflection cube map's faces are redrawn only every 30th or 60th frame) are skipped, the depth buffer is read directly by shaders instead of being copied first (shaders that sample it get a variant that reads the exact texel, which is what sampling depth gives), and data updates of things already in use are done in place instead of forcing extra submits. Such an update no longer cuts the current drawing pass in two: it waits until the pass ends, and the pass is split only if a later draw in it uses the new data. Each drawing pass starts with the graphics defaults, and the port only sends a viewport, scissor rectangle, blend constant or stencil reference when a draw needs a different one (they used to be sent at the start of every pass). The game's GPU fences (how it paces itself against the graphics side) are answered as soon as the frame's commands are handed over, instead of after a round trip through Chrome's GPU process; add `?gpufences=1` to the address to go back to waiting for the GPU. Add `?depthdirect=0` to the address to go back to copying the depth (if lighting ever looks wrong, that's the first thing to try).

**Frame rate overlay:** press `=` in the game to show the frame rate and where each frame's time goes: *GPU busy* (from handing work to the graphics side until it's done: Chrome's GPU process handling each draw, plus the graphics chip itself), *translating* (turning the game's draw calls into WebGPU, on the CPU) and *waiting for the game* (the game's own threads, also on the CPU). A *most drawn* line lists what the draws are (the game's shader names: `ped` people, `vehicle_…` cars, `trees…`, `normal…`/`spec…` buildings and props, `im` blits and menus), a *reflections* line shows how many draws the reflections take and how many were skipped, a *draw distance* line shows the distance, how many far or tiny draws and how many hidden ones were left out (or why hidden objects can't be worked out on your computer), and for what share of the world's draws the object sizes are known yet (the others are drawn), a *per frame* line shows what the graphics side was handed each frame (passes by what they're for: drawing, mipmaps, depth copies, clears; mipmap passes skipped because the picture hadn't changed; submits and why; data updates done in place; bind groups made; megabytes uploaded), the draw distance line also says why the world's drawn objects were kept (*skinned*, *instanced*, *near*...), a *passes start with* line names which of the game's steps start the most drawing passes (the effect of a pass's first draw and its target), a *the game waited for* line shows how long the game sat idle waiting for answers from the graphics side (data read back from the GPU, occlusion results, GPU fences), a *zip* line shows the game's reads from your zip (reads and megabytes a second, how long each read took and the longest, and time spent unpacking compressed files), a *graphics chip* line (measured every 2 seconds while the overlay is shown, where the browser supports timestamp queries) shows how long the chip itself worked on a frame and which passes took longest, and a *saved* line counts the work avoided per frame (screen clears folded into the next drawing pass, constant uploads that matched the previous ones, empty draws). The last line names the slowest part. If it's the graphics side, fewer draws help most and fewer pixels (**Fast**, **Fastest**) help somewhat. If it's the CPU, a lower resolution won't help much: close other tabs and keep a Chromebook plugged in. When the frame rate is low the game itself runs slower than real time (cutscenes look like slow motion), because it limits how much game time passes per frame, so more frames is the only fix.

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
