// wasm/platform/graphics/wgpu_worker.js
//
// The GPU worker of the wasm port: a plain JS worker (Node worker_threads or a browser dedicated worker) that owns the
// WebGPU device and executes the command stream the game writes into a ring buffer in the shared wasm memory.
//
// Why a separate worker and not calls from the game's render pthread:
//  - WebGPU objects cannot cross threads, but D3D11 resources are created by any engine thread (streaming, main, render).
//    The game threads only emit commands; every WebGPU object lives here.
//  - WebGPU is asynchronous (device creation, mapAsync, onSubmittedWorkDone); this worker has a normal event loop, the
//    game's blocking C++ threads never have to yield to JS. They wait on a futex/fence word in the ring when they need a
//    result (readback, occlusion query).
//
// Protocol (see wgpu_backend.h for the C++ producer; keep both in sync):
//   ring header, int32 words at the ring base address:
//     [0] head  byte offset of the next free byte (written by the producer(s) under a lock, published with release)
//     [1] tail  byte offset of the next unread command (written by this worker)
//     [2] state 0 = starting, 1 = running, 2 = failed (commands are drained and dropped)
//     [3] executed command counter (statistics)
//     [4] error counter (WebGPU validation errors reported by the device)
//   commands start at byte offset RING_DATA; each command = 2 header words (opcode, payload word count) + payload words.
//   opcode WRAP: the producer continues at RING_DATA.
//
// Node needs the `webgpu` npm package (Dawn). Its location: env WGPU_NODE_MODULE, default D:/wasm_build/shaders/node/node_modules/webgpu.

'use strict';

const RING_DATA = 64;
// keep in sync with wgpu_backend.h
const OP = {
	NOP: 0, WRAP: 1, INIT: 2, CREATE_TEXTURE: 3, DESTROY_OBJECT: 4, CLEAR_RT: 5, CLEAR_DS: 6, PRESENT: 7, FENCE: 8,
	SCREENSHOT: 9, LOG: 10, CREATE_BUFFER: 11, UPLOAD_BUFFER: 12, UPLOAD_TEXTURE: 13, CREATE_SHADER: 14, CREATE_LAYOUT: 15,
	CREATE_STATE: 16, CREATE_SRV: 17, SET_SHADER: 18, SET_INPUT_LAYOUT: 19, SET_TOPOLOGY: 20, SET_VERTEX_BUFFERS: 21,
	SET_INDEX_BUFFER: 22, SET_CBUFFERS: 23, SET_SRVS: 24, SET_SAMPLERS: 25, SET_RENDER_TARGETS: 26, SET_BLEND: 27,
	SET_DEPTH_STENCIL: 28, SET_RASTER: 29, SET_VIEWPORTS: 30, SET_SCISSORS: 31, DRAW: 32, CLEAR_STATE: 33,
	COPY_REGION: 34, COPY_RESOURCE: 35, RESOLVE: 36, CREATE_UAV: 37, SET_UAVS: 38, DISPATCH: 39, CLEAR_UAV: 40, GENERATE_MIPS: 41, READBACK: 42, COPY_COUNTER: 43, CREATE_QUERY: 44, BEGIN_QUERY: 45, END_QUERY: 46, UPLOAD_BUFFER_NO_OVERWRITE: 47,
};

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
let parentPort = null;
if (isNode) parentPort = require('worker_threads').parentPort;

function post(msg) { if (parentPort) parentPort.postMessage(msg); else self.postMessage(msg); }
// The player's own folder (index.html on GitHub Pages): loader.js sends { localFiles: { prefix, files: Map name -> File, dir } } before the engine starts this worker.
// A fetch of a URL under `prefix` (the build's shaders folder: index.json, the pipeline seeds, the packs, single shaders) is then answered from those Files (or
// looked up in `dir`, a directory handle, when the name is not in the map); nothing of it goes to the network.
let localFiles = null;
if (!isNode) {
	const netFetch = self.fetch.bind(self);
	self.fetch = async (url, init) => {
		const lf = localFiles, u = typeof url === 'string' ? url : url && url.url;
		if (!lf || !u || !u.startsWith(lf.prefix)) return netFetch(url, init);
		const name = decodeURIComponent(u.slice(lf.prefix.length).split(/[?#]/)[0]);
		let file = lf.files.get(name) || null;
		if (!file && lf.dir && !name.includes('/')) {
			try { file = await (await lf.dir.getFileHandle(name)).getFile(); lf.files.set(name, file); } catch (e) { /* not in the folder */ }
		}
		return file ? new Response(file) : new Response(null, { status: 404, statusText: 'Not Found' });
	};
}
// fs.writeSync: process.stderr in a worker is proxied through the main thread, whose event loop the blocked game never runs
function logLine(s) {
	if (isNode) { require('fs').writeSync(2, '[wgpu] ' + s + '\n'); return; }
	console.log('[wgpu] ' + s);
	// with ?log=1 on the page (loader.js puts it in this worker's URL) the page forwards it to the dev server (index.html, 'game-log'): a synchronous POST here stalled
	// this worker for a network round trip (remote players: tens of ms)
	if (logLine.remote === undefined) logLine.remote = new URLSearchParams(self.location.search).get('log') === '1';
	if (logLine.remote) try { (logLine.bc || (logLine.bc = new BroadcastChannel('game-log'))).postMessage('[wgpu] ' + s); } catch (e) { /* no channel */ }
}

// ---- D3D11 (DXGI) -> WebGPU formats ----------------------------------------------------------------------------------
// DXGI_FORMAT numbers. `ds` = the texture is bound as a depth-stencil target. Typeless formats pick the format the game
// most plausibly views them as; `views` are extra view formats (sRGB reinterpretation).
const DXGI = {
	R32G32B32A32_FLOAT: 2, R32G32B32_FLOAT: 6, R16G16B16A16_TYPELESS: 9, R16G16B16A16_FLOAT: 10, R16G16B16A16_UNORM: 11,
	R32G32_FLOAT: 16, R32G8X24_TYPELESS: 19, D32_FLOAT_S8X24_UINT: 20, R10G10B10A2_TYPELESS: 23, R10G10B10A2_UNORM: 24,
	R11G11B10_FLOAT: 26, R8G8B8A8_TYPELESS: 27, R8G8B8A8_UNORM: 28, R8G8B8A8_UNORM_SRGB: 29, R16G16_TYPELESS: 33,
	R16G16_FLOAT: 34, R16G16_UNORM: 35, R32_TYPELESS: 39, D32_FLOAT: 40, R32_FLOAT: 41, R24G8_TYPELESS: 44,
	D24_UNORM_S8_UINT: 45, R8G8_TYPELESS: 48, R8G8_UNORM: 49, R16_TYPELESS: 53, R16_FLOAT: 54, D16_UNORM: 55,
	R8_TYPELESS: 60, R8_UNORM: 61, BC1_TYPELESS: 70, BC1_UNORM: 71, BC1_UNORM_SRGB: 72, BC2_TYPELESS: 73, BC2_UNORM: 74,
	BC2_UNORM_SRGB: 75, BC3_TYPELESS: 76, BC3_UNORM: 77, BC3_UNORM_SRGB: 78, BC4_TYPELESS: 79, BC4_UNORM: 80,
	BC5_TYPELESS: 82, BC5_UNORM: 83, B8G8R8A8_UNORM: 87, B8G8R8X8_UNORM: 88, B8G8R8A8_TYPELESS: 90,
	B8G8R8A8_UNORM_SRGB: 91, BC6H_TYPELESS: 94, BC6H_UF16: 95, BC7_TYPELESS: 97, BC7_UNORM: 98, BC7_UNORM_SRGB: 99,
};
const BIND_SRV = 0x8, BIND_RT = 0x20, BIND_DS = 0x40, BIND_UAV = 0x80;

function mapFormat(f, bind) {
	const ds = (bind & BIND_DS) !== 0;
	switch (f) {
	case DXGI.R32G32B32A32_FLOAT: return { format: 'rgba32float' };
	case DXGI.R16G16B16A16_TYPELESS: case DXGI.R16G16B16A16_FLOAT: return { format: 'rgba16float' };
	case DXGI.R16G16B16A16_UNORM: return { format: 'rgba16float' };	// no core rgba16unorm: TODO texture-formats-tier1
	case DXGI.R32G32_FLOAT: return { format: 'rg32float' };
	case DXGI.R10G10B10A2_TYPELESS: case DXGI.R10G10B10A2_UNORM: return { format: 'rgb10a2unorm' };
	case DXGI.R11G11B10_FLOAT: return noRG11 ? { format: 'rgba16float', r11: true } : { format: 'rg11b10ufloat' };		// r11: uploads are converted (uploadTexture)
	case DXGI.R8G8B8A8_TYPELESS: case DXGI.R8G8B8A8_UNORM: return { format: 'rgba8unorm', views: ['rgba8unorm-srgb'] };
	case DXGI.R8G8B8A8_UNORM_SRGB: return { format: 'rgba8unorm-srgb', views: ['rgba8unorm'] };
	case DXGI.B8G8R8A8_TYPELESS: case DXGI.B8G8R8A8_UNORM: case DXGI.B8G8R8X8_UNORM: return { format: 'bgra8unorm', views: ['bgra8unorm-srgb'] };
	case DXGI.B8G8R8A8_UNORM_SRGB: return { format: 'bgra8unorm-srgb', views: ['bgra8unorm'] };
	case DXGI.R16G16_TYPELESS: case DXGI.R16G16_FLOAT: case DXGI.R16G16_UNORM: return { format: 'rg16float' };
	case DXGI.R32_TYPELESS: return { format: ds ? 'depth32float' : 'r32float' };
	case DXGI.D32_FLOAT: return { format: 'depth32float' };
	case DXGI.R32_FLOAT: return { format: 'r32float' };
	case DXGI.R32G8X24_TYPELESS: case DXGI.D32_FLOAT_S8X24_UINT: return { format: noD32S8 ? 'depth24plus-stencil8' : 'depth32float-stencil8' };
	case DXGI.R24G8_TYPELESS: case DXGI.D24_UNORM_S8_UINT: return { format: 'depth24plus-stencil8' };
	case DXGI.R8G8_TYPELESS: case DXGI.R8G8_UNORM: return { format: 'rg8unorm' };
	case DXGI.R16_TYPELESS: return { format: ds ? 'depth16unorm' : 'r16float' };
	case DXGI.D16_UNORM: return { format: 'depth16unorm' };
	case DXGI.R16_FLOAT: return { format: 'r16float' };
	case DXGI.R8_TYPELESS: case DXGI.R8_UNORM: return { format: 'r8unorm' };
	case 63: return { format: 'r8snorm' };
	case 51: return { format: 'rg8snorm' };
	case 31: return { format: 'rgba8snorm' };
	case 67: return { format: 'rgb9e5ufloat' };
	case 65: return { format: 'rgba8unorm', a8: true };		// A8_UNORM: sampled as (0,0,0,a); expanded to rgba8 on upload (no texture swizzle in WebGPU)
	case 56: return { format: 'depth16unorm' };
	case 21: case 22: case 46: case 47: return { format: 'depth24plus-stencil8' };		// depth/stencil views of a depth texture: the view aspect selects the plane
	case DXGI.BC1_TYPELESS: case DXGI.BC1_UNORM: return { format: 'bc1-rgba-unorm', views: ['bc1-rgba-unorm-srgb'] };
	case DXGI.BC1_UNORM_SRGB: return { format: 'bc1-rgba-unorm-srgb', views: ['bc1-rgba-unorm'] };
	case DXGI.BC2_TYPELESS: case DXGI.BC2_UNORM: return { format: 'bc2-rgba-unorm', views: ['bc2-rgba-unorm-srgb'] };
	case DXGI.BC2_UNORM_SRGB: return { format: 'bc2-rgba-unorm-srgb', views: ['bc2-rgba-unorm'] };
	case DXGI.BC3_TYPELESS: case DXGI.BC3_UNORM: return { format: 'bc3-rgba-unorm', views: ['bc3-rgba-unorm-srgb'] };
	case DXGI.BC3_UNORM_SRGB: return { format: 'bc3-rgba-unorm-srgb', views: ['bc3-rgba-unorm'] };
	case DXGI.BC4_TYPELESS: case DXGI.BC4_UNORM: return { format: 'bc4-r-unorm' };
	case DXGI.BC5_TYPELESS: case DXGI.BC5_UNORM: return { format: 'bc5-rg-unorm' };
	case DXGI.BC6H_TYPELESS: case DXGI.BC6H_UF16: return { format: 'bc6h-rgb-ufloat' };
	case DXGI.BC7_TYPELESS: case DXGI.BC7_UNORM: return { format: 'bc7-rgba-unorm', views: ['bc7-rgba-unorm-srgb'] };
	case DXGI.BC7_UNORM_SRGB: return { format: 'bc7-rgba-unorm-srgb', views: ['bc7-rgba-unorm'] };
	default: logOnce('fmt' + f, 'no WebGPU format for DXGI ' + f + ' (using rgba8unorm)'); return { format: 'rgba8unorm' };
	}
}

const hasStencil = (format) => format === 'depth24plus-stencil8' || format === 'depth32float-stencil8' || format === 'stencil8';
const isDepth = (format) => format.startsWith('depth') || format === 'stencil8';

// ---- state --------------------------------------------------------------------------------------------------------------
let gpu = null, adapter = null, device = null;
// Optional features the D3D11 renderer relies on, and what is done without them (initDevice sets these; Chromebook and phone GPUs often lack some):
//   float32-filterable: 32-bit float textures read where the shader filters go through a 16-bit float copy (halfProxy; depth proxies are r16float)
//   depth32float-stencil8: D32_FLOAT_S8X24 depth buffers become depth24plus-stencil8; rg11b10ufloat-renderable: R11G11B10_FLOAT textures become rgba16float
let noF32Filter = false, noD32S8 = false, noRG11 = false;
let mem = null, memBuffer = null, i32 = null, u32 = null, f32 = null, u8 = null, ringBase = 0, ringSize = 0;
let canvas = null, canvasCtx = null, canvasFormat = null, blit = null, canvasConfigured = false;
let fpsChannel = null, fpsOverlayN = 0, fpsOverlayT = 0, overlayOn = false;		// overlayOn: the page shows the overlay ('=' key): only then are frames timed on the chip (gpuTiming)
const ov = { idle: 0, wait: 0, pipe: 0, up: 0, draws: 0, gpu: 0, refl: 0, reflSkip: 0, merged: 0, reused: 0, noop: 0, culled: 0, chunkFrames: 0, mods: 0, pipes: 0, sized: 0, sizedK: 0, hidden: 0, passes: 0, submits: 0, bgs: 0, upBytes: 0, staged: 0, cpDef: 0, cpSplit: 0, mips: 0, mipsSkipped: 0, kept: null, passDraw: 0, passProxy: 0, passClear: 0, wRb: 0, wOcc: 0, wFence: 0, rbN: 0, rbMs: 0, cmds: 0, fxSkipped: 0 };		// merged/reused/noop: the counters' values at the last report		// the frame-rate overlay's sums since its last report (present)
const ovProgs = [];		// the programs drawn since the overlay's last report, each with its count in `ovN` (summed per effect for the report)
// The GPU's share of a frame (the overlay's "GPU"): the time during which some submitted work is not finished yet, from the submit to the moment this worker learns that the
// newest submit is done (its event loop gets a turn at least every 2 ms). It includes the GPU process's own work on the commands, so it is a little long, never short.
// gpuBusyMs(): all the busy time so far, the interval still open included (each reader keeps its own last value and takes the difference: while the GPU side never runs out
// of work, which is when it is the slowest part, no interval closes, and counting only closed ones read as an idle GPU)
let gpuSeq = 0, gpuDoneSeq = 0, gpuBusyT0 = 0, gpuBusyClosed = 0;
function gpuTrack() {
	const seq = ++gpuSeq;
	if (seq === gpuDoneSeq + 1) gpuBusyT0 = performance.now();		// everything before was done: the GPU is busy from now
	device.queue.onSubmittedWorkDone().then(() => {
		if (seq <= gpuDoneSeq) return;
		gpuDoneSeq = seq;
		if (seq === gpuSeq) gpuBusyClosed += performance.now() - gpuBusyT0;		// nothing newer outstanding: idle from now
	});
}
function gpuBusyMs(now) { return gpuBusyClosed + (gpuDoneSeq < gpuSeq ? now - gpuBusyT0 : 0); }
// ---- the graphics chip's own time per pass (timestamp-query) ----------------------------------------------------------------------------------------------------
// "GPU busy" above runs from a submit until the work is done, Chrome's GPU process handling every command included. To tell that apart from the chip's work, one frame
// every 2 s (once the world shows) has a timestamp at the start and end of each render pass this worker begins (ensurePass, clears), resolved at its present and read
// back: the chip's time for the frame, and the passes that took most, named by their targets and the effect of their first draw (the page's overlay shows them).
// Browsers round the times (Chrome: to 100 us), fine for passes of milliseconds.
const GPU_TIMING_MAX = 256;		// passes timed in a frame (2 timestamps each)
const gpuTiming = { set: null, resolve: null, read: null, state: 0, passes: [], cur: null, lastT: 0, result: null };		// state: 0 waiting, 1 timing this frame, 2 reading back
function gpuTimingInit() {
	gpuTiming.set = device.createQuerySet({ type: 'timestamp', count: GPU_TIMING_MAX * 2 });
	gpuTiming.resolve = device.createBuffer({ size: GPU_TIMING_MAX * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
	gpuTiming.read = device.createBuffer({ size: GPU_TIMING_MAX * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
}
function timePass(desc, label) {		// desc gets timestamp writes when this frame is sampled; returns desc
	if (gpuTiming.state !== 1 || gpuTiming.passes.length >= GPU_TIMING_MAX) return desc;
	const i = gpuTiming.passes.length;
	desc.timestampWrites = { querySet: gpuTiming.set, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
	gpuTiming.cur = { label, effect: '' };
	gpuTiming.passes.push(gpuTiming.cur);
	return desc;
}
function gpuTimingResolve() {		// at a sampled frame's present: the timestamps into the read-back buffer; returns how many passes (0: none were timed)
	const n = gpuTiming.passes.length;
	gpuTiming.cur = null;
	if (!n) { gpuTiming.state = 0; gpuTiming.lastT = performance.now(); return 0; }
	endPass();
	const enc = getEncoder();
	enc.resolveQuerySet(gpuTiming.set, 0, n * 2, gpuTiming.resolve, 0);
	enc.copyBufferToBuffer(gpuTiming.resolve, 0, gpuTiming.read, 0, n * 16);
	gpuTiming.state = 2;
	return n;
}
function gpuTimingRead(n) {
	const passes = gpuTiming.passes.slice(0, n);
	gpuTiming.read.mapAsync(GPUMapMode.READ, 0, n * 16).then(() => {
		const t = new BigUint64Array(gpuTiming.read.getMappedRange(0, n * 16));
		const by = new Map();
		let total = 0;
		for (let i = 0; i < n; i++) {
			const a = t[i * 2], b = t[i * 2 + 1];
			const ms = b > a ? Number(b - a) / 1e6 : 0;
			if (!(ms < 10000)) continue;		// a pass that did not write both (or a wrapped counter)
			total += ms;
			const p = passes[i], key = p.label === 'G-buffer' || p.label === 'clears' || p.label === 'reflections' ? p.label : p.effect || p.label;
			by.set(key, (by.get(key) || 0) + ms);
		}
		gpuTiming.read.unmap();
		gpuTiming.result = { ms: total, passes: n, top: [...by].sort((x, y) => y[1] - x[1]).slice(0, 4) };
		gpuTiming.state = 0; gpuTiming.lastT = performance.now();
	}, () => { gpuTiming.state = 0; gpuTiming.lastT = performance.now(); });
}
let encoder = null, pass = null, passKey = '';
let errorCount = 0, errorCount0 = 0, clampedDraws = 0, clampedDraws0 = 0, gpuErrorChannel = null;
const errorKinds = new Map();		// normalised message -> { n, msg }
function dumpErrors() { for (const [k, e] of [...errorKinds].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) logLine('  error x' + e.n + ': ' + e.msg.slice(0, 300)); }
let drawCount = 0, skippedDraws = 0, noopDraws = 0;
let lastPresentDraws = 0, progressChannel = null, worldSent = false;
let lastFitVs = null, lastFitPs = null;		// the shader pair of the last draw that needed texture-limit variants (fitTextures): a change forces a pipeline lookup
let worldSince = 0, worldClean = 0, worldSkips0 = 0, worldNoteT = 0, skipsAtPresent = 0;		// present(): the title screen stays up until frames stop skipping draws
// id -> object (texture, buffer, shader, layout, srv, state); ids are unique across kinds. Ids come from one counter in wgpu_backend.cpp (AllocId) and are never reused, so a plain
// array indexed by id holds them (dense, small gaps): a draw looks up ~15 objects, and an element load is several times cheaper than Map.get.
class IdTable {
	constructor() { this.a = []; this.n = 0; }
	get(id) { return this.a[id]; }
	set(id, v) { if (this.a[id] === undefined) this.n++; this.a[id] = v; return this; }
	delete(id) { if (this.a[id] === undefined) return false; this.a[id] = undefined; this.n--; return true; }
	has(id) { return this.a[id] !== undefined; }
	get size() { return this.n; }
	*values() { for (const v of this.a) if (v !== undefined) yield v; }
}
const objs = new IdTable();

// Index into i32/u32 of a wasm memory address. Not a right shift by 2: JS shifts work on signed 32 bits, so every address at or above 2 GB (the memory starts at 3 GB and objects
// created later in a session live up there) became a negative index; event queries (the engine's GPU fences), occlusion queries and readback flags then never completed.
function w32(addr) { return Math.floor(addr / 4); }
let ringW = 0;		// w32(ringBase)
function refreshViews() {
	if (memBuffer === mem.buffer) return;
	memBuffer = mem.buffer;
	i32 = new Int32Array(memBuffer);
	u32 = new Uint32Array(memBuffer);
	f32 = new Float32Array(memBuffer);
	u8 = new Uint8Array(memBuffer);
}

function getEncoder() { return encoder || (encoder = device.createCommandEncoder()); }
function endPass() { if (pass) { endOcclusionInPass(); pass.end(); pass = null; passKey = ''; applied = {}; passSt = newPassSt(); passAtt = null; } if (deferredCopies.length) runDeferredCopies(); }
// What the current pass already has set: the same call twice is skipped (every WebGPU call costs a few microseconds of validation + serialisation)
function newPassSt() { return { pl: null, bg0: null, bg1: null, dyn0: -2, dyn1: -2, vb: [], vbo: [], ib: null, ibFmt: '', ibOff: -1, vp: null, sc: null, bf: null, sref: -1 }; }
let passSt = newPassSt();
// Buffer/texture objects referenced by commands recorded since the last submit carry `enc === encEpoch`; flush() starts a new epoch. (A Set cost a hash insert for every bound
// buffer of every draw; nothing iterates it.)
let encEpoch = 1, submits = 0, submits0 = 0;
const usedInEncoder = { add(o) { if (o) { o.enc = encEpoch; if (o.pendCopy) needSplit = true; } }, has(o) { return !!o && o.enc === encEpoch; }, clear() { encEpoch++; } };
// Uploads into resources this encoder already uses (stagedBufferUpload / stagedTextureUpload) are copies, which cannot be recorded inside a render pass. They used to end the
// pass there, and the next draw started a new one with the same targets: one more pass (~1 ms of Chrome's GPU process on an N100 Chromebook) for every font glyph or
// partial buffer update in the middle of the frame. Now the copy waits until the pass ends: draws before the upload read the old contents either way, and only a later
// draw of the same pass that binds the resource again (o.pendCopy: needSplit) ends the pass early, so the copy lands before it.
const deferredCopies = [];
let needSplit = false, passAtt = null, copiesDeferred = 0, copySplits = 0;
function runDeferredCopies() {
	const enc = getEncoder();
	for (const c of deferredCopies) {
		c.o.pendCopy = false;
		if (c.tex) enc.copyBufferToTexture(c.src, c.dst, c.size); else enc.copyBufferToBuffer(c.src, c.at, c.dst, c.off, c.n);
	}
	deferredCopies.length = 0;
	needSplit = false;
}
function canDefer(o) { return !!pass && !(passAtt && passAtt.includes(o)); }		// (not a target of the open pass: its draws write it in order)
const flushReasons = new Map(), ovReasons = new Map();		// submits per reason since the last fps line / the overlay's last report
let passesBegun = 0, passDrawN = 0, passProxyN = 0, passClearN = 0, commandsRun = 0;
// the drawing passes of the frames since the overlay's last report, by the effect of their first draw and their target ('deferred_lighting > rgba16float 684x384'):
// which of the game's steps make the most passes (each costs Chrome's GPU process ~1 ms on an N100 Chromebook)
const passHist = new Map();
let passToName = null;
function namePass(prog) {
	const l = prog.label || '?', k = l.indexOf('::'), e = k > 0 ? l.slice(0, k) : l, r = passInfo.rtInfo && passInfo.rtInfo[0];
	const key = e + ' > ' + (r ? r.format.replace('float', 'f').replace('unorm', '') : 'depth') + ' ' + passInfo.width + 'x' + passInfo.height + (passInfo.colorCount > 1 ? ' x' + passInfo.colorCount : '');
	passHist.set(key, (passHist.get(key) || 0) + 1);
}		// all passes; those for draws (ensurePass), depth/float copies (proxies), clears of their own
// The graphics side's time by part of the frame (overlay only): each submit's work, from when it was handed over (or the previous part finished) until Chrome reports it done,
// summed per submit reason with what it held (drawing passes, draws, pipeline switches, bind group changes). Chrome's GPU process takes 80-90 ms a frame on an N100
// Chromebook while a frame of the same shape in probe.html takes 11 ms: this names the part where the time goes.
const segAgg = new Map();
let segLastDone = 0, segP0 = 0, segD0 = 0, segPl0 = 0, segBg0 = 0, plSets = 0, bgSets = 0;
let ringBytes = 0, vbSets = 0, ibSets = 0, occqN = 0, upAll = 0, rbBytes = 0, rbBig = 0;		// rbBytes: read back (game read-backs); rbBig: the largest single read-back since the overlay's last report		// (per part of the frame: constants written, vertex/index buffer bindings, occlusion queries, other uploads)
const segC0 = { rb: 0, vb: 0, ib: 0, ind: 0, oq: 0, up: 0, rd: 0 };
function segTrack(reason) {
	const t = performance.now(), e0 = { p: passDrawN - segP0, d: drawCount - segD0, pl: plSets - segPl0, bg: bgSets - segBg0, rb: ringBytes - segC0.rb, vb: vbSets - segC0.vb, ib: ibSets - segC0.ib, ind: indirectDraws - segC0.ind, oq: occqN - segC0.oq, up: upAll - segC0.up, rd: rbBytes - segC0.rd };
	segP0 = passDrawN; segD0 = drawCount; segPl0 = plSets; segBg0 = bgSets; segC0.rb = ringBytes; segC0.vb = vbSets; segC0.ib = ibSets; segC0.ind = indirectDraws; segC0.oq = occqN; segC0.up = upAll; segC0.rd = rbBytes;
	device.queue.onSubmittedWorkDone().then(() => {
		const done = performance.now(), ms = done - Math.max(t, segLastDone);
		segLastDone = done;
		let e = segAgg.get(reason);
		if (!e) segAgg.set(reason, e = { ms: 0, n: 0, p: 0, d: 0, pl: 0, bg: 0, rb: 0, vb: 0, ib: 0, ind: 0, oq: 0, up: 0, rd: 0 });
		for (const k in e0) e[k] += e0[k];
		e.ms += ms; e.n++;
	});
}
function flush(reason) {
	const tf0 = performance.now();
	if (encoder || pass) { const r = reason || 'other'; flushReasons.set(r, (flushReasons.get(r) || 0) + 1); ovReasons.set(r, (ovReasons.get(r) || 0) + 1); }
	endPass();
	if (dirtyChunks.size) flushUniforms();
	const resolves = pendingResolve.length ? recordResolves() : null;		// into this encoder: no command buffer of its own
	const boxes = boxRequests.length ? boxEncode(getEncoder()) : null;		// vertex buffers whose boxes are read back (draw distance)
	if (encoder) { device.queue.submit([encoder.finish()]); encoder = null; onSubmitted(); submits++; counterSlot = 0; if (!isNode) { gpuTrack(); if (overlayOn) segTrack(reason || 'other'); } }
	upStage.off = 0;		// staging writes from now on land after this submit's copies
	if (renameRetired.length) renameRelease();
	if (deferredDestroys.length) { for (const g of deferredDestroys) g.destroy(); deferredDestroys = []; }
	if (resolves) mapResolves(resolves);
	if (boxes) boxRead(boxes);
	if (occl.busy && !occl.busy.mapping) occlMap();		// the depth grid's copy went with this submit
	fr.flush += performance.now() - tf0;
	usedInEncoder.clear();
}
function logOnce(key, msg) { if (!logOnce.seen) logOnce.seen = new Set(); if (logOnce.seen.has(key)) return; logOnce.seen.add(key); logLine(msg); }

// ---- D3D11 enums -> WebGPU ----------------------------------------------------------------------------------------------
const CMP = [null, 'never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always'];
const STENCIL_OP = [null, 'keep', 'zero', 'replace', 'increment-clamp', 'decrement-clamp', 'invert', 'increment-wrap', 'decrement-wrap'];
const BLEND_FACTOR = [null, 'zero', 'one', 'src', 'one-minus-src', 'src-alpha', 'one-minus-src-alpha', 'dst-alpha', 'one-minus-dst-alpha',
	'dst', 'one-minus-dst', 'src-alpha-saturated', null, null, 'constant', 'one-minus-constant', 'src1', 'one-minus-src1', 'src1-alpha', 'one-minus-src1-alpha'];
const BLEND_OP = [null, 'add', 'subtract', 'reverse-subtract', 'min', 'max'];
const TOPOLOGY = { 1: ['point-list', false], 2: ['line-list', false], 3: ['line-strip', true], 4: ['triangle-list', false], 5: ['triangle-strip', true] };
const ADDRESS = [null, 'repeat', 'mirror-repeat', 'clamp-to-edge', 'clamp-to-edge', 'mirror-repeat'];

function vertexFormat(dxgi) {
	switch (dxgi) {
	case 2: return ['float32x4', 16, 'f']; case 6: return ['float32x3', 12, 'f']; case 16: return ['float32x2', 8, 'f']; case 41: return ['float32', 4, 'f'];
	case 3: return ['uint32x4', 16, 'u']; case 7: return ['uint32x3', 12, 'u']; case 17: return ['uint32x2', 8, 'u']; case 42: return ['uint32', 4, 'u'];
	case 4: return ['sint32x4', 16, 'i']; case 8: return ['sint32x3', 12, 'i']; case 18: return ['sint32x2', 8, 'i']; case 43: return ['sint32', 4, 'i'];
	case 10: return ['float16x4', 8, 'f']; case 34: return ['float16x2', 4, 'f'];
	case 11: return ['unorm16x4', 8, 'f']; case 35: return ['unorm16x2', 4, 'f'];
	case 12: return ['uint16x4', 8, 'u']; case 36: return ['uint16x2', 4, 'u'];
	case 13: return ['snorm16x4', 8, 'f']; case 37: return ['snorm16x2', 4, 'f'];
	case 14: return ['sint16x4', 8, 'i']; case 38: return ['sint16x2', 4, 'i'];
	case 28: return ['unorm8x4', 4, 'f']; case 30: return ['uint8x4', 4, 'u']; case 31: return ['snorm8x4', 4, 'f']; case 32: return ['sint8x4', 4, 'i'];
	case 49: return ['unorm8x2', 2, 'f']; case 50: return ['uint8x2', 2, 'u']; case 51: return ['snorm8x2', 2, 'f']; case 52: return ['sint8x2', 2, 'i'];
	case 87: return ['unorm8x4-bgra', 4, 'f']; case 24: return ['unorm10-10-10-2', 4, 'f'];
	default: return null;
	}
}

// D3D11_FILTER: bits 4-5 min, 2-3 mag, 0-1 mip (bit set = linear); 0x80 = comparison; 0x55 with aniso.
function makeSampler(words) {
	if ([1, 2, 3].some((i) => words[i] === 4)) noteApprox('sampler border addressing', 'border colour ' + [7, 8, 9, 10].map((i) => wf(words[i]).toFixed(2)).join(',') + (words[0] & 0x80 ? ' (comparison)' : ''));
	if (wf(words[4]) !== 0) noteApprox('sampler MipLODBias', String(wf(words[4]).toFixed(2)));
	// D3D11_SAMPLER_DESC: Filter, AddressU, AddressV, AddressW, MipLODBias, MaxAnisotropy, ComparisonFunc, BorderColor[4], MinLOD, MaxLOD
	const filter = words[0], aniso = ((filter & 0x7f) === 0x55);
	const d = {
		addressModeU: ADDRESS[words[1]] || 'repeat', addressModeV: ADDRESS[words[2]] || 'repeat', addressModeW: ADDRESS[words[3]] || 'repeat',
		magFilter: (filter >> 2) & 1 ? 'linear' : 'nearest', minFilter: (filter >> 4) & 1 ? 'linear' : 'nearest',
		mipmapFilter: filter & 1 ? 'linear' : 'nearest',
		lodMinClamp: Math.max(0, wf(words[11])), lodMaxClamp: Math.min(32, Math.max(0, wf(words[12]))),
	};
	if (filter & 0x80) d.compare = CMP[words[6]] || 'always';
	if (aniso) { d.magFilter = d.minFilter = d.mipmapFilter = 'linear'; d.maxAnisotropy = Math.max(1, Math.min(16, words[5])); }
	if (d.lodMaxClamp < d.lodMinClamp) d.lodMaxClamp = d.lodMinClamp;
	return device.createSampler(d);
}
const wfBuf = new Float32Array(1), wuBuf = new Uint32Array(wfBuf.buffer);
function wf(w) { wuBuf[0] = w; return wfBuf[0]; }

// ---- WGSL reflection (the translator emits plain declarations) ----------------------------------------------------------------
const DECL = /@group\((\d+)u?\)\s*@binding\((\d+)u?\)\s*var(?:<([^>]*)>)?\s+(\w+)\s*:\s*([^;]+);/g;
function parseWgsl(text) {
	const bindings = [];
	for (const m of text.matchAll(DECL)) {
		const group = +m[1], binding = +m[2], space = (m[3] || '').replace(/\s+/g, ''), type = m[5].trim();
		const b = { group, binding, name: m[4], type };
		if (space === 'uniform') b.kind = 'uniform';
		else if (space.startsWith('storage')) b.kind = space.includes('read_write') ? 'storage' : 'read-only-storage';
		else if (type === 'sampler') b.kind = 'sampler';
		else if (type === 'sampler_comparison') b.kind = 'sampler-comparison';
		else {
			b.kind = 'texture';
			const t = /^texture_(\w+?)(?:<([^>]*)>)?$/.exec(type);
			const name = t ? t[1] : '2d', arg = t && t[2] ? t[2] : 'f32';
			if (name.startsWith('storage_')) { b.kind = 'storage-texture'; b.dim = name.replace('storage_', ''); b.format = arg.split(',')[0].trim(); b.access = arg.includes('read_write') ? 'read-write' : (arg.includes('read') ? 'read-only' : 'write-only'); }
			else if (name.startsWith('depth_')) { b.dim = name.replace('depth_', ''); b.sample = 'depth'; }
			else if (name.startsWith('multisampled_')) { b.dim = '2d'; b.ms = true; b.sample = 'unfilterable-float'; }
			else { b.dim = name; b.sample = arg === 'u32' ? 'uint' : arg === 'i32' ? 'sint' : 'float'; }
			if (b.dim === 'depth_2d') b.dim = '2d';
			b.dim = ({ '2d': '2d', '2d_array': '2d-array', '3d': '3d', 'cube': 'cube', 'cube_array': 'cube-array', '1d': '1d' })[b.dim] || b.dim;
		}
		bindings.push(b);
	}
	// Float textures the shader only reads with textureLoad (never filters): without float32-filterable, their binding is declared unfilterable (layoutEntry) and takes
	// a 32-bit float texture as it is, at full precision. Conservative: every mention of the name other than its declaration must be a textureLoad/textureDimensions/
	// textureNumLevels/textureNumLayers argument (one passed to a helper function, or in a comment, keeps it filterable).
	for (const b of bindings) {
		if (b.kind !== 'texture' || b.sample !== 'float' || b.ms) continue;
		const all = text.match(new RegExp('\\b' + b.name + '\\b', 'g')) || [];
		const loads = text.match(new RegExp('\\b(?:textureLoad|textureDimensions|textureNumLevels|textureNumLayers)\\s*\\(\\s*' + b.name + '\\b', 'g')) || [];
		b.loadOnly = loads.length > 0 && loads.length === all.length - 1;
	}
	for (const b of bindings) {
		if (b.kind !== 'texture') continue;
		const all = text.match(new RegExp('\\b' + b.name + '\\b', 'g')) || [];
		const calls = (text.match(texCallRe(b.name)) || []).length;
		b.droppable = calls === all.length - 1;		// every mention but the declaration is a builtin call on it (one passed to a helper function is kept)
	}
	// fragment outputs: locations of the return value of `fn main`
	const outputs = [];
	const sig = /@fragment\s*fn\s+main\s*\((?:[^()]|\([^)]*\))*\)\s*->\s*([^{]+)\{/.exec(text);		// parameters contain @location(n)
	if (sig) {
		const r = sig[1];
		const inl = /@location\((\d+)u?\)/.exec(r);
		if (inl) outputs.push(+inl[1]);
		else {
			const st = new RegExp('struct\\s+' + r.trim() + '\\s*\\{([^}]*)\\}').exec(text);
			if (st) for (const m of st[1].matchAll(/@location\((\d+)u?\)/g)) outputs.push(+m[1]);
		}
	}
	return { bindings, outputs };
}

const STAGE_VIS = { 0: 1 /*VERTEX*/, 1: 2 /*FRAGMENT*/, 2: 4 /*COMPUTE*/ };
function layoutEntry(b, stage) {
	const visibility = STAGE_VIS[stage];
	const e = { binding: b.binding, visibility };
	switch (b.kind) {
	case 'uniform': e.buffer = { type: 'uniform', hasDynamicOffset: b.binding !== 15 }; break;		// binding 0 = the packed constant buffers
	case 'storage': e.buffer = { type: 'storage' }; break;
	case 'read-only-storage': e.buffer = { type: 'read-only-storage' }; break;
	case 'sampler': e.sampler = { type: 'filtering' }; break;
	case 'sampler-comparison': e.sampler = { type: 'comparison' }; break;
	case 'texture': e.texture = { sampleType: (noF32Filter || DEPTH_DIRECT) && b.loadOnly ? 'unfilterable-float' : b.sample, viewDimension: b.dim, multisampled: !!b.ms }; break;		// loadOnly: parseWgsl; DEPTH_DIRECT: srvView
	case 'storage-texture': e.storageTexture = { access: b.access, format: b.format, viewDimension: b.dim }; break;
	}
	return e;
}

// D3D11 shaders use up to 7 constant buffers per stage, WebGPU allows 10 dynamic-offset uniform bindings per pipeline layout.
// Every stage's constant buffers (all the `var<uniform>` except the special-constant table at binding 15) are therefore
// merged into ONE struct bound at binding 0 with one dynamic offset: `cbN_x` -> `cbpack_v.cbN_x`. The runtime copies the
// bound D3D constant buffers back to back into the uniform ring, in binding order, one 16-byte aligned block per member.
function packUniforms(text) {
	const decl = /@group\((\d+)u?\)\s*@binding\((\d+)u?\)\s*var<uniform>\s+(\w+)\s*:\s*(\w+)\s*;/g;
	const members = [];
	let group = 0;
	let out = text.replace(decl, (m, g, b, name, type) => {
		if (+b === 15) return m;
		group = +g;
		const st = new RegExp('struct\\s+' + type + '\\s*\\{([^}]*)\\}').exec(text);
		const arr = st ? /array<[^>]*>,\s*(\d+)u?>/.exec(st[1]) : null;
		members.push({ binding: +b, name, type, size: arr ? +arr[1] * 16 : 16, offset: 0 });
		return '';
	});
	if (!members.length) return { text, pack: null };
	members.sort((a, b) => a.binding - b.binding);
	let off = 0;
	for (const m of members) { m.offset = off; off += m.size; }
	for (const m of members) out = out.replace(new RegExp('\\b' + m.name + '\\b', 'g'), 'cbpack_v.' + m.name);
	const struct = 'struct cbpack_t {\n' + members.map((m) => '  ' + m.name + ' : ' + m.type + ',').join('\n') + '\n}\n@group(' + group + 'u) @binding(0u) var<uniform> cbpack_v : cbpack_t;\n';
	// the struct must follow the member type definitions: insert before the first function / entry point
	const at = out.search(/\n(?:@\w+|fn)\s/);
	out = at < 0 ? out + struct : out.slice(0, at) + '\n' + struct + out.slice(at);
	return { text: out, pack: { members, size: off, group } };
}

// ---- shaders ------------------------------------------------------------------------------------------------------------------
let shaderIndex = null;		// fnv1a64 hex -> { stage, effect, program, ok, consts }
let shaderDir = null;
let shaderUrl = './shaders';		// browser: base URL of the translated shaders (index.json, <hash>.wgsl, <hash>.consts.json)
function loadShaderIndex() {
	if (shaderIndex) return;
	shaderIndex = {};
	shaderDir = isNode ? (process.env.WGPU_SHADER_DIR || 'D:/wasm_build/web/shaders') : shaderUrl;
	if (isNode) {
		try { shaderIndex = JSON.parse(require('fs').readFileSync(shaderDir + '/index.json', 'utf8')); }
		catch (e) { logLine('no shader index at ' + shaderDir + ': ' + e.message); }
	}
}

// Browser: fetch is asynchronous, so the sources of the shaders a draw/dispatch needs are awaited before it is executed.
// An overloaded host answers 503/500/429 (2026-10-06): a shader pack that came back as an error left every draw that needs it unshaded for good. Such an answer, or none, is retried up
// to 8 times with growing, jittered waits (~20 s in all).
async function fetchRetry(url, init) {
	for (let attempt = 0; ; attempt++) {
		let res = null, err = null;
		try { res = await fetch(url, init); } catch (e) { err = e; }
		if (res && res.status < 500 && res.status !== 429) return res;
		if (attempt >= 7) { if (res) return res; throw err; }
		await new Promise((r) => setTimeout(r, Math.min(5000, 300 * 2 ** attempt) * (0.5 + Math.random())));
	}
}
async function fetchText(url) { const r = await fetchRetry(url); return r.ok ? r.text() : null; }
// true when the shaders bound now need nothing fetched (always, once they have been seen): draws and dispatches then skip `await ensureShaderSources()`, which suspended the
// whole command loop for a microtask turn on every draw
function shaderSourcesReady() {
	if (!shaderIndex) return false;
	for (let i = 0; i < 3; i++) { const id = S.shader[i]; if (id) { const o = objs.get(id); if (o && o.fetched === undefined) return false; } }
	return true;
}
// The index is loaded once (one promise shared by every fetch: shaderIndex is only set when it is complete).
let shaderIndexP = null;
function shaderIndexReady() {
	return shaderIndexP || (shaderIndexP = (async () => {
		let idx = {};
		try { idx = JSON.parse(await fetchText(shaderUrl + '/index.json')); } catch (e) { logLine('no shader index at ' + shaderUrl + ': ' + e.message); }
		shaderDir = shaderUrl;
		shaderIndex = idx;
	})());
}
// Shader packs (phase3/make_shader_pack.py): the translated shaders bundled into ~4 MB files grouped by effect (index.json: "p": [pack, offset, wgsl bytes, constants bytes]), so a
// browser makes ~20 requests instead of one or two per shader (~6,000 in a session, each a round trip: minutes against a distant host). A pack is dropped from memory 8 s after
// its last use (the engine creates a burst of shaders per effect; ~70 MB if all stayed); a shader asked for later refetches its pack, or falls back to its own files.
const packs = new Map(), fetchedByHash = new Map();		// pack number -> { p: Promise<Uint8Array | null>, last }; shader hash -> { text, consts } (shared by shader objects with the same hash)
let packDecoder = null, packSweep = 0;
function packBytes(k) {
	let c = packs.get(k);
	if (!c) {
		c = { p: null, last: 0, done: false };
		c.p = fetchRetry(shaderUrl + '/' + (shaderIndex._packs && shaderIndex._packs[k] ? shaderIndex._packs[k].file : 'pack' + k + '.bin')).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)).catch(() => null).then((u8) => { c.done = true; c.last = performance.now(); return u8; });
		packs.set(k, c);
		if (!packSweep) packSweep = setInterval(() => { const now = performance.now(); for (const [n, x] of packs) if (x.done && now - x.last > 8000) packs.delete(n); }, 4000);
	}
	c.last = performance.now();
	return c.p;
}
async function packShader(rec) {
	const [k, off, wl, cl] = rec.p;
	const u8 = await packBytes(k);
	if (!u8 || u8.length < off + wl + cl) return null;
	packs.get(k) && (packs.get(k).last = performance.now());
	const dec = packDecoder || (packDecoder = new TextDecoder());
	return { text: dec.decode(u8.subarray(off, off + wl)), consts: cl ? JSON.parse(dec.decode(u8.subarray(off + wl, off + wl + cl))) : null };
}
// A shader's sources (WGSL, constant table); sh.fetched is set only when they are here (null: none). Started at most once per shader.
function fetchShaderSource(sh) {
	if (!sh.fetchP) sh.fetchP = (async () => {
		await shaderIndexReady();
		const rec = shaderIndex[sh.hash];
		let fetched = null;
		if (rec && rec.ok) {
			fetched = fetchedByHash.get(sh.hash) || null;
			if (!fetched && rec.p && !(!isNode && new URLSearchParams(self.location.search).get('nopack') === '1')) {		// ?nopack=1 (diagnostics): one request per shader file
				try { fetched = await packShader(rec); } catch (e) { logOnce('packfail' + rec.p[0], 'shader pack ' + rec.p[0] + ' unusable (' + (e && e.message) + '): fetching shaders one by one'); }
			}
			if (!fetched) {
				try {
					const text = await fetchText(shaderDir + '/' + sh.hash + '.wgsl');
					let consts = null;
					if (rec.consts) consts = JSON.parse(await fetchText(shaderDir + '/' + sh.hash + '.consts.json'));
					fetched = { text, consts };
				} catch (e) { logOnce('shaderfetch' + sh.hash, 'shader ' + sh.hash + ' could not be fetched: ' + (e && e.message)); }
			}
			if (fetched) fetchedByHash.set(sh.hash, fetched);
		}
		sh.fetched = fetched;
		shadersReady++;
	})();
	return sh.fetchP;
}
// Prefetch: effects create their shaders long before the first draw that uses them, so the source is requested at creation (CREATE_SHADER) instead of by that draw,
// which suspended the command loop for a whole request per new shader (a network round trip each for remote players, hundreds in the first frames). At most
// SHADER_FETCHES are in flight; a draw that needs a shader not started yet starts it at once (ensureShaderSources).
const SHADER_FETCHES = 16, shaderQueue = [];
let shaderQueueHead = 0, shaderFetching = 0;
function pumpShaderQueue() {
	while (shaderFetching < SHADER_FETCHES && shaderQueueHead < shaderQueue.length) {
		const sh = shaderQueue[shaderQueueHead++];
		if (sh.fetchP) continue;
		shaderFetching++;
		fetchShaderSource(sh).finally(() => { shaderFetching--; pumpShaderQueue(); });
	}
	if (shaderQueueHead === shaderQueue.length) { shaderQueue.length = 0; shaderQueueHead = 0; }
}
function prefetchShader(sh) {
	if (isNode || sh.fetchP) return;
	shaderQueue.push(sh);
	pumpShaderQueue();
}
async function ensureShaderSources() {
	if (isNode) return;
	if (!shaderIndex) await shaderIndexReady();
	for (const id of S.shader) {
		const sh = id ? objs.get(id) : null;
		if (!sh || sh.fetched !== undefined) continue;
		await fetchShaderSource(sh);
	}
}

function a2cModule(prog) {
	if (prog.a2c !== undefined) return prog.a2c;
	prog.a2c = null;
	const re = /(\n\s*main_inner\([^;]*\);)/;
	if (re.test(prog.text)) {
		try { prog.a2c = device.createShaderModule({ code: prog.text.replace(re, '$1\n  if (o0.w < 0.5f) { discard; }') }); } catch (e) { logOnce('a2c' + prog.label, 'alpha-to-coverage variant of ' + prog.label + ' failed: ' + e.message); }
	} else logOnce('a2c' + prog.label, 'alpha-to-coverage: no main_inner call to patch in ' + prog.label);
	return prog.a2c;
}

function shaderProgram(sh) {
	// lazily load + compile the WGSL of a shader object; returns { module, info, consts } or null
	if (sh.program !== undefined) return sh.program;
	sh.program = null;
	loadShaderIndex();
	const rec = shaderIndex[sh.hash];
	if (!rec || !rec.ok) { logOnce('noshader' + sh.hash, 'no WGSL for ' + STAGE_NAME[sh.stage] + ' shader ' + sh.hash + (rec ? ' (' + rec.effect + '::' + rec.program + ': ' + (rec.error || rec.stage_failed || 'untranslated') + ')' : ' (not in the index)')); return null; }
	const fs = isNode ? require('fs') : null;
	const source = isNode ? fs.readFileSync(shaderDir + '/' + sh.hash + '.wgsl', 'utf8') : (sh.fetched && sh.fetched.text);
	if (!source) { logOnce('nosrc' + sh.hash, 'shader source of ' + sh.hash + ' was not fetched'); return null; }
	const { text: packed, pack } = packUniforms(source);
	let text = nanRules || nanFire ? packed.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '') : packed;		// comments out first: a "max(" or "main_inner(" in one would mislead the rewrites
	if (nanRules) text = d3dNanRules(text);		// see d3dNanRules (opt-in)
	if (nanFire && sh.stage === 1) text = nanFirewall(text);
	shaderModuleCount++;
	const tm0 = performance.now();
	const module = device.createShaderModule({ code: text, label: rec.effect + '::' + rec.program });
	fr.mod += performance.now() - tm0;
	const info = parseWgsl(text);
	let consts = null;
	if (rec.consts) {
		const arr = isNode ? JSON.parse(fs.readFileSync(shaderDir + '/' + sh.hash + '.consts.json', 'utf8')) : sh.fetched.consts;
		const n = Math.max(1, arr.length);
		const data = new Uint32Array(n * 4);
		arr.forEach((v, i) => { data[i * 4] = v >>> 0; });
		consts = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(consts, 0, data);
	}
	const flat = [];
	for (const m of text.matchAll(/@location\((\d+)u?\)\s*@interpolate\(flat[^)]*\)/g)) flat.push(+m[1]);
	const groupBindings = {};
	for (const b of info.bindings) (groupBindings[b.group] || (groupBindings[b.group] = [])).push(b);
	for (const g in groupBindings) groupBindings[g].sort((a, b) => a.binding - b.binding);
	// vid/iid: the shader reads vertex_index / instance_index (doDraw folds the draw's start into the buffer offsets only for those: 6 and 93 of ~4,800 shaders)
	const overTex = info.bindings.filter((b) => b.kind === 'texture').length - (device.limits.maxSampledTexturesPerShaderStage || 16);		// see fitTextures
	sh.program = { module, info, consts, pack, text, flat, groupBindings, variants: new Map(), bgls: [], label: rec.effect + '::' + rec.program, vid: /\bvertex_index\b/.test(text), iid: /\binstance_index\b/.test(text), overTex: Math.max(0, overTex) };
	return sh.program;
}

// ---- shaders with more textures than the device allows per stage ---------------------------------------------------------------------------------------
// D3D11 allows 128 textures per shader stage; WebGPU devices may allow as few as 16 (Chromebook GPUs do), and some of the game's shaders read up to 22. Their bind
// group layout cannot be made and every draw with them is lost. Such a shader runs as a variant compiled without some of its textures, each read replaced by
// the value an empty D3D11 slot gives (zeros): first the slots this draw leaves empty (exact: the shader reads zeros from them anyway), and only if that is not
// enough the highest-numbered bound ones (approximate; noted on the page once). A variant is its own shader object and program, so pipelines and bind groups
// are cached for it as for any other.
const TEX_CALL = '\\b(?:textureSample\\w*|textureLoad|textureDimensions|textureNumLevels|textureNumLayers|textureNumSamples|textureGather\\w*)\\s*\\(\\s*';
function texCallRe(name) { return new RegExp(TEX_CALL + '(?:(?<=textureGather\\w*\\s*\\(\\s*)[\\w.]+\\s*,\\s*)?' + name + '\\b', 'g'); }
// the program's text without texture binding b: its declaration removed, each builtin call on it replaced by an empty slot's value (zeros) of the call's type
function dropTexture(text, b) {
	text = text.replace(new RegExp('@group\\(\\d+u?\\)\\s*@binding\\(' + b.binding + 'u?\\)\\s*var\\s+' + b.name + '\\s*:[^;]*;'), '');
	const scalar = b.sample === 'uint' ? 'u32' : b.sample === 'sint' ? 'i32' : 'f32', zero = scalar === 'u32' ? '0u' : scalar === 'i32' ? '0i' : '0.0';
	const value = (fn) => (fn === 'textureDimensions' ? (b.dim === '1d' ? '0u' : b.dim === '3d' ? 'vec3<u32>(0u)' : 'vec2<u32>(0u)')
		: fn.startsWith('textureNum') ? '0u'
		: fn.startsWith('textureGather') || b.sample !== 'depth' ? 'vec4<' + scalar + '>(' + zero + ')' : '0.0');		// depth: textureSample/Load/Compare give f32
	const re = texCallRe(b.name);
	let out = '', last = 0, m;
	while ((m = re.exec(text))) {
		const fn = /^\w+/.exec(m[0])[0], open = text.indexOf('(', m.index);
		let i = open + 1, depth = 1;
		while (i < text.length && depth) { const c = text[i++]; if (c === '(') depth++; else if (c === ')') depth--; }
		out += text.slice(last, m.index) + value(fn);
		last = i;
		re.lastIndex = i;
	}
	return out + text.slice(last);
}
// The variant of program prog (of shader object obj, at stage) for the textures bound now: { obj, prog }, or null when it cannot be made to fit. Per draw only a loop over
// the droppable bindings: which of them are bound now (a bit mask) picks the variant from a cache; lists, sorting and the variant itself only the first time for a mask.
function fitTextures(obj, prog, stage) {
	let f = prog.fit;
	if (!f) {
		const limit = device.limits.maxSampledTexturesPerShaderStage || 16;
		const texs = prog.info.bindings.filter((b) => b.kind === 'texture');
		const cand = texs.filter((b) => b.droppable).sort((a, b) => b.binding - a.binding).slice(0, 30);		// highest binding first: those go first
		f = prog.fit = { limit, texs, need: texs.length - limit, cand, byMask: new Map() };
		if (cand.length < f.need) logOnce('fit' + prog.label, 'shader ' + prog.label + ' reads ' + texs.length + ' textures (this GPU allows ' + limit + ') and cannot be reduced: its draws are skipped');
	}
	if (f.cand.length < f.need) return null;
	const srvs = S.srv[stage];
	let mask = 0;
	for (let i = 0; i < f.cand.length; i++) {
		const id = srvs[f.cand[i].binding - 32], srv = id ? objs.get(id) : null, t = srv && !srv.isBuf ? objs.get(srv.res) : null;
		if (t && t.kind === 'texture') mask |= 1 << i;
	}
	let v = f.byMask.get(mask);
	if (v === undefined) { v = fitVariant(obj, prog, f, mask); f.byMask.set(mask, v); }
	return v;
}
function fitVariant(obj, prog, f, mask) {
	const { limit, texs, need, cand } = f;
	const empty = cand.filter((b, i) => !((mask >>> i) & 1));
	let drop = empty.slice(0, need), lossy = [];
	if (drop.length < need) {
		lossy = cand.filter((b, i) => (mask >>> i) & 1).slice(0, need - drop.length);
		drop = drop.concat(lossy);
	}
	drop.sort((a, b) => a.binding - b.binding);
	const key = drop.map((b) => b.binding).join(',');
	const cache = prog.texVariants || (prog.texVariants = new Map());
	let v = cache.get(key);
	if (v) return v;
	let text = prog.text;
	for (const b of drop) text = dropTexture(text, b);
	const bindings = prog.info.bindings.filter((b) => !drop.includes(b)), groupBindings = {};
	for (const b of bindings) (groupBindings[b.group] || (groupBindings[b.group] = [])).push(b);
	for (const g in groupBindings) groupBindings[g].sort((a, b) => a.binding - b.binding);
	const label = prog.label + ' (without t' + drop.map((b) => b.binding - 32).join(',t') + ')';
	shaderModuleCount++;
	const vprog = { module: device.createShaderModule({ code: text, label }), info: { ...prog.info, bindings }, consts: prog.consts, pack: prog.pack, text, flat: prog.flat, groupBindings,
		variants: new Map(), bgls: [], label, vid: prog.vid, iid: prog.iid, overTex: 0 };
	v = { obj: { kind: 'shader', stage: obj.stage, hash: obj.hash + '~' + key, sig: obj.sig, program: vprog, fetched: obj.fetched, variantOf: obj }, prog: vprog };
	cache.set(key, v);
	logLine('shader ' + prog.label + ' reads ' + texs.length + ' textures, this GPU allows ' + limit + ': variant without ' + drop.map((b) => 't' + (b.binding - 32) + (lossy.includes(b) ? ' (bound)' : '')).join(', '));
	if (lossy.length && !isNode) (gpuErrorChannel || (gpuErrorChannel = new BroadcastChannel('game-progress'))).postMessage({ gpuError: 'shader ' + prog.label + ' needs ' + texs.length + ' textures, this GPU allows ' + limit + ': ' + lossy.length + ' left out (some detail may be missing)', kinds: 'note', total: 0 });
	return v;
}
const STAGE_NAME = ['vs', 'ps', 'cs'];

// ---- depth sampled with textureSample: a variant that loads it ------------------------------------------------------------------------------------------
// A shader that samples (textureSample*) a float texture the game binds a depth buffer to needed a float copy of the depth first (depthProxy: a render pass each time the
// depth changed, and the pass it interrupted begun again; an N100 Chromebook's overlay: 5 copies a frame, with ~58 passes setting the frame time at ~1 ms each in Chrome's
// GPU process). The game samples depth point-wise at pixel centres (filtering depth means nothing): the variant reads it with textureLoad at the texel the coordinates fall
// in (plus the call's offset, clamped to the edge, level 0). The binding is then load-only, so the depth is bound as it is (DEPTH_DIRECT): no copy, no interrupted pass.
// Only 2D bindings read with textureSample / Level / Bias / Grad (with or without an offset); anything else (gathers, arrays) keeps the copy.
function sampleToLoad(text, b) {		// the text with every sample of binding b a load, or null when some use of b cannot be
	const re = new RegExp('\\b(textureSample(?:Level|Bias|Grad)?)\\s*\\(\\s*' + b.name + '\\b', 'g');
	let out = '', last = 0, m, n = 0;
	while ((m = re.exec(text))) {
		const a = wgslArgs(text, text.indexOf('(', m.index));
		if (!a) return null;
		const fn = m[1], L = a.list, base = fn === 'textureSample' ? 3 : fn === 'textureSampleGrad' ? 5 : 4;		// (t, s, uv), (t, s, uv, level|bias), (t, s, uv, dx, dy), each + offset
		if (L.length !== base && L.length !== base + 1) return null;
		out += text.slice(last, m.index) + '_dload_' + b.name + '(' + L[2] + ', ' + (L.length > base ? L[base] : 'vec2<i32>(0)') + ')';
		last = a.end; re.lastIndex = a.end; n++;
	}
	if (!n) return null;
	text = out + text.slice(last) + '\nfn _dload_' + b.name + '(uv : vec2<f32>, o : vec2<i32>) -> vec4<f32> {\n  let d = vec2<i32>(textureDimensions(' + b.name + ', 0));\n' +
		'  return textureLoad(' + b.name + ', clamp(vec2<i32>(floor(uv * vec2<f32>(d))) + o, vec2<i32>(0), d - vec2<i32>(1)), 0);\n}\n';
	// every other mention a load or a size query now (parseWgsl's load-only test)
	const all = text.match(new RegExp('\\b' + b.name + '\\b', 'g')) || [];
	const loads = text.match(new RegExp('\\b(?:textureLoad|textureDimensions|textureNumLevels|textureNumLayers)\\s*\\(\\s*' + b.name + '\\b', 'g')) || [];
	return loads.length === all.length - 1 ? text : null;
}
function depthLoadVariant(obj, prog, bs) {
	const key = 'dl' + bs.map((b) => b.binding).join(',');
	const cache = prog.dlVariants || (prog.dlVariants = new Map());
	if (cache.has(key)) return cache.get(key);
	let text = prog.text;
	for (const b of bs) if (text) text = sampleToLoad(text, b);
	let v = null;
	if (text) {
		const bindings = prog.info.bindings.map((x) => (bs.includes(x) ? Object.assign({}, x, { loadOnly: true }) : x)), groupBindings = {};
		for (const x of bindings) (groupBindings[x.group] || (groupBindings[x.group] = [])).push(x);
		for (const g in groupBindings) groupBindings[g].sort((a, b) => a.binding - b.binding);
		const label = prog.label + ' (depth loaded: t' + bs.map((b) => b.binding - 32).join(',t') + ')';
		shaderModuleCount++;
		const vprog = { module: device.createShaderModule({ code: text, label }), info: { ...prog.info, bindings }, consts: prog.consts, pack: prog.pack, text, flat: prog.flat, groupBindings,
			variants: new Map(), bgls: [], label, vid: prog.vid, iid: prog.iid, overTex: prog.overTex };
		v = { obj: { kind: 'shader', stage: obj.stage, hash: obj.hash + '~' + key, sig: obj.sig, program: vprog, fetched: obj.fetched, variantOf: obj }, prog: vprog };
		depthLoadVariants++;
	} else logOnce('dl' + prog.label, 'shader ' + prog.label + ' reads a depth buffer in a way that cannot become a load: it keeps the copy');
	cache.set(key, v);
	return v;
}
// the variant of program prog (shader obj, at stage) for the depth buffers bound now to its sampled float bindings, or null (none bound, or no variant possible);
// worked out again only when the stage's bindings change
function depthLoadFor(obj, prog, stage) {
	const cands = prog.dlCand || (prog.dlCand = prog.info.bindings.filter((b) => b.kind === 'texture' && b.sample === 'float' && !b.loadOnly && !b.ms && b.dim === '2d'));
	if (!cands.length) return null;
	if (prog.dlEpoch === bindEpoch[stage] && prog.dlG === gEpoch) return prog.dlLast;
	let sel = null;
	const srvs = S.srv[stage];
	for (const b of cands) {
		const id = srvs[b.binding - 32], srv = id ? objs.get(id) : null, t = srv && !srv.isBuf ? objs.get(srv.res) : null;
		if (t && t.kind === 'texture' && isDepth(t.format) && srv.fmt !== 47 && srv.fmt !== 22) (sel || (sel = [])).push(b);
	}
	const v = sel ? depthLoadVariant(obj, prog, sel) : null;
	prog.dlEpoch = bindEpoch[stage]; prog.dlG = gEpoch; prog.dlLast = v;
	return v;
}
let depthLoadVariants = 0, lastDlVs = null, lastDlPs = null;

// ---- D3D's NaN rules for min / max / clamp / saturate ---------------------------------------------------------------------------------------------------------
// In D3D10+ a NaN operand of min/max yields the other operand (IEEE 754-2008 minNum/maxNum) and saturate(NaN) is 0: shaders rely on that to clean up NaN (a normal
// of length 0, 0/0) before it spreads. WGSL leaves it undefined, and Tint's Vulkan output (FMin/FMax/FClamp) lets NaN through on Intel GPUs: on a Chromebook the
// lighting buffer came out ~95 % NaN, shown as white snow, trees and walls (Direct3D 12 on Windows follows the D3D rules, so this is off there). Each call is
// rewritten with explicit NaN tests, the way D3D-on-Vulkan layers use NMin/NMax/NClamp. A call whose (rewritten) arguments are long is left as it is (each
// argument is repeated a few times). ?nansafe=1 / ?nansafe=0 on the page forces it on or off.
// Opt-in since the firewall below (?nansafe=1): with it on, an Intel Chromebook's lighting buffer still came out ~83 % NaN (the NaN hunt of 2026-11), so the rules did not stop
// the NaN there, while every min/max/clamp/saturate cost several extra instructions in every shader (and bigger shaders to compile) on GPUs that do not fold them away.
const nanParam = isNode ? null : new URLSearchParams(self.location.search).get('nansafe');
const nanRules = !isNode && nanParam === '1';
// The firewall: on except on Windows (Direct3D 12 follows D3D's NaN rules); ?nansafe=0 turns it off, ?nansafe=1 on.
const nanFire = !isNode && (nanParam === '1' || (nanParam !== '0' && !/Windows/.test(self.navigator.userAgent)));
// Pixel shader outputs: a NaN or infinite component becomes 0 before it is written (with the NaN rules: not on Windows). On an Intel Chromebook the sun's deferred light
// (directional::PS_directional_standard) still wrote NaN/Inf into ~83 % of the lighting buffer, shown as white. With this no pass can hand NaN on to the next through a
// render target, and a pass that makes it leaves those pixels without its light (darker, not white). The outputs are the module's o0..o7, written by main_inner() (as
// the alpha-to-coverage variant assumes too).
function nanFirewall(text) {
	const outs = [...text.matchAll(/var<private>\s+(o\d)\s*:\s*(?:vec4<f32>|vec4f)\s*;/g)].map((m) => m[1]);
	if (!outs.length || !/\n\s*main_inner\([^;]*\);/.test(text)) return text;
	// NaN and infinity tested on the bits (exponent all ones): WGSL lets compilers assume floats are never NaN, and they fold x != x to false (SwiftShader does).
	// Infinity goes too: written to a 16-bit float target it can come out as NaN (SwiftShader's conversion does that).
	const fix = outs.map((o) => '\n  ' + o + ' = select(' + o + ', vec4<f32>(0.0), (bitcast<vec4<u32>>(' + o + ') & vec4<u32>(0x7fffffffu)) >= vec4<u32>(0x7f800000u));').join('');
	return text.replace(/(\n\s*main_inner\([^;]*\);)/, '$1' + fix);
}
function wgslArgs(s, open) {		// the arguments of the call whose '(' is at s[open]: { list, end (after ')') } or null
	const list = [];
	let depth = 0, start = open + 1;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (c === '(' || c === '[') depth++;
		else if (c === ')' || c === ']') { depth--; if (depth === 0) { list.push(s.slice(start, i).trim()); return { list, end: i + 1 }; } }
		else if (c === ',' && depth === 1) { list.push(s.slice(start, i).trim()); start = i + 1; }
	}
	return null;
}
function d3dNanRules(s) {
	const re = /\b(min|max|clamp|saturate)\s*\(/g;
	let out = '', last = 0, m;
	while ((m = re.exec(s))) {
		if (/\b(fn|let|var|const|alias|struct)\s*$/.test(s.slice(Math.max(0, m.index - 8), m.index)) || s[m.index - 1] === '.') continue;		// a declaration or a member, not a call
		const call = wgslArgs(s, m.index + m[0].length - 1);
		if (!call) continue;
		const a = call.list.map(d3dNanRules), fn = m[1], P = (x) => '(' + x + ')';
		const nanMax = (f, x, y) => 'select(select(' + f + '(' + x + ', ' + y + '), ' + x + ', ' + P(y) + ' != ' + P(y) + '), ' + y + ', ' + P(x) + ' != ' + P(x) + ')';
		let rep = null;
		if (a.every((x) => x.length <= 240)) {
			if ((fn === 'min' || fn === 'max') && a.length === 2) rep = nanMax(fn, a[0], a[1]);
			else if (fn === 'clamp' && a.length === 3) rep = 'select(clamp(' + a.join(', ') + '), ' + a[1] + ', ' + P(a[0]) + ' != ' + P(a[0]) + ')';		// as maxNum then minNum: NaN -> low
			else if (fn === 'saturate' && a.length === 1) rep = 'select(saturate(' + a[0] + '), step(' + a[0] + ', ' + a[0] + ') * 0.0, ' + P(a[0]) + ' != ' + P(a[0]) + ')';		// NaN -> 0 (step() gives a zero of the right type that is never NaN)
		}
		out += s.slice(last, m.index) + (rep || fn + '(' + a.join(', ') + ')');
		last = call.end;
		re.lastIndex = call.end;
	}
	return out + s.slice(last);
}

async function initDevice(msg) {
	if (isNode) {
		const modPath = process.env.WGPU_NODE_MODULE || 'D:/wasm_build/shaders/node/node_modules/webgpu';
		const dawn = require(modPath);
		Object.assign(globalThis, dawn.globals);
		// FXC (the shader compiler of Dawn's D3D12 backend in this npm build; it has no DXC) rejects several translated compute kernels
		// with X3694/X3695 "race condition" errors that come from its optimiser. emit_hlsl_debug_symbols compiles without optimisation
		// (the driver still optimises). Chrome uses DXC where available, so this is a dev-loop workaround only.
		gpu = dawn.create(process.env.WGPU_DAWN_FLAGS ? process.env.WGPU_DAWN_FLAGS.split(',') : ['enable-dawn-features=emit_hlsl_debug_symbols']);
	} else {
		gpu = self.navigator.gpu;
	}
	if (!gpu) throw new Error('no WebGPU');
	adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
	if (!adapter) throw new Error('no WebGPU adapter');
	const want = ['texture-compression-bc', 'texture-compression-bc-sliced-3d', 'depth32float-stencil8', 'float32-filterable', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'depth-clip-control', 'clip-distances', 'texture-formats-tier1', 'dual-source-blending', 'timestamp-query'];
	const requiredFeatures = want.filter((f) => adapter.features.has(f));
	const limits = {};
	for (const k of ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxUniformBufferBindingSize', 'maxTextureDimension2D', 'maxTextureArrayLayers',
		'maxColorAttachmentBytesPerSample', 'maxBindGroups', 'maxStorageBuffersPerShaderStage', 'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage',
		'maxStorageTexturesPerShaderStage', 'maxUniformBuffersPerShaderStage', 'maxVertexBuffers', 'maxVertexAttributes', 'maxBindingsPerBindGroup',
		'maxInterStageShaderVariables', 'maxDynamicUniformBuffersPerPipelineLayout', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupStorageSize', 'maxComputeWorkgroupsPerDimension'])
		if (adapter.limits[k] !== undefined) limits[k] = adapter.limits[k];
	// WGPU_LIMITS=name=value,... (Node, test aid): request a smaller device, e.g. a Chromebook's (maxInterStageShaderVariables=16)
	if (isNode && process.env.WGPU_LIMITS) for (const kv of process.env.WGPU_LIMITS.split(',')) { const [k, v] = kv.split('='); limits[k] = +v; }
	// ?limits=name:value,... (browser): the same, lowered to a weaker device's limits (never below the WebGPU defaults)
	if (!isNode) for (const kv of (new URLSearchParams(self.location.search).get('limits') || '').split(',').filter(Boolean)) { const [k, v] = kv.split(':'); limits[k] = +v; }
	// ?nofeatures=a,b (diagnostics): leave optional features out, to reproduce a device that lacks them
	const drop = isNode ? [] : (new URLSearchParams(self.location.search).get('nofeatures') || '').split(',').filter(Boolean);
	device = await adapter.requestDevice({ requiredFeatures: requiredFeatures.filter((f) => !drop.includes(f)), requiredLimits: limits });
	noF32Filter = !device.features.has('float32-filterable');
	noD32S8 = !device.features.has('depth32float-stencil8');
	noRG11 = !device.features.has('rg11b10ufloat-renderable');
	if (!isNode && device.features.has('timestamp-query')) gpuTimingInit();
	if (!isNode && !GPUCommandEncoder.prototype.passCounted) {		// the overlay's passes per frame: every render and compute pass this worker begins
		const r = GPUCommandEncoder.prototype.beginRenderPass, c = GPUCommandEncoder.prototype.beginComputePass;
		GPUCommandEncoder.prototype.beginRenderPass = function (d) { passesBegun++; return r.call(this, d); };
		GPUCommandEncoder.prototype.beginComputePass = function (d) { passesBegun++; return c.call(this, d); };
		GPUCommandEncoder.prototype.passCounted = true;
	}
	const lacking = want.filter((f) => !device.features.has(f));
	if (lacking.length) logLine('this device lacks: ' + lacking.join(', ') + (noF32Filter || noD32S8 || noRG11 ? ' (worked around: ' + [noF32Filter && '32-bit float textures filtered through 16-bit copies', noD32S8 && '24-bit depth', noRG11 && 'rgba16float HDR targets'].filter(Boolean).join(', ') + ')' : ''));
	if (!isNode) {
		const info = adapter.info || {};
		new BroadcastChannel('game-progress').postMessage({ gpuInfo: { name: [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'unknown', lacking } });
	}
	device.addEventListener('uncapturederror', (ev) => {
		errorCount++;
		Atomics.add(i32, ringW + 4, 1);
		const msg = ev.error.message;
		const key = msg.replace(/0x[0-9a-f]+|\d+/g, 'N').slice(0, 200);
		const e = errorKinds.get(key);
		if (e) e.n++;
		else {
			errorKinds.set(key, { n: 1, msg });
			if (errorKinds.size <= 40) logLine('validation error: ' + msg.slice(0, 700));
			if (!isNode && errorKinds.size <= 3) (gpuErrorChannel || (gpuErrorChannel = new BroadcastChannel('game-progress'))).postMessage({ gpuError: msg.split('\n').slice(0, 3).join(' ').slice(0, 300), kinds: errorKinds.size, total: errorCount });
		}
	});
	device.lost.then((info) => {
		logLine('device lost: ' + info.reason + ' ' + info.message);
		if (!isNode && info.reason !== 'destroyed') new BroadcastChannel('game-progress').postMessage({ gpuLost: info.message.split('\n')[0].slice(0, 160) });
	});
	logLine('limits: maxDynamicUniformBuffersPerPipelineLayout=' + device.limits.maxDynamicUniformBuffersPerPipelineLayout + ' maxBindGroups=' + device.limits.maxBindGroups + ' maxUniformBuffersPerShaderStage=' + device.limits.maxUniformBuffersPerShaderStage + ' maxVertexBuffers=' + device.limits.maxVertexBuffers +
		' maxInterStageShaderVariables=' + device.limits.maxInterStageShaderVariables + ' maxSampledTexturesPerShaderStage=' + device.limits.maxSampledTexturesPerShaderStage + ' maxColorAttachmentBytesPerSample=' + device.limits.maxColorAttachmentBytesPerSample);
	logLine('device ready: ' + (adapter.info ? (adapter.info.description || adapter.info.vendor) : 'adapter') + ', features ' + requiredFeatures.join(','));
	if (msg.canvas) {
		canvas = msg.canvas;
		canvasCtx = canvas.getContext('webgpu');
		canvasFormat = gpu.getPreferredCanvasFormat();
	}
}

// ---- objects ----------------------------------------------------------------------------------------------------------------
// Rough GPU memory of a texture (all mips, all layers, samples), for the exit statistics: block-compressed formats by block size, others by texel size.
function textureBytes(desc) {
	const f = desc.format;
	let texel = 4;
	const block = /^(bc1|bc4|etc2-rgb8|eac-r11)/.test(f) ? 8 : /^(bc|astc|etc2|eac)/.test(f) ? 16 : 0;
	if (!block) texel = /r8|a8/.test(f) && !/rg8|rgba8|bgra8/.test(f) ? 1 : /rg8|r16|depth16/.test(f) ? 2 : /rgba16|rg32/.test(f) ? 8 : /rgba32/.test(f) ? 16 : 4;
	let total = 0;
	for (let m = 0; m < desc.mipLevelCount; m++) {
		const mw = Math.max(1, desc.size.width >> m), mh = Math.max(1, desc.size.height >> m), md = desc.dimension === '3d' ? Math.max(1, desc.size.depthOrArrayLayers >> m) : desc.size.depthOrArrayLayers;
		total += (block ? Math.ceil(mw / 4) * Math.ceil(mh / 4) * block : mw * mh * texel) * md;
	}
	return total * (desc.sampleCount || 1);
}
// Stutter diagnostics: what this worker spent time on since the last present; frames over SPIKE_MS are listed in the 10 s log line with the breakdown
const fr = { idle: 0, pipe: 0, mod: 0, up: 0, upBytes: 0, wait: 0, flush: 0 };
const SPIKE_MS = 40;
let lastPresentT = 0, spikes = [], spikeCount = 0, frameMax = 0, over25 = 0;
let pipeMs = 0, pipeCreates = 0, pipeCreates0 = 0, busyMs = 0, idleMs = 0, shaderModuleCount = 0, fpsT0 = 0, fpsCount0 = 0, fpsDraw0 = 0;
let texBytesAlive = 0, texBytesPeak = 0, texCount = 0, bufBytesAlive = 0, bufBytesPeak = 0;

function createTexture(id, dim, w, h, d, mips, arraySize, dxgi, bind, samples) {
	const m = mapFormat(dxgi, bind);
	let usage = GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
	if (bind & BIND_SRV) usage |= GPUTextureUsage.TEXTURE_BINDING;
	if (bind & (BIND_RT | BIND_DS)) usage |= GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
	if (bind & BIND_UAV) usage |= GPUTextureUsage.STORAGE_BINDING;
	if (!(bind & (BIND_SRV | BIND_RT | BIND_DS | BIND_UAV))) usage |= GPUTextureUsage.TEXTURE_BINDING;
	const desc = {
		size: { width: w, height: dim === 1 ? 1 : h, depthOrArrayLayers: dim === 3 ? d : arraySize },
		mipLevelCount: mips, sampleCount: samples, dimension: dim === 3 ? '3d' : (dim === 1 ? '1d' : '2d'),
		format: m.format, usage,
	};
	if (samples > 1) desc.usage &= ~(GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING);
	if (m.views) desc.viewFormats = m.views.filter((v) => !v.startsWith('bc') || device.features.has('texture-compression-bc'));
	const tex = device.createTexture(desc);
	const bytes = textureBytes(desc);
	texBytesAlive += bytes; texCount++;
	if (texBytesAlive > texBytesPeak) texBytesPeak = texBytesAlive;
	// a square 6-layer render target is a cube map the game renders every frame (the environment reflections): see REFLECT_EVERY
	const reflect = dim === 2 && arraySize === 6 && w === h && (bind & BIND_RT) ? new Int32Array(6).fill(-1000000) : null;
	objs.set(id, { kind: 'texture', tex, desc, format: m.format, views: new Map(), a8: !!m.a8, r11: !!m.r11, bytes, reflect });
}
// ---- reflections at a lower rate ------------------------------------------------------------------------------------------------------------------------------
// The game renders an environment cube map every frame for the reflections on cars, glass and water: each of its 6 faces from the scenery's low-detail models, a few dozen
// draws per face (~180 a frame), each as costly here as any other draw. With REFLECT_EVERY = n (the page's Fast and Fastest presets: 4; ?reflect=n) a face is redrawn at
// most every n-th frame: in between its clears and draws are skipped and it keeps its last picture, so reflections trail the view by a few frames. Decided per face, on the
// first clear or draw of that face in a frame, so a game that renders one face per frame still gets every face redrawn.
// The water's mirrored view (the scenery drawn with the shaders' *WaterReflection techniques into a target of its own) the same way: a target becomes a reflection when a
// water-reflection draw goes into it, and stops being one for good when anything else but the sky and clouds is drawn into it (a target shared with another pass).
const REFLECT_EVERY = isNode ? +(process.env.WGPU_REFLECT_EVERY || 1) : Math.max(1, Math.min(60, +(new URLSearchParams(self.location.search).get('reflect') || 1) | 0));
// ---- draw distance by object size ---------------------------------------------------------------------------------------------------------------------------
// The game streams and draws its world by its own rules (already at their lowest), and every draw costs about the same here and in Chrome's GPU process however far away or
// small it is. With a draw distance (the page's Balanced, Fast and Fastest; ?chunk=metres,tiny) a solid object of the world is left out when the nearest point of its box is
// farther than `metres` from the camera (along the ground: flying high leaves the city below as it was), or, with `tiny` (thousandths), when it is so small for how far it is
// that it would cover a few pixels: its size below tiny/1000 of its distance (not glass: a missing window is a hole). An object's box is the box of its vertex buffer's
// positions, read back from the GPU once, the first time the buffer is drawn (vbBoxRequest), and placed by the object's matrix: a long road or a block of buildings is drawn
// while any part of it is near. (Square cells judged by an object's origin left out roads that started two cells away: "roads don't load in".) Until its box is known an
// object is drawn. The ground, water, sky, lights and effects are always drawn, so the land stays to the horizon; people, vehicles and anything skinned too (see chunkCull).
// Only draws of the frame's main view are looked at (its G-buffer pass gives the camera), and only when the vertex constants at register b1 hold the game's matrices
// (rage_matrices: gWorld, gWorldView, gWorldViewProj, gViewInverse): the object's and the camera's transforms must be rigid ones, scaled or not (last column or row
// 0, 0, 0, 1), the object's must not be the identity (instanced and world-space geometry carry their positions elsewhere), and the camera must be the same as for the
// frame's other draws. Anything else is drawn as before.
const CHUNK = (() => {
	const v = (isNode ? process.env.WGPU_CHUNK || '' : new URLSearchParams(self.location.search).get('chunk') || '').split(',').map((x) => Math.max(0, +x || 0));
	return { dist: v[0] || 0, tiny: Math.min(0.05, (v[1] || 0) / 1000), min: v[2] >= 10 ? v[2] : 40 };
})();
// while the distance follows the frame rate: never nearer than CHUNK.min (?chunk=dist,tiny,min; 40 m unless given: the page's Fastest 30 m), never more than 2 % for `tiny`
const CHUNK_MIN_DIST = CHUNK.min, CHUNK_MAX_TINY = 0.02;
const chunkCam = { frame: -1, x: 0, y: 0, z: 0 };
let chunkCulled = 0, chunkSized = 0, chunkUnsized = 0, chunkFrames = 0;
// A draw distance that follows the frame rate (?chunkauto=<target frame time in ms>, the page's presets): once a second it is scaled, down (x0.85, to 0.4 of the preset's
// at least) while the frames take longer than the target, back up (x1.08, to twice the preset's at most) while there is room, or while the game's own threads are what
// holds the frame rate: this worker waiting for their commands half the frame or more with the GPU side mostly free (fewer draws would not help). `tiny` goes the other way.
// (A rule that only shrank when one part was busy 70 % of the frame never fired on a 4-thread CPU, where the game's threads, this worker and the GPU process share the cores.)
const CHUNK_AUTO = isNode ? 0 : Math.max(0, +(new URLSearchParams(self.location.search).get('chunkauto') || 0));
const CHUNK_BASE = { ...CHUNK }, CHUNK_MIN_SCALE = 0.4, CHUNK_MAX_SCALE = 2;
let chunkScale = 1;
const chunkWin = { t: 0, n: 0, idle: 0, wait: 0, gpu: 0 };		// this second's frames (present)
function chunkAdaptStep(scale, ms, gpu, idle, target) {
	const gameBound = idle >= 0.5 * ms && gpu < 0.5 * ms;
	if (ms > target * 1.08 && !gameBound) return Math.max(CHUNK_MIN_SCALE, scale * 0.85);
	if (ms < target * 0.85 || gameBound) return Math.min(CHUNK_MAX_SCALE, scale * 1.08);
	return scale;
}
function chunkApplyScale(scale) {
	chunkScale = scale;
	if (CHUNK_BASE.dist > 0) CHUNK.dist = Math.max(CHUNK_MIN_DIST, Math.round(CHUNK_BASE.dist * scale));
	if (CHUNK_BASE.tiny > 0) CHUNK.tiny = Math.min(CHUNK_MAX_TINY, CHUNK_BASE.tiny / scale);
}
// 0: never culled, 1: the world's solid objects (buildings, props), 2: people and vehicles, 3: decals, 4: the stand-ins of distant trees (trees_lod*), 5: trees,
// 6: see-through glass and fences of the world (blended or alpha-tested), 7: the ground's tiles (terrain*: only when hidden, never for distance or size)
function chunkKind(label) {
	const k = label.indexOf('::'), e = (k > 0 ? label.slice(0, k) : label).toLowerCase();
	if (/terrain/.test(e)) return 7;		// terrain*, default_terrain_wet (the wet ground's layers): the ground, only when hidden
	if (/^(terrain|water|sky|cloud|im$|imms|postfx|deferred|lighting|ptfx|ptxgpu|rmptfx|debug|scaleform|radar|rage_|shadow|ssao|hdao|blur|cascade|mirror|billboard|grass|light|spot|point|capsule|tiled|volume|fog|lens|rain|snow|corona|vfx|cubemap|reflect|seethrough|occlu|stencil|copy|clear|downsample|gpu|cs_|directional|distortion|memory|adaptive|avg|damage|distance|dof|exposure|golf|mlaa|silhouette|skinblend|waveform|rope|cable|blend_2lyr)/.test(e)) return 0;
	if (/terrain|_wet|shadow/.test(e)) return 0;		// the ground (wet ground layers too) and shadow-only geometry
	if (/^(ped|cloth|vehicle|weapon|hair)/.test(e)) return 2;
	if (/^trees_lod/.test(e)) return 4;
	if (/^trees/.test(e)) return 5;
	if (/^(glass|cutout_fence)/.test(e)) return 6;
	if (/decal/.test(e)) return 3;
	return 1;
}
// The box of a vertex buffer's positions: the element at offset 0 of slot 0 as three or four floats (the game's vertex formats start with the position), read back from the
// GPU: copies into one of two 4 MB staging buffers recorded at the end of the next submit (BOX_PER_FLUSH buffers at most), mapped after it; with both staging buffers being
// read, nothing more until one is back. A buffer whose data does not look like positions (not finite, beyond 100 km, all of unit length: normals, or all one point) gets no
// box; one uploaded again is read again (streamed geometry), up to twice, then never (data that keeps changing: CPU-skinned, cloth). A box is only used for draws that bind
// the buffer from offset 0 with the stride it was read with.
// o.boxSt: undefined not looked at yet, 1 being read, 2 no box, 3 o.box = [min x, y, z, max x, y, z]
const BOX_STAGE_BYTES = 4 << 20, BOX_PER_FLUSH = 48, BOX_STAGES = 2;
const boxRequests = [], boxStages = [];
let boxStagesMade = 0;
function vbBoxRequest(o, layout, stride) {
	o.boxSt = 2; o.boxSeen = true;
	if (!layout || !stride || (stride & 3) || !o.gpu || o.bytes > BOX_STAGE_BYTES || (o.reup || 0) > 2) return;
	let e = null;
	for (const x of layout.els) if (x.slot === 0 && x.offset === 0 && x.cls === 0) { e = x; break; }
	if (!e || (e.fmt !== 6 && e.fmt !== 2)) return;		// DXGI R32G32B32_FLOAT, R32G32B32A32_FLOAT
	o.boxSt = 1; o.boxStride = stride; o.boxGen = o.gen || 0;
	boxRequests.push(o);
}
function boxEncode(enc) {		// in flush(), right before the submit: no buffer can go away in between
	if (!boxStages.length && boxStagesMade >= BOX_STAGES) return null;		// both staging buffers are being read
	const list = [];
	let at = 0;
	while (boxRequests.length && list.length < BOX_PER_FLUSH * 4) {
		const o = boxRequests[0], n = o.bytes;
		if (objs.get(o.uid) !== o || !o.gpu || o.boxSt !== 1) { boxRequests.shift(); continue; }
		if (at + n > BOX_STAGE_BYTES) break;
		boxRequests.shift();
		list.push(o, at, n, o.boxGen);
		at += n;
	}
	if (!list.length) return null;
	const stage = boxStages.pop() || (boxStagesMade++, device.createBuffer({ size: BOX_STAGE_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
	for (let i = 0; i < list.length; i += 4) enc.copyBufferToBuffer(list[i].gpu, 0, stage, list[i + 1], list[i + 2]);
	return { stage, list, bytes: at };
}
function boxFromFloats(f, stride, count) {		// null when the floats are not positions (see above)
	const step = stride >> 2;
	let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, unit = count > 8;
	for (let i = 0, k = 0; i < count; i++, k += step) {
		const x = f[k], y = f[k + 1], z = f[k + 2];
		if (!(x > -1e5 && x < 1e5 && y > -1e5 && y < 1e5 && z > -1e5 && z < 1e5)) return null;
		if (x < x0) x0 = x; if (x > x1) x1 = x;
		if (y < y0) y0 = y; if (y > y1) y1 = y;
		if (z < z0) z0 = z; if (z > z1) z1 = z;
		if (unit) { const l2 = x * x + y * y + z * z; if (l2 < 0.96 || l2 > 1.04) unit = false; }
	}
	if (!count || unit || x1 - x0 + y1 - y0 + z1 - z0 < 1e-4) return null;
	return [x0, y0, z0, x1, y1, z1];
}
function boxRead(r) {
	const list = r.list;
	r.stage.mapAsync(GPUMapMode.READ, 0, r.bytes).then(() => {
		const all = r.stage.getMappedRange(0, r.bytes);
		for (let i = 0; i < list.length; i += 4) {
			const o = list[i], at = list[i + 1], n = list[i + 2], gen = list[i + 3];
			if (o.boxSt !== 1) continue;
			if ((o.gen || 0) !== gen) { o.boxSt = undefined; continue; }		// uploaded again meanwhile: read again when next drawn
			const box = boxFromFloats(new Float32Array(all, at, n >> 2), o.boxStride, Math.floor(n / o.boxStride));
			if (box) { o.box = box; o.boxSt = 3; boxesKnown++; } else o.boxSt = 2;
		}
		r.stage.unmap(); boxStages.push(r.stage);
	}, () => { r.stage.destroy(); boxStagesMade--; for (let i = 0; i < list.length; i += 4) if (list[i].boxSt === 1) list[i].boxSt = 2; });
}
let boxesKnown = 0;
// a vertex buffer uploaded again once its box was asked for (uploadBuffer): its box is read again, or never after the second time
function boxUploaded(o) {
	o.gen = (o.gen || 0) + 1; o.reup = (o.reup || 0) + 1;
	o.boxSt = o.reup <= 2 ? undefined : 2;
}
// The game's matrices from 64 floats at f[b..] (gWorld at b, gWorldViewProj at b + 32, gViewInverse at b + 48) as row-vector matrices (the translation in the last row, as
// the game stores them; the transpose of that is turned around): gWorld into chunkW, the camera's position into chunkCamPos, and with `wvp` gWorldViewProj into chunkWVP.
// False when gWorld or gViewInverse is not a rigid transform (scaled or not) or a position is off the map; chunkIdent: gWorld has no translation (world-space geometry).
const chunkW = new Float64Array(16), chunkWVP = new Float64Array(16), chunkCamPos = new Float64Array(3);
let chunkIdent = false;
function chunkMatrices(f, b, wvp) {
	const v = b + 48;
	let tr;
	if (f[b + 3] === 0 && f[b + 7] === 0 && f[b + 11] === 0 && f[b + 15] === 1) tr = false;
	else if (f[b + 12] === 0 && f[b + 13] === 0 && f[b + 14] === 0 && f[b + 15] === 1) tr = true;
	else return false;
	if (f[v + 3] === 0 && f[v + 7] === 0 && f[v + 11] === 0 && f[v + 15] === 1) { chunkCamPos[0] = f[v + 12]; chunkCamPos[1] = f[v + 13]; chunkCamPos[2] = f[v + 14]; }
	else if (f[v + 12] === 0 && f[v + 13] === 0 && f[v + 14] === 0 && f[v + 15] === 1) { chunkCamPos[0] = f[v + 3]; chunkCamPos[1] = f[v + 7]; chunkCamPos[2] = f[v + 11]; }
	else return false;
	const W = chunkW;
	if (!tr) for (let i = 0; i < 16; i++) W[i] = f[b + i];
	else for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) W[r * 4 + c] = f[b + c * 4 + r];
	if (wvp) {
		if (!tr) for (let i = 0; i < 16; i++) chunkWVP[i] = f[b + 32 + i];
		else for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) chunkWVP[r * 4 + c] = f[b + 32 + c * 4 + r];
	}
	chunkIdent = W[12] === 0 && W[13] === 0 && W[14] === 0;
	const s = Math.max(W[0] * W[0] + W[1] * W[1] + W[2] * W[2], W[4] * W[4] + W[5] * W[5] + W[6] * W[6], W[8] * W[8] + W[9] * W[9] + W[10] * W[10]);
	if (!(s > 1e-6 && s < 1e6)) return false;		// no scale like that on a map object (and not a NaN)
	return Math.abs(W[12]) < 1e5 && Math.abs(W[13]) < 1e5 && Math.abs(W[14]) < 1e5 && Math.abs(chunkCamPos[0]) < 1e5 && Math.abs(chunkCamPos[1]) < 1e5 && Math.abs(chunkCamPos[2]) < 1e5;
}
// the floats of the vertex constant buffer at register `slot`, from its bound first constant, or null when fewer than 256 bytes
function chunkCb(slot) {
	const c = S.cb[0][slot], o = c.buf ? objs.get(c.buf) : null;
	if (!o || !o.shadow || o.size - c.first * 16 < 256) return null;
	chunkCbOff = c.first * 4;
	return o.shadowF32 || (o.shadowF32 = new Float32Array(o.shadow.buffer, o.shadow.byteOffset, o.shadow.length >> 2));
}
let chunkCbOff = 0;
// Is this draw an object of the world that is too far, too small for its distance, or hidden (occlusion, below)? 0: draw it, 1: too far or too small, 2: hidden
// Effects left out altogether (?skipfx=prefix,prefix: the shader effect's name starts with one; the page's Fastest: grass_fur, the shell layers of furry lawn grass, a draw per
// layer: 32 of 468 draws in an N100 Chromebook's frame on a lawn). The ground under them stays.
const SKIP_FX = (isNode ? process.env.WGPU_SKIP_FX || '' : new URLSearchParams(self.location.search).get('skipfx') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
let fxSkipped = 0;
function skipFxOf(prog) {
	if (prog.skipFx === undefined) { const l = (prog.label || '').toLowerCase(), k = l.indexOf('::'), e = k > 0 ? l.slice(0, k) : l; prog.skipFx = SKIP_FX.some((x) => e.startsWith(x)); }
	return prog.skipFx;
}
// Why a draw of the world (kinds 1-7) was kept, counted for the overlay (what to look at next): KEPT_WHY names the counters of keptWhy
const KEPT_WHY = ['instanced', 'other pass', 'skinned', 'no matrices', 'no position', 'other view', 'size unknown', 'near', 'before the camera'];
const keptWhy = new Float64Array(KEPT_WHY.length);
function chunkCull(vsProg, psProg, inst) {
	const prog = psProg || vsProg;
	const kind = prog.chunkKind !== undefined ? prog.chunkKind : (prog.chunkKind = chunkKind(prog.label || ''));
	if (!kind) return 0;
	if (inst > 1) { keptWhy[0]++; return 0; }
	let mrt = 0;
	for (let i = 0; i < 8; i++) if (S.rt[i].tex) mrt++;
	if (!mrt) { keptWhy[1]++; return 0; }		// depth-only passes (occlusion, shadows): never
	if (mrt < 3 && chunkCam.frame !== presentCount) { keptWhy[1]++; return 0; }		// passes with fewer targets (glass, foliage, decals drawn see-through) only after the G-buffer gave the frame's camera
	// Skinned meshes (vehicles' bodies, people, breakable props: lamp posts, signs, fences; VS_*Skin*) are placed by their bone matrices, and the object matrix at b1 is not
	// where they are: culled by it, car bodies vanished while their wheels (not skinned) stayed, until a hit broke the car into parts (reported: "cars are just wheels").
	// The rigid parts of people and vehicles (wheels, lights, props, weapons) are placed by it, and are only left out when too small for their distance (a wheel 60 m away
	// on Fastest: a pixel or two), never for distance or because hidden (they move: the depth grid is a frame or two old).
	if (vsProg.skinned === undefined) vsProg.skinned = /skin/i.test(vsProg.label || '');
	if (vsProg.skinned) { keptWhy[2]++; return 0; }
	// the game's matrices: at register b1 (rage_matrices); a vertex shader whose b1 never holds them is searched once at the other registers (another build may bind them
	// elsewhere), and the register found is kept for it; one with none anywhere after 64 tries is left alone
	let slot = vsProg.chunkSlot;
	if (slot === undefined) {
		const tries = (vsProg.chunkTries = (vsProg.chunkTries || 0) + 1);
		for (const k of [1, 0, 2, 3, 4, 5, 6, 7]) { const f = chunkCb(k); if (f && chunkMatrices(f, chunkCbOff, false)) { slot = vsProg.chunkSlot = k; break; } }
		if (slot === undefined) { if (tries >= 64) vsProg.chunkSlot = -1; keptWhy[3]++; return 0; }
	}
	if (slot < 0) { keptWhy[3]++; return 0; }
	const first = chunkCam.frame !== presentCount;
	const f = chunkCb(slot);
	if (!f || !chunkMatrices(f, chunkCbOff, first && mrt >= 3)) { keptWhy[3]++; return 0; }		// not the matrices this time
	if (chunkIdent) { keptWhy[4]++; return 0; }		// no translation (instanced and world-space geometry: placed elsewhere)
	const cx = chunkCamPos[0], cy = chunkCamPos[1], cz = chunkCamPos[2];
	if (first) {
		if (mrt < 3 || kind === 2) { keptWhy[8]++; return 0; }		// the frame's camera from a world object of the G-buffer (first-person arms and weapons may have a projection of their own)
		chunkCam.frame = presentCount; chunkCam.x = cx; chunkCam.y = cy; chunkCam.z = cz; chunkFrames++;
		if (OCCL) occlFrameView();
	} else if (Math.abs(cx - chunkCam.x) > 0.05 || Math.abs(cy - chunkCam.y) > 0.05 || Math.abs(cz - chunkCam.z) > 0.05) { keptWhy[5]++; return 0; }		// not the frame's main view
	const vb = S.vb[0], o = vb.buf ? objs.get(vb.buf) : null;
	if (!o || !o.gpu) { keptWhy[6]++; return 0; }
	if (o.boxSt !== 3) { if (o.boxSt === undefined && vb.offset === 0) vbBoxRequest(o, S.layout ? objs.get(S.layout) : null, vb.stride); chunkUnsized++; keptWhy[6]++; return 0; }
	if (vb.offset !== 0 || vb.stride !== o.boxStride) { chunkUnsized++; keptWhy[6]++; return 0; }
	chunkSized++;
	// the box placed in the world: its centre, and the half sizes of the box around it along the map's axes
	const bx = o.box, W = chunkW;
	const lx = (bx[0] + bx[3]) * 0.5, ly = (bx[1] + bx[4]) * 0.5, lz = (bx[2] + bx[5]) * 0.5, ex = (bx[3] - bx[0]) * 0.5, ey = (bx[4] - bx[1]) * 0.5, ez = (bx[5] - bx[2]) * 0.5;
	const wx = lx * W[0] + ly * W[4] + lz * W[8] + W[12], wy = lx * W[1] + ly * W[5] + lz * W[9] + W[13], wz = lx * W[2] + ly * W[6] + lz * W[10] + W[14];
	const hx = Math.abs(W[0]) * ex + Math.abs(W[4]) * ey + Math.abs(W[8]) * ez, hy = Math.abs(W[1]) * ex + Math.abs(W[5]) * ey + Math.abs(W[9]) * ez, hz = Math.abs(W[2]) * ex + Math.abs(W[6]) * ey + Math.abs(W[10]) * ez;
	if (kind === 7) { if (OCCL && occlHidden(bx)) return 2; keptWhy[7]++; return 0; }		// the ground: only when hidden (it reaches the horizon)
	if (CHUNK.dist > 0 && kind !== 2) {
		const dx = Math.max(0, Math.abs(wx - cx) - hx), dy = Math.max(0, Math.abs(wy - cy) - hy);
		if (dx * dx + dy * dy > CHUNK.dist * CHUNK.dist) return 1;
	}
	if (CHUNK.tiny > 0 && kind !== 6) {
		const dx = wx - cx, dy = wy - cy, dz = wz - cz, r2 = hx * hx + hy * hy + hz * hz, d2 = dx * dx + dy * dy + dz * dz;
		if (d2 > r2 && r2 < CHUNK.tiny * CHUNK.tiny * d2) return 1;
	}
	if (OCCL && kind !== 2 && occlHidden(bx)) return 2;
	keptWhy[7]++;
	return 0;
}
// ---- occlusion: what an earlier frame's depth shows is hidden is left out -----------------------------------------------------------------------------------
// With ?occl=1 (the page's Balanced, Fast and Fastest) the depth buffer of the frame's main view is reduced on the GPU, once its G-buffer pass is over, to a grid of up to
// 64 cells across with the nearest and the farthest depth in each cell (occlSnapshot), read back, and kept with that frame's camera: its view-projection matrix, taken from
// the frame's first G-buffer draw (inverse(gWorld) x gWorldViewProj). An object whose box (see above), seen from that camera, lies wholly behind the farthest depth of every
// cell it covers, with a margin, was hidden behind what was drawn there, and is left out. The grid is a frame or two old, so a box that reaches outside that view or in front
// of its camera is drawn, everything is once the camera has moved more than OCCL_MAX_MOVE metres since (a cut, a teleport) or the grid is older than OCCL_MAX_AGE frames,
// and for smaller moves the box is widened by how far the nearest thing in front of it can have shifted on the screen (an object coming out from behind a corner).
// Nothing is left out because of the grid that the grid's own frame drew: what was left out is not in it, and comes back as soon as a grid shows it uncovered.
const OCCL = isNode ? process.env.WGPU_OCCL === '1' : new URLSearchParams(self.location.search).get('occl') === '1';
// OCCL_MAX_AGE: with the GPU fences answered at submit the game runs up to FRAME_SLOTS frames ahead of the GPU, and a grid comes back 3-5 frames after its frame (an N100
// Chromebook's overlay said "depth too old" at 4); the camera-move limit and the widening by the shift of what is in front keep an older grid safe
const OCCL_GRID = 64, OCCL_MAX_MOVE = 4, OCCL_MAX_AGE = 8, OCCL_REL = 1.02, OCCL_ABS = 0.3;
const occl = { frame: -1, ds: 0, mip: 0, slice: 0, vp: [0, 0, 0, 0, 0, 1], VP: null, cam: [0, 0, 0], open: false, busy: null, ready: null, pipe: null, params: null, out: null, rbs: [], moved: 0, movedFrame: -1, snaps: 0, why: '' };
let occlCulled = 0;
// the frame's main view (chunkCull, its first G-buffer draw): its depth target, viewport and camera; chunkW/chunkWVP hold that draw's gWorld and gWorldViewProj
function occlFrameView() {
	occl.frame = presentCount; occl.ds = S.ds.tex; occl.mip = S.ds.mip; occl.slice = S.ds.slice;
	const v = S.viewports[0];
	if (v) for (let i = 0; i < 6; i++) occl.vp[i] = v[i]; else occl.vp[2] = 0;
	occl.cam[0] = chunkCamPos[0]; occl.cam[1] = chunkCamPos[1]; occl.cam[2] = chunkCamPos[2];
	occl.VP = viewProjFrom(chunkW, chunkWVP);
	occl.why = occl.VP ? '' : 'the camera is not a perspective view';		// (occlSnapshot may find another reason)
	occl.open = true;		// its G-buffer pass is open now or begins with this draw (ensurePass: occlPassStart)
}
// a render pass begins (ensurePass, after the last one ended): the first one after the main view's G-buffer pass takes the depth grid, before any clear of its own
function occlPassStart() {
	let mrt = 0;
	for (let i = 0; i < 8; i++) if (S.rt[i].tex) mrt++;
	if (mrt >= 3 && S.ds.tex !== 0 && S.ds.tex === occl.ds && S.ds.mip === occl.mip && S.ds.slice === occl.slice) return;		// the G-buffer pass goes on
	if (occl.open) occlSnapshot();
}
// inverse(W) x WVP for a W of the form [R 0; t 1] (row vectors): the camera's view-projection; null when R cannot be inverted or the result is not a perspective projection
function viewProjFrom(W, WVP) {
	const a = W[0], b = W[1], c = W[2], d = W[4], e = W[5], f = W[6], g = W[8], h = W[9], k = W[10];
	const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
	if (!(Math.abs(det) > 1e-12)) return null;
	const inv = [A / det, -(b * k - c * h) / det, (b * f - c * e) / det, B / det, (a * k - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
	const t0 = W[12], t1 = W[13], t2 = W[14];
	const s0 = -(t0 * inv[0] + t1 * inv[3] + t2 * inv[6]), s1 = -(t0 * inv[1] + t1 * inv[4] + t2 * inv[7]), s2 = -(t0 * inv[2] + t1 * inv[5] + t2 * inv[8]);
	const VP = new Float64Array(16);
	for (let j = 0; j < 4; j++) {
		for (let i = 0; i < 3; i++) VP[i * 4 + j] = inv[i * 3] * WVP[j] + inv[i * 3 + 1] * WVP[4 + j] + inv[i * 3 + 2] * WVP[8 + j];
		VP[12 + j] = s0 * WVP[j] + s1 * WVP[4 + j] + s2 * WVP[8 + j] + WVP[12 + j];
	}
	return occlProjection(VP) ? VP : null;
}
// how the view-projection maps depth: clip z = a * w + b (a perspective projection, w the distance along the view), reversed (far = 0) when b > 0; and its scale on the
// screen (px, py: NDC per radian at the centre). Stored on the matrix; false when it is not a perspective projection.
function occlProjection(VP) {
	const g3x = VP[3], g3y = VP[7], g3z = VP[11], g2x = VP[2], g2y = VP[6], g2z = VP[10];
	const l3 = g3x * g3x + g3y * g3y + g3z * g3z;
	if (!(l3 > 1e-12) || !isFinite(l3)) return false;
	const a = (g2x * g3x + g2y * g3y + g2z * g3z) / l3, b = VP[14] - a * VP[15];
	const rx = g2x - a * g3x, ry = g2y - a * g3y, rz = g2z - a * g3z;
	if (rx * rx + ry * ry + rz * rz > 1e-6 * Math.max(l3, g2x * g2x + g2y * g2y + g2z * g2z) || !(Math.abs(b) > 1e-9)) return false;
	const l = Math.sqrt(l3);
	VP.occA = a; VP.occB = b; VP.rev = b > 0;
	VP.px = Math.hypot(VP[0], VP[4], VP[8]) / l; VP.py = Math.hypot(VP[1], VP[5], VP[9]) / l; VP.wl = l;
	return VP.px > 0.05 && VP.py > 0.05;
}
// the depth grid's compute shader: per cell, the lowest and the highest depth of its texels of the viewport
const OCCL_WGSL = `
struct P { gw: u32, gh: u32, x0: u32, y0: u32, w: u32, h: u32, mip: u32, pad: u32 };
@group(0) @binding(0) var dep: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> outv: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	if (id.x >= p.gw || id.y >= p.gh) { return; }
	// the texels the cell's part of the screen touches, the ones it shares with the next cell included
	let xa = p.x0 + id.x * p.w / p.gw; let xb = p.x0 + min(p.w, ((id.x + 1u) * p.w + p.gw - 1u) / p.gw);
	let ya = p.y0 + id.y * p.h / p.gh; let yb = p.y0 + min(p.h, ((id.y + 1u) * p.h + p.gh - 1u) / p.gh);
	var lo = 1e30; var hi = -1e30;
	for (var y = ya; y < yb; y++) {
		for (var x = xa; x < xb; x++) {
			let d = textureLoad(dep, vec2<i32>(i32(x), i32(y)), i32(p.mip));
			lo = min(lo, d); hi = max(hi, d);
		}
	}
	outv[id.y * p.gw + id.x] = vec2<f32>(lo, hi);
}`;
// once the frame's G-buffer pass is over (ensurePass, when the next pass is something else; present): the grid of the main view's depth, recorded into this encoder
function occlSnapshot() {
	occl.open = false;
	if ((occl.busy && !occl.busy.mapping) || !occl.VP || occl.frame !== presentCount) return;		// one not submitted yet (the same frame); grids being read overlap
	const t = objs.get(occl.ds);
	if (!t || t.kind !== 'texture' || !t.tex || !isDepth(t.format)) { occl.why = 'no depth buffer in the main view'; return; }
	if (t.desc.sampleCount > 1 || t.desc.dimension !== '2d') { occl.why = 'a multisampled or layered depth buffer'; return; }
	const vp = occl.vp, mw = Math.max(1, t.desc.size.width >> occl.mip), mh = Math.max(1, t.desc.size.height >> occl.mip);
	if (vp[4] !== 0 || vp[5] !== 1) { occl.why = 'a depth range of ' + vp[4] + '..' + vp[5]; return; }		// a depth range other than 0..1
	const x0 = Math.max(0, Math.round(vp[0])), y0 = Math.max(0, Math.round(vp[1])), w = Math.min(mw - x0, Math.round(vp[2])), h = Math.min(mh - y0, Math.round(vp[3]));
	if (w < 32 || h < 32) { occl.why = 'a viewport of ' + w + 'x' + h; return; }
	occl.why = '';
	const gw = Math.min(OCCL_GRID, w), gh = Math.max(8, Math.min(OCCL_GRID, Math.round(gw * h / w)));
	try {
		if (!occl.pipe) {
			occl.pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: OCCL_WGSL, label: 'occlusion grid' }), entryPoint: 'main' }, label: 'occlusion grid' });
			occl.params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
			occl.out = device.createBuffer({ size: OCCL_GRID * OCCL_GRID * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
		}
		const key = occl.mip + ':' + occl.slice;
		if (!t.occlBG || t.occlKey !== key) {
			const view = t.tex.createView({ dimension: '2d', baseMipLevel: occl.mip, mipLevelCount: 1, baseArrayLayer: occl.slice, arrayLayerCount: 1, aspect: 'depth-only' });
			t.occlBG = device.createBindGroup({ layout: occl.pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: occl.out } }, { binding: 2, resource: { buffer: occl.params } }] });
			t.occlKey = key;
		}
		device.queue.writeBuffer(occl.params, 0, new Uint32Array([gw, gh, x0, y0, w, h, 0, 0]));
		const n = gw * gh * 8, rb = occl.rbs.pop() || device.createBuffer({ size: OCCL_GRID * OCCL_GRID * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		endPass();
		const enc = getEncoder(), cp = enc.beginComputePass();
		cp.setPipeline(occl.pipe); cp.setBindGroup(0, t.occlBG); cp.dispatchWorkgroups(Math.ceil(gw / 8), Math.ceil(gh / 8)); cp.end();
		enc.copyBufferToBuffer(occl.out, 0, rb, 0, n);
		usedInEncoder.add(t);
		occl.busy = { rb, n, gw, gh, VP: occl.VP, cam: occl.cam.slice(), frame: presentCount, mapping: false };
		occl.snaps++;
	} catch (e) { logOnce('occl', 'occlusion grid: ' + (e && e.message || e)); occl.pipe = null; occl.why = 'the depth grid failed: ' + String(e && e.message || e).slice(0, 60); }
}
// after the submit that carries a grid's copy (flush): read it back; the depths become distances along the view (w), Infinity where nothing was drawn (the sky)
function occlMap() {
	const s = occl.busy;
	s.mapping = true;
	s.rb.mapAsync(GPUMapMode.READ, 0, s.n).then(() => {
		const raw = new Float32Array(s.rb.getMappedRange(0, s.n)), m = s.gw * s.gh, far = new Float32Array(m), near = new Float32Array(m);
		const a = s.VP.occA, b = s.VP.occB, rev = s.VP.rev, wl = s.VP.wl;
		const toW = (z) => { if (rev ? !(z > 1e-7) : !(z < 1 - 1e-7)) return Infinity; const w = b / (z - a); return w > 0 ? w / wl : Infinity; };
		for (let k = 0; k < m; k++) {
			const lo = raw[k * 2], hi = raw[k * 2 + 1];
			far[k] = toW(rev ? lo : hi); near[k] = toW(rev ? hi : lo);
		}
		s.rb.unmap(); occl.rbs.push(s.rb);
		if (!occl.ready || s.frame > occl.ready.frame) occl.ready = { far, near, gw: s.gw, gh: s.gh, VP: s.VP, cam: s.cam, frame: s.frame };		// the newest grid wins
		if (occl.busy === s) occl.busy = null;
	}, () => { if (occl.busy === s) occl.busy = null; });
}
// for the overlay: is occlusion working now, and if not, why
function occlActive() {
	const R = occl.ready;
	return !!R && presentCount - R.frame <= OCCL_MAX_AGE && !(occl.movedFrame === presentCount && occl.moved > OCCL_MAX_MOVE);
}
function occlStatus() {
	if (occlActive()) return '';
	if (occl.why) return occl.why;
	if (chunkCam.frame < presentCount - 2) return 'no main view found';
	const R = occl.ready;
	return !R ? 'no depth yet' : presentCount - R.frame > OCCL_MAX_AGE ? 'depth too old' : 'camera moving fast';
}
// is the box of the object (chunkW places it) behind the depth of the latest grid?
function occlHidden(bx) {
	const R = occl.ready;
	if (!R || presentCount - R.frame > OCCL_MAX_AGE) return false;
	if (occl.movedFrame !== presentCount) {		// how far the camera has gone since the grid's frame (once a frame)
		occl.movedFrame = presentCount;
		occl.moved = Math.hypot(chunkCam.x - R.cam[0], chunkCam.y - R.cam[1], chunkCam.z - R.cam[2]);
	}
	const moved = occl.moved;
	if (moved > OCCL_MAX_MOVE) return false;
	// the corners in that view: x, y and w of gWorld x VP
	const W = chunkW, V = R.VP;
	let m0 = 0, m1 = 0, m3 = 0, m4 = 0, m5 = 0, m7 = 0, m8 = 0, m9 = 0, m11 = 0, m12 = 0, m13 = 0, m15 = 0;
	for (let k = 0; k < 4; k++) {
		const v0 = V[k * 4], v1 = V[k * 4 + 1], v3 = V[k * 4 + 3];
		const w0 = W[k], w1 = W[4 + k], w2 = W[8 + k], w3 = W[12 + k];
		m0 += w0 * v0; m1 += w0 * v1; m3 += w0 * v3;
		m4 += w1 * v0; m5 += w1 * v1; m7 += w1 * v3;
		m8 += w2 * v0; m9 += w2 * v1; m11 += w2 * v3;
		m12 += w3 * v0; m13 += w3 * v1; m15 += w3 * v3;
	}
	let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, wMin = Infinity;
	for (let c = 0; c < 8; c++) {
		const px = c & 1 ? bx[3] : bx[0], py = c & 2 ? bx[4] : bx[1], pz = c & 4 ? bx[5] : bx[2];
		const w = px * m3 + py * m7 + pz * m11 + m15;
		if (!(w > 0.05 * V.wl)) return false;		// reaches the camera's plane: in front of everything
		const x = (px * m0 + py * m4 + pz * m8 + m12) / w, y = (px * m1 + py * m5 + pz * m9 + m13) / w;
		if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (w < wMin) wMin = w;
	}
	const gw = R.gw, gh = R.gh;
	let gx0 = Math.floor((x0 * 0.5 + 0.5) * gw), gx1 = Math.floor((x1 * 0.5 + 0.5) * gw), gy0 = Math.floor((0.5 - y1 * 0.5) * gh), gy1 = Math.floor((0.5 - y0 * 0.5) * gh);
	if (gx0 < 0 || gy0 < 0 || gx1 >= gw || gy1 >= gh) return false;		// not all inside that view
	const need = (wMin / V.wl - OCCL_ABS) / OCCL_REL, far = R.far;
	if (moved > 0.01) {		// widened by the shift of the nearest thing in front of it: the angle moved/distance, in cells (1.7: the screen's edges move more than its centre)
		let nearest = Infinity;
		for (let gy = gy0; gy <= gy1; gy++) for (let k = gy * gw + gx0, e = gy * gw + gx1; k <= e; k++) { const n = R.near[k]; if (n < nearest) nearest = n; }
		const ang = 1.5 * moved / Math.max(0.5, nearest);
		const dx = Math.ceil(ang * V.px * 1.7 * gw * 0.5), dy = Math.ceil(ang * V.py * 1.7 * gh * 0.5);
		gx0 -= dx; gx1 += dx; gy0 -= dy; gy1 += dy;
		if (gx0 < 0 || gy0 < 0 || gx1 >= gw || gy1 >= gh) return false;
	}
	for (let gy = gy0; gy <= gy1; gy++) for (let k = gy * gw + gx0, e = gy * gw + gx1; k <= e; k++) if (!(far[k] < need)) return false;
	return true;
}
// a water-reflection draw makes its target a reflection (redrawn every REFLECT_EVERY frames from now); anything but the sky or clouds in a water reflection undoes that for good
function waterReflection(t, slice, ps) {
	const kind = ps.reflKind || (ps.reflKind = /water_?reflection/i.test(ps.label) ? 'water' : /^(sky_system|clouds\w*)::/.test(ps.label) ? 'sky' : 'other');
	if (t.water) { if (kind === 'other') { t.reflect = null; t.water = false; t.reflectNot = true; } }
	else if (kind === 'water' && !t.reflect && t.desc.size.depthOrArrayLayers === 1) { t.reflect = new Int32Array(6).fill(-1000000); t.water = true; t.reflect[0] = presentCount; }
	else if (kind === 'other' && !t.reflect) t.reflectNot = true;		// an ordinary target: never looked at again
}
function reflectDue(t, slice) {
	if (REFLECT_EVERY <= 1 || slice > 5) return true;
	const last = t.reflect[slice];
	if (last === presentCount) return true;		// this face is being redrawn this frame
	if (presentCount - last < REFLECT_EVERY + (t.reflectLag ? t.reflectLag[slice] : 0)) return false;
	// the first time, the faces are spread over the interval (face k one k-th later), so they are not all redrawn in one frame (~180 draws at once)
	if (last < 0) (t.reflectLag || (t.reflectLag = new Int32Array(6)))[slice] = (slice * REFLECT_EVERY / 6) | 0;
	else if (t.reflectLag) t.reflectLag[slice] = 0;
	t.reflect[slice] = presentCount;
	return true;
}

// Exit report: where the GPU-side memory of the mirror goes (diagnostics for the 4 GB target).
function dumpMemBreakdown() {
	const bufs = [], byFmt = new Map();
	let nBuf = 0, shadow = 0;
	for (const o of objs.values()) {
		if (o.kind === 'buffer') { nBuf++; if (o.shadow) shadow += o.shadow.byteLength; if (o.gpu) bufs.push(o); }
		else if (o.kind === 'texture' && o.bytes) { const k = o.desc.format + (o.desc.dimension === '3d' ? ' 3d' : '') + (o.desc.sampleCount > 1 ? ' msaa' : '') + ((o.desc.usage & GPUTextureUsage.RENDER_ATTACHMENT) ? ' rt' : ''); const e = byFmt.get(k) || [0, 0]; e[0] += o.bytes; e[1]++; byFmt.set(k, e); }
	}
	bufs.sort((a, b) => b.bytes - a.bytes);
	logLine('mem: ' + nBuf + ' buffers (' + bufs.length + ' with GPU storage), constant-buffer shadows ' + (shadow / 1048576 | 0) + ' MB, pipelines ' + pipelineCount + ', uniform ring ' + (ubo.shared.length * FRAME_SLOTS * RING_CHUNK / 1048576 | 0) + ' MB, shader modules ' + shaderModuleCount);
	logLine('mem: biggest buffers: ' + bufs.slice(0, 8).map((o) => (o.bytes / 1048576).toFixed(1) + 'MB bind=' + o.bind.toString(16) + (o.stride ? ' stride=' + o.stride : '')).join(' | '));
	logLine('mem: textures by format: ' + [...byFmt].sort((a, b) => b[1][0] - a[1][0]).slice(0, 10).map(([k, [b, n]]) => k + ' ' + (b / 1048576 | 0) + 'MB x' + n).join(' | '));
}

function createBuffer(id, size, bind, misc, stride) {
	const o = { kind: 'buffer', uid: id, size, bind, misc, stride, gpu: null, shadow: null, version: 0 };
	if (bind & 4) { o.shadow = new Uint8Array(size); }		// constant buffers live in this shadow and are copied to the uniform ring per draw
	let usage = GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
	if (bind & 1) usage |= GPUBufferUsage.VERTEX;
	if (bind & 2) usage |= GPUBufferUsage.INDEX;
	if (bind & (8 | 0x80)) usage |= GPUBufferUsage.STORAGE;
	if (misc & 0x10) usage |= GPUBufferUsage.INDIRECT;		// D3D11_RESOURCE_MISC_DRAWINDIRECT_ARGS
	if ((bind & (1 | 2 | 8 | 0x80)) || (misc & 0x10)) {
		o.bytes = Math.max(4, (size + 3) & ~3);		// the GPU buffer's size (per-draw code reads this: GPUBuffer.size is a native getter, ~5 % of the worker read per draw)
		o.gpu = device.createBuffer({ size: o.bytes, usage });
		bufBytesAlive += o.bytes;
		if (bufBytesAlive > bufBytesPeak) bufBytesPeak = bufBytesAlive;
	}
	objs.set(id, o);
}

// ---- uploads into resources this encoder already uses -------------------------------------------------------------------------------------------------------
// D3D11 lets the game overwrite a buffer or texture that earlier draws of the frame read (a dynamic buffer mapped with DISCARD, UpdateSubresource, a font texture getting
// new glyphs), and those draws must still see the old contents. That used to submit everything recorded so far first (flush): a whole submit each time, which on a
// 4-thread Chromebook costs the GPU process a millisecond or more, and splits the frame. Now the new data goes into a staging buffer (queue.writeBuffer, which lands on
// the queue before this encoder runs) and a copy into the resource is recorded right here, between the draws before (they read the old contents) and after (the new).
// Staging space is taken in order from UPLOAD_STAGE_BYTES and only reused after the next submit (a write into it lands before this encoder runs). The old flush is
// the fallback when the staging buffer is full or the copy cannot be expressed (an offset not a multiple of 4, depth or multisampled textures).
const UPLOAD_STAGE_BYTES = 8 << 20;
const upStage = { buf: null, off: 0 };
let stagedUploads = 0, deferredDestroys = [];
function stageAlloc(n) {		// the 256-aligned offset of n bytes in the staging buffer for this encoder, or -1
	if (!upStage.buf) upStage.buf = device.createBuffer({ size: UPLOAD_STAGE_BYTES, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
	const at = (upStage.off + 255) & ~255;
	if (at + n > UPLOAD_STAGE_BYTES) return -1;
	upStage.off = at + n;
	return at;
}
function stagedBufferUpload(o, offset, size, dataOff) {
	const n4 = (size + 3) & ~3;
	if ((offset & 3) || offset + n4 > o.bytes) return false;
	const at = stageAlloc(n4);
	if (at < 0) return false;
	const n = size & ~3;
	if (n) device.queue.writeBuffer(upStage.buf, at, u8, dataOff, n);
	if (size & 3) { const tail = new Uint8Array(4); tail.set(u8.subarray(dataOff + n, dataOff + size)); device.queue.writeBuffer(upStage.buf, at + n, tail); }
	if (canDefer(o)) { deferredCopies.push({ o, tex: false, src: upStage.buf, at, dst: o.gpu, off: offset, n: n4 }); o.enc = encEpoch; o.pendCopy = true; copiesDeferred++; }
	else { endPass(); getEncoder().copyBufferToBuffer(upStage.buf, at, o.gpu, offset, n4); usedInEncoder.add(o); }
	stagedUploads++;
	return true;
}
// A vertex or index buffer (nothing else: bind groups hold the others) whose whole contents are replaced while this encoder uses it gets a fresh GPU buffer instead
// (renamed, as D3D drivers do for a DISCARD map): the draws recorded so far keep the old one, the upload goes into the new one, and no copy or pass break is needed.
// Old buffers go back to a pool once the GPU is done with them (RENAME_POOL_BYTES at most kept).
const RENAME_POOL_BYTES = 64 << 20;
const renamePool = new Map();		// 'bytes|usage' -> [GPUBuffer]
let renameRetired = [], renamePoolBytes = 0, renamedBuffers = 0;
function renamable(o) { return (o.bind & 3) !== 0 && (o.bind & (4 | 8 | 0x10 | 0x80)) === 0 && (o.misc & 0x10) === 0 && !o.counter; }
function renameBuffer(o) {
	const usage = o.gpu.usage, key = o.bytes + '|' + usage, l = renamePool.get(key), b = l && l.pop();
	if (b) renamePoolBytes -= o.bytes;
	renameRetired.push(key, o.gpu, o.bytes);
	o.gpu = b || device.createBuffer({ size: o.bytes, usage });
	o.enc = 0;		// the new buffer: not used by this encoder yet
	renamedBuffers++;
}
function renameRelease() {		// after a submit: the buffers it retired go back to the pool once the GPU has run it
	const r = renameRetired;
	renameRetired = [];
	device.queue.onSubmittedWorkDone().then(() => {
		for (let i = 0; i < r.length; i += 3) {
			if (renamePoolBytes + r[i + 2] > RENAME_POOL_BYTES) { r[i + 1].destroy(); continue; }
			let l = renamePool.get(r[i]);
			if (!l) renamePool.set(r[i], l = []);
			l.push(r[i + 1]); renamePoolBytes += r[i + 2];
		}
	});
}
// rows of `w` x `h` x `d` texels (bytesPerRow `bpr` apart, images rowsPerImage rows apart) into the staging buffer with 256-byte rows, copied into the texture here
function stagedTextureUpload(o, mip, origin, data, bpr, rowsPerImage, w, h, d) {
	const f = o.desc.format;
	if (isDepth(f) || o.desc.sampleCount > 1 || !o.tex) return false;
	const bi = blockInfo(f), rowBytes = Math.ceil(w / bi.bw) * bi.bytes, rows = Math.ceil(h / bi.bh), abpr = (rowBytes + 255) & ~255, srcImage = (rowsPerImage || rows) * bpr;
	if (rowBytes > bpr) return false;
	const at = stageAlloc(abpr * rows * d);
	if (at < 0) return false;
	if (bpr === abpr && srcImage === rows * abpr && data.length >= abpr * rows * d) device.queue.writeBuffer(upStage.buf, at, data, 0, abpr * rows * d);
	else {
		const tmp = new Uint8Array(abpr * rows * d);
		for (let k = 0; k < d; k++) for (let r = 0; r < rows; r++) { const src = k * srcImage + r * bpr; tmp.set(data.subarray(src, Math.min(data.length, src + rowBytes)), (k * rows + r) * abpr); }
		device.queue.writeBuffer(upStage.buf, at, tmp);
	}
	const src = { buffer: upStage.buf, offset: at, bytesPerRow: abpr, rowsPerImage: rows }, dst = { texture: o.tex, mipLevel: mip, origin }, sz = { width: w, height: h, depthOrArrayLayers: d };
	if (canDefer(o)) { deferredCopies.push({ o, tex: true, src, dst, size: sz }); o.enc = encEpoch; o.pendCopy = true; copiesDeferred++; }
	else { endPass(); getEncoder().copyBufferToTexture(src, dst, sz); usedInEncoder.add(o); }
	stagedUploads++;
	return true;
}

function uploadBuffer(id, offset, size, dataOff, noOverwrite) {
	const o = objs.get(id);
	if (!o) return;
	if (o.boxSeen) boxUploaded(o);		// its box (draw distance) is read again
	if (o.shadow) { o.shadow.set(u8.subarray(dataOff, dataOff + size), offset); o.version++; }
	if (debugDraw && o.gpu && !o.shadow) { if (!o.dbg) o.dbg = new Uint8Array(o.size); o.dbg.set(u8.subarray(dataOff, dataOff + size), offset); }
	if (o.gpu) {
		// a recorded draw still reads the old contents: D3D semantics need them (not after a no-overwrite map: the app promises those bytes are unused): a copy in order
		if (!noOverwrite && usedInEncoder.has(o)) {
			if (offset === 0 && size + 3 >= o.size && renamable(o)) renameBuffer(o);		// all of it replaced: a fresh buffer, written below
			else if (stagedBufferUpload(o, offset, size, dataOff)) return;
			else flush('buffer upload');
		}
		const n = size & ~3;
		if (n) device.queue.writeBuffer(o.gpu, offset, u8, dataOff, n);
		if (size & 3) {		// tail bytes: merge into a padded 4-byte write
			const tail = new Uint8Array(4); tail.set(u8.subarray(dataOff + n, dataOff + size));
			device.queue.writeBuffer(o.gpu, offset + n, tail);
		}
	}
}

function uploadTexture(id, mip, slice, x, y, z, w, h, d, bytesPerRow, rowsPerImage, size, dataOff) {
	const o = objs.get(id);
	if (!o) return;
	// a clear still waiting for this texture must happen before the new contents: recorded now, and the upload is then a copy recorded after it
	const pend = pendingClears.length && pendingHas(id);
	if (pend) flushPendingClears();
	const inUse = pend || usedInEncoder.has(o);
	markColorDirty(o, o.desc.dimension === '3d' ? undefined : slice);
	if (debugDraw || debugPs) { o.uploads = (o.uploads || 0) + 1; o.lastUpload = 'mip' + mip + ' ' + w + 'x' + h + ' bpr' + bytesPerRow + ' first bytes ' + Array.from(u8.subarray(dataOff, dataOff + 8)).join(','); }		// dumpDraw only: a string per upload otherwise
	const three = o.desc.dimension === '3d';
	const origin = { x, y, z: three ? z : slice };
	let data = u8.subarray(dataOff, dataOff + size), bpr = bytesPerRow;
	if (o.a8) {		// expand one byte per texel to (0,0,0,a)
		const out = new Uint8Array(w * h * 4);
		for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) out[(r * w + c) * 4 + 3] = data[r * bytesPerRow + c];
		data = out; bpr = w * 4;
	}
	if (o.r11) {		// R11G11B10_FLOAT kept as rgba16float (no rg11b10ufloat-renderable): each packed texel becomes four halves (the 11/10-bit floats are halves without sign and low mantissa bits)
		const rows = d * (rowsPerImage || h), out = new Uint16Array(w * rows * 4), dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		for (let r = 0; r < rows; r++) for (let c = 0; c < w; c++) {
			const v = dv.getUint32(r * bytesPerRow + c * 4, true), o4 = (r * w + c) * 4;
			out[o4] = (v & 0x7ff) << 4; out[o4 + 1] = ((v >>> 11) & 0x7ff) << 4; out[o4 + 2] = ((v >>> 22) & 0x3ff) << 5; out[o4 + 3] = 0x3c00;
		}
		data = new Uint8Array(out.buffer); bpr = w * 8;
	}
	if (inUse) {		// earlier draws of this encoder read the old contents (see stagedTextureUpload)
		if (stagedTextureUpload(o, mip, origin, data, bpr, rowsPerImage, w, h, d)) return;
		flush('texture upload');
	}
	device.queue.writeTexture({ texture: o.tex, mipLevel: mip, origin }, data,
		{ bytesPerRow: bpr, rowsPerImage }, { width: w, height: h, depthOrArrayLayers: d });
}

function createShader(p, n) {
	const id = u32[p], stage = u32[p + 1], hash = u32[p + 3].toString(16).padStart(8, '0') + u32[p + 2].toString(16).padStart(8, '0');
	const nin = u32[p + 4];
	const sig = [];
	for (let i = 0; i < nin; i++) sig.push({ sem: u32[p + 5 + i * 4], idx: u32[p + 6 + i * 4], reg: u32[p + 7 + i * 4], mask: u32[p + 8 + i * 4] });
	const o = { kind: 'shader', stage, hash, sig, program: undefined };
	objs.set(id, o);
	shadersByHash.set(hash, o);
	if (isNode) shadersReady++;		// Node reads the sources from disk when needed
	prefetchShader(o);
}

function createLayout(p) {
	// id, n, then n x [semHash, semIndex, dxgi, slot, offset, slotClass, stepRate]
	const id = u32[p], n = u32[p + 1], els = [];
	for (let i = 0; i < n; i++) {
		const q = p + 2 + i * 7;
		els.push({ sem: u32[q], idx: u32[q + 1], fmt: u32[q + 2], slot: u32[q + 3], offset: u32[q + 4], cls: u32[q + 5], rate: u32[q + 6] });
	}
	objs.set(id, { kind: 'layout', els, slots: layoutSlots(els) });
}
// each vertex buffer slot once, with the step class of its first element (per-draw loops walk this instead of de-duplicating els every time)
function layoutSlots(els) {
	const slots = [];
	let seen = 0;
	for (const e of els) { if (e.slot < 32 && !((seen >>> e.slot) & 1)) { seen |= 1 << e.slot; slots.push({ slot: e.slot, cls: e.cls }); } }
	return slots;
}

function createState(p, n) {
	const id = u32[p], kind = u32[p + 1], words = Array.from(u32.subarray(p + 2, p + n));
	const o = { kind: 'state', skind: kind, words };
	if (kind === 3) o.sampler = makeSampler(words);
	objs.set(id, o);
}

function createUav(p) {
	// id, resKind(0 tex, 1 buf), resId, dxgi, viewDim, a, b, c, flags
	objs.set(u32[p], { kind: 'uav', res: u32[p + 2], isBuf: u32[p + 1] === 1, fmt: u32[p + 3], vdim: u32[p + 4], a: u32[p + 5], b: u32[p + 6], c: u32[p + 7], flags: u32[p + 8], views: new Map() });
}

function createSrv(p) {
	// id, resKind(0 tex, 1 buf), resId, dxgi, viewDim, a, b, c, d
	objs.set(u32[p], { kind: 'srv', res: u32[p + 2], isBuf: u32[p + 1] === 1, fmt: u32[p + 3], vdim: u32[p + 4], a: u32[p + 5], b: u32[p + 6], c: u32[p + 7], d: u32[p + 8], views: new Map() });
}

// ---- pipeline state -----------------------------------------------------------------------------------------------------------
const S = {
	shader: [0, 0, 0], layout: 0, topo: 4,
	vb: Array.from({ length: 16 }, () => ({ buf: 0, stride: 0, offset: 0 })),
	ib: { buf: 0, fmt: 0, offset: 0 },
	cb: [0, 1, 2].map(() => Array.from({ length: 16 }, () => ({ buf: 0, first: 0, num: 0 }))),
	srv: [0, 1, 2].map(() => new Array(128).fill(0)),
	uav: [0, 1, 2].map(() => new Array(8).fill(0)),
	smp: [0, 1, 2].map(() => new Array(16).fill(0)),
	rt: Array.from({ length: 8 }, () => ({ tex: 0, mip: 0, slice: 0, fmt: 0 })), ds: { tex: 0, mip: 0, slice: 0, fmt: 0, flags: 0 },
	blend: { id: 0, factor: [1, 1, 1, 1], mask: 0xffffffff }, dss: { id: 0, ref: 0 }, rs: 0,
	viewports: [], scissors: [],
};
let applied = {};
let pdirty = true, lastPl = null, lastPlPass = null;		// pipeline memo: any command that changes the pipeline key sets pdirty

function resetState() {
	pdirty = true;
	S.shader = [0, 0, 0]; S.layout = 0; S.topo = 4;
	S.vb.forEach((v) => { v.buf = 0; v.stride = 0; v.offset = 0; });
	S.ib = { buf: 0, fmt: 0, offset: 0 };
	for (let s = 0; s < 3; s++) { S.cb[s].forEach((c) => { c.buf = 0; c.first = 0; c.num = 0; }); S.srv[s].fill(0); S.smp[s].fill(0); }
	S.rt.forEach((r) => { r.tex = 0; r.mip = 0; r.slice = 0; r.fmt = 0; });
	S.ds = { tex: 0, mip: 0, slice: 0, fmt: 0, flags: 0 };
	rtKey = null; bindEpoch[0]++; bindEpoch[1]++; bindEpoch[2]++; gEpoch++;
	S.blend = { id: 0, factor: [1, 1, 1, 1], mask: 0xffffffff }; S.dss = { id: 0, ref: 0 }; S.rs = 0;
	S.viewports = []; S.scissors = [];
	endPass();
}

function viewFormat(dxgi, tex) { return dxgi ? mapFormat(dxgi, 0).format : tex.format; }

// A 3D texture is rendered into one depth slice at a time: a 3d view of the mip and the attachment's depthSlice (WebGPU has no 2d view of a 3D texture; the view this made
// before, a 2d one or a 3d one at an array layer, was rejected: clears and draws into 3D targets were lost with a validation error)
function targetView(t, dxgi, mip, slice, dimension) {
	const fmt = viewFormat(dxgi, t), is3d = t.desc.dimension === '3d';
	const key = fmt + '|' + mip + '|' + (is3d ? '3d' : slice);
	let v = t.views.get(key);
	if (!v) {
		v = is3d ? t.tex.createView({ format: fmt, baseMipLevel: mip, mipLevelCount: 1, dimension: '3d' })
			: t.tex.createView({ format: fmt, baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: slice, arrayLayerCount: 1, dimension: '2d' });
		t.views.set(key, v);
	}
	return { view: v, format: fmt, depthSlice: is3d ? slice : undefined };
}

// ---- uniform ring: constant buffers are copied per draw (D3D11 semantics) and bound with dynamic offsets ----------------------------------
const RING_CHUNK = 8 << 20, UBO_WINDOW = 65536;
// Frames in flight: the uniform ring has one slot per frame; before a slot is reused the GPU must be done with the frame that last used it. Chrome reports completion through the
// wire from the GPU process, so with 3 slots (2 frames in flight) the round trip, not the work, capped the frame rate.
const FRAME_SLOTS = (isNode ? +process.env.WGPU_SLOTS : +(new URLSearchParams(self.location.search).get('slots') || 0)) || 3;
// Chunk k of every frame slot is a RING_CHUNK region of one GPU buffer (`shared[k]`, FRAME_SLOTS regions): slot s's chunk object has the buffer, its id and base s * RING_CHUNK, and keeps
// its own mirror and dirty range. Bind groups name the buffer (and the id is part of their cache key), so one bind group serves every frame slot; with a buffer per slot and chunk each
// set of resources needed a bind group per frame in flight (three times the creations and the cache entries). Dynamic offsets are base + offset.
const ubo = { slots: Array.from({ length: FRAME_SLOTS }, () => []), shared: [], slot: 0, chunk: 0, off: 0, pending: Array(FRAME_SLOTS).fill(null), nextId: 1 };
// returns the offset of `size` bytes in the current ring chunk (from the chunk's base), which it leaves in allocChunk (no result object: this runs for every pack)
let allocChunk = null;
function uniformAlloc(size) {
	size = (size + 255) & ~255;
	let list = ubo.slots[ubo.slot];
	let c = list[ubo.chunk];
	if (!c || ubo.off + size + UBO_WINDOW > RING_CHUNK) {
		if (c) { ubo.chunk++; ubo.off = 0; c = list[ubo.chunk]; }
		if (!c) {
			const sh = ubo.shared[ubo.chunk] || (ubo.shared[ubo.chunk] = { buf: device.createBuffer({ size: RING_CHUNK * FRAME_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), id: ubo.nextId++ });
			c = { buf: sh.buf, id: sh.id, base: ubo.slot * RING_CHUNK };
			list[ubo.chunk] = c;
		}
	}
	const off = ubo.off; ubo.off += size;
	allocChunk = c;
	return off;
}
// The per-draw constant copies go into a JS mirror of the ring chunk and reach the GPU with one writeBuffer per chunk at the next flush (a queue.writeBuffer per draw was ~10 %
// of the worker's time at 1,700 draws per frame). Commands only execute at submit, which flush() does after these writes, so the order is the same.
const dirtyChunks = new Set();
// marks [off, off + n) of the chunk's mirror as written and returns the mirror (grown if needed); the caller writes the bytes into it directly
function stageReserve(chunk, off, n) {
	const end = off + n;
	if (!chunk.stage || chunk.stage.length < end) {
		const grown = new Uint8Array(Math.min(RING_CHUNK, Math.max(end, chunk.stage ? chunk.stage.length * 2 : 262144)));
		if (chunk.stage) grown.set(chunk.stage.subarray(0, chunk.top));
		chunk.stage = grown;
		chunk.top = chunk.top || 0;
	}
	if (end > (chunk.top || 0)) chunk.top = end;
	if (chunk.lo === undefined || off < chunk.lo) chunk.lo = off;
	if (end > (chunk.hi || 0)) chunk.hi = end;
	dirtyChunks.add(chunk);
	return chunk.stage;
}
function flushUniforms() {
	for (const c of dirtyChunks) {
		const hi = Math.min(c.stage.length, (c.hi + 3) & ~3);
		device.queue.writeBuffer(c.buf, c.base + c.lo, c.stage, c.lo, hi - c.lo); ringBytes += hi - c.lo;
		c.lo = undefined; c.hi = 0;
	}
	dirtyChunks.clear();
}
const curObjs = [], curVers = [], curFirsts = [];		// scratch: identity of the constant buffers a program's pack reads right now
function packCopy(prog, stage) {
	const pack = prog.pack;
	if (!pack) return null;
	if (pack.size > UBO_WINDOW) { logOnce('packbig' + prog.label, prog.label + ': constant buffers total ' + pack.size + ' bytes (> 64 KB uniform binding limit)'); return null; }
	const members = pack.members, n = members.length, cbs = S.cb[stage];
	for (let i = 0; i < n; i++) {
		const c = cbs[members[i].binding], o = c.buf ? objs.get(c.buf) : null;
		curObjs[i] = o; curVers[i] = o ? o.version : -1; curFirsts[i] = c.first;
	}
	// the same constants already packed this frame (by this program and stage): reuse that ring allocation. No string keys: the last few packs are compared member by member.
	const ents = prog.packEnts || (prog.packEnts = [[], [], []]), list = ents[stage];
	for (let k = 0; k < list.length; k++) {
		const en = list[k];
		if (en.frame !== ubo.frame) continue;
		let same = true;
		for (let i = 0; i < n; i++) if (en.objs[i] !== curObjs[i] || en.vers[i] !== curVers[i] || en.firsts[i] !== curFirsts[i]) { same = false; break; }
		if (same) return en.alloc;
	}
	// The engine uploads the same constants again all the time (a material's parameters, set anew for the next draw of the same material): when the bytes equal the last pack
	// of this program and stage in this frame, that allocation is used again. The bind group then keeps its dynamic offset and is not set again, and every set made Chrome's
	// GPU process walk all the textures of the group once more.
	const last = list.length ? list[list.length - 1] : null;
	if (last && last.frame === ubo.frame && samePack(members, n, last.alloc)) {
		for (let i = 0; i < n; i++) { last.objs[i] = curObjs[i]; last.vers[i] = curVers[i]; last.firsts[i] = curFirsts[i]; }
		packsReused++;
		return last.alloc;
	}
	// members are contiguous (packUniforms): each is copied straight into the ring mirror, and only the part a constant buffer does not cover is zeroed (D3D reads zeros there)
	const aOff = uniformAlloc(pack.size), aChunk = allocChunk;
	const dst = stageReserve(aChunk, aOff, pack.size);
	for (let i = 0; i < n; i++) {
		const m = members[i], o = curObjs[i], at = aOff + m.offset;
		let len = 0;
		if (o && o.shadow) {
			const from = curFirsts[i] * 16;
			len = Math.min(m.size, o.size - from);
			if (len > 0) {
				// the whole shadow, or one cached view of it: a new subarray per member and draw was garbage
				let src;
				if (from === 0 && len === o.shadow.length) src = o.shadow;
				else if (o.svFrom === from && o.svLen === len) src = o.sv;
				else { src = o.sv = o.shadow.subarray(from, from + len); o.svFrom = from; o.svLen = len; }
				dst.set(src, at);
			} else len = 0;
		}
		if (len < m.size) dst.fill(0, at + len, at + m.size);
	}
	// the oldest entry of this (program, stage) is recycled in place: a pack per draw made ~6 short-lived objects each, which the garbage collector showed up for (~14 % of the worker)
	let en;
	if (list.length >= 6) {
		en = list.shift();
		for (let i = 0; i < n; i++) { en.objs[i] = curObjs[i]; en.vers[i] = curVers[i]; en.firsts[i] = curFirsts[i]; }
		en.alloc.chunk = aChunk; en.alloc.off = aOff; en.alloc.frame = ubo.frame;
	} else en = { frame: 0, objs: curObjs.slice(0, n), vers: curVers.slice(0, n), firsts: curFirsts.slice(0, n), alloc: { chunk: aChunk, off: aOff, frame: ubo.frame } };
	en.frame = ubo.frame;
	list.push(en);
	return en.alloc;
}
ubo.frame = 0;
let packsReused = 0;
// would packing the bound constant buffers now (curObjs/curFirsts, see packCopy) give the same bytes as the pack at `alloc`? Compared 32 bits at a time (offsets are multiples of 16).
function samePack(members, n, alloc) {
	const st = alloc.chunk.stage;
	if (!st) return false;
	const d32 = alloc.chunk.stage32 && alloc.chunk.stage32.buffer === st.buffer ? alloc.chunk.stage32 : (alloc.chunk.stage32 = new Int32Array(st.buffer, st.byteOffset, st.length >> 2));
	for (let i = 0; i < n; i++) {
		const m = members[i], o = curObjs[i], at = (alloc.off + m.offset) >> 2;
		let len = 0;
		if (o && o.shadow) {
			const from = curFirsts[i] * 16;
			len = Math.min(m.size, o.size - from);
			if (len > 0) {
				const s32 = o.shadow32 || (o.shadow32 = new Int32Array(o.shadow.buffer, o.shadow.byteOffset, o.shadow.length >> 2));
				const w = len >> 2, f = from >> 2;
				for (let k = 0; k < w; k++) if (s32[f + k] !== d32[at + k]) return false;
				for (let k = w << 2; k < len; k++) if (o.shadow[from + k] !== st[alloc.off + m.offset + k]) return false;
			} else len = 0;
		}
		let k = alloc.off + m.offset + len;		// the zeroed rest
		const e = alloc.off + m.offset + m.size;
		for (; (k & 3) && k < e; k++) if (st[k] !== 0) return false;
		for (; k + 4 <= e; k += 4) if (d32[k >> 2] !== 0) return false;
		for (; k < e; k++) if (st[k] !== 0) return false;
	}
	return true;
}

// ---- dummies for unbound slots ------------------------------------------------------------------------------------------------------------
const dummy = { tex: new Map(), smp: null, cmp: null, buf: null, uni: null };
function dummyTexture(b) {
	const key = b.dim + '|' + b.sample + '|' + (b.ms ? 'ms' : '');
	let v = dummy.tex.get(key);
	if (v) return v;
	const format = b.sample === 'uint' ? 'rgba8uint' : b.sample === 'sint' ? 'rgba8sint' : b.sample === 'depth' ? 'depth32float' : 'rgba8unorm';
	const layers = (b.dim === 'cube' || b.dim === 'cube-array') ? 6 * (b.dim === 'cube-array' ? 1 : 1) : 1;
	const tex = device.createTexture({ size: { width: 1, height: b.dim === '1d' ? 1 : 1, depthOrArrayLayers: b.dim === '3d' ? 1 : layers },
		dimension: b.dim === '3d' ? '3d' : b.dim === '1d' ? '1d' : '2d', format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, sampleCount: b.ms ? 4 : 1 });
	v = tex.createView({ dimension: b.dim });
	dummy.tex.set(key, v);
	return v;
}
function dummySampler(cmp) {
	if (cmp) return dummy.cmp || (dummy.cmp = device.createSampler({ compare: 'always' }));
	return dummy.smp || (dummy.smp = device.createSampler({}));
}
// one per binding: writable storage buffers bound twice in a dispatch are an aliasing error
function dummyBuffer(binding) {
	if (!dummy.bufs) dummy.bufs = new Map();
	let b = dummy.bufs.get(binding);
	if (!b) { b = device.createBuffer({ size: 65536, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); dummy.bufs.set(binding, b); }
	return b;
}

// A depth texture that a shader only loads from (textureLoad) as a float texture is bound as it is: its depth aspect, which WebGPU takes for an 'unfilterable-float'
// binding (layoutEntry declares load-only float bindings so), with no copy pass (depthProxy: a render pass each time the depth changed; on a throttled N100 a pass costs
// Chrome's GPU process ~0.5 ms, a dozen draws' worth). While the current pass writes that depth (a writable attachment cannot be read in its own pass) it is not bound
// at all: D3D unbinds an SRV of the depth buffer being written, so the shader reads zeros (a dummy texture). Such bind groups get keys of their own (stageBG: -id) and
// stay off the fast path (sawProxy), which would reuse them in a pass that writes the depth. ?depthdirect=0 turns it off (diagnostics).
const DEPTH_DIRECT = isNode ? process.env.WGPU_DEPTH_DIRECT !== '0' : new URLSearchParams(self.location.search).get('depthdirect') !== '0';
// 0: not this case (a copy as before), 1: bound as it is, 2: not bound (the pass writes it)
function depthDirectMode(srv, b) {
	if (!DEPTH_DIRECT || b.sample !== 'float' || !b.loadOnly || srv.fmt === 47 || srv.fmt === 22) return 0;
	return S.ds.tex === srv.res && !(S.ds.flags & 1) ? 2 : 1;
}
let srvDirect = false, depthDirectViews = 0;		// srvDirect: the last srvView gave a depth texture as it is
function srvView(srv, b) {
	// GPUTextureView of an SRV in the dimension the shader declares
	let t = objs.get(srv.res);
	srvDirect = false;
	if (!t || t.kind !== 'texture') return null;
	let proxied = false;
	if (isDepth(t.format) && b.sample !== 'depth') {
		const dd = depthDirectMode(srv, b);
		if (dd === 2) { sawProxy = true; return null; }		// this pass writes it: not bound, as D3D does (a dummy reads zeros)
		if (dd === 1) { srvDirect = true; sawProxy = true; depthDirectViews++; }		// the depth aspect itself (see above)
		else { t = depthProxy(t, b.sample === 'uint' ? 'stencil' : 'depth', noF32Filter && b.loadOnly); proxied = true; sawProxy = true; }
	} else if (!isDepth(t.format) && b.sample === 'depth') {
		t = floatToDepthProxy(t);
		proxied = true; sawProxy = true;
	}
	if (noF32Filter && b.sample === 'float' && !b.loadOnly && HALF_OF[t.format]) {		// no float32-filterable: a filtering binding cannot take a 32-bit float texture
		const h = halfProxy(t);
		if (h !== t) { t = h; proxied = true; sawProxy = true; }
	}
	const key = b.dim + (proxied ? ':p' : '');
	let v = srv.views.get(key);
	if (v && !proxied) return v;
	if (v && proxied && !t.dirty && v.__proxyTex === t.tex) return v;
	const total = t.desc.mipLevelCount;
	const mipCount = srv.b === 0xffffffff || srv.b === 0 ? total - srv.a : srv.b;
	const layers = t.desc.size.depthOrArrayLayers;
	if ((b.dim === 'cube' && layers - srv.c < 6) || (b.dim === 'cube-array' && layers - srv.c < 6)) {
		logOnce('cubeview' + srv.res, 'cube SRV over a texture with ' + layers + ' layer(s): bound as an empty cube');
		return null;		// the caller binds a dummy cube: creating the view would invalidate the whole command buffer
	}
	const desc = { dimension: b.dim, baseMipLevel: Math.min(srv.a, total - 1), mipLevelCount: Math.max(1, Math.min(mipCount, total - srv.a)) };
	if (b.dim === '2d-array' || b.dim === 'cube' || b.dim === 'cube-array' || b.dim === '2d') {
		const first = srv.c, cnt = (b.dim === 'cube') ? 6 : (b.dim === '2d' ? 1 : (srv.d || layers - first));
		desc.baseArrayLayer = Math.min(first, layers - 1); desc.arrayLayerCount = Math.max(1, Math.min(cnt, layers - first));
	}
	const f = t.format;
	if (srv.fmt && !isDepth(f)) { const mf = mapFormat(srv.fmt, 0).format; if (mf !== f && (f.includes('srgb') !== mf.includes('srgb'))) desc.format = mf; }
	if (isDepth(f) && !proxied) desc.aspect = (srv.fmt === 47 || srv.fmt === 22) ? 'stencil-only' : 'depth-only';
	try { v = t.tex.createView(desc); } catch (e) { logOnce('srvview' + srv.res, 'SRV view failed: ' + e.message); return null; }
	v.__proxyTex = t.tex;
	srv.views.set(key, v);
	return v;
}

// ---- depth textures sampled as float ----------------------------------------------------------------------------------------------
// D3D11 lets a shader read a depth texture as a float texture (Load / point Sample); WebGPU only binds it as `depth`
// (comparison or textureLoad of texture_depth_2d) and the translated code uses texture_2d<f32>. A proxy r32float (depth) or
// r8uint (stencil) texture is refreshed by a render pass whenever the depth texture was drawn into since the last read.
let proxyPipelines = {};
function proxyPipeline(kind, format) {
	if (proxyPipelines[kind + format]) return proxyPipelines[kind + format];
	const code = kind === 'depth'
		? `@group(0) @binding(0) var src: texture_depth_2d;
		   @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
		   @fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f { return vec4f(textureLoad(src, vec2i(pos.xy), 0), 0, 0, 1); }`
		: `@group(0) @binding(0) var src: texture_2d<u32>;
		   @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
		   @fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4<u32> { return textureLoad(src, vec2i(pos.xy), 0); }`;
	const module = device.createShaderModule({ code });
	return (proxyPipelines[kind + format] = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' },
		fragment: { module, entryPoint: 'fs', targets: [{ format }] } }));
}
const depthProxyFormat = () => (noF32Filter ? 'r16float' : 'r32float');		// a depth texture read where the shader filters: filterable without float32-filterable (16-bit: ~0.05 % relative precision)
// A layout for the helper passes below that read any float texture with textureLoad: 'unfilterable-float' takes 32-bit float textures on every device ('auto'
// would make it a filtering binding, invalid for them without float32-filterable).
function loadLayout(viewDimension) {
	const key = 'load|' + viewDimension;
	return layoutCache.get(key) || layoutCache.set(key, device.createPipelineLayout({ bindGroupLayouts: [device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension } }] })] })).get(key);
}

// ---- 32-bit float textures read where the shader filters, on a device without float32-filterable ---------------------------------------------------------------
// WebGPU lets a shader filter r32float / rg32float / rgba32float textures only with the optional float32-filterable feature. The translated shaders declare every
// float texture filterable, so without it any bind group holding such a texture is invalid, and its draws (or the whole submit) are dropped: exposure, lighting and
// fog read depth and luminance this way, and the picture came out overexposed, white with black specks. Such a texture is bound through a 16-bit float copy instead,
// refreshed like the depth proxies whenever it was written since it was last read (markColorDirty).
const HALF_OF = { r32float: 'r16float', rg32float: 'rg16float', rgba32float: 'rgba16float' };
const halfPipelines = {};
function halfPipeline(format) {
	if (halfPipelines[format]) return halfPipelines[format];
	const module = device.createShaderModule({ code: `@group(0) @binding(0) var src: texture_2d<f32>;
		@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
		@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f { return textureLoad(src, vec2i(pos.xy), 0); }` });
	return (halfPipelines[format] = device.createRenderPipeline({ layout: loadLayout('2d'), vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } }));
}
function halfProxy(t) {
	let px = t.proxy_half;
	if (!px) {
		const d = t.desc;
		if (d.dimension !== '2d' || (d.sampleCount || 1) > 1) { logOnce('half' + d.dimension, 'no 16-bit copy for a ' + d.dimension + ' ' + t.format + ' texture: bound as it is'); return t; }
		const format = HALF_OF[t.format];
		const tex = device.createTexture({ size: d.size, mipLevelCount: d.mipLevelCount, sampleCount: 1, dimension: '2d', format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
		px = t.proxy_half = { kind: 'texture', tex, desc: { size: d.size, mipLevelCount: d.mipLevelCount, dimension: '2d', sampleCount: 1 }, format, views: new Map(), dirty: true };
		logOnce('halfproxy' + t.format, 'no float32-filterable: ' + t.format + ' textures are read through ' + format + ' copies');
	}
	if (px.dirty) {
		endPass();
		const pl = halfPipeline(px.format), enc = getEncoder();
		if (!px.passes) {		// made once (see floatToDepthProxy)
			px.passes = [];
			for (let mip = 0; mip < t.desc.mipLevelCount; mip++) for (let layer = 0; layer < t.desc.size.depthOrArrayLayers; layer++) {
				const src = t.tex.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
				const dst = px.tex.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
				px.passes.push({ dst, bg: device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: src }] }) });
			}
		}
		for (const r of px.passes) {
			passProxyN++; const p = enc.beginRenderPass({ colorAttachments: [{ view: r.dst, loadOp: 'clear', storeOp: 'store' }] });
			p.setPipeline(pl);
			p.setBindGroup(0, r.bg);
			p.draw(3);
			p.end();
		}
		usedInEncoder.add(t);
		px.dirty = false;
	}
	return px;
}

let f2dPipeline = null;
function floatToDepthProxy(t) {
	// D3D11 SampleCmp works on any float texture; WebGPU comparison sampling needs a depth texture: keep a depth32float copy
	let px = t.proxy_fdepth;
	if (!px) {
		const d = t.desc;
		const tex = device.createTexture({ size: d.size, mipLevelCount: d.mipLevelCount, sampleCount: 1, dimension: '2d', format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
		px = t.proxy_fdepth = { kind: 'texture', tex, desc: { size: d.size, mipLevelCount: d.mipLevelCount, dimension: '2d', sampleCount: 1 }, format: 'depth32float', views: new Map(), dirty: true };
	}
	if (px.dirty) {
		endPass();
		if (!f2dPipeline) {
			const module = device.createShaderModule({ code: `@group(0) @binding(0) var src: texture_2d<f32>;
				@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
				@fragment fn fs(@builtin(position) pos: vec4f) -> @builtin(frag_depth) f32 { return textureLoad(src, vec2i(pos.xy), 0).x; }` });
			f2dPipeline = device.createRenderPipeline({ layout: loadLayout('2d'), vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [] },
				depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' } });
		}
		const enc = getEncoder(), layers = t.desc.size.depthOrArrayLayers;
		if (!px.passes) {		// the views and bind groups of a refresh never change: made once (three new objects per mip and layer per refresh before)
			px.passes = [];
			for (let mip = 0; mip < t.desc.mipLevelCount; mip++) for (let layer = 0; layer < layers; layer++) {
				const src = t.tex.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
				const dst = px.tex.createView({ baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
				px.passes.push({ dst, bg: device.createBindGroup({ layout: f2dPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: src }] }) });
			}
		}
		for (const r of px.passes) {
			passProxyN++; const p = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: r.dst, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
			p.setPipeline(f2dPipeline);
			p.setBindGroup(0, r.bg);
			p.draw(3);
			p.end();
		}
		usedInEncoder.add(t);
		px.dirty = false;
	}
	return px;
}
// A colour texture was (or is about to be) written: its proxies are stale, and its mipmaps (generateMips) unless regenerated. `layer`: the array layer written (render
// targets, clears, uploads), so a cube map whose faces are redrawn one at a time regenerates only those faces' mips; without it every layer counts as written.
function markColorDirty(t, layer) {
	if (!t) return;
	if (t.proxy_fdepth) t.proxy_fdepth.dirty = true;
	if (t.proxy_half) t.proxy_half.dirty = true;
	if (layer === undefined || !t.lgen || layer >= t.lgen.length) t.wgen = (t.wgen || 0) + 1;
	else t.lgen[layer]++;
}

function depthProxy(t, kind, full) {
	// returns the proxy texture object of depth texture `t`, refreshed if the depth texture changed since the last refresh. full: a binding that only loads (r32float always)
	const format = kind === 'depth' ? (full ? 'r32float' : depthProxyFormat()) : 'r8uint';
	const key = 'proxy_' + kind + (format === 'r16float' ? '16' : '');
	let px = t[key];
	if (!px) {
		const d = t.desc;
		const tex = device.createTexture({ size: d.size, mipLevelCount: d.mipLevelCount, sampleCount: 1, dimension: '2d',
			format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
		px = t[key] = { kind: 'texture', tex, desc: { size: d.size, mipLevelCount: d.mipLevelCount, dimension: '2d', sampleCount: 1 }, format: tex.format, views: new Map(), dirty: true };
	}
	if (px.dirty) {
		endPass();
		const pl = proxyPipeline(kind, format), enc = getEncoder();
		const layers = t.desc.size.depthOrArrayLayers;
		if (!px.passes) {		// made once per proxy (see floatToDepthProxy)
			px.passes = [];
			for (let mip = 0; mip < t.desc.mipLevelCount; mip++) for (let layer = 0; layer < layers; layer++) {
				const src = t.tex.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1, aspect: kind === 'depth' ? 'depth-only' : 'stencil-only' });
				const dst = px.tex.createView({ baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
				px.passes.push({ dst, bg: device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: src }] }) });
			}
		}
		for (const r of px.passes) {
			passProxyN++; const p = enc.beginRenderPass({ colorAttachments: [{ view: r.dst, loadOp: 'clear', storeOp: 'store' }] });
			p.setPipeline(pl);
			p.setBindGroup(0, r.bg);
			p.draw(3);
			p.end();
		}
		usedInEncoder.add(t);
		px.dirty = false;
		t['clean_' + kind] = true;
	}
	return px;
}

function markDepthDirty(t) { t.proxy_depth && (t.proxy_depth.dirty = true); t.proxy_depth16 && (t.proxy_depth16.dirty = true); t.proxy_stencil && (t.proxy_stencil.dirty = true); }

// ---- pipelines --------------------------------------------------------------------------------------------------------------------
const layoutCache = new Map();
// Pipelines are found by a tuple of small integers (shader hashes and pass formats interned) hashed to a number: building and hashing a string key took ~15 % of the worker,
// since the lookup runs whenever any pipeline state changed (most draws). Buckets hold [tuple, pipeline] pairs; null pipelines (creation failed) are cached too.
const pipelineBuckets = new Map(), pipeTuple = new Int32Array(64), internedHashes = new Map(), internedTails = new Map();
let pipelineCount = 0;
function internHash(o) {
	if (o.hid === undefined) { let h = internedHashes.get(o.hash); if (h === undefined) { h = internedHashes.size + 1; internedHashes.set(o.hash, h); } o.hid = h; }
	return o.hid;
}
function bindGroupLayoutFor(prog, stage, group) {
	const key = prog.label + '|' + stage;
	let bgl = layoutCache.get(key);
	if (!bgl) {
		const entries = prog.info.bindings.filter((b) => b.group === group).map((b) => layoutEntry(b, stage));
		bgl = device.createBindGroupLayout({ entries });
		layoutCache.set(key, bgl);
	}
	return bgl;
}
const emptyBgl = () => emptyBgl.v || (emptyBgl.v = device.createBindGroupLayout({ entries: [] }));

function depthStencilFor(dss, dsFormat, roDepth, roStencil) {
	if (!dsFormat) return undefined;
	const w = dss ? dss.words : null;
	const stencilOn = dsFormat.includes('stencil');
	const d = { format: dsFormat, depthWriteEnabled: false, depthCompare: 'always' };
	if (w) {
		if (w[0]) { d.depthWriteEnabled = w[1] === 1; d.depthCompare = CMP[w[2]] || 'less'; }
		if (stencilOn && w[3]) {
			d.stencilReadMask = w[4] & 0xff; d.stencilWriteMask = (w[4] >> 8) & 0xff;
			d.stencilFront = { failOp: STENCIL_OP[w[5]], depthFailOp: STENCIL_OP[w[6]], passOp: STENCIL_OP[w[7]], compare: CMP[w[8]] };
			d.stencilBack = { failOp: STENCIL_OP[w[9]], depthFailOp: STENCIL_OP[w[10]], passOp: STENCIL_OP[w[11]], compare: CMP[w[12]] };
		}
	}
	if (roDepth) d.depthWriteEnabled = false;
	if (roStencil && d.stencilFront) { d.stencilWriteMask = 0; }
	return d;
}

// does a D3D blend state blend with the blend constant (D3D11_BLEND_BLEND_FACTOR 14, INV_BLEND_FACTOR 15) on any target?
function blendUsesConst(state) {
	const w = state.words;
	if (!w) return true;
	for (let rt = 0; rt < (w[1] ? 8 : 1); rt++) {
		const q = 2 + rt * 8;
		if (w[q] && (w[q + 1] === 14 || w[q + 1] === 15 || w[q + 2] === 14 || w[q + 2] === 15 || w[q + 4] === 14 || w[q + 4] === 15 || w[q + 5] === 14 || w[q + 5] === 15)) return true;
	}
	return false;
}
function blendFor(state, rtIndex) {
	if (!state) return { write: 0xf };
	const w = state.words;		// D3D11_BLEND_DESC: AlphaToCoverage, Independent, RT[8] x 8 words {enable, src, dst, op, srcA, dstA, opA, mask}
	const rt = w[1] ? rtIndex : 0, q = 2 + rt * 8;
	const out = { write: w[q + 7] & 0xf };
	if (w[q]) {
		out.blend = {
			color: { srcFactor: BLEND_FACTOR[w[q + 1]] || 'one', dstFactor: BLEND_FACTOR[w[q + 2]] || 'zero', operation: BLEND_OP[w[q + 3]] || 'add' },
			alpha: { srcFactor: BLEND_FACTOR[w[q + 4]] || 'one', dstFactor: BLEND_FACTOR[w[q + 5]] || 'zero', operation: BLEND_OP[w[q + 6]] || 'add' },
		};
	}
	return out;
}

function vertexFormatBytes(f) {
	if (f.includes('10-10-10-2')) return 4;
	const m = /(\d+)(?:x(\d))?$/.exec(f);
	return m ? (m[1] / 8) * (+m[2] || 1) : 4;
}
const vbAvail = new Array(16).fill(0);		// bytes from the bound offset to the end of the buffer, per vertex slot, for the current draw

function vertexBuffersFor(vs, layout, strides) {
	// D3D input layout elements matched to the vertex shader's input signature by semantic
	const bySlot = new Map(), attrs = [];
	const sigByKey = new Map();
	for (const s of vs.sig) sigByKey.set(s.sem + ':' + s.idx, s);
	for (const e of layout.els) {
		const s = sigByKey.get(e.sem + ':' + e.idx);
		if (!s) continue;		// element the shader does not read
		const f = vertexFormat(e.fmt);
		if (!f) { logOnce('vf' + e.fmt, 'unsupported vertex format DXGI ' + e.fmt); continue; }
		let list = bySlot.get(e.slot);
		if (!list) { list = { attributes: [], step: e.cls === 1 ? 'instance' : 'vertex' }; bySlot.set(e.slot, list); }
		list.attributes.push({ shaderLocation: s.reg, offset: e.offset, format: f[0] });
	}
	const buffers = [];
	for (const [slot, l] of bySlot) {
		while (buffers.length < slot) buffers.push(null);
		buffers[slot] = { arrayStride: strides[slot], stepMode: l.step, attributes: l.attributes };
	}
	return buffers;
}

// WebGPU requires the interpolation of a varying to match between the stages; HLSL only declares `nointerpolation` on the
// pixel shader input. The vertex shader gets a variant with those outputs flat (and, with `remap`, its outputs moved: interStageRemap).
function vertexModule(vsProg, flat, remap) {
	if (!flat.length && !remap) return vsProg.module;
	const key = flat.join(',') + (remap ? '|' + remap.key : '');
	let m = vsProg.variants.get(key);
	if (!m) {
		let text = vsProg.text.replace(/@location\((\d+)u\)(\s*\n\s*\w+\s*:)/g, (all, loc, rest) => flat.includes(+loc) ? '@location(' + loc + 'u) @interpolate(flat)' + rest : all);
		if (remap) { text = remapLocations(text, 'vs', remap.map); remapVariants[0]++; }
		const tm0 = performance.now();
		m = device.createShaderModule({ code: text, label: vsProg.label + ' [flat ' + key + ']' });
		fr.mod += performance.now() - tm0;
		vsProg.variants.set(key, m);
	}
	return m;
}
// WebGPU requires every inter-stage location to be below maxInterStageShaderVariables, and Dawn's Vulkan backend charges the clip distances against it (a Chromebook's
// Intel GPU: 16, so locations up to 14 next to clip distances). The translation keeps the D3D register as the location, so vertex shaders that write o15 next to
// SV_ClipDistance (cables, particles, clouds, the _DOF variants, vehicle parts) failed there with "location (15) that is too large", although they have only a few
// outputs. For such a pair, the outputs at or above the limit move to free low locations, in the vertex shader's output struct and in the pixel shader's inputs.
// null: nothing to move (always on GPUs with higher limits) or no room.
function interStageRemap(vsProg, psProg) {
	const max = (isNode && process.env.WGPU_INTERSTAGE_MAX ? +process.env.WGPU_INTERSTAGE_MAX : device.limits.maxInterStageShaderVariables) || 16;		// WGPU_INTERSTAGE_MAX (Node, test aid): remap below a lower limit
	const lim = /@builtin\(clip_distances\)/.test(vsProg.text) ? max - 1 : max;
	const outs = vsProg.outLocs || (vsProg.outLocs = locationsIn(vsProg.text, 'vs'));
	if (!outs.some((l) => l >= lim)) return null;
	const ins = psProg ? (psProg.inLocs || (psProg.inLocs = locationsIn(psProg.text, 'ps'))) : [];
	const used = new Set(outs.concat(ins).filter((l) => l < lim)), map = new Map();
	let free = 0;
	for (const l of outs) {
		if (l < lim) continue;
		while (used.has(free)) free++;
		if (free >= lim) { logOnce('remap' + vsProg.label, vsProg.label + ': ' + outs.length + ' vertex outputs do not fit below location ' + lim); return null; }
		map.set(l, free); used.add(free);
	}
	return { map, key: [...map].map(([a, b]) => a + '>' + b).join(','), ps: ins.some((l) => map.has(l)) };
}
const remapVariants = [0, 0];		// vertex / pixel shader variants made for interStageRemap (in the "world shown" line)
// The vertex shader's outputs are the struct its main() returns; the pixel shader's inputs are main()'s parameters (the parameter lists contain `@location(Nu)`, so they
// are matched lazily up to ") ->").
const VS_MAIN = /@vertex\s*fn\s+main\s*\([\s\S]*?\)\s*->\s*(\w+)\s*\{/, PS_MAIN = /(@fragment\s*fn\s+main\s*\()([\s\S]*?)(\)\s*->)/;
function vsOutputStruct(text) {
	const m = VS_MAIN.exec(text);
	return m ? new RegExp('(struct\\s+' + m[1] + '\\s*\\{)([^}]*)(\\})') : null;
}
function locationsIn(text, stage) {
	let body = '';
	if (stage === 'vs') { const re = vsOutputStruct(text), m = re && re.exec(text); body = m ? m[2] : ''; }
	else { const m = PS_MAIN.exec(text); body = m ? m[2] : ''; }
	return [...body.matchAll(/@location\((\d+)u?\)/g)].map((x) => +x[1]);
}
function remapLocations(text, stage, map) {
	const swap = (s) => s.replace(/@location\((\d+)(u?)\)/g, (all, n, u) => map.has(+n) ? '@location(' + map.get(+n) + u + ')' : all);
	const re = stage === 'vs' ? vsOutputStruct(text) : PS_MAIN;
	return re ? text.replace(re, (all, a, body, c) => a + swap(body) + c) : text;
}
// the pixel shader module for a pipeline: its alpha-to-coverage variant and/or the inputs moved by interStageRemap
function pixelModule(psProg, a2c, remap) {
	if (!remap || !remap.ps) return a2c ? (a2cModule(psProg) || psProg.module) : psProg.module;
	const key = 'remap|' + remap.key + (a2c ? '|a2c' : '');
	let m = psProg.variants.get(key);
	if (!m) {
		let text = psProg.text;
		if (a2c) text = text.replace(/(\n\s*main_inner\([^;]*\);)/, '$1\n  if (o0.w < 0.5f) { discard; }');
		text = remapLocations(text, 'ps', remap.map); remapVariants[1]++;
		m = device.createShaderModule({ code: text, label: psProg.label + ' [' + key + ']' });
		psProg.variants.set(key, m);
	}
	return m;
}

function getPipeline(vsObj, psObj, vsProg, psProg, layout, rtInfo, dsFormat) {
	const passInfoNow = passInfo;
	const topo = TOPOLOGY[S.topo] || TOPOLOGY[4];
	const stripFmt = topo[1] && S.ib.buf ? (S.ib.fmt === 57 ? 'uint16' : 'uint32') : undefined;
	// key: only what the pipeline depends on, built without intermediate arrays (this runs whenever any pipeline state changed, i.e. for most draws)
	const T = pipeTuple;
	let n = 0;
	T[n++] = internHash(vsObj); T[n++] = psObj ? internHash(psObj) : 0; T[n++] = S.layout;
	const lslots = layout.slots;
	for (let k = 0; k < lslots.length; k++) {
		const v = S.vb[lslots[k].slot], o = v.buf ? objs.get(v.buf) : null;
		T[n++] = o && o.gpu ? v.stride : 0;
	}
	if (!passInfoNow.tailId) {
		const tail = rtInfo.map((r) => r ? r.format : '-').join(',') + '|' + (dsFormat || '-') + '|' + rtInfo.samples + '|' + (passInfoNow.roDepth ? 'rd' : '') + (passInfoNow.roStencil ? 'rs' : '');
		let id = internedTails.get(tail);
		if (id === undefined) { id = internedTails.size + 1; internedTails.set(tail, id); }
		passInfoNow.tailId = id;
	}
	T[n++] = S.topo; T[n++] = stripFmt === 'uint16' ? 1 : stripFmt ? 2 : 0; T[n++] = S.blend.id; T[n++] = S.dss.id; T[n++] = S.rs; T[n++] = passInfoNow.tailId;
	let h = n * 0x9e3779b1;
	for (let i = 0; i < n; i++) { h = Math.imul(h ^ T[i], 0x85ebca6b); h ^= h >>> 13; }
	h &= 0x3fffffff;		// a small integer (Smi): a full 32-bit key would be a heap number, allocated and hashed as a double on every lookup
	let bucket = pipelineBuckets.get(h);
	if (bucket) {
		for (let b = 0; b < bucket.length; b += 2) {
			const t = bucket[b];
			if (t.length !== n) continue;
			let i = 0;
			while (i < n && t[i] === T[i]) i++;
			if (i === n) return bucket[b + 1];
		}
	} else pipelineBuckets.set(h, bucket = []);
	// not seen with these state objects: by content (an identical pipeline made for other state objects, or compiled ahead from a recipe: no draw is skipped for it)
	const strides = S.vb.map((v) => (v.buf && objs.get(v.buf) && objs.get(v.buf).gpu) ? v.stride : 0);
	const blendState = S.blend.id ? objs.get(S.blend.id) : null;
	const dss = S.dss.id ? objs.get(S.dss.id) : null;
	const rs = S.rs ? objs.get(S.rs) : null;
	const rc = pipelineRecipe(vsObj, psObj, layout, strides, S.topo, stripFmt, blendState, dss, rs, rtInfo, dsFormat, passInfoNow.roDepth, passInfoNow.roStencil);
	const key = recipeKey(rc);
	let c = contentPipelines.get(key);
	if (c) {
		if (c.ahead) { c.ahead = false; aheadUsed++; }
		if (c.p !== undefined) { bucket.push(T.slice(0, n), c.p); return c.p; }
		bucket.push(T.slice(0, n), PIPELINE_PENDING);
		c.waiters.push(bucket, bucket.length - 1);
		return PIPELINE_PENDING;
	}
	if (!vsObj.variantOf && !(psObj && psObj.variantOf)) recordRecipe(rc, key);		// a texture-limit variant (fitTextures) has no shader of its own to find next time
	const { desc, vbReq } = pipelineDescFor(vsObj, psObj, vsProg, psProg, layout, strides, S.topo, stripFmt, blendState, dss, rs, rtInfo, dsFormat, passInfoNow.roDepth, passInfoNow.roStencil);
	contentPipelines.set(key, c = { p: undefined, waiters: [], ahead: false });
	pipeCreates++;
	if (asyncPipelines) {
		// Compiled off the GPU process's command thread: a synchronous createRenderPipeline makes everything submitted after it wait for the shader compile (tens of ms per
		// pipeline, hundreds of new pipelines when a new area streams in: the hitches). Draws needing it are skipped until it is ready (a new object appears a frame or two later).
		bucket.push(T.slice(0, n), PIPELINE_PENDING);
		c.waiters.push(bucket, bucket.length - 1);
		compileAsync(c, desc, vbReq);
		return PIPELINE_PENDING;
	}
	const pl = compileSync(c, desc, vbReq);
	bucket.push(T.slice(0, n), pl);
	return pl;
}
// The render pipeline for these shaders and states (shared by draws and the compile-ahead queue): { desc, vbReq }.
function pipelineDescFor(vsObj, psObj, vsProg, psProg, layout, strides, topoIdx, stripFmt, blendState, dss, rs, rtInfo, dsFormat, roDepth, roStencil) {
	const bgl0 = vsProg.info.bindings.some((b) => b.group === 0) ? bindGroupLayoutFor(vsProg, 0, 0) : emptyBgl();
	const bgl1 = psProg ? (psProg.info.bindings.some((b) => b.group === 1) ? bindGroupLayoutFor(psProg, 1, 1) : emptyBgl()) : emptyBgl();
	const dynCount = (vsProg.info.bindings.filter((b) => b.kind === 'uniform' && b.binding !== 15 && b.group === 0).length) + (psProg ? psProg.info.bindings.filter((b) => b.kind === 'uniform' && b.binding !== 15 && b.group === 1).length : 0);
	if (dynCount > (device.limits.maxDynamicUniformBuffersPerPipelineLayout || 8)) logOnce('dyn' + vsProg.label + psProg, 'pipeline ' + vsProg.label + ' + ' + (psProg ? psProg.label : '-') + ' needs ' + dynCount + ' dynamic uniform buffers (limit ' + device.limits.maxDynamicUniformBuffersPerPipelineLayout + ')');
	const remap = interStageRemap(vsProg, psProg);		// null unless a vertex output is at or above the device's inter-stage limit
	const desc = {
		layout: device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] }),
		vertex: { module: vertexModule(vsProg, psProg ? psProg.flat : [], remap), entryPoint: 'main', buffers: vertexBuffersFor(vsObj, layout, strides) },
		primitive: { topology: (TOPOLOGY[topoIdx] || TOPOLOGY[4])[0] },
		label: vsProg.label + ' + ' + (psProg ? psProg.label : '-'),
	};
	if (stripFmt) desc.primitive.stripIndexFormat = stripFmt;
	if (rs) {
		const w = rs.words;		// FillMode, CullMode, FrontCCW, DepthBias, DepthBiasClamp, SlopeScaledDepthBias, DepthClip, Scissor, MS, AA line
		if (w[0] === 2) noteApprox('wireframe fill', desc.label);
		if (w[6] === 0) noteApprox('DepthClipEnable=false', desc.label);
		desc.primitive.cullMode = w[1] === 2 ? 'front' : w[1] === 3 ? 'back' : 'none';
		desc.primitive.frontFace = w[2] ? 'ccw' : 'cw';
	} else { desc.primitive.cullMode = 'back'; desc.primitive.frontFace = 'cw'; }
	const ds = depthStencilFor(dss, dsFormat, roDepth, roStencil);
	if (ds) {
		if (rs) { ds.depthBias = rs.words[3] | 0; ds.depthBiasSlopeScale = wf(rs.words[5]); ds.depthBiasClamp = wf(rs.words[4]); }
		desc.depthStencil = ds;
	}
	if (psProg) {
		// the targets must match the pass attachments slot by slot; slots the shader does not write get a zero write mask
		const targets = [];
		for (let i = 0; i < rtInfo.length; i++) {
			const r = rtInfo[i];
			if (!r) { targets.push(null); continue; }
			if (!psProg.info.outputs.includes(i)) { targets.push({ format: r.format, writeMask: 0 }); continue; }
			const b = blendFor(blendState, i);
			targets.push({ format: r.format, writeMask: b.write, ...(b.blend ? { blend: b.blend } : {}) });
		}
		const missing = psProg.info.outputs.filter((l) => !rtInfo[l]);
		if (missing.length) logOnce('psout' + psProg.label, psProg.label + ' writes colour output(s) ' + missing.join(',') + ' with no render target bound');
		// D3D11 alpha-to-coverage on a single-sample target turns the alpha of target 0 into a coverage of 0 or 1 (alpha >= 0.5): the foliage (grass) shaders
		// rely on it instead of clip(). WebGPU only honours the flag with MSAA, so the module gets an explicit alpha test.
		const a2c = !!(blendState && blendState.words[0]) && rtInfo.samples <= 1 && psProg.info.outputs.includes(0);
		desc.fragment = { module: pixelModule(psProg, a2c, remap), entryPoint: 'main', targets };
	} else if (rtInfo.length) {
		desc.fragment = undefined;
	}
	if (blendState && blendState.words[0] && rtInfo.samples <= 1) noteApprox('alpha-to-coverage without MSAA', desc.label);
	if (blendState) for (let rt = 0; rt < 8; rt++) { const q = 2 + rt * 8; if (blendState.words[q] && [1, 2, 4, 5, 6].some((o) => [16, 17, 18, 19].includes(blendState.words[q + o]))) noteApprox('dual-source blend', desc.label); }
	if (rtInfo.samples > 1) desc.multisample = { count: rtInfo.samples, alphaToCoverageEnabled: !!(blendState && blendState.words[0]) };
	// what each vertex buffer slot must hold for n elements: (n - 1) * stride + last (doDraw clamps the counts to it)
	const vbReq = [];
	desc.vertex.buffers.forEach((b, slot) => { if (b) vbReq.push({ slot, instance: b.stepMode === 'instance', stride: b.arrayStride, last: b.attributes.reduce((m, a) => Math.max(m, a.offset + vertexFormatBytes(a.format)), 0) }); });
	return { desc, vbReq };
}
function compileSync(c, desc, vbReq) {
	let pl;
	try {
		const pt0 = performance.now();
		pl = device.createRenderPipeline(desc);
		pipeMs += performance.now() - pt0; fr.pipe += performance.now() - pt0;
		pl.vbReq = vbReq;
	} catch (e) {
		logLine('pipeline failed (' + desc.label + '): ' + e.message);
		pl = null;
	}
	pipelineCount++;
	c.p = pl;
	return pl;
}
function compileAsync(c, desc, vbReq, onDone) {
	pipelinesPending++;
	const settle = (p) => {
		c.p = p;
		for (let i = 0; i < c.waiters.length; i += 2) c.waiters[i][c.waiters[i + 1]] = p;
		c.waiters = null;
		pipelinesPending--; pipelineCount++;
		if (onDone) onDone();
	};
	device.createRenderPipelineAsync(desc).then((p) => { p.vbReq = vbReq; settle(p); }, (e) => { logLine('pipeline failed (' + desc.label + '): ' + (e && e.message)); settle(null); });
}
// Browser: pipelines compile asynchronously (?syncpipelines=1: synchronously, as Node does by default for deterministic headless runs and screenshots; WGPU_ASYNC_PIPELINES=1
// makes Node compile them asynchronously too, to measure the draws skipped meanwhile)
const asyncPipelines = isNode ? !!process.env.WGPU_ASYNC_PIPELINES : !new URLSearchParams(self.location.search).get('syncpipelines') && typeof GPUDevice !== 'undefined' && !!GPUDevice.prototype.createRenderPipelineAsync;
const PIPELINE_PENDING = { pending: true };
let pipelinesPending = 0, pendingSkips = 0, pendingSkips0 = 0;

// ---- pipelines by content, compiled ahead -------------------------------------------------------------------------------------------
// A draw that needs a pipeline nobody compiled yet is skipped until its asynchronous compile finishes. On a slow GPU process (a 4-core Chromebook: ~250 pipelines for
// the first view of the world took seconds, 28,000 draws skipped in one second) that shows as holes (white) in the picture. So every pipeline is also known by its
// recipe: shader hashes, input layout, strides, topology, the blend/depth/raster state words, target formats; recipes seen are kept per browser (IndexedDB, no
// network) and, as a seed, in /shaders/pipelines.json (Node recordings, phase3/pipeline_seed.py). While the game loads, the recipes whose shaders have arrived are
// compiled ahead, a few at a time; a draw whose pipeline has the same recipe then uses it at once.
const contentPipelines = new Map();		// recipeKey -> { p: GPURenderPipeline | null (failed) | undefined (compiling), waiters: [bucket, index, ...], ahead: compiled ahead and not used yet }
const shadersByHash = new Map();		// DXBC hash -> shader object (createShader)
let shadersReady = 0;		// shader objects whose sources are here (browser: fetched): unready recipes are retried when this grows
let aheadMade = 0, aheadUsed = 0, aheadInFlight = 0;
let aheadList = [], aheadPos = 0, aheadLater = [], aheadReadyAtPass = -1;
const AHEAD_MAX = isNode ? 1 : Math.max(2, Math.min(8, (self.navigator.hardwareConcurrency || 4) - 1));		// compiles in flight at once (the GPU process compiles them on its threads)
const AHEAD_PLAY = isNode ? 1 : ((v) => (v === null ? 1 : Math.max(0, Math.min(8, +v | 0))))(new URLSearchParams(self.location.search).get('aheadplay'));		// ... once the world is shown (aheadStep)
function pipelineRecipe(vsObj, psObj, layout, strides, topoIdx, stripFmt, blendState, dss, rs, rtInfo, dsFormat, roDepth, roStencil) {
	return {
		vs: vsObj.hash, ps: psObj ? psObj.hash : '',
		el: layout.els.map((e) => [e.sem, e.idx, e.fmt, e.slot, e.offset, e.cls, e.rate]), st: layout.slots.map((s) => strides[s.slot] || 0),
		tp: topoIdx, sf: stripFmt || '', b: blendState ? blendState.words : null, d: dss ? dss.words : null, r: rs ? rs.words : null,
		rt: rtInfo.map((x) => x ? x.format : null), n: rtInfo.samples, ds: dsFormat || '', ro: (roDepth ? 1 : 0) | (roStencil ? 2 : 0),
	};
}
function recipeKey(rc) {
	return JSON.stringify([rc.vs, rc.ps, rc.el, rc.st, rc.tp, rc.sf, rc.b, rc.d, rc.r, rc.rt, rc.n, rc.ds, rc.ro]);
}
// 'done' (compiling, compiled or not compilable) or 'later' (a shader is not here yet)
function compileAhead(rc, key) {
	if (contentPipelines.has(key)) return 'done';
	const vsObj = shadersByHash.get(rc.vs), psObj = rc.ps ? shadersByHash.get(rc.ps) : null;
	if (!vsObj || (rc.ps && !psObj)) return 'later';
	if (!isNode && (vsObj.fetched === undefined || (psObj && psObj.fetched === undefined))) return 'later';		// shaderProgram must not run before the fetch: it would cache a failure
	const vsProg = shaderProgram(vsObj), psProg = psObj ? shaderProgram(psObj) : null;
	if (!vsProg || (psObj && !psProg)) return 'done';
	if (vsProg.overTex || (psProg && psProg.overTex)) return 'done';		// over this device's texture limit: compiled per draw as variants (fitTextures)
	const els = rc.el.map(([sem, idx, fmt, slot, offset, cls, rate]) => ({ sem, idx, fmt, slot, offset, cls, rate }));
	const layout = { kind: 'layout', els, slots: layoutSlots(els) };
	const strides = new Array(16).fill(0);
	layout.slots.forEach((s, i) => { strides[s.slot] = rc.st[i] || 0; });
	const rtInfo = rc.rt.map((f) => f ? { format: f } : null);
	rtInfo.samples = rc.n;
	const { desc, vbReq } = pipelineDescFor(vsObj, psObj, vsProg, psProg, layout, strides, rc.tp, rc.sf || undefined, rc.b ? { words: rc.b } : null, rc.d ? { words: rc.d } : null, rc.r ? { words: rc.r } : null,
		rtInfo, rc.ds || null, (rc.ro & 1) !== 0, (rc.ro & 2) !== 0);
	const c = { p: undefined, waiters: [], ahead: true };
	contentPipelines.set(key, c);
	aheadMade++;
	if (asyncPipelines) { aheadInFlight++; compileAsync(c, desc, vbReq, () => { aheadInFlight--; }); }
	else compileSync(c, desc, vbReq);
	return 'done';
}
// Runs while the worker is idle and at every present: at most ~3 ms per call; a pass over the list ends when it is empty or the unready ones wait for new shaders.
function aheadStep() {
	if (aheadPos >= aheadList.length && !aheadLater.length) return;
	const t0 = performance.now();
	// once the world is shown, AHEAD_PLAY compiles at a time (1; the page's Fast and Fastest: 0, none): each runs on a thread of Chrome's GPU process, and on a 4-thread CPU
	// three at once took cores the game and the GPU process itself need right then (a story mission loading its people and places). A pipeline not compiled ahead is
	// compiled when first drawn, as always (its draws wait a few frames).
	const inFlightMax = worldSent ? AHEAD_PLAY : AHEAD_MAX;
	if (!inFlightMax) return;
	while (aheadInFlight < inFlightMax && performance.now() - t0 < 3) {
		if (aheadPos >= aheadList.length) {
			if (!aheadLater.length || aheadReadyAtPass === shadersReady) break;
			aheadReadyAtPass = shadersReady; aheadList = aheadLater; aheadLater = []; aheadPos = 0;
		}
		const it = aheadList[aheadPos++];
		if (compileAhead(it[0], it[1]) === 'later') aheadLater.push(it);
	}
}
// Recipes: this browser's (IndexedDB 'gta-pipelines', newest session's new ones appended, at most RECIPES_MAX) first, then the seed's. Node: WGPU_PIPELINE_SEED=<json>
// (a seed file) and WGPU_RECORD_PIPELINES=<jsonl> (appends every new recipe of the run, for pipeline_seed.py).
const RECIPES_MAX = 6000;
let recipesKnown = new Set(), recipesNew = [], recipesSaved = 0, recipesSaveT = 0;
function recordRecipe(rc, key) {
	if (recipesKnown.has(key)) return;
	recipesKnown.add(key);
	if (isNode) { if (process.env.WGPU_RECORD_PIPELINES) require('fs').appendFileSync(process.env.WGPU_RECORD_PIPELINES, JSON.stringify(rc) + '\n'); return; }
	recipesNew.push(rc);
}
function idbOpen() {
	return new Promise((res, rej) => { const r = indexedDB.open('gta-pipelines', 1); r.onupgradeneeded = () => r.result.createObjectStore('recipes'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
// this browser's recipes, one list per kind of settings: the low ones (Balanced, Fast, Fastest: ?low=1) apart from the rest, so a session does not compile ahead thousands of
// pipelines recorded with other settings (shadows and all) that it never draws
const RECIPES_KEY = !isNode && new URLSearchParams(self.location.search).get('low') === '1' ? 'list-low' : 'list';
async function idbList(db) {
	return new Promise((res) => { const r = db.transaction('recipes').objectStore('recipes').get(RECIPES_KEY); r.onsuccess = () => res(Array.isArray(r.result) ? r.result : []); r.onerror = () => res([]); });
}
async function loadRecipes() {
	let local = [], seed = [];
	if (isNode) {
		if (process.env.WGPU_PIPELINE_SEED) seed = JSON.parse(require('fs').readFileSync(process.env.WGPU_PIPELINE_SEED, 'utf8'));
	} else {
		try { local = await idbList(await idbOpen()); } catch (e) { logLine('pipeline recipes: no IndexedDB (' + (e && e.message) + ')'); }
		try { const r = await fetch(shaderUrl + (new URLSearchParams(self.location.search).get('low') === '1' ? '/pipelines_low.json' : '/pipelines.json')); if (r.ok) seed = await r.json(); } catch (e) { /* no seed */ }		// the page's low-memory profile has its own (no shadow pipelines)
	}
	for (const rc of local.concat(seed)) {
		const key = recipeKey(rc);
		if (recipesKnown.has(key)) continue;
		recipesKnown.add(key);
		aheadList.push([rc, key]);
	}
	recipesSaved = local.length;
	logLine('pipeline recipes: ' + local.length + ' from this browser, ' + seed.length + ' in the seed, ' + aheadList.length + ' to compile ahead (' + AHEAD_MAX + ' at a time)');
}
// The new recipes of this session go to IndexedDB every 20 s (a tab can be closed at any time).
async function saveRecipes() {
	if (isNode || !recipesNew.length) return;
	const add = recipesNew.splice(0);
	try {
		const db = await idbOpen();
		const list = (await idbList(db)).concat(add);
		if (list.length > RECIPES_MAX) list.splice(0, list.length - RECIPES_MAX);
		await new Promise((res, rej) => { const t = db.transaction('recipes', 'readwrite'); t.objectStore('recipes').put(list, RECIPES_KEY); t.oncomplete = res; t.onerror = () => rej(t.error); });
		recipesSaved = list.length;
	} catch (e) { logOnce('idbsave', 'pipeline recipes not saved: ' + (e && e.message)); }
}

// ---- render pass + draw -----------------------------------------------------------------------------------------------------------
let rtKey = null;		// the render-target part of the pass key: rebuilt only after SET_RENDER_TARGETS / a state reset
function ensurePass() {
	const key = rtKey || (rtKey = S.rt.map((r) => r.tex + ':' + r.mip + ':' + r.slice + ':' + r.fmt).join(',') + '/' + S.ds.tex + ':' + S.ds.mip + ':' + S.ds.slice + ':' + S.ds.fmt + ':' + S.ds.flags);
	if (pass && key === passKey) return true;
	endPass();
	if (OCCL && occl.open) occlPassStart();		// the main view's G-buffer pass may be over: its depth grid (occlusion)
	const colorAttachments = [], rtInfo = [];
	let samples = 1, any = false, passW = 1, passH = 1;
	for (let i = 0; i < 8; i++) {
		const r = S.rt[i];
		const t = r.tex ? objs.get(r.tex) : null;
		if (!t) { colorAttachments.push(null); rtInfo.push(null); continue; }
		const v = targetView(t, r.fmt, r.mip, r.slice);
		const att = { view: v.view, loadOp: 'load', storeOp: 'store' };
		if (v.depthSlice !== undefined) att.depthSlice = v.depthSlice;
		if (pendingClears.length) takeColorClear(att, r.tex, r.mip, r.slice, v.format, t);
		colorAttachments.push(att);
		markColorDirty(t, t.desc.dimension === '3d' ? undefined : r.slice);
		rtInfo.push({ format: v.format });
		samples = t.desc.sampleCount; any = true; passW = Math.max(1, t.desc.size.width >> r.mip); passH = Math.max(1, t.desc.size.height >> r.mip);
		usedInEncoder.add(t);
	}
	while (colorAttachments.length && colorAttachments[colorAttachments.length - 1] === null) { colorAttachments.pop(); rtInfo.pop(); }
	const desc = { colorAttachments };
	if (occlusion.set) desc.occlusionQuerySet = occlusion.set;
	let dsFormat = null;
	const dt = S.ds.tex ? objs.get(S.ds.tex) : null;
	if (dt) {
		const v = targetView(dt, 0, S.ds.mip, S.ds.slice);
		const att = { view: v.view };
		const roDepth = (S.ds.flags & 1) !== 0, roStencil = (S.ds.flags & 2) !== 0;
		if (roDepth) att.depthReadOnly = true; else { att.depthLoadOp = 'load'; att.depthStoreOp = 'store'; }
		if (hasStencil(dt.format)) { if (roStencil) att.stencilReadOnly = true; else { att.stencilLoadOp = 'load'; att.stencilStoreOp = 'store'; } }
		if (pendingClears.length) takeDepthClear(att, S.ds.tex, S.ds.mip, S.ds.slice, dt, roDepth, roStencil);
		if (!roDepth && !roStencil) markDepthDirty(dt);
		desc.depthStencilAttachment = att; dsFormat = dt.format; samples = dt.desc.sampleCount; any = true;
		if (!S.rt.some((r) => r.tex)) { passW = Math.max(1, dt.desc.size.width >> S.ds.mip); passH = Math.max(1, dt.desc.size.height >> S.ds.mip); }
		usedInEncoder.add(dt);
	}
	if (!any) return false;
	// a clear still waiting for a texture this pass renders into (another view of it, or one that could not be folded in) must happen before the pass does
	if (pendingClears.length) {
		let conflict = !!dt && pendingHas(S.ds.tex);
		for (let i = 0; i < 8 && !conflict; i++) if (S.rt[i].tex && pendingHas(S.rt[i].tex)) conflict = true;
		if (conflict) flushPendingClears();
	}
	rtInfo.samples = samples;
	passKey = key;
	passAtt = [];
	for (let i = 0; i < 8; i++) if (S.rt[i].tex) passAtt.push(objs.get(S.rt[i].tex));
	if (dt) passAtt.push(dt);
	pdirty = true;
	if (gpuTiming.state === 1) {
		const t0 = S.rt[0].tex ? objs.get(S.rt[0].tex) : null;
		timePass(desc, colorAttachments.length >= 3 ? 'G-buffer' : t0 && t0.reflect ? 'reflections' : (rtInfo[0] ? rtInfo[0].format : 'depth') + ' ' + passW + 'x' + passH);
	}
	pass = getEncoder().beginRenderPass(desc); passDrawN++;
	beginOcclusionInPass();
	passInfo = { rtInfo, dsFormat, colorCount: colorAttachments.length, roDepth: !!dt && (S.ds.flags & 1) !== 0, roStencil: !!dt && (S.ds.flags & 2) !== 0, width: passW, height: passH };
	applied = {};
	// A pass starts with WebGPU's defaults (the whole target as viewport, depth 0..1, and as scissor rectangle, blend constant 0, stencil reference 0): draws that want
	// those set nothing. Every call costs twice on a Chromebook (packed here, executed in Chrome's GPU process): these four were set at the start of every pass.
	passSt = newPassSt();
	passSt.vp = [0, 0, passW, passH, 0, 1]; passSt.sc = [0, 0, passW, passH]; passSt.bf = [0, 0, 0, 0]; passSt.sref = 0;
	passToName = passInfo;		// the overlay's passes by what starts them: named by its first draw (doDraw)
	return true;
}
let passInfo = null;

// refresh depth-as-float proxies before the render pass starts (a refresh is a pass of its own)
function prepareDepthProxies(prog, stage) {
	const texs = prog.texBindings || (prog.texBindings = prog.info.bindings.filter((b) => b.kind === 'texture'));
	if (!texs.length) return;
	// Most draws bind no depth texture: once a scan found none, skip it until this stage's bindings or the set of resources change (a proxy that exists must be refreshed every time)
	const dp = prog.dpScan || (prog.dpScan = [{ none: false, e: -1, g: -1 }, { none: false, e: -1, g: -1 }, { none: false, e: -1, g: -1 }]), sc = dp[stage];
	if (sc.none && sc.e === bindEpoch[stage] && sc.g === gEpoch) return;
	let any = false;
	for (let i = 0; i < texs.length; i++) {
		const b = texs[i];
		const id = S.srv[stage][b.binding - 32], srv = id ? objs.get(id) : null;
		const t = srv && !srv.isBuf ? objs.get(srv.res) : null;
		if (t && t.kind === 'texture' && isDepth(t.format) && b.sample !== 'depth') { any = true; if (!depthDirectMode(srv, b)) depthProxy(t, b.sample === 'uint' ? 'stencil' : 'depth', noF32Filter && b.loadOnly); }		// bound as it is or not at all: no copy (DEPTH_DIRECT)
		else if (t && t.kind === 'texture' && !isDepth(t.format) && b.sample === 'depth') { any = true; floatToDepthProxy(t); }
		else if (t && t.kind === 'texture' && noF32Filter && b.sample === 'float' && !b.loadOnly && HALF_OF[t.format]) { any = true; halfProxy(t); }		// the 16-bit copies too (srvView)
	}
	sc.none = !any; sc.e = bindEpoch[stage]; sc.g = gEpoch;
}

// Bind-group fast path: the result of stageBindGroup for a (program, stage) is reused while nothing it depends on changed. bindEpoch[stage] counts binding ops of that stage, gEpoch
// counts destructions of textures/buffers that some bind group referenced (bgUse marks them `inBG`), constant buffers are compared by version, and the ring frame must be the same (the
// packed constants live in it). Creations do not count: ids are never reused and an object's CREATE op precedes every op that binds it, so nothing a cached result references can
// change by a later creation (counting them made streaming, which creates and destroys objects all the time, invalidate every program's fast path).
const bindEpoch = [0, 0, 0];
let gEpoch = 0, sawProxy = false;
let zeroVb = null;
const ZERO_VB_SIZE = 4096;
function zeroVertexBuffer() { return zeroVb || (zeroVb = device.createBuffer({ size: ZERO_VB_SIZE, usage: GPUBufferUsage.VERTEX })); }

function replayBG(e) {
	for (let i = 0; i < e.used.length; i++) { const o = e.used[i]; o.enc = encEpoch; if (o.pendCopy) needSplit = true; }
	for (let i = 0; i < e.dirty.length; i++) markColorDirty(e.dirty[i]);
}
// The ids a program's bind group for `group` is built from, as (slot kind, index) pairs: 0/1 constant buffer id/first constant of a pack member, 2 sampler, 3 SRV, 4 UAV. Equal ids
// give an equal bind group (objects never change under an id; destroyed ones bump gEpoch), so an entry whose stage epoch moved on (any binding op of the stage, by any program,
// invalidated it: a third of all lookups) is revalidated by comparing these few ids instead of rebuilding.
function idSources(prog, group) {
	const src = [], bs = prog.groupBindings[group] || [];
	if (prog.pack && bs.some((b) => b.kind === 'uniform' && b.binding !== 15)) for (const m of prog.pack.members) src.push(0, m.binding, 1, m.binding);
	for (const b of bs) {
		if (b.kind === 'sampler' || b.kind === 'sampler-comparison') src.push(2, b.binding - 16);
		else if (b.kind === 'texture') src.push(3, b.binding - 32);
		else if (b.kind === 'read-only-storage' || b.kind === 'storage') { if (b.binding >= 160) src.push(4, b.binding - (b.binding >= 176 ? 176 : 160)); else src.push(3, b.binding - 32); }
		else if (b.kind === 'storage-texture') src.push(4, b.binding - 160);
	}
	return src;
}
function boundId(stage, k, x) { return k === 0 ? S.cb[stage][x].buf : k === 1 ? S.cb[stage][x].first : k === 2 ? S.smp[stage][x] : k === 3 ? S.srv[stage][x] : S.uav[stage][x]; }
function readIds(stage, src) { const out = new Array(src.length >> 1); for (let i = 0; i < src.length; i += 2) out[i >> 1] = boundId(stage, src[i], src[i + 1]); return out; }
function sameIds(stage, src, ids) { for (let i = 0; i < src.length; i += 2) if (boundId(stage, src[i], src[i + 1]) !== ids[i >> 1]) return false; return true; }
function stageBG(stage, prog, group) {
	const e = prog.fast && prog.fast[stage];
	const src = (prog.idSrc || (prog.idSrc = []))[group] || (prog.idSrc[group] = idSources(prog, group));
	if (e && !e.noFast && e.gEpoch === gEpoch && (e.epoch === bindEpoch[stage] || (sameIds(stage, src, e.ids) && (e.epoch = bindEpoch[stage], true)))) {
		// A result is tied to a frame only by its dynamic constant offset, which points into the ring slot of the frame that packed it.
		if (e.frame === ubo.frame || !e.result.dyn.length) {
			let ok = true;
			for (let i = 0; i < e.objs.length; i++) { const o = e.objs[i]; if (o && o.version !== e.vers[i]) { ok = false; break; } }
			if (ok) { replayBG(e); return e.result; }
		}
		// constants changed, or a new frame: the bind group is the same while the new constants land in the same ring chunk (the chunk is bound whole, the offset is dynamic, and
		// chunk k of every frame slot is the same buffer)
		if (e.chunkId) {
			const a = packCopy(prog, stage);
			if (a && a.chunk.id === e.chunkId) {
				for (let i = 0; i < e.objs.length; i++) { const o = e.objs[i]; e.vers[i] = o ? o.version : -1; }
				e.result.dyn[0] = a.chunk.base + a.off;		// the same result object and offsets array (doDraw compares offsets by value, not identity)
				e.frame = ubo.frame;
				replayBG(e);
				return e.result;
			}
		}
	}
	const epoch = bindEpoch[stage], g = gEpoch;
	sawProxy = false;
	const result = stageBindGroup(stage, prog, group, prog.bgls[group] || (prog.bgls[group] = bindGroupLayoutFor(prog, group, group)));
	if (!prog.fast) { prog.fast = []; progsWithFast.add(prog); }
	if (result && prog.pack && result.dyn.length === 1) {
		const a = packCopy(prog, stage);		// (a hit: the slow path just packed it) for the chunk the bind group was created with
		const objsList = [], vers = [];
		for (const m of prog.pack.members) { const c = S.cb[stage][m.binding], o = c.buf ? objs.get(c.buf) : null; objsList.push(o); vers.push(o ? o.version : -1); }
		prog.fast[stage] = { epoch, gEpoch: g, frame: ubo.frame, objs: objsList, vers, result, noFast: sawProxy, chunkId: a ? a.chunk.id : 0, used: bgUsed.slice(), dirty: bgDirty.slice(), ids: readIds(stage, src) };
	} else if (result && prog.pack) {
		const objsList = [], vers = [];
		for (const m of prog.pack.members) { const c = S.cb[stage][m.binding], o = c.buf ? objs.get(c.buf) : null; objsList.push(o); vers.push(o ? o.version : -1); }
		prog.fast[stage] = { epoch, gEpoch: g, frame: ubo.frame, objs: objsList, vers, result, noFast: sawProxy, chunkId: 0, used: bgUsed.slice(), dirty: bgDirty.slice(), ids: readIds(stage, src) };
	} else if (result) prog.fast[stage] = { epoch, gEpoch: g, frame: ubo.frame, objs: [], vers: [], result, noFast: sawProxy, chunkId: 0, used: bgUsed.slice(), dirty: bgDirty.slice(), ids: readIds(stage, src) };
	else prog.fast[stage] = null;
	return result;
}

// Bindings of the group being built, in flat scratch arrays: binding number, resource (sampler / texture view / GPUBuffer), buffer offset (-1: not a buffer binding) and size
// (-1: to the end). The GPUBindGroupEntry objects are only built when the cache misses; most calls hit and built them for nothing.
const sbB = [], sbR = [], sbO = [], sbS = [];
let sbN = 0;
function ent(binding, res, off, size) { sbB[sbN] = binding; sbR[sbN] = res; sbO[sbN] = off; sbS[sbN] = size; sbN++; }
function buildEntries() {
	const entries = new Array(sbN);
	for (let i = 0; i < sbN; i++) {
		const off = sbO[i];
		entries[i] = { binding: sbB[i], resource: off < 0 ? sbR[i] : sbS[i] >= 0 ? { buffer: sbR[i], offset: off, size: sbS[i] } : off ? { buffer: sbR[i], offset: off } : { buffer: sbR[i] } };
	}
	return entries;
}
function noteSamplerApprox(st, prog, slot) {
	// once per sampler object (the approximated-features report; checked on every bind group build before)
	if (st.approxSeen) return;
	st.approxSeen = true;
	const w = st.words;
	if (w[1] === 4 || w[2] === 4 || w[3] === 4) noteApprox('border sampler bound by', prog.label + ' s' + slot);
	if (wf(w[4]) !== 0) noteApprox('MipLODBias sampler bound by', prog.label + ' s' + slot + ' bias ' + wf(w[4]).toFixed(2));
}
function stageBindGroup(stage, prog, group, bgl) {
	// resources of one stage; returns { bg, dyn } or null
	const dyn = [];
	sbN = 0;
	bgUsed.length = 0; bgDirty.length = 0;
	const bindings = prog.groupBindings[group] || [];
	// cache key: the layout, the program (its bindings and its constant table) and the stage, then the resource ids of the bindings in order
	bgKeyN = 0;
	bgKey[bgKeyN++] = bgl.__uid || (bgl.__uid = nextUid++);
	bgKey[bgKeyN++] = prog.uid || (prog.uid = nextUid++);
	bgKey[bgKeyN++] = stage;
	for (let bi = 0; bi < bindings.length; bi++) {
		const b = bindings[bi];
		if (b.kind === 'uniform') {
			if (b.binding === 15) {
				if (!prog.consts) { logOnce('c15' + prog.label, 'shader ' + prog.label + ' declares binding 15 but has no constant table'); return null; }
				ent(15, prog.consts, 0, -1);
				continue;
			}
			const a = packCopy(prog, stage);
			if (!a) return null;
			ent(0, a.chunk.buf, 0, prog.pack.size);
			dyn.push(a.chunk.base + a.off);
			bgKey[bgKeyN++] = a.chunk.id;
		} else if (b.kind === 'sampler' || b.kind === 'sampler-comparison') {
			const sid = S.smp[stage][b.binding - 16], st = sid ? objs.get(sid) : null;
			const cmp = b.kind === 'sampler-comparison';
			if (st && st.words) noteSamplerApprox(st, prog, b.binding - 16);
			ent(b.binding, st && st.sampler && !!(st.words[0] & 0x80) === cmp ? st.sampler : dummySampler(cmp), -1, -1);
			bgKey[bgKeyN++] = st ? sid : 0;
		} else if (b.kind === 'texture') {
			const id = S.srv[stage][b.binding - 32];
			const srv = id ? objs.get(id) : null;
			let v = null;
			if (srv && !srv.isBuf) { v = srvView(srv, b); if (v) bgUse(objs.get(srv.res)); }
			ent(b.binding, v || dummyTexture(b), -1, -1);
			bgKey[bgKeyN++] = v ? (srvDirect ? -id : id) : 0;		// a depth texture bound as it is: a bind group of its own (DEPTH_DIRECT)
		} else if (b.kind === 'read-only-storage' || b.kind === 'storage') {
			const isCounter = b.binding >= 176, isUav = b.binding >= 160;
			const id = isUav ? S.uav[stage][b.binding - (isCounter ? 176 : 160)] : S.srv[stage][b.binding - 32];
			const view = id ? objs.get(id) : null;
			const buf = view && view.isBuf ? objs.get(view.res) : null;
			const gb = isCounter ? (buf ? counterBuffer(buf) : dummyBuffer(b.binding)) : (buf && buf.gpu ? buf.gpu : dummyBuffer(b.binding));
			let resOff = 0, resSize = -1;
			if (buf && buf.gpu && !isCounter) {
				const stride = buf.stride || 4, first = view.a, num = view.b;
				const off = first * stride;
				if (off && off % 256 === 0) { resOff = off; if (num && num !== 0xffffffff) resSize = Math.min(num * stride, buf.bytes - off); }
				else if (off) logOnce('bufoff' + prog.label, prog.label + ': buffer view offset ' + off + ' is not 256-aligned; binding the whole buffer');
			}
			ent(b.binding, gb, resOff, resSize);
			if (buf) bgUse(buf);
			bgKey[bgKeyN++] = buf ? id : 0;
			bgKey[bgKeyN++] = resOff;
		} else if (b.kind === 'storage-texture') {
			const uav = S.uav[stage][b.binding - 160] ? objs.get(S.uav[stage][b.binding - 160]) : null;
			const t = uav && !uav.isBuf ? objs.get(uav.res) : null;
			if (!t) { logOnce('nouavtex' + prog.label, prog.label + ': storage texture u' + (b.binding - 160) + ' has no UAV bound'); return null; }
			const key2 = b.dim + ':' + t.format;
			let v = uav.views.get(key2);
			if (!v) {
				const d = { dimension: b.dim, baseMipLevel: uav.a, mipLevelCount: 1 };
				if (b.dim === '2d-array') { d.baseArrayLayer = uav.vdim === 5 ? uav.b : 0; d.arrayLayerCount = uav.vdim === 5 ? uav.c : t.desc.size.depthOrArrayLayers; }
				else if (b.dim === '2d') d.baseArrayLayer = uav.vdim === 5 ? uav.b : 0;
				try { v = t.tex.createView(d); } catch (e) { logOnce('uavview' + prog.label, 'UAV view failed: ' + e.message); return null; }
				uav.views.set(key2, v);
			}
			ent(b.binding, v, -1, -1);
			bgUse(t); markColorDirty(t); bgDirty.push(t);
			bgKey[bgKeyN++] = S.uav[stage][b.binding - 160];
		} else {
			logOnce('bk' + b.kind, 'unsupported binding kind ' + b.kind);
			return null;
		}
	}
	let h = 0x811c9dc5 | 0;
	for (let i = 0; i < bgKeyN; i++) h = Math.imul(h ^ bgKey[i], 16777619);
	h &= 0x3fffffff;
	const head = bindGroupCache.get(h);
	let e = head;
	for (; e; e = e.next) {
		const k = e.k;
		if (k.length !== bgKeyN) continue;
		let i = 0;
		while (i < bgKeyN && k[i] === bgKey[i]) i++;
		if (i === bgKeyN) break;
	}
	if (!e) {
		e = { k: bgKey.slice(0, bgKeyN), bg: device.createBindGroup({ layout: bgl, entries: buildEntries() }), next: head || null };
		bgCreated++;
		bindGroupCache.set(h, e);
		trimBindGroups();
	}
	return { bg: e.bg, dyn };
}
// Side effects of building a bind group that must also happen when stageBG reuses it: the bound resources are in use by this encoder (an upload to them must flush first)
// and UAV textures were written (their depth proxies go stale). stageBindGroup collects them here, stageBG keeps a copy with the cached result and replays it.
const bgUsed = [], bgDirty = [];
function bgUse(o) { if (o) { usedInEncoder.add(o); bgUsed.push(o); o.inBG = true; } }
// Bind groups by a 30-bit hash of their numeric key (stageBindGroup), each bucket a chain of { k: key, bg, next }. The string keys this replaced (built by concatenation and
// hashed on every lookup) were ~40 % of stageBindGroup, which runs for every draw whose program's previous bindings changed.
const bindGroupCache = new Map();
const bgKey = [];
let bgKeyN = 0, nextUid = 1;
let bgCreated = 0, bgCreated0 = 0, bgEvicted = 0;
// Every cached bind group holds Direct3D descriptors (and references to the views/textures in it) until the JS object is collected. Keys contain resource ids, which are never reused,
// so an entry whose texture was destroyed (streaming does this constantly) is dead weight that would otherwise live forever: in a long session that exhausted the descriptor heaps
// (`CreateDescriptorHeap failed with E_OUTOFMEMORY`, device lost, black screen). Keep the newest BG_LIMIT; older ones are rebuilt on demand (cheap).
const BG_LIMIT = 24000;
function trimBindGroups() {
	if (bindGroupCache.size <= BG_LIMIT * 1.5) return;
	let drop = bindGroupCache.size - BG_LIMIT;
	for (const k of bindGroupCache.keys()) { bindGroupCache.delete(k); bgEvicted++; if (--drop <= 0) break; }
	for (const prog of progsWithFast) prog.fast = null;		// the fast path holds bind groups too
}
const progsWithFast = new Set();

// Draw isolation (page ?dbg=1): the page writes a draw limit N into the input block; only the first N draws of every frame run, and the pipeline of the
// last one that ran is reported back, so a user can find which draw paints an artifact. -1 = off.
let dbgIdx = 0, dbgFrameDraw = 0, dbgLastLabel = '', dbgChannel = null, dbgLastPost = 0;
const skipReasons = new Map();
// D3D11 features the mirror approximates or ignores: what is used (by pipeline label / sampler), counted for the exit report
const approx = new Map();
function noteApprox(feature, detail) { const k = feature + ': ' + detail; approx.set(k, (approx.get(k) || 0) + 1); }
function skipDraw(why) { skippedDraws++; skipReasons.set(why, (skipReasons.get(why) || 0) + 1); }

// Dynamic offsets through the typed-array overload (spec: dynamicOffsetsData, start, length): Chrome converts a JS array argument to a new sequence on every call. Browser only:
// the Node binding is not known to implement that overload.
const dynOffsets = new Uint32Array(8);
function setBG(enc, index, g) {
	const n = g.dyn.length;
	if (!n) enc.setBindGroup(index, g.bg);
	else if (isNode) enc.setBindGroup(index, g.bg, g.dyn);
	else { for (let i = 0; i < n; i++) dynOffsets[i] = g.dyn[i]; enc.setBindGroup(index, g.bg, dynOffsets, 0, n); }
}
function isBound(id) {
	if (S.layout === id || S.blend.id === id || S.dss.id === id || S.rs === id || S.ib.buf === id || S.shader[0] === id || S.shader[1] === id || S.shader[2] === id) return true;
	for (let i = 0; i < S.vb.length; i++) if (S.vb[i].buf === id) return true;
	return false;
}
function setScissorOnce(x, y, w, h) {
	const o = passSt.sc;
	if (o && o[0] === x && o[1] === y && o[2] === w && o[3] === h) return;
	pass.setScissorRect(x, y, w, h);
	const sc = passSt.sc || (passSt.sc = [0, 0, 0, 0]); sc[0] = x; sc[1] = y; sc[2] = w; sc[3] = h;
}

function doDraw(p) {
	// kind (0 draw, 1 indexed, 2 instanced, 3 indexed instanced), a..: vertexCount/indexCount, instanceCount, start, baseVertex, startInstance
	let dbgLimit = -1;
	if (dbgIdx) {
		dbgLimit = Atomics.load(i32, dbgIdx);
		if (dbgLimit >= 0 && dbgFrameDraw >= dbgLimit) { dbgFrameDraw++; return; }
		dbgFrameDraw++;
	}
	const kind = u32[p], count = u32[p + 1], inst = u32[p + 2], start = u32[p + 3], baseVertex = u32[p + 4] | 0, startInstance = u32[p + 5];
	// draws that cannot touch a pixel (D3D accepts them): no vertices or instances, an empty scissor rectangle, an empty viewport. Each still cost a full draw here and in the GPU process.
	if (kind < 4 && (count === 0 || inst === 0)) { noopDraws++; return; }
	if (S.viewports.length && (S.viewports[0][2] <= 0 || S.viewports[0][3] <= 0)) { noopDraws++; return; }
	if (S.scissors.length && S.rs) { const rs0 = objs.get(S.rs), c = S.scissors[0]; if (rs0 && rs0.words[7] && (c[2] <= c[0] || c[3] <= c[1])) { noopDraws++; return; } }
	// a draw into a reflection (REFLECT_EVERY): skipped while that face keeps its picture from an earlier frame
	const r0 = S.rt[0], t0 = r0.tex ? objs.get(r0.tex) : null;
	if (t0 && t0.reflect) {
		if (!reflectDue(t0, r0.slice)) { ov.reflSkip++; return; }
		ov.refl++;
	}
	let vsObj = S.shader[0] ? objs.get(S.shader[0]) : null;
	if (!vsObj) { skipDraw('if (!vsObj) { skippedDraws++; return; }'); return; }
	let psObj = S.shader[1] ? objs.get(S.shader[1]) : null;
	const layout = S.layout ? objs.get(S.layout) : null;
	if (!layout) { skipDraw('if (!layout) { skippedDraws++; return; }'); return; }
	let vsProg = shaderProgram(vsObj);
	let psProg = psObj ? shaderProgram(psObj) : null;
	if (!vsProg || (psObj && !psProg)) { skipDraw('if (!vsProg || (psObj && !psProg)) { skippedDraws++; return;'); return; }
	if (SKIP_FX.length && psProg && skipFxOf(psProg)) { fxSkipped++; return; }		// an effect left out altogether (SKIP_FX)
	if ((CHUNK.dist > 0 || CHUNK.tiny > 0 || OCCL) && kind < 4) { const c = chunkCull(vsProg, psProg, inst); if (c) { if (c === 1) chunkCulled++; else occlCulled++; return; } }		// too far, too small or hidden
	if (DEPTH_DIRECT) {		// a depth buffer sampled with textureSample: the variant that loads it (depthLoadFor), so it is bound as it is, with no copy pass
		const dv = depthLoadFor(vsObj, vsProg, 0), dp = psProg ? depthLoadFor(psObj, psProg, 1) : null;
		if (dv) { vsObj = dv.obj; vsProg = dv.prog; }
		if (dp) { psObj = dp.obj; psProg = dp.prog; }
		const a = dv && dv.obj, b = dp && dp.obj;
		if (lastDlVs !== a || lastDlPs !== b) { lastDlVs = a; lastDlPs = b; pdirty = true; }
	}
	if (vsProg.overTex || (psProg && psProg.overTex)) {		// more textures than this device allows per stage: a variant for the textures bound now (fitTextures)
		const vv = vsProg.overTex ? fitTextures(vsObj, vsProg, 0) : null, pv = psProg && psProg.overTex ? fitTextures(psObj, psProg, 1) : null;
		if ((vsProg.overTex && !vv) || (psProg && psProg.overTex && !pv)) { skipDraw('texture limit'); return; }
		if (vv) { vsObj = vv.obj; vsProg = vv.prog; }
		if (pv) { psObj = pv.obj; psProg = pv.prog; }
		if (lastFitVs !== vsObj || lastFitPs !== psObj) { lastFitVs = vsObj; lastFitPs = psObj; pdirty = true; }
	} else if (lastFitVs) { lastFitVs = lastFitPs = null; pdirty = true; }
	if (REFLECT_EVERY > 1 && psProg && t0 && !t0.reflectNot && t0.reflect !== undefined) waterReflection(t0, r0.slice, psProg);
	if (pendingClears.length && (drawReadsPending(vsProg, 0) || drawReadsPending(psProg, 1))) flushPendingClears();
	prepareDepthProxies(vsProg, 0);
	if (psProg) prepareDepthProxies(psProg, 1);
	for (let attempt = 0; ; attempt++) {
	if (!ensurePass()) { skipDraw('if (!ensurePass()) { skippedDraws++; return; }'); return; }
	if (attempt === 0) needSplit = false;
	if (passToName === passInfo) { passToName = null; namePass(psProg || vsProg); }
	let pl;
	if (!pdirty && lastPl && lastPlPass === passInfo) pl = lastPl;
	else {
		pl = getPipeline(vsObj, psObj, vsProg, psProg, layout, passInfo.rtInfo, passInfo.dsFormat);
		if (pl === PIPELINE_PENDING) { pendingSkips++; skippedDraws++; return; }		// still compiling: looked up again by the next draw (pdirty stays set)
		lastPl = pl; lastPlPass = passInfo; pdirty = false;
	}
	if (!pl) { skipDraw('if (!pl) { skippedDraws++; return; }'); return; }
	if (passSt.pl !== pl) { pass.setPipeline(pl); passSt.pl = pl; plSets++; }
	if (dbgIdx && dbgLimit >= 0 && dbgFrameDraw === dbgLimit) {
		const t0 = passInfo.rtInfo && passInfo.rtInfo[0];
		dbgLastLabel = '#' + (dbgFrameDraw - 1) + ' ' + (pl.label || '?') + ' target ' + (t0 ? t0.format : 'depth only') + ' ' + passInfo.width + 'x' + passInfo.height + ' n=' + count + (inst > 1 ? ' x' + inst : '');
	}
	// bind groups
	const g0 = vsProg.groupBindings[0] ? stageBG(0, vsProg, 0) : null;
	const g1 = psProg && psProg.groupBindings[1] ? stageBG(1, psProg, 1) : null;
	if (vsProg.groupBindings[0] && !g0) { skipDraw('if (vsProg.groupBindings[0] && !g0) { skippedDraws++; return'); return; }
	if (psProg && psProg.groupBindings[1] && !g1) { skipDraw('if (psProg && psProg.groupBindings[1] && !g1) { skippedDraws'); return; }
	if (g0) { const d = g0.dyn.length ? g0.dyn[0] : -1; if (passSt.bg0 !== g0.bg || passSt.dyn0 !== d) { setBG(pass, 0, g0); passSt.bg0 = g0.bg; passSt.dyn0 = d; bgSets++; } }
	if (g1) { const d = g1.dyn.length ? g1.dyn[0] : -1; if (passSt.bg1 !== g1.bg || passSt.dyn1 !== d) { setBG(pass, 1, g1); passSt.bg1 = g1.bg; passSt.dyn1 = d; bgSets++; } }
	// vertex / index buffers (baseVertex and startInstance are folded into the buffer offsets: SV_VertexID is zero based)
	const indexed = kind === 4 || (kind < 4 && (kind & 1) !== 0);
	// D3D's SV_VertexID / SV_InstanceID do not include the draw's base vertex / start instance (and this port treats StartVertexLocation the same); WebGPU's vertex_index / instance_index
	// do. Only for vertex shaders that read them are the starts folded into the vertex buffer offsets, which re-binds the buffers whenever a start changes; every other draw passes the
	// starts to the draw call and keeps its vertex buffers bound across draws.
	const foldV = vsProg.vid, foldI = vsProg.iid;
	const vFirst = indexed || foldV ? 0 : start, iFirst = foldI ? 0 : startInstance;
	const lslots = layout.slots;
	for (let k = 0; k < lslots.length; k++) {
		const e = lslots[k];
		const vb = S.vb[e.slot], o = vb.buf ? objs.get(vb.buf) : null;
		if (!o || !o.gpu) {		// unbound vertex slot: D3D reads zeros
			const z = zeroVertexBuffer();
			if (passSt.vb[e.slot] !== z || passSt.vbo[e.slot] !== 0) { pass.setVertexBuffer(e.slot, z); passSt.vb[e.slot] = z; passSt.vbo[e.slot] = 0; }
			vbAvail[e.slot] = ZERO_VB_SIZE;
			continue;
		}
		const shift = e.cls === 1 ? (foldI ? startInstance * vb.stride : 0) : (foldV ? (indexed ? baseVertex : start) * vb.stride : 0);
		const voff = vb.offset + shift < 0 ? 0 : vb.offset + shift;
		if (passSt.vb[e.slot] !== o.gpu || passSt.vbo[e.slot] !== voff) { pass.setVertexBuffer(e.slot, o.gpu, voff); vbSets++; passSt.vb[e.slot] = o.gpu; passSt.vbo[e.slot] = voff; }
		vbAvail[e.slot] = o.bytes - voff;
		usedInEncoder.add(o);
	}
	let ibMax = Infinity;
	if (indexed) {
		const ib = objs.get(S.ib.buf);
		if (!ib || !ib.gpu) { skipDraw('if (!ib || !ib.gpu) { skippedDraws++; return; }'); return; }
		const ifmt = S.ib.fmt === 57 ? 'uint16' : 'uint32';
		ibMax = Math.floor((ib.bytes - S.ib.offset) / (ifmt === 'uint16' ? 2 : 4)) - start;
		if (passSt.ib !== ib.gpu || passSt.ibFmt !== ifmt || passSt.ibOff !== S.ib.offset) { pass.setIndexBuffer(ib.gpu, ifmt, S.ib.offset); ibSets++; passSt.ib = ib.gpu; passSt.ibFmt = ifmt; passSt.ibOff = S.ib.offset; }
		usedInEncoder.add(ib);
	}
	// dynamic state
	if (S.viewports.length) {
		const v = S.viewports[0], o = passSt.vp;
		if (!o || o[0] !== v[0] || o[1] !== v[1] || o[2] !== v[2] || o[3] !== v[3] || o[4] !== v[4] || o[5] !== v[5]) {
			pass.setViewport(v[0], v[1], Math.max(1, v[2]), Math.max(1, v[3]), v[4], v[5]);
			const vp = passSt.vp || (passSt.vp = [0, 0, 0, 0, 0, 0]); for (let i = 0; i < 6; i++) vp[i] = v[i];
		}
	}
	const rs = S.rs ? objs.get(S.rs) : null;
	if (rs && rs.words[7] && S.scissors.length) {
		const c = S.scissors[0], x0 = Math.min(passInfo.width, c[0]), y0 = Math.min(passInfo.height, c[1]), x1 = Math.min(passInfo.width, Math.max(x0, c[2])), y1 = Math.min(passInfo.height, Math.max(y0, c[3]));
		setScissorOnce(x0, y0, x1 - x0, y1 - y0);
	} else setScissorOnce(0, 0, passInfo.width, passInfo.height);
	// the blend constant only for blend states that use it (D3D's BLEND_FACTOR / INV_BLEND_FACTOR), the stencil reference only with the stencil test on
	const bso = S.blend.id ? objs.get(S.blend.id) : null;
	if (bso && (bso.usesConst !== undefined ? bso.usesConst : (bso.usesConst = blendUsesConst(bso)))) {
		const bf = S.blend.factor, ob = passSt.bf;
		if (!ob || ob[0] !== bf[0] || ob[1] !== bf[1] || ob[2] !== bf[2] || ob[3] !== bf[3]) { pass.setBlendConstant(bf); const sb = passSt.bf || (passSt.bf = [0, 0, 0, 0]); sb[0] = bf[0]; sb[1] = bf[1]; sb[2] = bf[2]; sb[3] = bf[3]; }
	}
	if (passSt.sref !== S.dss.ref && passInfo.dsFormat && hasStencil(passInfo.dsFormat)) {
		const dso = S.dss.id ? objs.get(S.dss.id) : null;
		if (dso && dso.words[3]) { pass.setStencilReference(S.dss.ref); passSt.sref = S.dss.ref; }
	}
	if (debugPs && psProg && psProg.label.includes(debugPs) && debugPsSeen < debugPsN) { debugPsSeen++; dumpDraw(kind, count, inst, start, baseVertex, vsProg, psProg, layout, g0, g1, true); debugPsProbe = { ps: psProg }; }
	if (debugDraw && drawCount >= debugDraw && drawCount < debugDraw + debugDrawN) dumpDraw(kind, count, inst, start, baseVertex, vsProg, psProg, layout, g0, g1);
	if (kind >= 4) { const a = objs.get(u32[p + 1]); if (a && a.pendCopy) needSplit = true; }
	if (needSplit && attempt === 0) { needSplit = false; copySplits++; endPass(); continue; }		// this draw reads a resource whose upload waits for the pass end: that comes first
	if (kind >= 4) {
		const args = objs.get(u32[p + 1]);
		if (!args || !args.gpu) { skipDraw('indirect draw without an argument buffer'); return; }
		usedInEncoder.add(args);
		if (kind === 4) pass.drawIndexedIndirect(args.gpu, u32[p + 2]); else pass.drawIndirect(args.gpu, u32[p + 2]);
		indirectDraws++;
	} else {
		// D3D11 reads zeros past the end of a vertex/index buffer; WebGPU rejects the draw, and an invalid draw invalidates the whole command buffer: every draw of that submit
		// is lost (seen in play: a frame's 3D vanished while the UI, submitted later, kept drawing over the stale image). Clamp the counts to what the bound buffers hold; the
		// elements dropped are the ones D3D would have fed zeros.
		let dCount = count, dInst = inst;
		const req = pl.vbReq || [];
		for (let i = 0; i < req.length; i++) {
			const r = req[i], avail = vbAvail[r.slot];
			const n = avail < r.last ? 0 : (r.stride ? Math.floor((avail - r.last) / r.stride) + 1 : Infinity);
			if (r.instance) { if (dInst > n - iFirst) dInst = n - iFirst; } else if (!indexed && dCount > n - vFirst) dCount = n - vFirst;
		}
		if (indexed && dCount > ibMax) dCount = Math.max(0, ibMax);
		if (dCount !== count || dInst !== inst) {
			clampedDraws++;
			logOnce('clamp' + pl.label, 'draw clamped to its buffers (' + pl.label + '): ' + (indexed ? 'indexed ' : '') + count + ' x ' + inst + ' -> ' + dCount + ' x ' + dInst);
			if (dCount <= 0 || dInst <= 0) { skipDraw('vertex/instance/index buffer smaller than the draw'); return; }
		}
		if (indexed) pass.drawIndexed(dCount, dInst, start, foldV ? 0 : baseVertex, iFirst);
		else pass.draw(dCount, dInst, vFirst, iFirst);
	}
	break;
	}
	drawCount++;
	{ const ep = psProg || vsProg; if (ep.ovN) ep.ovN++; else { ep.ovN = 1; ovProgs.push(ep); } }		// the overlay's draws per effect
	if (gpuTiming.cur && !gpuTiming.cur.effect) { const l = (psProg || vsProg).label || '', k = l.indexOf('::'); gpuTiming.cur.effect = k > 0 ? l.slice(0, k) : l; }
	if (nanHuntState === 2) { nanHuntLabel = vsProg.label + ' + ' + (psProg ? psProg.label : '-') + ' (draw ' + drawCount + ')'; nanHuntPs = psProg; nanHuntVs = vsProg; }
	if (shotEvery || shotAllRt) {
		const t0 = S.rt[0].tex ? objs.get(S.rt[0].tex) : null;
		const tk = 'rt0=' + S.rt[0].tex + (t0 ? '(' + t0.desc.size.width + 'x' + t0.desc.size.height + ' ' + t0.format + ')' : '') + ' ds=' + S.ds.tex;
		frameStats.targets.set(tk, (frameStats.targets.get(tk) || 0) + 1);
		for (const r of S.rt) if (r.tex) frameStats.rts.add(r.tex);
		frameStats.pipes.set(vsProg.label + ' + ' + (psProg ? psProg.label : '-'), (frameStats.pipes.get(vsProg.label + ' + ' + (psProg ? psProg.label : '-')) || 0) + 1);
	}
}
const debugPs = isNode ? (process.env.WGPU_DEBUG_PS || '') : '', debugPsN = isNode ? +(process.env.WGPU_DEBUG_PS_N || 2) : 0;
let debugPsSeen = 0, debugPsProbe = null;
const debugDraw = isNode ? +(process.env.WGPU_DEBUG_DRAW || 0) : 0, debugDrawN = isNode ? +(process.env.WGPU_DEBUG_DRAW_N || 1) : 0;
function dumpDraw(kind, count, inst, start, baseVertex, vsProg, psProg, layout, g0, g1, allSrv) {
	const rs = S.rs ? objs.get(S.rs) : null, bl = S.blend.id ? objs.get(S.blend.id) : null, ds = S.dss.id ? objs.get(S.dss.id) : null;
	const lines = ['DRAW #' + drawCount + ' kind ' + kind + ' count ' + count + ' inst ' + inst + ' start ' + start + ' base ' + baseVertex + ' ' + vsProg.label + ' + ' + (psProg ? psProg.label : '-'),
		'  viewport ' + JSON.stringify(S.viewports[0]) + ' scissor ' + JSON.stringify(S.scissors[0]) + ' topo ' + S.topo,
		'  raster ' + (rs ? rs.words.join(',') : 'default') + ' | blend ' + (bl ? bl.words.slice(0, 10).join(',') : 'default') + ' | dss ' + (ds ? ds.words.join(',') : 'default'),
		'  vs pack ' + (vsProg.pack ? vsProg.pack.members.map((m) => 'b' + m.binding + ':' + m.size).join(' ') : 'none') + ' | ps pack ' + (psProg && psProg.pack ? psProg.pack.members.map((m) => 'b' + m.binding + ':' + m.size).join(' ') : 'none')];
	for (const e of layout.els) {
		const vb = S.vb[e.slot], o = vb.buf ? objs.get(vb.buf) : null;
		if (o && o.dbg) lines.push('  vb bytes @' + vb.offset + ': ' + Array.from(o.dbg.subarray(vb.offset, vb.offset + 40)).join(','));
		lines.push('  el slot ' + e.slot + ' fmt ' + e.fmt + ' off ' + e.offset + ' vb ' + vb.buf + ' stride ' + vb.stride + ' voff ' + vb.offset + (o ? ' size ' + o.size : ' UNBOUND'));
	}
	for (const [st, prog] of [[0, vsProg], [1, psProg]]) {
		if (!prog || !prog.pack) continue;
		for (const m of prog.pack.members) {
			const c = S.cb[st][m.binding], o = c.buf ? objs.get(c.buf) : null;
			lines.push('  ' + STAGE_NAME[st] + ' cb b' + m.binding + ' buf ' + c.buf + (o && o.shadow ? ' v' + o.version + ' [' + Array.from(new Float32Array(o.shadow.buffer, o.shadow.byteOffset, Math.min(48, o.shadow.length >> 2))).map((x) => +x.toPrecision(4)).join(',') + ']' : ' NO SHADOW'));
		}
	}
	for (let i = 0; i < (allSrv ? 32 : 8); i++) {
		const sid = S.srv[1][i], srv = sid ? objs.get(sid) : null, t = srv ? objs.get(srv.res) : null;
		if (t) lines.push('  ps srv t' + i + ' -> res ' + srv.res + ' ' + t.format + ' ' + t.desc.size.width + 'x' + t.desc.size.height + ' mips ' + t.desc.mipLevelCount + ' uploads ' + (t.uploads || 0) + ' ' + (t.lastUpload || ''));
	}
	lines.push('  srv ps ' + S.srv[1].slice(0, 8).join(',') + ' smp ' + S.smp[1].slice(0, 4).join(','));
	logLine(lines.join('\n'));
}
async function probeUavs() {
	flush();
	for (let i = 0; i < 8; i++) {
		const uid = S.uav[2][i], u = uid ? objs.get(uid) : null, t = u && !u.isBuf ? objs.get(u.res) : null;
		if (!t || t.tex.width * t.tex.height > 4096 || !TEXTURE_PROBE[t.format]) continue;
		const bpp = TEXTURE_PROBE[t.format], w = t.tex.width, h = t.tex.height, bpr = Math.ceil(w * bpp / 256) * 256;
		const rb = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		const enc = device.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: t.tex }, { buffer: rb, bytesPerRow: bpr }, { width: w, height: h });
		device.queue.submit([enc.finish()]);
		await rb.mapAsync(GPUMapMode.READ);
		const raw = new DataView(rb.getMappedRange().slice(0));
		const vals = [];
		for (let k = 0; k < Math.min(8, bpp / 4 * w * h); k++) vals.push(raw.getFloat32(k * 4, true));
		logLine('  after dispatch: uav u' + i + ' ' + t.format + ' ' + w + 'x' + h + ' first values ' + vals.map((v) => +v.toPrecision(5)).join(','));
		rb.unmap(); rb.destroy();
	}
}

async function probeSmallSrvs() {
	// print the contents of tiny bound textures (exposure/luminance values) for the draw dumped by WGPU_DEBUG_PS
	if (!debugPsProbe) return;
	debugPsProbe = null;
	flush();
	const cand = [];
	for (let i = 0; i < 32; i++) { const sid = S.srv[1][i], srv = sid ? objs.get(sid) : null; if (srv && !srv.isBuf) cand.push(['t' + i, objs.get(srv.res)]); }
	for (let i = 0; i < 8; i++) if (S.rt[i].tex) cand.push(['RT' + i, objs.get(S.rt[i].tex)]);
	for (const [name, t] of cand) {
		if (!t || t.tex.width * t.tex.height > 1024 || !TEXTURE_PROBE[t.format]) continue;
		const bpp = TEXTURE_PROBE[t.format], w = t.tex.width, h = t.tex.height, bpr = Math.ceil(w * bpp / 256) * 256;
		const rb = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		const enc = device.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: t.tex }, { buffer: rb, bytesPerRow: bpr }, { width: w, height: h });
		device.queue.submit([enc.finish()]);
		await rb.mapAsync(GPUMapMode.READ);
		const raw = new DataView(rb.getMappedRange().slice(0));
		const vals = [];
		for (let k = 0; k < Math.min(8, bpp / 4 * w * h); k++) vals.push(t.format.includes('16float') ? halfToFloat(raw.getUint16(k * 2, true)) : raw.getFloat32(k * 4, true));
		logLine('  small texture ' + name + ' ' + t.format + ' ' + w + 'x' + h + ' first values ' + vals.map((v) => +v.toPrecision(5)).join(','));
		rb.unmap(); rb.destroy();
	}
}
const TEXTURE_PROBE = { 'r32float': 4, 'rg32float': 8, 'rgba32float': 16, 'r16float': 2, 'rg16float': 4, 'rgba16float': 8 };

async function probeTarget() {
	const r = S.rt[0], t = r.tex ? objs.get(r.tex) : null;
	if (!t) return;
	flush();
	const w = t.desc.size.width, h = t.desc.size.height, bpr = Math.ceil(w * 4 / 256) * 256;
	const rb = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
	const enc = device.createCommandEncoder();
	enc.copyTextureToBuffer({ texture: t.tex }, { buffer: rb, bytesPerRow: bpr }, { width: w, height: h });
	device.queue.submit([enc.finish()]);
	await rb.mapAsync(GPUMapMode.READ);
	const src = new Uint8Array(rb.getMappedRange());
	let sum = 0, nz = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * bpr + x * 4; const v = src[i] + src[i + 1] + src[i + 2]; sum += v; if (v) nz++; }
	rb.unmap(); rb.destroy();
	logLine('  probe after draw #' + (drawCount - 1) + ': non-black pixels ' + nz + ' of ' + w * h);
}
const frameStats = { targets: new Map(), pipes: new Map(), rts: new Set() };
function dumpFrameStats() {
	if (approx.size) logLine('approximated D3D features: ' + [...approx].sort((a, b) => b[1] - a[1]).filter(([k]) => !k.startsWith('MipLODBias')).slice(0, 60).map(([k, n]) => k + ' x' + n).join(' | '));
	if (skipReasons.size) logLine('skipped draws by reason: ' + [...skipReasons].map(([k, n]) => k + ' x' + n).join(' | '));
	logLine('draws by target since last dump: ' + [...frameStats.targets].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => k + ' x' + n).join(' | '));
	logLine('top pipelines: ' + [...frameStats.pipes].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => k + ' x' + n).join(' | '));
	frameStats.targets.clear(); frameStats.pipes.clear();
}
async function dumpAllTargets() {
	const ids = [...frameStats.rts];
	frameStats.rts.clear();
	for (const tid of ids.slice(0, 24)) { const t = objs.get(tid); if (t && t.desc.size.width >= 64) await screenshot(tid, shotPrefix + 'rt' + tid + '_' + String(presentCount).padStart(6, '0') + '.png'); }
}

// ---- copies (GPU to GPU) ------------------------------------------------------------------------------------------------------------
function subresourceOf(t, sub) {
	const mips = t.desc.mipLevelCount;
	return { mip: sub % mips, layer: Math.floor(sub / mips) };
}
function mipSize(t, mip) {
	const d = t.desc;
	return { w: Math.max(1, d.size.width >> mip), h: Math.max(1, d.size.height >> mip), d: d.dimension === '3d' ? Math.max(1, d.size.depthOrArrayLayers >> mip) : 1 };
}
// D3D11 allows CopySubresourceRegion between a block-compressed texture and an uncompressed one whose texel size equals the block size (one texel = one
// block: the GPU block compressor of the head blend renders to a small R16G16B16A16/R32G32 target and copies it into a BC1/BC3 texture). WebGPU refuses
// texture-to-texture copies between the formats; the bytes go through a buffer, which is format agnostic.
function blockBytes(format) { return /^(bc1|bc4)/.test(format) ? 8 : /^bc/.test(format) ? 16 : 0; }
function texelBytesOf(format) {
	if (/^(rgba32|rgba16|rg32|r32g32)/.test(format)) return format.startsWith('rgba32') ? 16 : 8;
	if (/^(rgba8|bgra8|r32|rg16|rgb10|rg11|rgb9)/.test(format)) return 4;
	if (/^(rg8|r16)/.test(format)) return 2;
	return /^r8/.test(format) ? 1 : 0;
}
let scratchBuf = null;
function scratch(size) {
	if (!scratchBuf || scratchBuf.size < size) scratchBuf = device.createBuffer({ size: Math.max(size, 1 << 16), usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
	return scratchBuf;
}
function copyThroughBuffer(s, ss, d, ds, w, h, hasBox, l, t, dx, dy) {
	const sb = blockBytes(s.format), db = blockBytes(d.format);
	const bytes = sb || db;		// bytes per block == bytes per texel of the other side
	// number of blocks/texels copied (in units of the *uncompressed* side)
	const cw = sb ? Math.ceil(w / 4) : w, ch = sb ? Math.ceil(h / 4) : h;
	const bpr = Math.ceil(cw * bytes / 256) * 256;
	const buf = scratch(bpr * ch);
	const so = { x: hasBox ? l : 0, y: hasBox ? t : 0, z: ss.layer }, dO = { x: dx, y: dy, z: ds.layer };
	const enc = getEncoder();
	enc.copyTextureToBuffer({ texture: s.tex, mipLevel: ss.mip, origin: so }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: ch }, { width: sb ? cw * 4 : cw, height: sb ? ch * 4 : ch, depthOrArrayLayers: 1 });
	enc.copyBufferToTexture({ buffer: buf, bytesPerRow: bpr, rowsPerImage: ch }, { texture: d.tex, mipLevel: ds.mip, origin: dO }, { width: db ? cw * 4 : cw, height: db ? ch * 4 : ch, depthOrArrayLayers: 1 });
}
function copyRegion(dstId, dstSub, dx, dy, dz, srcId, srcSub, hasBox, l, t, f, r, b, bk) {
	const s = objs.get(srcId), d = objs.get(dstId);
	if (!s || !d) return;
	endPass();
	if (s.kind === 'buffer') {
		if (!s.gpu || !d.gpu) return;
		const size = hasBox ? r - l : Math.min(s.size, d.size);
		getEncoder().copyBufferToBuffer(s.gpu, hasBox ? l : 0, d.gpu, dx, size & ~3);
		usedInEncoder.add(s); usedInEncoder.add(d);
		return;
	}
	if (s.kind !== 'texture' || d.kind !== 'texture') return;
	const ss = subresourceOf(s, srcSub), ds = subresourceOf(d, dstSub);
	const m = mipSize(s, ss.mip);
	const w = hasBox ? r - l : m.w, h = hasBox ? b - t : m.h, dep = hasBox ? bk - f : m.d;
	const three = s.desc.dimension === '3d';
	if (s.format !== d.format && !three && d.desc.dimension !== '3d' && (blockBytes(s.format) !== 0) !== (blockBytes(d.format) !== 0)
		&& (blockBytes(s.format) || blockBytes(d.format)) === (texelBytesOf(s.format) || texelBytesOf(d.format))) {
		copyThroughBuffer(s, ss, d, ds, w, h, hasBox, l, t, dx, dy);
		markDepthDirty(d); markColorDirty(d);
		usedInEncoder.add(s); usedInEncoder.add(d);
		return;
	}
	try {
		getEncoder().copyTextureToTexture(
			{ texture: s.tex, mipLevel: ss.mip, origin: { x: hasBox ? l : 0, y: hasBox ? t : 0, z: three ? (hasBox ? f : 0) : ss.layer } },
			{ texture: d.tex, mipLevel: ds.mip, origin: { x: dx, y: dy, z: d.desc.dimension === '3d' ? dz : ds.layer } },
			{ width: w, height: h, depthOrArrayLayers: three ? dep : 1 });
	} catch (e) { logOnce('copyfail', 'copyTextureToTexture failed: ' + e.message); }
	markDepthDirty(d); markColorDirty(d);
	usedInEncoder.add(s); usedInEncoder.add(d);
}
function copyResource(dstId, srcId) {
	const s = objs.get(srcId), d = objs.get(dstId);
	if (!s || !d) return;
	if (s.kind === 'buffer') { copyRegion(dstId, 0, 0, 0, 0, srcId, 0, 0, 0, 0, 0, 0, 0, 0); return; }
	if (s.kind !== 'texture' || d.kind !== 'texture') return;
	endPass();
	const mips = Math.min(s.desc.mipLevelCount, d.desc.mipLevelCount);
	for (let mip = 0; mip < mips; mip++) {
		const m = mipSize(s, mip);
		const layers = s.desc.dimension === '3d' ? m.d : s.desc.size.depthOrArrayLayers;
		try {
			getEncoder().copyTextureToTexture({ texture: s.tex, mipLevel: mip }, { texture: d.tex, mipLevel: mip }, { width: m.w, height: m.h, depthOrArrayLayers: layers });
		} catch (e) { logOnce('copyfail2', 'copyTextureToTexture (resource) failed: ' + e.message); }
	}
	markDepthDirty(d); markColorDirty(d);
	usedInEncoder.add(s); usedInEncoder.add(d);
}
function resolve(dstId, dstSub, srcId, srcSub) {
	const s = objs.get(srcId), d = objs.get(dstId);
	if (!s || !d || s.kind !== 'texture' || d.kind !== 'texture') return;
	endPass();
	const ss = subresourceOf(s, srcSub), ds = subresourceOf(d, dstSub);
	const sv = s.tex.createView({ baseMipLevel: ss.mip, mipLevelCount: 1, baseArrayLayer: ss.layer, arrayLayerCount: 1, dimension: '2d' });
	const dv = d.tex.createView({ baseMipLevel: ds.mip, mipLevelCount: 1, baseArrayLayer: ds.layer, arrayLayerCount: 1, dimension: '2d' });
	getEncoder().beginRenderPass({ colorAttachments: [{ view: sv, resolveTarget: dv, loadOp: 'load', storeOp: 'discard' }] }).end();
	markColorDirty(d);
	usedInEncoder.add(s); usedInEncoder.add(d);
}

// ---- queries -------------------------------------------------------------------------------------------------------------------------
// Occlusion: the samples passed in the passes between Begin and End (WebGPU reports whether any sample passed, not a count, so the result is
// 0 or 1: fine for the engine's visibility tests, flare intensity is on/off). One query-set slot per (query, pass). Event/timestamp: complete
// when the GPU has finished everything submitted so far. A query's result is stored into a slot in the wasm memory (`done` written last).
// Dawn's D3D12 backend reports occlusion as binary (0 or 1) but the engine compares the count with pixel thresholds (`> 100`), so a query that
// passed reports this many samples: visibility tests work, partial-visibility fades (flares) saturate.
const OCCLUSION_VISIBLE_COUNT = 65536n;
const queries = new Map();
const occlusion = { set: null, capacity: 2048, next: 0, active: null, passSlot: -1, inflight: [] };
const pendingResolve = [], pendingEvents = [];
function queryStore(q, result, seq) {
	refreshViews();
	const base = w32(q.addr);
	// result: low/high words (offset 8), then done (offset 0)
	const lo = Number(BigInt.asUintN(32, BigInt(result))), hi = Number(BigInt.asUintN(32, BigInt(result) >> 32n));
	Atomics.store(i32, base + 2, lo | 0); Atomics.store(i32, base + 3, hi | 0);
	Atomics.store(i32, base, seq | 0);
	Atomics.notify(i32, base);
}
function createQuery(id, type, addr) {
	queries.set(id, { kind: 'query', type, addr, slots: [], seq: 0 });
	objs.set(id, queries.get(id));
	if (!occlusion.set) occlusion.set = device.createQuerySet({ type: 'occlusion', count: occlusion.capacity });
}
// D3D11_QUERY: EVENT 0, OCCLUSION 1, TIMESTAMP 2, TIMESTAMP_DISJOINT 3, PIPELINE_STATISTICS 4, OCCLUSION_PREDICATE 5
const isOcclusion = (q) => q.type === 1 || q.type === 5;
function beginOcclusionInPass() {
	const q = occlusion.active;
	if (!q || !pass || occlusion.passSlot >= 0) return;
	if (occlusion.next >= occlusion.capacity) { logOnce('qfull', 'occlusion query set exhausted'); return; }
	occlusion.passSlot = occlusion.next++;
	q.slots.push(occlusion.passSlot);
	pass.beginOcclusionQuery(occlusion.passSlot); occqN++;
}
function endOcclusionInPass() {
	if (pass && occlusion.passSlot >= 0) { pass.endOcclusionQuery(); occlusion.passSlot = -1; }
}
function beginQuery(id) {
	const q = queries.get(id);
	if (!q || !isOcclusion(q)) return;
	q.slots = [];
	occlusion.active = q;
	beginOcclusionInPass();
}
function endQuery(id, seq) {
	const q = queries.get(id);
	if (!q) return;
	q.seq = seq;
	if (isOcclusion(q)) {
		if (occlusion.active === q) { endOcclusionInPass(); occlusion.active = null; }
		pendingResolve.push({ q, seq, slots: q.slots });
		q.slots = [];
	} else {
		pendingEvents.push({ q, seq, time: BigInt(Math.round(performance.now() * 1e6)) });
	}
}
// Staging buffers that are created and dropped all the time (readbacks, occlusion resolves) are kept per (usage, size) and reused: createBuffer/destroy per use cost more than
// the copy. At most 4 per kind.
const bufferPool = new Map();
function pooledBuffer(size, usage) {
	const l = bufferPool.get(usage * 4294967296 + size);
	return l && l.length ? l.pop() : device.createBuffer({ size, usage });
}
function releaseBuffer(b, size, usage) {
	const k = usage * 4294967296 + size;
	let l = bufferPool.get(k);
	if (!l) bufferPool.set(k, l = []);
	if (l.length < 4) l.push(b); else b.destroy();
}
// Occlusion queries ended since the last submit are resolved by commands recorded at the end of the encoder being submitted (they had a command buffer and two new buffers of
// their own per submit). A query's slots are consecutive (one active query at a time, slots taken in order, the wrap only happens with no query active): one resolve per query,
// its 8-byte results packed from a 256-aligned offset.
function recordResolves() {
	const list = pendingResolve.splice(0);
	const layout = [];
	let bytes = 0;
	for (const r of list) {
		const k = r.slots.length;
		if (!k) { queryStore(r.q, 0, r.seq); continue; }
		const s0 = r.slots[0];
		let consecutive = true;
		for (let i = 1; i < k; i++) if (r.slots[i] !== s0 + i) { consecutive = false; break; }
		layout.push(r, bytes, consecutive);
		bytes += consecutive ? Math.ceil(k * 8 / 256) * 256 : k * 256;
	}
	if (occlusion.next > occlusion.capacity - 256 && !occlusion.active) occlusion.next = 0;		// slots are reusable once resolved (the resolves are recorded before any later pass)
	if (!bytes) return null;
	let size = 256;
	while (size < bytes) size *= 2;
	const RU = GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC, MU = GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ;
	const rb = pooledBuffer(size, RU), map = pooledBuffer(size, MU);
	const enc = getEncoder();
	for (let j = 0; j < layout.length; j += 3) {
		const r = layout[j], at = layout[j + 1];
		if (layout[j + 2]) enc.resolveQuerySet(occlusion.set, r.slots[0], r.slots.length, rb, at);
		else for (let i = 0; i < r.slots.length; i++) enc.resolveQuerySet(occlusion.set, r.slots[i], 1, rb, at + i * 256);
	}
	enc.copyBufferToBuffer(rb, 0, map, 0, bytes);
	return { layout, rb, map, size, RU, MU };
}
let readbacksInFlight = 0, readbacksDone = 0, readbackMs = 0, resolvesInFlight = 0;
const waitedOn = { readback: 0, occlusion: 0, fence: 0 };		// ms this worker sat idle while each kind of GPU answer was outstanding (the overlay)
function mapResolves(res) {
	resolvesInFlight++;
	res.map.mapAsync(GPUMapMode.READ).then(() => {
		resolvesInFlight--;
		const v = new BigUint64Array(res.map.getMappedRange());
		const L = res.layout;
		for (let j = 0; j < L.length; j += 3) {
			const r = L[j], base = L[j + 1] / 8, step = L[j + 2] ? 1 : 32;
			let sum = 0n;
			for (let i = 0; i < r.slots.length; i++) sum += v[base + i * step];
			queryStore(r.q, sum !== 0n ? OCCLUSION_VISIBLE_COUNT : 0n, r.seq);
		}
		res.map.unmap();
		releaseBuffer(res.map, res.size, res.MU); releaseBuffer(res.rb, res.size, res.RU);
	}, () => { resolvesInFlight--; res.map.destroy(); res.rb.destroy(); });
}
// after a submit: complete events once the GPU has caught up
// The game's GPU fences (D3D11 event queries): it waits on them to pace its frames (a frame or two ahead of the GPU) and before it reuses memory the GPU may still read.
// Answered when the GPU reported the work done, each wait was a round trip through Chrome's GPU process (everything submitted so far, then the notification back): on a
// throttled 4-thread Chromebook the game stopped and waited 1-2 times a frame (the overlay's "idle" submits: the game sent nothing while a fence was pending). Here a
// fence passes when its commands are submitted: every later write of the game's data (queue.writeBuffer/writeTexture, staged copies) is ordered on the queue after
// the work already submitted, and destroying something still in use waits for the GPU (deferredDestroys; WebGPU itself for submitted work), so nothing the GPU still
// reads changes under it. How far the game gets ahead is still bounded by this worker's own wait at the present (FRAME_SLOTS frames). ?gpufences=1: answered when the
// GPU is done, as before (diagnostics).
const FENCES_AT_SUBMIT = isNode ? process.env.WGPU_GPU_FENCES !== '1' : new URLSearchParams(self.location.search).get('gpufences') !== '1';
let fencesInFlight = 0;
function onSubmitted() {
	if (pendingEvents.length) {
		const evs = pendingEvents.splice(0);
		let late = evs;
		if (FENCES_AT_SUBMIT) { late = []; for (const e of evs) { if (e.q.type === 0) queryStore(e.q, 1, e.seq); else late.push(e); } }
		if (late.length) {
			fencesInFlight += late.length;
			device.queue.onSubmittedWorkDone().then(() => { fencesInFlight -= late.length; for (const e of late) queryStore(e.q, e.q.type === 2 ? e.time : 1, e.seq); });
		}
	}
}

// ---- UAV counters (append/consume/counter buffers): vkd3d gives them a separate storage buffer; one per D3D buffer ------------------------
function counterBuffer(bufObj) {
	if (!bufObj.counter) bufObj.counter = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
	return bufObj.counter;
}
// Append/consume counter resets (D3D: initial counts in SetUnorderedAccessViews) happen at their place in the command stream: the value goes into its own slot of counterSrc
// (queue.writeBuffer lands before the command buffer submitted afterwards) and a copy into the counter is recorded, so earlier dispatches/draws still see the old value without a
// submit (one per reset before: 6-11 per frame in some scenes). Slots are reused after the next submit.
const COUNTER_SLOTS = 1024, counterVal = new Uint32Array(1);
let counterSrc = null, counterSlot = 0;
function setUavCounter(uavId, value) {
	const uav = objs.get(uavId), buf = uav && uav.isBuf ? objs.get(uav.res) : null;
	if (!buf) return;
	if (!counterSrc) counterSrc = device.createBuffer({ size: COUNTER_SLOTS * 4, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
	if (counterSlot >= COUNTER_SLOTS) flush('uav counter');		// resets counterSlot
	const slot = counterSlot++;
	counterVal[0] = value >>> 0;
	device.queue.writeBuffer(counterSrc, slot * 4, counterVal);
	endPass();
	getEncoder().copyBufferToBuffer(counterSrc, slot * 4, counterBuffer(buf), 0, 4);
	usedInEncoder.add(buf);
}
const debugCounters = isNode ? +(process.env.WGPU_DEBUG_COUNTERS || 0) : 0;
let counterLogged = 0, indirectDraws = 0;
async function logCounter(uavId) {
	const uav = objs.get(uavId), buf = uav && uav.isBuf ? objs.get(uav.res) : null;
	if (!buf || !buf.counter) { logLine('counter of uav ' + uavId + ': none'); return; }
	flush();
	const rb = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
	const enc = device.createCommandEncoder();
	enc.copyBufferToBuffer(buf.counter, 0, rb, 0, 16);
	device.queue.submit([enc.finish()]);
	await rb.mapAsync(GPUMapMode.READ);
	logLine('counter of uav ' + uavId + ' (buffer ' + uav.res + ') = ' + new Uint32Array(rb.getMappedRange())[0] + '; indirect draws so far ' + indirectDraws);
	rb.unmap(); rb.destroy();
}
function copyCounter(dstId, offset, uavId) {
	const dst = objs.get(dstId), uav = objs.get(uavId), src = uav && uav.isBuf ? objs.get(uav.res) : null;
	if (!dst || !dst.gpu || !src) return;
	endPass();
	getEncoder().copyBufferToBuffer(counterBuffer(src), 0, dst.gpu, offset, 4);
	usedInEncoder.add(dst); usedInEncoder.add(src);
}

// ---- compute --------------------------------------------------------------------------------------------------------------------------
const computeCache = new Map();
function computePipelineFor(csObj, prog) {
	// the WGSL declares typed storage textures with a format guessed from the component count; the pipeline needs the real one
	const subs = [];
	for (const b of prog.groupBindings[0] || []) {
		if (b.kind !== 'storage-texture') continue;
		const uav = S.uav[2][b.binding - 160] ? objs.get(S.uav[2][b.binding - 160]) : null;
		const t = uav && !uav.isBuf ? objs.get(uav.res) : null;
		if (t && t.format !== b.format) subs.push([b.binding, b.format, t.format]);
	}
	const key = csObj.hash + '|' + subs.join(';');
	let pl = computeCache.get(key);
	if (pl !== undefined) return pl;
	let module = prog.module, bindings = prog.info.bindings;
	if (subs.length) {
		let text = prog.text;
		for (const [binding, from, to] of subs) text = text.replace(new RegExp('(@binding\\(' + binding + 'u?\\)\\s*var\\s+\\w+\\s*:\\s*texture_storage_\\w+<)' + from), '$1' + to);
		module = device.createShaderModule({ code: text, label: prog.label + ' [uav formats]' });
		bindings = parseWgsl(text).bindings;
	}
	const entries = bindings.filter((b) => b.group === 0).map((b) => layoutEntry(b, 2));
	const layout = device.createPipelineLayout({ bindGroupLayouts: [device.createBindGroupLayout({ entries })] });
	try { pl = device.createComputePipeline({ layout, compute: { module, entryPoint: 'main' }, label: prog.label }); }
	catch (e) { logLine('compute pipeline failed (' + prog.label + '): ' + e.message); pl = null; }
	computeCache.set(key, { pl, bgl: pl ? pl.getBindGroupLayout(0) : null, bindings });
	return computeCache.get(key);
}
let dispatchCount = 0, setCsLogged = 0;
const debugCs = isNode ? +(process.env.WGPU_DEBUG_CS || 0) : 0, debugCsN = debugCs;
let debugCsProbe = false;
function doDispatch(x, y, z) {
	const cs = S.shader[2] ? objs.get(S.shader[2]) : null;
	if (!cs) { skippedDraws++; logOnce('dispatch-nocs', 'Dispatch with no compute shader bound'); return; }
	const prog = shaderProgram(cs);
	if (!prog) { skippedDraws++; logOnce('dispatch-noprog' + cs.hash, 'Dispatch skipped: compute shader ' + cs.hash + ' has no WGSL'); return; }
	prepareDepthProxies(prog, 2);
	endPass();
	const cp = computePipelineFor(cs, prog);
	if (!cp || !cp.pl) { skippedDraws++; logOnce('dispatch-nopl' + prog.label, 'Dispatch skipped: no compute pipeline for ' + prog.label); return; }
	// the program view with the pipeline's bindings is made once per pipeline: a new object per dispatch defeated the per-program pack cache (constants re-packed every time)
	const cprog = cp.prog || (cp.prog = { ...prog, groupBindings: { 0: cp.bindings.filter((b) => b.group === 0).sort((a, b) => a.binding - b.binding) }, packEnts: undefined, uid: 0, fast: undefined, idSrc: undefined, bgls: [] });
	const g0 = stageBindGroup(2, cprog, 0, cp.bgl);
	if (!g0) { skippedDraws++; logOnce('dispatch-nobg' + prog.label, 'Dispatch skipped: bind group failed for ' + prog.label); return; }
	const cpass = getEncoder().beginComputePass();
	cpass.setPipeline(cp.pl);
	setBG(cpass, 0, g0);
	cpass.dispatchWorkgroups(x, y, z);
	cpass.end();
	dispatchCount++;
	if (debugCs && dispatchCount <= debugCsN) {
		const info = ['DISPATCH #' + dispatchCount + ' ' + prog.label + ' ' + x + 'x' + y + 'x' + z];
		for (let i = 0; i < 16; i++) { const sid = S.srv[2][i], srv = sid ? objs.get(sid) : null, t = srv && !srv.isBuf ? objs.get(srv.res) : null; if (t) info.push('  srv t' + i + ' ' + t.format + ' ' + t.desc.size.width + 'x' + t.desc.size.height + ' res ' + srv.res); else if (srv && srv.isBuf) info.push('  srv t' + i + ' buffer ' + srv.res); }
		for (let i = 0; i < 8; i++) { const uid = S.uav[2][i], u = uid ? objs.get(uid) : null; if (u) { const t = objs.get(u.res); info.push('  uav u' + i + (u.isBuf ? ' buffer' : ' ' + (t ? t.format + ' ' + t.desc.size.width + 'x' + t.desc.size.height : '?')) + ' res ' + u.res); } }
		logLine(info.join('\n'));
		debugCsProbe = true;
	}
}

let zeroSrc = null;		// never written: WebGPU buffers start zeroed
const TEXEL_BYTES = { 'r8unorm': 1, 'rg8unorm': 2, 'rgba8unorm': 4, 'bgra8unorm': 4, 'r16float': 2, 'rg16float': 4, 'rgba16float': 8, 'r32float': 4, 'r32uint': 4, 'r32sint': 4, 'rg32float': 8, 'rgba32float': 16, 'rgba32uint': 16, 'rgba8uint': 4, 'rg11b10ufloat': 4, 'rgb10a2unorm': 4 };
function clearUav(id, isFloat, values) {
	const uav = objs.get(id);
	if (!uav) return;
	if (uav.isBuf) {
		const buf = objs.get(uav.res);
		if (!buf || !buf.gpu) return;
		if (usedInEncoder.has(buf)) { /* ordering: recorded commands are in the same encoder */ }
		endPass();
		if (!(values[0] | values[1] | values[2] | values[3])) getEncoder().clearBuffer(buf.gpu);
		else { flush('uav clear'); const n = buf.bytes >> 2, a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = values[i & 3]; device.queue.writeBuffer(buf.gpu, 0, a); }
		usedInEncoder.add(buf);
		return;
	}
	const t = objs.get(uav.res);
	if (!t) return;
	const bpt = TEXEL_BYTES[t.format];
	if (!bpt) { logOnce('clearuav' + t.format, 'ClearUnorderedAccessView: texture format ' + t.format + ' not supported'); return; }
	const mip = uav.a, w = Math.max(1, t.desc.size.width >> mip), h = Math.max(1, t.desc.size.height >> mip);
	const layers = t.desc.dimension === '3d' ? Math.max(1, t.desc.size.depthOrArrayLayers >> mip) : t.desc.size.depthOrArrayLayers;
	if (!(values[0] | values[1] | values[2] | values[3])) {
		// zero: a copy from a buffer that stays zero, recorded in order (no submit, no texture-sized array per clear)
		const bpr = Math.ceil(w * bpt / 256) * 256, need = bpr * h;
		if (!zeroSrc || zeroSrc.size < need) zeroSrc = device.createBuffer({ size: Math.max(need, 1 << 20), usage: GPUBufferUsage.COPY_SRC });
		endPass();
		const enc = getEncoder();
		for (let l = 0; l < layers; l++) enc.copyBufferToTexture({ buffer: zeroSrc, bytesPerRow: bpr, rowsPerImage: h }, { texture: t.tex, mipLevel: mip, origin: { x: 0, y: 0, z: l } }, { width: w, height: h, depthOrArrayLayers: 1 });
		usedInEncoder.add(t); markColorDirty(t);
		return;
	}
	flush('uav clear');
	const data = new Uint8Array(w * h * bpt);
	if (values[0] | values[1] | values[2] | values[3]) {
		const dv = new DataView(data.buffer);
		for (let i = 0; i < w * h; i++) for (let c = 0; c < bpt / 4; c++) dv.setUint32(i * bpt + c * 4, values[c & 3], true);
	}
	for (let l = 0; l < layers; l++) device.queue.writeTexture({ texture: t.tex, mipLevel: mip, origin: { x: 0, y: 0, z: l } }, data, { bytesPerRow: w * bpt, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });
}

// ---- mip generation and readback ------------------------------------------------------------------------------------------------------
const mipPipelines = new Map();
let mipSampler = null;
function generateMips(srvId) {
	const srv = objs.get(srvId), t = srv ? objs.get(srv.res) : null;
	if (!t || t.kind !== 'texture' || t.desc.mipLevelCount < 2) return;
	const fmt = t.format;
	if (isDepth(fmt) || fmt.startsWith('bc') || t.desc.dimension === '3d') { logOnce('mips' + fmt, 'GenerateMips: unsupported texture format/dimension ' + fmt + ' ' + t.desc.dimension); return; }
	// The game regenerates some mipmaps every frame whether or not the picture changed: the reflection cube map's, 6 faces x ~7 levels = ~42 render passes a frame (a
	// Chromebook's overlay showed 65 passes a frame, the chip busy 10 ms of an 80 ms frame: each pass costs Chrome's GPU process far more than the chip). Only the layers
	// written since this texture's last generation are regenerated (markColorDirty); with reflections redrawn every 30th or 60th frame (REFLECT_EVERY), most frames none.
	const layers = t.desc.size.depthOrArrayLayers;
	if (!t.lgen) { t.lgen = new Int32Array(layers); t.mipL = new Int32Array(layers).fill(-1); t.mipW = -1; }
	const all = t.mipW !== (t.wgen || 0);
	let dirty = 0;
	for (let layer = 0; layer < layers; layer++) if (all || t.lgen[layer] !== t.mipL[layer]) dirty++;
	if (!dirty) { mipSkipped += layers * (t.desc.mipLevelCount - 1); return; }
	endPass();
	// Without float32-filterable a 32-bit float texture cannot be read through a linear sampler (the bind group is invalid, and with it the whole submit: the luminance
	// average of auto exposure is made this way): each texel of the next mip is then the average of its 2x2 texels, read with textureLoad (what the linear sample at
	// the centre of the four gives for even sizes).
	const byLoad = noF32Filter && !!HALF_OF[fmt];
	let pl = mipPipelines.get(fmt);
	if (!pl && byLoad) {
		const module = device.createShaderModule({ code: `@group(0) @binding(0) var src: texture_2d<f32>;
			@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
			@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
				let s = vec2i(textureDimensions(src, 0)) - 1;
				let p = vec2i(pos.xy) * 2;
				return (textureLoad(src, min(p, s), 0) + textureLoad(src, min(p + vec2i(1, 0), s), 0) + textureLoad(src, min(p + vec2i(0, 1), s), 0) + textureLoad(src, min(p + vec2i(1, 1), s), 0)) * 0.25;
			}` });
		pl = device.createRenderPipeline({ layout: loadLayout('2d'), vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: fmt }] } });
		mipPipelines.set(fmt, pl);
	}
	if (!pl) {
		const module = device.createShaderModule({ code: `@group(0) @binding(0) var src: texture_2d<f32>;
			@group(0) @binding(1) var smp: sampler;
			@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
			@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
				let dst = max(vec2f(1.0), floor(vec2f(textureDimensions(src, 0)) * 0.5));
				return textureSampleLevel(src, smp, pos.xy / dst, 0.0);
			}` });
		pl = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: fmt }] } });
		mipPipelines.set(fmt, pl);
	}
	if (!mipSampler) mipSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
	const enc = getEncoder();
	if (!t.mipPasses) {		// per texture, made once (GenerateMips runs every frame on some targets, e.g. the reflection map's mip blur)
		t.mipPasses = [];
		for (let layer = 0; layer < layers; layer++) for (let mip = 1; mip < t.desc.mipLevelCount; mip++) {
			const src = t.tex.createView({ dimension: '2d', baseMipLevel: mip - 1, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
			const dst = t.tex.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
			t.mipPasses.push({ dst, bg: device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: byLoad ? [{ binding: 0, resource: src }] : [{ binding: 0, resource: src }, { binding: 1, resource: mipSampler }] }) });
		}
	}
	const per = t.desc.mipLevelCount - 1;
	for (let layer = 0; layer < layers; layer++) {
		if (!all && t.lgen[layer] === t.mipL[layer]) { mipSkipped += per; continue; }
		for (let k = 0; k < per; k++) {
			const r = t.mipPasses[layer * per + k];
			const p = enc.beginRenderPass({ colorAttachments: [{ view: r.dst, loadOp: 'clear', storeOp: 'store' }] });
			p.setPipeline(pl);
			p.setBindGroup(0, r.bg);
			p.draw(3);
			p.end();
			mipPassesRun++;
		}
		t.mipL[layer] = t.lgen[layer];
	}
	usedInEncoder.add(t);
	if (t.proxy_fdepth) t.proxy_fdepth.dirty = true;
	if (t.proxy_half) t.proxy_half.dirty = true;
	t.mipW = t.wgen || 0;		// its own writes (mips 1 and up) do not make it stale
}
let mipPassesRun = 0, mipSkipped = 0;

function blockInfo(format) {
	if (format.startsWith('bc')) return { bytes: /^bc(1|4)/.test(format) ? 8 : 16, bw: 4, bh: 4 };
	if (/^(r8|stencil8)/.test(format)) return { bytes: 1, bw: 1, bh: 1 };
	if (/^(rg8|r16)/.test(format)) return { bytes: 2, bw: 1, bh: 1 };
	if (/^(rgba16|rg32)/.test(format)) return { bytes: 8, bw: 1, bh: 1 };
	if (/^rgba32/.test(format)) return { bytes: 16, bw: 1, bh: 1 };
	return { bytes: 4, bw: 1, bh: 1 };
}

async function readback(p) {
	// GPU resource -> the CPU storage of a D3D staging resource, written straight into the shared wasm memory
	const src = objs.get(u32[p]);
	const sub = u32[p + 1], hasBox = u32[p + 2];
	const l = u32[p + 3], t = u32[p + 4], f = u32[p + 5], r = u32[p + 6], b = u32[p + 7], bk = u32[p + 8];
	const addr = u32[p + 9] + u32[p + 10] * 4294967296, rowPitch = u32[p + 11], slicePitch = u32[p + 12], isBuf = u32[p + 13], size = u32[p + 14];
	if (!src) return;
	// The copy is recorded into the open encoder, after the commands that produce the data, and that encoder is submitted at once: the engine maps the staging resource soon
	// (often next frame) and deferring the submit to the present made it wait 50-300 ms. One submit per readback (it was the open encoder plus a separate one for the copy).
	if (isBuf) {
		if (!src.gpu) return;
		const n = hasBox ? r - l : Math.min(size, src.size), padded = (n + 3) & ~3;
		const MU = GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, rbSize = Math.max(4, padded);
		const rb = pooledBuffer(rbSize, MU);
		rbBytes += rbSize; if (rbSize > rbBig) rbBig = rbSize;
		endPass();
		getEncoder().copyBufferToBuffer(src.gpu, hasBox ? l : 0, rb, 0, rbSize);
		flush('readback');
		await rb.mapAsync(GPUMapMode.READ);
		refreshViews();
		u8.set(new Uint8Array(rb.getMappedRange(), 0, n), addr);
		rb.unmap(); releaseBuffer(rb, rbSize, MU);
		return;
	}
	if (src.kind !== 'texture' || src.desc.sampleCount > 1 || isDepth(src.format)) { logOnce('rbfmt' + src.format, 'readback of ' + src.format + (src.desc.sampleCount > 1 ? ' (multisampled)' : '') + ' not supported'); return; }
	const mips = src.desc.mipLevelCount, mip = sub % mips, layer = Math.floor(sub / mips);
	const mw = Math.max(1, src.desc.size.width >> mip), mh = Math.max(1, src.desc.size.height >> mip);
	const three = src.desc.dimension === '3d', md = three ? Math.max(1, src.desc.size.depthOrArrayLayers >> mip) : 1;
	const bi = blockInfo(src.format);
	const x0 = hasBox ? l : 0, y0 = hasBox ? t : 0, z0 = hasBox ? f : 0;
	const w = hasBox ? r - l : mw, h = hasBox ? b - t : mh, d = hasBox ? bk - f : md;
	const bx = Math.ceil(w / bi.bw), by = Math.ceil(h / bi.bh), rowBytes = bx * bi.bytes, bpr = Math.ceil(rowBytes / 256) * 256;
	const MU = GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, rbSize = bpr * by * d;
	const rb = pooledBuffer(rbSize, MU);
	rbBytes += rbSize; if (rbSize > rbBig) rbBig = rbSize;
	if (rbSize > 65536) logOnce('rbbig' + src.format + w + 'x' + h, 'read-back of ' + w + 'x' + h + 'x' + d + ' ' + src.format + ' (' + (rbSize / 1048576).toFixed(2) + ' MB)');
	endPass();
	getEncoder().copyTextureToBuffer({ texture: src.tex, mipLevel: mip, origin: { x: x0, y: y0, z: three ? z0 : layer } }, { buffer: rb, bytesPerRow: bpr, rowsPerImage: by },
		{ width: bx * bi.bw, height: by * bi.bh, depthOrArrayLayers: three ? d : 1 });
	flush('readback');
	await rb.mapAsync(GPUMapMode.READ);
	refreshViews();
	const data = new Uint8Array(rb.getMappedRange());
	for (let z = 0; z < d; z++) for (let row = 0; row < by; row++)
		u8.set(data.subarray((z * by + row) * bpr, (z * by + row) * bpr + rowBytes), addr + z * slicePitch + row * rowPitch);
	rb.unmap(); releaseBuffer(rb, rbSize, MU);
}

// ---- clears (own passes) ------------------------------------------------------------------------------------------------------------
// views for clears come from the same per-texture cache as render-target views (a new GPUTextureView per clear before)
function clearView(t, mip, slice) { return targetView(t, 0, mip, slice).view; }
function clearRT(id, mip, slice, r, g, b, a) {
	const t = objs.get(id);
	if (!t || t.kind !== 'texture') return;
	if (t.reflect && !reflectDue(t, slice)) return;		// a reflection face kept from an earlier frame (REFLECT_EVERY)
	markColorDirty(t, t.desc.dimension === '3d' ? undefined : slice);
	endPass();
	queueClear({ t, id, mip, slice, depth: false, color: { r, g, b, a }, flags: 0, depthValue: 0, stencil: 0 });
}

function clearDS(id, mip, slice, flags, depth, stencil) {
	const t = objs.get(id);
	if (!t || t.kind !== 'texture') return;
	markDepthDirty(t);
	endPass();
	queueClear({ t, id, mip, slice, depth: true, color: null, flags, depthValue: depth, stencil });
}

// ---- clears folded into the next pass --------------------------------------------------------------------------------------------------------------------
// A D3D clear was a render pass of its own (begin, clear, end), and the game clears its targets right before it draws into them: in Chrome's GPU process and the driver a pass
// that only clears costs about as much set-up as one that draws. A clear now waits (pendingClears) and becomes the load operation of the next pass that renders into that very
// view, which then starts cleared. Before anything else that may read or write a waiting clear's texture the waiting clears run as before (flushPendingClears): any command
// but state changes, creations, draws and clears (CLEAR_SAFE); a texture upload to it; a draw that samples it (drawReadsPending); a pass that has its texture attached
// in a way the clear cannot become part of (another view format, a read-only depth). ?mergeclears=0 turns it off (diagnostics).
const MERGE_CLEARS = isNode ? process.env.WGPU_MERGE_CLEARS !== '0' : new URLSearchParams(self.location.search).get('mergeclears') !== '0';
const pendingClears = [];
let clearsMerged = 0, clearsRun = 0;
function queueClear(c) {
	if (!MERGE_CLEARS || c.t.desc.dimension === '3d') { runClear(c); return; }
	for (const e of pendingClears) {
		if (e.id !== c.id || e.mip !== c.mip || e.slice !== c.slice || e.depth !== c.depth) continue;
		if (!c.depth) e.color = c.color;		// a later clear of the same view replaces the earlier one
		else { if (c.flags & 1) { e.flags |= 1; e.depthValue = c.depthValue; } if (c.flags & 2) { e.flags |= 2; e.stencil = c.stencil; } }
		return;
	}
	pendingClears.push(c);
}
function runClear(c) {		// the clear as its own pass
	const t = c.t;
	if (objs.get(c.id) !== t) return;		// destroyed meanwhile
	clearsRun++;
	const view = clearView(t, c.mip, c.slice);
	passClearN++; if (!c.depth) getEncoder().beginRenderPass(timePass({ colorAttachments: [Object.assign({ view, loadOp: 'clear', storeOp: 'store', clearValue: c.color }, t.desc.dimension === '3d' ? { depthSlice: c.slice } : null)] }, 'clears')).end();
	else {
		const att = { view, depthLoadOp: (c.flags & 1) ? 'clear' : 'load', depthStoreOp: 'store', depthClearValue: c.depthValue };
		if (hasStencil(t.format)) Object.assign(att, { stencilLoadOp: (c.flags & 2) ? 'clear' : 'load', stencilStoreOp: 'store', stencilClearValue: c.stencil });
		getEncoder().beginRenderPass(timePass({ colorAttachments: [], depthStencilAttachment: att }, 'clears')).end();
	}
	usedInEncoder.add(t);
}
function flushPendingClears() {
	if (!pendingClears.length) return;
	endPass();
	const list = pendingClears.splice(0);
	for (const c of list) runClear(c);
}
function pendingHas(id) { for (let i = 0; i < pendingClears.length; i++) if (pendingClears[i].id === id) return true; return false; }
function dropPendingClears(id) { for (let i = pendingClears.length - 1; i >= 0; i--) if (pendingClears[i].id === id) pendingClears.splice(i, 1); }
// does this draw read (or write as a UAV) a texture with a waiting clear?
function drawReadsPending(prog, stage) {
	if (!prog) return false;
	const bs = prog.info.bindings;
	for (let i = 0; i < bs.length; i++) {
		const b = bs[i];
		let id = 0;
		if (b.kind === 'texture' || ((b.kind === 'read-only-storage' || b.kind === 'storage') && b.binding < 160)) id = S.srv[stage][b.binding - 32];
		else if (b.kind === 'storage-texture' || b.binding >= 160) id = S.uav[stage] ? S.uav[stage][b.binding - (b.binding >= 176 ? 176 : 160)] : 0;
		const v = id ? objs.get(id) : null;
		if (v && !v.isBuf && pendingHas(v.res)) return true;
	}
	return false;
}
// a waiting clear of this view, as the attachment's load operation (true), or none (false); a clear that cannot be folded in stays waiting (see ensurePass)
function takeColorClear(att, id, mip, slice, format, t) {
	for (let i = 0; i < pendingClears.length; i++) {
		const c = pendingClears[i];
		if (c.depth || c.id !== id || c.mip !== mip || c.slice !== slice) continue;
		if (format !== viewFormat(0, t)) return false;		// the clear was of the texture's own format; this view reads it differently
		att.loadOp = 'clear'; att.clearValue = c.color;
		pendingClears.splice(i, 1); clearsMerged++;
		return true;
	}
	return false;
}
function takeDepthClear(att, id, mip, slice, t, roDepth, roStencil) {
	for (let i = 0; i < pendingClears.length; i++) {
		const c = pendingClears[i];
		if (!c.depth || c.id !== id || c.mip !== mip || c.slice !== slice) continue;
		const st = hasStencil(t.format);
		if (((c.flags & 1) && roDepth) || ((c.flags & 2) && st && roStencil)) return false;		// a read-only aspect cannot be cleared by the pass
		if (c.flags & 1) { att.depthLoadOp = 'clear'; att.depthClearValue = c.depthValue; }
		if ((c.flags & 2) && st) { att.stencilLoadOp = 'clear'; att.stencilClearValue = c.stencil; }
		pendingClears.splice(i, 1); clearsMerged++;
		return true;
	}
	return false;
}
// commands that neither read nor write texture contents outside a pass: a waiting clear can stay waiting across them (UPLOAD_TEXTURE and DESTROY_OBJECT: see runCommands)
const CLEAR_SAFE = new Uint8Array(64);
for (const op of [0, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 37, 38, 44, 47, 5, 6]) CLEAR_SAFE[op] = 1;

// Present: in a browser, blit the back buffer into the canvas; in Node there is no surface (screenshots are explicit).
function makeBlit() {
	const module = device.createShaderModule({ code: `
		@group(0) @binding(0) var src: texture_2d<f32>;
		@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
			var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
			return vec4f(p[i], 0, 1);
		}
		@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
			return textureLoad(src, vec2i(pos.xy), 0);
		}` });
	blit = device.createRenderPipeline({
		layout: 'auto',
		vertex: { module, entryPoint: 'vs' },
		fragment: { module, entryPoint: 'fs', targets: [{ format: canvasFormat }] },
	});
}


// PNG writer (Node only; used by the headless verification).
function crc32(buf) {
	let c, crc = ~0;
	for (let n = 0; n < buf.length; n++) {
		c = (crc ^ buf[n]) & 0xff;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crc = (crc >>> 8) ^ c;
	}
	return ~crc >>> 0;
}
function encodePng(w, h, rgba) {
	const zlib = require('zlib');
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
	const chunk = (type, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}


function readString(w, lenBytes) {
	const start = w * 4;
	return new TextDecoder().decode(u8.slice(start, start + lenBytes));
}

const f16 = new Float32Array(1), u32v = new Uint32Array(f16.buffer);
function halfToFloat(h) {
	const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
	if (e === 0) return s * m * 5.960464477539063e-8;
	if (e === 31) return m ? NaN : s * Infinity;
	return s * Math.pow(2, e - 15) * (1 + m / 1024);
}
const clamp8 = (v) => Math.max(0, Math.min(255, Math.round((v > 0 ? v : 0) * 255)));
// texel -> [r,g,b,a] (0..255) for the formats the debugging dumps understand
const TEXEL = {
	'rgba8unorm': [4, (d, i) => [d[i], d[i + 1], d[i + 2], d[i + 3]]],
	'rgba8unorm-srgb': [4, (d, i) => [d[i], d[i + 1], d[i + 2], d[i + 3]]],
	'bgra8unorm': [4, (d, i) => [d[i + 2], d[i + 1], d[i], d[i + 3]]],
	'bgra8unorm-srgb': [4, (d, i) => [d[i + 2], d[i + 1], d[i], d[i + 3]]],
	'rgba16float': [8, (d, i) => [0, 2, 4, 6].map((o) => clamp8(halfToFloat(d[i + o] | (d[i + o + 1] << 8))))],
	'rgb10a2unorm': [4, (d, i) => { const v = (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0; return [(v & 1023) / 1023 * 255, ((v >>> 10) & 1023) / 1023 * 255, ((v >>> 20) & 1023) / 1023 * 255, 255]; }],
	'rg11b10ufloat': [4, (d, i) => { const v = (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0; const f11 = (x) => { const e = x >> 6, m = x & 63; return e === 0 ? m / 64 * Math.pow(2, -14) : Math.pow(2, e - 15) * (1 + m / 64); }; const f10 = (x) => { const e = x >> 5, m = x & 31; return e === 0 ? m / 32 * Math.pow(2, -14) : Math.pow(2, e - 15) * (1 + m / 32); }; return [clamp8(f11(v & 2047)), clamp8(f11((v >>> 11) & 2047)), clamp8(f10(v >>> 22)), 255]; }],
	'r32float': [4, (d, i) => { u32v[0] = d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24); const x = clamp8(f16[0]); return [x, x, x, 255]; }],
	'rg16float': [4, (d, i) => [clamp8(halfToFloat(d[i] | (d[i + 1] << 8))), clamp8(halfToFloat(d[i + 2] | (d[i + 3] << 8))), 0, 255]],
	'r8unorm': [1, (d, i) => [d[i], d[i], d[i], 255]],
	'rg8unorm': [2, (d, i) => [d[i], d[i + 1], 0, 255]],
};

async function screenshot(id, path) {
	const t = objs.get(id);
	if (!t || t.kind !== 'texture') { logLine('screenshot: unknown texture ' + id); return; }
	const fmt = TEXEL[t.format];
	if (!fmt || t.desc.sampleCount > 1) { logLine('screenshot: texture ' + id + ' is ' + t.format + (t.desc.sampleCount > 1 ? ' (multisampled)' : ' (format not decoded)')); return; }
	flush();
	const w = t.desc.size.width, h = t.desc.size.height, bpp = fmt[0];
	const bpr = Math.ceil(w * bpp / 256) * 256;
	const rb = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
	const enc = device.createCommandEncoder();
	enc.copyTextureToBuffer({ texture: t.tex }, { buffer: rb, bytesPerRow: bpr }, { width: w, height: h });
	device.queue.submit([enc.finish()]);
	await rb.mapAsync(GPUMapMode.READ);
	const src = new Uint8Array(rb.getMappedRange());
	const out = new Uint8Array(w * h * 4);
	let nonBlack = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const px = fmt[1](src, y * bpr + x * bpp), d = (y * w + x) * 4;
			out[d] = px[0]; out[d + 1] = px[1]; out[d + 2] = px[2]; out[d + 3] = px[3];
			if (px[0] | px[1] | px[2]) nonBlack++;
		}
	}
	rb.unmap(); rb.destroy();
	if (isNode) require('fs').writeFileSync(path, encodePng(w, h, out));
	else {
		post({ screenshot: { path, w, h, format: t.format, pixels: out } });
		fetch('/shot?name=' + encodeURIComponent(String(path).replace(/^.*[\\/]/, '').replace(/\.png$/, '')) + '&w=' + w + '&h=' + h, { method: 'POST', body: out }).catch(() => {});
	}
	dumpErrors();
	logLine('screenshot ' + path + ' ' + w + 'x' + h + ' ' + t.format + ' non-black ' + nonBlack + '; draws so far ' + drawCount + ', skipped ' + skippedDraws);
}

// ?shotrt=1: the numbers behind a float render target (the lighting buffer is rgba16float; screenshot() clamps to 8 bits, so "white" there only says >= 1): per channel max and the
// mean of the finite texels, how many texels are NaN, +-Inf, above 1 and above 100, and the centre texel. A device that renders the world white shows here whether the lighting
// really produced huge/invalid values or the picture went white later (tone mapping).
const F11 = (x) => { const e = x >> 6, m = x & 63; return e === 0 ? m / 64 * 6.103515625e-5 : e === 31 ? (m ? NaN : Infinity) : Math.pow(2, e - 15) * (1 + m / 64); };
const F10 = (x) => { const e = x >> 5, m = x & 31; return e === 0 ? m / 32 * 6.103515625e-5 : e === 31 ? (m ? NaN : Infinity) : Math.pow(2, e - 15) * (1 + m / 32); };
const FLOAT_STAT_FORMATS = {		// format: [channels, reader(DataView, byte offset, channel)]
	rgba16float: [4, (dv, o, c) => halfToFloat(dv.getUint16(o + c * 2, true))], rg16float: [2, (dv, o, c) => halfToFloat(dv.getUint16(o + c * 2, true))], r16float: [1, (dv, o, c) => halfToFloat(dv.getUint16(o, true))],
	rgba32float: [4, (dv, o, c) => dv.getFloat32(o + c * 4, true)], rg32float: [2, (dv, o, c) => dv.getFloat32(o + c * 4, true)], r32float: [1, (dv, o) => dv.getFloat32(o, true)],
	rg11b10ufloat: [3, (dv, o, c) => { const v = dv.getUint32(o, true); return c === 0 ? F11(v & 2047) : c === 1 ? F11((v >>> 11) & 2047) : F10(v >>> 22); }],
};
const rtListed = new Set();
async function floatStats(id) {
	const t = objs.get(id);
	if (!t || t.kind !== 'texture') return;
	const w = t.desc.size.width, h = t.desc.size.height;
	if (!rtListed.has(id)) { rtListed.add(id); logLine('rt ' + id + ' ' + w + 'x' + h + ' ' + t.format + (t.desc.sampleCount > 1 ? ' x' + t.desc.sampleCount : '')); }
	const fs = FLOAT_STAT_FORMATS[t.format];
	if (!fs || t.desc.sampleCount > 1) return;
	flush();
	const ch = fs[0], read = fs[1], bpp = TEXEL_BYTES[t.format];
	const bpr = Math.ceil(w * bpp / 256) * 256;
	const rb = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
	const enc = device.createCommandEncoder();
	enc.copyTextureToBuffer({ texture: t.tex }, { buffer: rb, bytesPerRow: bpr }, { width: w, height: h });
	device.queue.submit([enc.finish()]);
	await rb.mapAsync(GPUMapMode.READ);
	const range = rb.getMappedRange(), dv = new DataView(range);
	const max = new Array(ch).fill(-Infinity), sum = new Array(ch).fill(0);
	let nan = 0, inf = 0, gt1 = 0, gt100 = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const o = y * bpr + x * bpp;
		for (let c = 0; c < ch; c++) {
			const v = read(dv, o, c);
			if (v !== v) { nan++; continue; }
			if (v === Infinity || v === -Infinity) { inf++; continue; }
			sum[c] += v; if (v > max[c]) max[c] = v;
			if (c < 3) { if (v > 1) gt1++; if (v > 100) gt100++; }
		}
	}
	const cx = ((h >> 1) * bpr) + (w >> 1) * bpp, centre = [];
	for (let c = 0; c < ch; c++) centre.push(read(dv, cx, c).toPrecision(4));
	rb.unmap(); rb.destroy();
	const n = w * h;
	logLine('rtstats ' + id + ' ' + w + 'x' + h + ' ' + t.format + ': max ' + max.map((v) => v.toPrecision(4)).join('/') + ', mean ' + sum.map((v) => (v / Math.max(1, n)).toPrecision(4)).join('/') + ', NaN ' + nan + ', Inf ' + inf + ', rgb>1 ' + gt1 + ', rgb>100 ' + gt100 + ' of ' + n + ' texels, centre ' + centre.join('/'));
}
let rtStatsT = 0;

// ?shotrt=1, 30 s after the world's first frame: ONE frame is scanned draw by draw (nanHuntState 2, from present() to the next present()). After every draw into a large HDR target
// (rgba16float / rg11b10ufloat, 600 px or wider) a 64x40 grid of the target is read back and counted for texels with a NaN, an Inf or a value over 1000 in RGB; whenever the count
// of a target changes the draw's shaders are logged. Found on a Chromebook (Intel, Dawn/Vulkan, 2026-10-06): the lighting buffer was ~95 % NaN, which displays as white, and this PC's
// has none - so the first draw that introduces NaN names the shader whose maths differs on that GPU.
let nanHuntState = 0, nanHuntLabel = '', nanHuntLogged = 0, nanHuntScans = 0, nanHuntLastCount = -1, nanHuntPs = null, nanHuntVs = null, nanHuntDetails = 0, nanHuntFound = false;
function nanNote(text) { logLine(text); (gpuErrorChannel || (gpuErrorChannel = new BroadcastChannel('game-progress'))).postMessage({ gpuError: text, kinds: 'NaN', total: 0 }); }
const nanHuntPrev = new Map();
const NAN_TEXEL = { r8uint: 1, r8unorm: 1, rg8unorm: 2, rgba8unorm: 4, bgra8unorm: 4, r16float: 2, rg16float: 4, rgba16float: 8, r32float: 4, rg32float: 8, rgba32float: 16, rg11b10ufloat: 4, rgb10a2unorm: 4 };
// One texel of a texture (position given for a target of tw x th, scaled to the texture's size) as text: raw bytes, and decoded floats for the float formats.
async function nanReadTexel(t, x, y, tw, th, mip = 0) {
	const bpp = NAN_TEXEL[t.format];
	if (!bpp || t.desc.sampleCount > 1) return t.format + (t.desc.sampleCount > 1 ? ' (multisampled)' : ' (not readable here)');
	const mw = Math.max(1, t.desc.size.width >> mip), mh = Math.max(1, t.desc.size.height >> mip);
	const sx = Math.min(mw - 1, Math.floor((x + 0.5) * mw / tw)), sy = Math.min(mh - 1, Math.floor((y + 0.5) * mh / th));
	try {
		const rb = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		const enc = device.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: t.tex, mipLevel: mip, origin: { x: sx, y: sy } }, { buffer: rb, bytesPerRow: 256 }, { width: 1, height: 1 });
		device.queue.submit([enc.finish()]);
		await rb.mapAsync(GPUMapMode.READ);
		const dv = new DataView(rb.getMappedRange().slice(0));
		rb.unmap(); rb.destroy();
		const bytes = []; for (let i = 0; i < bpp; i++) bytes.push(dv.getUint8(i));
		const fs = FLOAT_STAT_FORMATS[t.format];
		const vals = fs ? Array.from({ length: fs[0] }, (_, c) => fs[1](dv, 0, c)).map((v) => +v.toPrecision(7)) : null;
		return t.format + ' ' + mw + 'x' + mh + ' mip ' + mip + '/' + t.desc.mipLevelCount + ' @' + sx + ',' + sy + ' bytes ' + bytes.join(',') + (vals ? ' = ' + vals.join(', ') : '');
	} catch (e) { return t.format + ' unreadable: ' + e; }
}
// The pixel shader's inputs for a draw whose output has NaN: every bound texture at the texel (a bad one and a good one), and the constant buffers (as floats).
async function nanDetail(bx, by, gx, gy, tw, th) {
	const lines = ['nanhunt detail for ' + nanHuntLabel + ': bad texel ' + bx + ',' + by + ', good texel ' + gx + ',' + gy];
	const rt = S.rt[0].tex ? objs.get(S.rt[0].tex) : null;
	if (rt) { lines.push('  output target bad : ' + await nanReadTexel(rt, bx, by, tw, th)); if (gx >= 0) lines.push('  output target good: ' + await nanReadTexel(rt, gx, gy, tw, th)); }
	for (let i = 0; i < 32; i++) {
		const sid = S.srv[1][i], srv = sid ? objs.get(sid) : null, t = srv && !srv.isBuf ? objs.get(srv.res) : null;
		if (!t || t.kind !== 'texture') continue;
		lines.push('  t' + i + ' res ' + srv.res + ' bad  : ' + await nanReadTexel(t, bx, by, tw, th));
		if (t.desc.mipLevelCount > 1 && FLOAT_STAT_FORMATS[t.format] && t.desc.size.width <= 512) for (let m = 1; m < t.desc.mipLevelCount; m++) lines.push('  t' + i + ' res ' + srv.res + ' centre of mip ' + m + ': ' + await nanReadTexel(t, tw >> 1, th >> 1, tw, th, m));
		if (gx >= 0) lines.push('  t' + i + ' res ' + srv.res + ' good : ' + await nanReadTexel(t, gx, gy, tw, th));
	}
	if (nanHuntPs && nanHuntPs.pack) for (const m of nanHuntPs.pack.members) {
		const c = S.cb[1][m.binding], o = c.buf ? objs.get(c.buf) : null;
		lines.push('  ps cb b' + m.binding + (o && o.shadow ? ' [' + Array.from(new Float32Array(o.shadow.buffer, o.shadow.byteOffset, Math.min(256, o.shadow.length >> 2))).map((x) => +x.toPrecision(6)).join(',') + ']' : ' (no CPU copy)'));
	}
	logLine(lines.join('\n'));
	return lines;
}
async function nanScanAfterDraw() {
	const r = S.rt[0], t = r.tex ? objs.get(r.tex) : null;
	if (!t || drawCount === nanHuntLastCount || t.desc.sampleCount > 1 || (t.format !== 'rgba16float' && t.format !== 'rg11b10ufloat') || t.desc.size.width < 600) return;
	nanHuntLastCount = drawCount;
	if (++nanHuntScans > 900) { nanHuntState = 3; logLine('nanhunt: stopped after 900 scans'); return; }
	const fs = FLOAT_STAT_FORMATS[t.format], read = fs[1], bpp = TEXEL_BYTES[t.format];
	flush();
	const w = t.desc.size.width, h = t.desc.size.height, bpr = Math.ceil(w * bpp / 256) * 256;
	const rb = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
	const enc = device.createCommandEncoder();
	enc.copyTextureToBuffer({ texture: t.tex }, { buffer: rb, bytesPerRow: bpr }, { width: w, height: h });
	device.queue.submit([enc.finish()]);
	await rb.mapAsync(GPUMapMode.READ);
	const dv = new DataView(rb.getMappedRange());
	let bad = 0, firstBad = '', bx = -1, by = -1, gx = -1, gy = -1;
	for (let gj = 0; gj < 40; gj++) for (let gi = 0; gi < 64; gi++) {
		const x = Math.min(w - 1, Math.floor((gi + 0.5) * w / 64)), y = Math.min(h - 1, Math.floor((gj + 0.5) * h / 40)), o = y * bpr + x * bpp;
		let b = false;
		for (let c = 0; c < 3; c++) { const v = read(dv, o, c); if (v !== v || v === Infinity || v === -Infinity || v > 1000 || v < -1000) b = true; }
		if (b) { bad++; if (!firstBad) { firstBad = x + ',' + y; bx = x; by = y; } } else if (gx < 0 && gi > 8 && gj > 8) { gx = x; gy = y; }
	}
	rb.unmap(); rb.destroy();
	const prev = nanHuntPrev.get(r.tex);
	if (bad !== (prev || 0) || prev === undefined) {
		nanHuntPrev.set(r.tex, bad);
		if (nanHuntLogged++ < 100) logLine('nanhunt: ' + nanHuntLabel + ' -> target ' + r.tex + ' ' + w + 'x' + h + ' ' + t.format + ': bad texels ' + (prev === undefined ? 'first look ' : prev + ' -> ') + bad + ' of 2560' + (bad ? ' (first at ' + firstBad + ')' : ''));
		if (bad && !prev && !nanHuntFound) { nanHuntFound = true; nanNote('NaN hunt: ' + bad + ' of 2560 samples of an HDR target turned NaN/Inf after ' + nanHuntLabel); }
		if (bad && !prev && nanHuntDetails < 2) {
			nanHuntDetails++;
			let detail = [];
			try { detail = await nanDetail(bx, by, gx, gy, w, h); } catch (e) { logLine('nanhunt detail failed: ' + e); detail = ['detail failed: ' + e]; }
			if (nanHuntDetails === 1 && !isNode) {		// everything needed to find the cause, for the page to copy: the device, the draw's inputs, the shaders
				const info = adapter.info || {};
				const report = ['GTA V browser runtime: NaN hunt report', 'GPU: ' + [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') + ' | lacks: ' + (['texture-compression-bc', 'float32-filterable', 'depth32float-stencil8', 'rg11b10ufloat-renderable'].filter((f) => !device.features.has(f)).join(', ') || 'nothing'),
					'Limits: textures/stage ' + device.limits.maxSampledTexturesPerShaderStage + ', inter-stage ' + device.limits.maxInterStageShaderVariables + ' | NaN rules ' + nanRules + ', firewall ' + nanFire + ' | UA ' + self.navigator.userAgent,
					'Target ' + r.tex + ' ' + w + 'x' + h + ' ' + t.format + ': ' + bad + ' of 2560 samples bad after ' + nanHuntLabel, '', ...detail, '',
					'==== vertex shader ' + (nanHuntVs ? nanHuntVs.label : '-') + ' ====', nanHuntVs ? nanHuntVs.text : '', '==== pixel shader ' + (nanHuntPs ? nanHuntPs.label : '-') + ' ====', nanHuntPs ? nanHuntPs.text : ''].join('\n');
				(gpuErrorChannel || (gpuErrorChannel = new BroadcastChannel('game-progress'))).postMessage({ nanReport: report });
			}
		}
	}
}

let frameSlotDone = Array(FRAME_SLOTS).fill(null);
let presentCount = 0;
let shotEvery = isNode ? +(process.env.WGPU_SHOT_EVERY || 0) : 0;
const shotPrefix = isNode ? (process.env.WGPU_SHOT_PREFIX || 'D:/wasm_tmp/shot_') : 'present';
const shotAllRt = !isNode && new URLSearchParams(self.location.search).get('shotrt') === '1';		// the page's ?shotrt=1 (with ?shot=N): see present()
const nanHuntParam = !isNode && new URLSearchParams(self.location.search).get('nanhunt') === '1';		// the page's ?nanhunt=1: the NaN hunt alone, 10 s after the world shows, its findings on the page
let shotAllRtDone = false;
async function present(id) {
	const t = objs.get(id);
	if (t && canvasCtx) {
		endPass();
		// configure() reallocates the canvas's swap-chain textures: only on the first present and when the back buffer size changes (it ran every frame)
		if (!canvasConfigured || canvas.width !== t.desc.size.width || canvas.height !== t.desc.size.height) {
			canvas.width = t.desc.size.width; canvas.height = t.desc.size.height;
			canvasCtx.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
			canvasConfigured = true;
		}
		if (!blit) makeBlit();
		const pass2 = getEncoder().beginRenderPass({ colorAttachments: [{ view: canvasCtx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
		pass2.setPipeline(blit);
		if (!t.blitBG) t.blitBG = device.createBindGroup({ layout: blit.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.tex.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1 }) }] });
		pass2.setBindGroup(0, t.blitBG);
		pass2.draw(3);
		pass2.end();
	}
	// debugging aid: WGPU_SHOT_EVERY=<n> WGPU_SHOT_PREFIX=<path prefix> writes <prefix><presentNumber>.png every n-th present
	presentCount++;
	{
		const tn = performance.now();
		if (lastPresentT) {
			const dt = tn - lastPresentT;
			if (dt > frameMax) frameMax = dt;
			if (dt > 25) over25++;
			if (dt > SPIKE_MS) {
				spikeCount++;
				spikes.push({ dt, idle: fr.idle, pipe: fr.pipe, mod: fr.mod, up: fr.up, mb: fr.upBytes / 1048576, wait: fr.wait, flush: fr.flush });
			}
		}
		lastPresentT = tn;
		ov.idle += fr.idle; ov.wait += fr.wait; ov.pipe += fr.pipe; ov.up += fr.up; ov.upBytes += fr.upBytes;		// the page's frame-rate overlay (below)
		chunkWin.idle += fr.idle; chunkWin.wait += fr.wait;
		fr.idle = fr.pipe = fr.mod = fr.up = fr.upBytes = fr.wait = fr.flush = 0;
	}
	{	// every 10 s: frame rate and work per frame (visible in the session log)
		const now = performance.now();
		if (!fpsT0) { fpsT0 = now; fpsCount0 = presentCount; fpsDraw0 = drawCount; }
		else if (now - fpsT0 >= 10000) {
			const fr = presentCount - fpsCount0;
			logLine('fps: ' + (fr * 1000 / (now - fpsT0)).toFixed(1) + ' (' + fr + ' frames, ' + (((drawCount - fpsDraw0) / Math.max(1, fr)) | 0) + ' draws/frame, ' + ((submits - submits0) / Math.max(1, fr)).toFixed(1) + ' submits/frame: ' + ([...flushReasons].sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + (n / Math.max(1, fr)).toFixed(1)).join(', ') || 'none') + '), draws waiting for a compiling pipeline +' + (pendingSkips - pendingSkips0) + ', validation errors +' + (errorCount - errorCount0) + ', clamped draws +' + (clampedDraws - clampedDraws0) + ', bind groups +' + (bgCreated - bgCreated0) + ' (cache ' + bindGroupCache.size + ', evicted ' + bgEvicted + '), pipelines +' + (pipeCreates - pipeCreates0) + ' (' + pipeMs.toFixed(0) + ' ms), worker busy ' + (busyMs * 100 / Math.max(1, busyMs + idleMs)).toFixed(0) + '% (' + (busyMs / Math.max(1, fr)).toFixed(1) + ' ms/frame)');
			busyMs = idleMs = 0; pipeCreates0 = pipeCreates; pipeMs = 0; bgCreated0 = bgCreated; submits0 = submits; flushReasons.clear(); errorCount0 = errorCount; clampedDraws0 = clampedDraws; pendingSkips0 = pendingSkips;
			if (spikeCount || over25) {
				spikes.sort((a, b) => b.dt - a.dt);
				logLine('stutter: ' + over25 + ' frames > 25 ms, ' + spikeCount + ' > ' + SPIKE_MS + ' ms, worst ' + frameMax.toFixed(0) + ' ms; worst frames (ms: worker idle/pipeline/modules/uploads MB/gpu wait/submit): ' +
					spikes.slice(0, 4).map((x) => x.dt.toFixed(0) + ': ' + x.idle.toFixed(0) + '/' + x.pipe.toFixed(0) + '/' + x.mod.toFixed(0) + '/' + x.up.toFixed(0) + ' ' + x.mb.toFixed(1) + 'MB/' + x.wait.toFixed(0) + '/' + x.flush.toFixed(0)).join(' | '));
			}
			spikes = []; spikeCount = 0; frameMax = 0; over25 = 0;
			fpsT0 = now; fpsCount0 = presentCount; fpsDraw0 = drawCount;
		}
	}
	if (dbgIdx) {
		Atomics.store(i32, dbgIdx + 1, dbgFrameDraw);
		dbgFrameDraw = 0;
		const now = Date.now();
		if (now - dbgLastPost > 250) {
			dbgLastPost = now;
			if (!dbgChannel) dbgChannel = new BroadcastChannel('game-debug');
			dbgChannel.postMessage({ limit: Atomics.load(i32, dbgIdx), total: Atomics.load(i32, dbgIdx + 1), last: dbgLastLabel });
		}
	}
	if (CHUNK_AUTO > 0 && (CHUNK_BASE.dist > 0 || CHUNK_BASE.tiny > 0)) {		// a draw distance that follows the frame rate (CHUNK_AUTO)
		const tn = performance.now();
		if (!chunkWin.t) { chunkWin.t = tn; chunkWin.n = 0; chunkWin.idle = chunkWin.wait = 0; chunkWin.gpu = gpuBusyMs(tn); }
		else if (++chunkWin.n && tn - chunkWin.t >= 1000) {
			const n = chunkWin.n, ms = (tn - chunkWin.t) / n, busy = gpuBusyMs(tn), gpu = Math.min(ms, (busy - chunkWin.gpu) / n);
			chunkApplyScale(chunkAdaptStep(chunkScale, ms, gpu, chunkWin.idle / n, CHUNK_AUTO));
			chunkWin.t = tn; chunkWin.n = 0; chunkWin.idle = chunkWin.wait = 0; chunkWin.gpu = busy;
		}
	}
	if (!isNode) {		// the page's FPS counter (index.html, '=' key): presented frames per second, twice a second, and where a frame's time went (per frame): this worker waiting
		// for the game's commands (idle), waiting for the GPU (wait: a frame slot or a fence), working (the rest: translating draws), and how long the GPU had work (gpu, see gpuTrack)
		const tn = performance.now();
		if (!fpsChannel) { fpsChannel = new BroadcastChannel('game-fps'); fpsChannel.onmessage = (e) => { if (e.data && e.data.overlay !== undefined) overlayOn = !!e.data.overlay; }; }
		fpsOverlayN++;
		if (!fpsOverlayT) { fpsOverlayT = tn; fpsOverlayN = 0; ov.idle = ov.wait = ov.pipe = ov.up = ov.refl = ov.reflSkip = 0; ov.gpu = gpuBusyMs(tn); ov.draws = drawCount; ov.merged = clearsMerged; ov.reused = packsReused; ov.noop = noopDraws; ov.culled = chunkCulled; ov.chunkFrames = chunkFrames; ov.mods = shaderModuleCount; ov.pipes = pipeCreates + aheadMade; ov.sized = chunkSized + chunkUnsized; ov.sizedK = chunkSized; ov.hidden = occlCulled; ov.passes = passesBegun; ov.submits = submits; ov.bgs = bgCreated; ov.staged = stagedUploads + renamedBuffers; ov.cpDef = copiesDeferred; ov.cpSplit = copySplits; ov.mips = mipPassesRun; ov.passDraw = passDrawN; passHist.clear(); segAgg.clear(); rbBig = 0; ov.cmds = commandsRun; ov.fxSkipped = fxSkipped; ov.wRb = waitedOn.readback; ov.wOcc = waitedOn.occlusion; ov.wFence = waitedOn.fence; ov.rbN = readbacksDone; ov.rbMs = readbackMs; ov.passProxy = passProxyN; ov.passClear = passClearN; ov.mipsSkipped = mipSkipped; ov.kept = keptWhy.slice(); ov.upBytes = 0; ovReasons.clear(); for (const pr of ovProgs) pr.ovN = 0; ovProgs.length = 0; }
		else if (tn - fpsOverlayT >= 500) {
			const n = Math.max(1, fpsOverlayN), ms = (tn - fpsOverlayT) / n, busy = gpuBusyMs(tn), gpuPer = (busy - ov.gpu) / n;
			const byEffect = new Map();
			for (const pr of ovProgs) { const l = pr.label || '?', k = l.indexOf('::'), e = k > 0 ? l.slice(0, k) : l; byEffect.set(e, (byEffect.get(e) || 0) + pr.ovN); pr.ovN = 0; }
			ovProgs.length = 0;
			const top = [...byEffect].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e, c]) => [e, c / n]);
			fpsChannel.postMessage({ fps: fpsOverlayN * 1000 / (tn - fpsOverlayT), ms, draws: (drawCount - ov.draws) / n, idle: ov.idle / n, wait: ov.wait / n, pipe: ov.pipe / n, up: ov.up / n, gpu: Math.min(ms, gpuPer),
				top, refl: ov.refl / n, reflSkip: ov.reflSkip / n, reflEvery: REFLECT_EVERY, merged: (clearsMerged - ov.merged) / n, reused: (packsReused - ov.reused) / n, noop: (noopDraws - ov.noop) / n,
				culled: (chunkCulled - ov.culled) / n, chunk: CHUNK, chunkAuto: CHUNK_AUTO, chunkActive: chunkFrames > ov.chunkFrames, chip: overlayOn ? gpuTiming.result : null, overlay: overlayOn,
				sizedPct: chunkSized + chunkUnsized - ov.sized > 0 ? Math.round(100 * (chunkSized - ov.sizedK) / (chunkSized + chunkUnsized - ov.sized)) : -1,
				occl: OCCL, hidden: (occlCulled - ov.hidden) / n, occlOn: OCCL && occlActive(), occlWhy: OCCL ? occlStatus() : '',
				// what the GPU process got per frame: passes begun, submits and why, copies recorded instead of submits, bind groups made, MB uploaded
				passes: (passesBegun - ov.passes) / n, submits: (submits - ov.submits) / n, why: [...ovReasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => [k, c / n]),
				staged: (stagedUploads + renamedBuffers - ov.staged) / n, cpDef: (copiesDeferred - ov.cpDef) / n, cpSplit: (copySplits - ov.cpSplit) / n, mips: (mipPassesRun - ov.mips) / n, mipsSkipped: (mipSkipped - ov.mipsSkipped) / n,
				passDraw: (passDrawN - ov.passDraw) / n, passProxy: (passProxyN - ov.passProxy) / n, passClear: (passClearN - ov.passClear) / n,
				cmds: (commandsRun - ov.cmds) / n, fxSkipped: (fxSkipped - ov.fxSkipped) / n, skipFx: SKIP_FX.join(','),
				segs: [...segAgg].sort((a, b) => b[1].ms - a[1].ms).slice(0, 5).map(([r, e]) => [r, e.ms / n, e.n / n, e.p / n, e.d / n, e.pl / n, e.bg / n, e.rb / n / 1048576, e.vb / n, e.ib / n, e.ind / n, e.oq / n, e.up / n / 1048576, e.rd / n / 1048576]),
				rbBig: rbBig / 1048576,
				passTop: [...passHist].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k2, c]) => [k2, c / n]), depthLoads: depthLoadVariants,
				// what the game sat waiting for (ms a frame this worker was idle with each kind of GPU answer outstanding), read-backs a frame and how long each took
				waitRb: (waitedOn.readback - ov.wRb) / n, waitOcc: (waitedOn.occlusion - ov.wOcc) / n, waitFence: (waitedOn.fence - ov.wFence) / n,
				rbs: (readbacksDone - ov.rbN) / n, rbMs: readbacksDone > ov.rbN ? (readbackMs - ov.rbMs) / (readbacksDone - ov.rbN) : 0, fencesAtSubmit: FENCES_AT_SUBMIT,
				kept: KEPT_WHY.map((k, i) => [k, (keptWhy[i] - ov.kept[i]) / n]).filter((x) => x[1] >= 1).sort((a, b) => b[1] - a[1]).slice(0, 4), bgs: (bgCreated - ov.bgs) / n, mb: ov.upBytes / n / 1048576,
				// shader modules and pipelines made per second: each is compiled by Chrome's GPU process (shown there only as "GPU busy"), many while new places stream in
				newShaders: (shaderModuleCount - ov.mods) * 1000 / (tn - fpsOverlayT), newPipelines: (pipeCreates + aheadMade - ov.pipes) * 1000 / (tn - fpsOverlayT) });
			ov.merged = clearsMerged; ov.reused = packsReused; ov.noop = noopDraws; ov.culled = chunkCulled; ov.chunkFrames = chunkFrames; ov.mods = shaderModuleCount; ov.pipes = pipeCreates + aheadMade; ov.sized = chunkSized + chunkUnsized; ov.sizedK = chunkSized; ov.hidden = occlCulled; ov.passes = passesBegun; ov.submits = submits; ov.bgs = bgCreated; ov.staged = stagedUploads + renamedBuffers; ov.cpDef = copiesDeferred; ov.cpSplit = copySplits; ov.mips = mipPassesRun; ov.passDraw = passDrawN; passHist.clear(); segAgg.clear(); rbBig = 0; ov.cmds = commandsRun; ov.fxSkipped = fxSkipped; ov.wRb = waitedOn.readback; ov.wOcc = waitedOn.occlusion; ov.wFence = waitedOn.fence; ov.rbN = readbacksDone; ov.rbMs = readbackMs; ov.passProxy = passProxyN; ov.passClear = passClearN; ov.mipsSkipped = mipSkipped; ov.kept = keptWhy.slice(); ov.upBytes = 0; ovReasons.clear();
			fpsOverlayN = 0; fpsOverlayT = tn; ov.idle = ov.wait = ov.pipe = ov.up = ov.refl = ov.reflSkip = 0; ov.gpu = busy; ov.draws = drawCount;
		}
	}
	{	// loading progress for the page (phase3/index.html): first frame, then the world. The world starts with the first frame with a real scene (loading screens draw ~10
		// times), but the page drops its title screen only once 1.5 s of frames went by without a draw skipped for a compiling pipeline (60 s at most): the first view
		// needs a few hundred new pipelines, and on a slow GPU process the picture has holes until they are compiled. Node computes it too (the log line) but posts nothing.
		const d = drawCount - lastPresentDraws, now = performance.now();
		lastPresentDraws = drawCount;
		if (!isNode && !progressChannel) progressChannel = new BroadcastChannel('game-progress');
		if (!isNode && presentCount === 1) progressChannel.postMessage({ pct: 76, label: 'First frame' });
		if (!worldSent && (worldSince || d > 300)) {
			if (!worldSince) { worldSince = now; worldSkips0 = pendingSkips; }
			if (pendingSkips !== skipsAtPresent) worldClean = 0; else if (!worldClean) worldClean = now;
			if ((worldClean && now - worldClean >= 1500) || now - worldSince >= 60000) {
				worldSent = true;
				logLine('world shown: title screen held ' + ((now - worldSince) / 1000).toFixed(1) + ' s for compiling pipelines (' + (pendingSkips - worldSkips0) + ' draws skipped meanwhile, ' + pipelinesPending + ' still compiling); compiled ahead ' + aheadMade + ', used ' + aheadUsed + ', compiled when first drawn ' + pipeCreates + '; shader variants for the inter-stage limit: ' + remapVariants[0] + ' vertex, ' + remapVariants[1] + ' pixel');
				if (!isNode) progressChannel.postMessage({ pct: 100, label: 'Ready', world: true });
			} else if (!isNode && now - worldNoteT >= 1000) { worldNoteT = now; progressChannel.postMessage({ compiling: pipelinesPending }); }
		}
		skipsAtPresent = pendingSkips;
		if (!isNode && now - recipesSaveT >= 20000) { recipesSaveT = now; saveRecipes(); }
	}
	aheadStep();
	// ?shotrt=1 (browser): the world as it is 20 s after its first real frame - the back buffer, then every render target - once, whatever shotEvery says. A slow device presents the world at a few
	// frames per second, so waiting for a multiple of shotEvery took minutes and the tab died first (Chromebook session of 2026-10-06: world from 15:36:05, killed 15:37:15, no dump).
	// And every 10 s from the world's first frame: floatStats() of the float render targets (the picture is cheap, the numbers are what shows why a device renders white).
	if (!isNode && shotAllRt && worldSent && performance.now() - rtStatsT >= 10000) {
		rtStatsT = performance.now();
		let n = 0;
		for (const tid of [...frameStats.rts]) { const tt = objs.get(tid); if (tt && tt.desc.size.width >= 256 && n < 20) { n++; await floatStats(tid); } }
	}
	if (!isNode && (shotAllRt || nanHuntParam)) {		// the NaN hunt's frame: from this present to the next
		if (nanHuntState === 2) { nanHuntState = 3; logLine('nanhunt: frame finished, ' + nanHuntScans + ' draws into HDR targets scanned'); if (nanHuntParam && !nanHuntFound) nanNote('NaN hunt: no NaN or Inf found in this frame (' + nanHuntScans + ' draws scanned)'); }
		else if (nanHuntState === 0 && worldSince && performance.now() - worldSince >= (nanHuntParam ? 10000 : 30000)) { nanHuntState = 2; logLine('nanhunt: scanning the next frame draw by draw'); }
	}
	if (!isNode && shotAllRt && !shotAllRtDone && worldSince && performance.now() - worldSince >= 20000) {
		shotAllRtDone = true;
		logLine('shotrt: dumping the world, present ' + presentCount + ', ' + ((performance.now() - worldSince) / 1000).toFixed(1) + ' s after its first frame');
		await screenshot(id, 'world' + String(presentCount).padStart(6, '0') + '.png');
		const rtsCopy = new Set(frameStats.rts); dumpFrameStats(); frameStats.rts = rtsCopy;
		await dumpAllTargets();
	}
	// every shotEvery-th present: draw statistics; with WGPU_SHOT_ALLRT (Node) every render target of that frame, with ?shotrt=1 (browser: posted to the dev server's shots/) once,
	// the first time after the world is shown (diagnosis of a device that renders differently)
	const allRt = isNode ? !!process.env.WGPU_SHOT_ALLRT : (shotAllRt && worldSent && !shotAllRtDone);
	if (shotEvery && t && presentCount % shotEvery === 0) { const rtsCopy = new Set(frameStats.rts); dumpFrameStats(); if (allRt) { shotAllRtDone = true; frameStats.rts = rtsCopy; await dumpAllTargets(); } }
	if (shotEvery && t && presentCount % shotEvery === 0) {
		await screenshot(id, shotPrefix + String(presentCount).padStart(6, '0') + '.png');
		for (const tid of (isNode ? process.env.WGPU_SHOT_TEXS || '' : '').split(',').filter(Boolean)) await screenshot(+tid, shotPrefix + 'tex' + tid + '_' + String(presentCount).padStart(6, '0') + '.png');
	}
	if (OCCL && occl.open) occlSnapshot();		// the main view's G-buffer pass was the frame's last: its depth grid now
	const timedRead = gpuTiming.state === 1 ? gpuTimingResolve() : 0;		// a sampled frame's pass times: resolved with this frame's last commands
	flush('present');
	if (timedRead) gpuTimingRead(timedRead);
	if (gpuTiming.state === 0 && gpuTiming.set && worldSent && overlayOn && performance.now() - gpuTiming.lastT >= 2000) { gpuTiming.state = 1; gpuTiming.passes.length = 0; gpuTiming.cur = null; }		// the next frame is sampled
	frameSlotDone[ubo.slot] = device.queue.onSubmittedWorkDone();
	ubo.slot = (ubo.slot + 1) % FRAME_SLOTS; ubo.chunk = 0; ubo.off = 0; ubo.frame++;
	const tw0 = performance.now();
	if (frameSlotDone[ubo.slot]) await frameSlotDone[ubo.slot];		// the ring slot we are about to reuse must be idle
	fr.wait += performance.now() - tw0;
}

// ---- command dispatcher ---------------------------------------------------------------------------------------------------------------
function setRange(dst, start, n, src) { for (let i = 0; i < n; i++) dst[start + i] = src(i); }

// Completion callbacks (onSubmittedWorkDone, mapAsync: they complete the engine's frame-latency fence and readbacks) are delivered as macrotasks, but this loop only awaits
// already-resolved promises, so under load it never let the event loop run: fences completed at the next idle gap and the engine polled them for ~25 ms per frame (a flat
// 25 fps with the worker half idle). A MessageChannel round trip is a cheap macrotask boundary.
const yieldChannel = new MessageChannel();
let yieldResolve = null;
yieldChannel.port1.onmessage = () => { const r = yieldResolve; yieldResolve = null; if (r) r(); };
if (yieldChannel.port1.unref) { yieldChannel.port1.unref(); yieldChannel.port2.unref(); }
function yieldTask() { return new Promise((res) => { yieldResolve = res; yieldChannel.port2.postMessage(0); }); }
let sinceYield = 0, executedLocal = 0, lastYieldT = 0;

async function runCommands(tail, head) {
	// executes [tail, head) (byte offsets relative to ringBase); returns the new tail
	while (tail !== head) {
		const base = ringW + (tail >> 2);
		const op = u32[base], n = u32[base + 1];
		if (op === OP.WRAP) { tail = RING_DATA; continue; }
		const p = base + 2;
		if (pendingClears.length) {		// see CLEAR_SAFE
			if (op >= 64 || !CLEAR_SAFE[op]) flushPendingClears();
			else if (op === 13 /* UPLOAD_TEXTURE */ && pendingHas(u32[p])) flushPendingClears();
			else if (op === 4 /* DESTROY_OBJECT */) dropPendingClears(u32[p]);
		}
		switch (op) {		// numeric labels (OP.* in comments): V8 compiles constant Smi cases to a jump table; `case OP.X` was a chain of property loads and compares per command
		case 0 /* NOP */: case 2 /* INIT */: break;
		case 3 /* CREATE_TEXTURE */: createTexture(u32[p], u32[p + 1], u32[p + 2], u32[p + 3], u32[p + 4], u32[p + 5], u32[p + 6], u32[p + 7], u32[p + 8], u32[p + 9]); break;
		case 4 /* DESTROY_OBJECT */: {
			// the pipeline lookup only has to run again if the object is bound now (a vertex buffer's presence is part of the key; the states and shaders are): streaming destroys
			// objects all the time, and each forced a full lookup on the next draw
			if (isBound(u32[p])) pdirty = true;
			const o = objs.get(u32[p]);
			if (o) {
				if (o.inBG) gEpoch++;		// a cached bind group may hold a view of it
				// used by commands of this encoder: destroyed right after its submit (a destroyed resource cannot be submitted; this used to submit at once, one submit per
				// streamed-out object that was drawn this frame)
				const later = usedInEncoder.has(o);
				if (o.tex) { if (later) deferredDestroys.push(o.tex); else o.tex.destroy(); texBytesAlive -= o.bytes || 0; texCount--; }
				if (o.gpu) { if (later) deferredDestroys.push(o.gpu); else o.gpu.destroy(); bufBytesAlive -= o.bytes || 0; }
				objs.delete(u32[p]);
			}
			break;
		}
		case 5 /* CLEAR_RT */: clearRT(u32[p], u32[p + 1], u32[p + 2], f32[p + 3], f32[p + 4], f32[p + 5], f32[p + 6]); break;
		case 6 /* CLEAR_DS */: clearDS(u32[p], u32[p + 1], u32[p + 2], u32[p + 3], f32[p + 4], u32[p + 5]); break;
		case 7 /* PRESENT */: await present(u32[p]); refreshViews(); break;
		case 8 /* FENCE */: {
			flush('fence');
			const tw = performance.now();
			await device.queue.onSubmittedWorkDone();
			fr.wait += performance.now() - tw;		// the engine waits for the GPU here (the overlay's "waiting for the GPU")
			refreshViews();
			const addr = u32[p] + u32[p + 1] * 4294967296;
			Atomics.store(i32, w32(addr), u32[p + 2] | 0);
			Atomics.notify(i32, w32(addr));
			break;
		}
		case 9 /* SCREENSHOT */: await screenshot(u32[p], readString(p + 2, u32[p + 1])); refreshViews(); break;
		case 10 /* LOG */: { const text = readString(p + 1, u32[p]); if (text === 'stats') logLine('stats: GPU memory now: textures ' + (texBytesAlive / 1048576 | 0) + ' MB in ' + texCount + ' textures (peak ' + (texBytesPeak / 1048576 | 0) + ' MB), buffers ' + (bufBytesAlive / 1048576 | 0) + ' MB (peak ' + (bufBytesPeak / 1048576 | 0) + ' MB)'); if (text === 'stats') dumpMemBreakdown(); if (text === 'stats') dumpFrameStats(); if (text === 'stats') logLine('stats: draws ' + drawCount + ' (skipped ' + skippedDraws + '), indirect draws ' + indirectDraws + ', dispatches ' + dispatchCount + ', queries ' + queries.size + ', occlusion slots used ' + occlusion.next); else logLine(text); break; }
		case 11 /* CREATE_BUFFER */: createBuffer(u32[p], u32[p + 1], u32[p + 2], u32[p + 3], u32[p + 4]); break;
		case 12 /* UPLOAD_BUFFER */: case 47 /* UPLOAD_BUFFER_NO_OVERWRITE */: {
			// timed only when large (the stutter breakdown): most uploads are small constant-buffer copies, thousands per frame, and two performance.now() each added up
			const sz = u32[p + 2], big = sz >= 65536, t0 = big ? performance.now() : 0;
			uploadBuffer(u32[p], u32[p + 1], sz, (p + 3) * 4, op === 47);
			if (big) fr.up += performance.now() - t0;
			fr.upBytes += sz; upAll += sz;
			break;
		}
		case 13 /* UPLOAD_TEXTURE */: { const t0 = performance.now(); fr.upBytes += u32[p + 11]; upAll += u32[p + 11]; uploadTexture(u32[p], u32[p + 1], u32[p + 2], u32[p + 3], u32[p + 4], u32[p + 5], u32[p + 6], u32[p + 7], u32[p + 8], u32[p + 9], u32[p + 10], u32[p + 11], (p + 12) * 4); fr.up += performance.now() - t0; break; }
		case 14 /* CREATE_SHADER */: createShader(p, n); break;
		case 15 /* CREATE_LAYOUT */: createLayout(p); break;
		case 16 /* CREATE_STATE */: createState(p, n); break;
		case 17 /* CREATE_SRV */: createSrv(p); break;
		case 18 /* SET_SHADER */: if (u32[p] === 2 && debugCs && (setCsLogged++ < 30)) logLine('SET_SHADER cs -> ' + u32[p + 1] + (objs.get(u32[p + 1]) ? ' (' + objs.get(u32[p + 1]).kind + ' ' + objs.get(u32[p + 1]).hash + ')' : ' (unknown object)'));
			if (S.shader[u32[p]] !== u32[p + 1]) { S.shader[u32[p]] = u32[p + 1]; pdirty = true; } break;
		case 19 /* SET_INPUT_LAYOUT */: if (S.layout !== u32[p]) { S.layout = u32[p]; pdirty = true; } break;
		case 20 /* SET_TOPOLOGY */: if (S.topo !== u32[p]) { S.topo = u32[p]; pdirty = true; } break;
		case 21 /* SET_VERTEX_BUFFERS */: { const s = u32[p], c = u32[p + 1]; for (let i = 0; i < c && s + i < 16; i++) { const v = S.vb[s + i]; const nb = u32[p + 2 + i * 3], ns = u32[p + 3 + i * 3]; if (v.stride !== ns || !v.buf !== !nb) pdirty = true; v.buf = nb; v.stride = ns; v.offset = u32[p + 4 + i * 3]; } break; }
		case 22 /* SET_INDEX_BUFFER */: if (S.ib.fmt !== u32[p + 1] || !S.ib.buf !== !u32[p]) pdirty = true; S.ib.buf = u32[p]; S.ib.fmt = u32[p + 1]; S.ib.offset = u32[p + 2]; break;
		case 23 /* SET_CBUFFERS */: { bindEpoch[u32[p]]++; const st = u32[p], s = u32[p + 1], c = u32[p + 2]; for (let i = 0; i < c && s + i < 16; i++) { const v = S.cb[st][s + i]; v.buf = u32[p + 3 + i * 3]; v.first = u32[p + 4 + i * 3]; v.num = u32[p + 5 + i * 3]; } break; }
		case 24 /* SET_SRVS */: { bindEpoch[u32[p]]++; const st = u32[p], s = u32[p + 1], c = u32[p + 2]; for (let i = 0; i < c && s + i < 128; i++) S.srv[st][s + i] = u32[p + 3 + i]; break; }
		case 25 /* SET_SAMPLERS */: { bindEpoch[u32[p]]++; const st = u32[p], s = u32[p + 1], c = u32[p + 2]; for (let i = 0; i < c && s + i < 16; i++) S.smp[st][s + i] = u32[p + 3 + i]; break; }
		case 26 /* SET_RENDER_TARGETS */: {
			for (let i = 0; i < 8; i++) { const r = S.rt[i]; r.tex = u32[p + i * 4]; r.mip = u32[p + 1 + i * 4]; r.slice = u32[p + 2 + i * 4]; r.fmt = u32[p + 3 + i * 4]; }
			const q = p + 32, d = S.ds; d.tex = u32[q]; d.mip = u32[q + 1]; d.slice = u32[q + 2]; d.fmt = u32[q + 3]; d.flags = u32[q + 4];
			rtKey = null;
			pdirty = true;
			break;
		}
		case 27 /* SET_BLEND */: { if (S.blend.id !== u32[p]) pdirty = true; const b = S.blend, f = b.factor; b.id = u32[p]; f[0] = f32[p + 1]; f[1] = f32[p + 2]; f[2] = f32[p + 3]; f[3] = f32[p + 4]; b.mask = u32[p + 5]; break; }		// in place: these state ops run between most draws, a new object each time fed the GC
		case 28 /* SET_DEPTH_STENCIL */: if (S.dss.id !== u32[p]) pdirty = true; S.dss.id = u32[p]; S.dss.ref = u32[p + 1]; break;
		case 29 /* SET_RASTER */: if (S.rs !== u32[p]) pdirty = true; S.rs = u32[p]; break;
		case 30 /* SET_VIEWPORTS */: { const c = u32[p], vs = S.viewports; vs.length = c; for (let i = 0; i < c; i++) { const v = vs[i] || (vs[i] = [0, 0, 0, 0, 0, 0]); for (let k = 0; k < 6; k++) v[k] = f32[p + 1 + i * 6 + k]; } break; }
		case 31 /* SET_SCISSORS */: { const c = u32[p], ss = S.scissors; ss.length = c; for (let i = 0; i < c; i++) { const r = ss[i] || (ss[i] = [0, 0, 0, 0]); for (let k = 0; k < 4; k++) r[k] = u32[p + 1 + i * 4 + k]; } break; }
		case 32 /* DRAW */: if (!isNode && !shaderSourcesReady()) { await ensureShaderSources(); refreshViews(); } doDraw(p); if (debugPsProbe) { await probeSmallSrvs(); refreshViews(); } if (debugDraw && drawCount > debugDraw && drawCount <= debugDraw + debugDrawN) { await probeTarget(); refreshViews(); } if (nanHuntState === 2) { await nanScanAfterDraw(); refreshViews(); } break;
		case 33 /* CLEAR_STATE */: resetState(); break;
		case 37 /* CREATE_UAV */: createUav(p); break;
		case 41 /* GENERATE_MIPS */: generateMips(u32[p]); break;
		case 42 /* READBACK */: {		// the copy is recorded and submitted now (queue order is kept); only the mapping is awaited, without blocking this command loop
			const flagAddr = u32[p + 15] + u32[p + 16] * 4294967296, rt0 = performance.now();
			readbacksInFlight++;
			const done = () => { readbacksInFlight--; readbacksDone++; readbackMs += performance.now() - rt0; if (flagAddr) { refreshViews(); Atomics.store(i32, w32(flagAddr), 0); Atomics.notify(i32, w32(flagAddr)); } };
			readback(p).catch((e) => logLine('readback failed: ' + (e && e.message || e))).finally(done);
			break;
		}
		case 38 /* SET_UAVS */: { bindEpoch[u32[p]]++; const st = u32[p], s0 = u32[p + 1], c = u32[p + 2]; for (let i = 0; i < c && s0 + i < 8; i++) { S.uav[st][s0 + i] = u32[p + 3 + i]; if (u32[p + 3 + c + i] !== 0xffffffff) setUavCounter(u32[p + 3 + i], u32[p + 3 + c + i]); } break; }
		case 44 /* CREATE_QUERY */: createQuery(u32[p], u32[p + 1], u32[p + 2] + u32[p + 3] * 4294967296); break;
		case 45 /* BEGIN_QUERY */: beginQuery(u32[p]); break;
		case 46 /* END_QUERY */: endQuery(u32[p], u32[p + 1]); break;
		case 43 /* COPY_COUNTER */: copyCounter(u32[p], u32[p + 1], u32[p + 2]); if (debugCounters && counterLogged < debugCounters) { counterLogged++; await logCounter(u32[p + 2]); refreshViews(); } break;
		case 39 /* DISPATCH */: if (!isNode && !shaderSourcesReady()) { await ensureShaderSources(); refreshViews(); } doDispatch(u32[p], u32[p + 1], u32[p + 2]); if (debugCsProbe) { debugCsProbe = false; await probeUavs(); refreshViews(); } break;
		case 40 /* CLEAR_UAV */: clearUav(u32[p], u32[p + 1], [u32[p + 2], u32[p + 3], u32[p + 4], u32[p + 5]]); break;
		case 34 /* COPY_REGION */: copyRegion(u32[p], u32[p + 1], u32[p + 2], u32[p + 3], u32[p + 4], u32[p + 5], u32[p + 6], u32[p + 7], u32[p + 8], u32[p + 9], u32[p + 10], u32[p + 11], u32[p + 12], u32[p + 13]); break;
		case 35 /* COPY_RESOURCE */: copyResource(u32[p], u32[p + 1]); break;
		case 36 /* RESOLVE */: resolve(u32[p], u32[p + 1], u32[p + 2], u32[p + 3]); break;
		default: logLine('unknown opcode ' + op); break;
		}
		executedLocal++;		// published in batches (statistics only): an atomic add per command was measurable at ~25,000 commands per frame
		tail += n * 4 + 8;
		if (++sinceYield >= 512) {
			sinceYield = 0;
			Atomics.add(i32, ringW + 3, executedLocal); commandsRun += executedLocal; executedLocal = 0;
			Atomics.store(i32, ringW + 1, tail);		// let the producers reuse the ring space already consumed
			Atomics.notify(i32, ringW + 1);
			// The event loop gets a turn at most every 2 ms (completion callbacks: fences, readbacks, queries): a MessageChannel round trip per 512 commands was ~50 per frame
			const tn = performance.now();
			if (tn - lastYieldT >= 2) {
				await yieldTask();
				refreshViews();
				lastYieldT = performance.now();
			}
		}
		// The views are refreshed after each await above (another thread may have grown the memory meanwhile), not after every command: the `mem.buffer` getter is a runtime
		// call (~1 % of this worker). Between awaits the commands only touch the ring, which lies inside the views; paths that write to other addresses refresh themselves.
	}
	return tail;
}

async function loop() {
	const hi = ringW, ti = hi + 1;
	let tail = RING_DATA;
	Atomics.store(i32, ti, tail);
	Atomics.store(i32, hi + 2, 1);
	for (;;) {
		refreshViews();
		const head = Atomics.load(i32, hi);
		if (head === tail) {
			if (pendingEvents.length || pendingResolve.length) { flush('idle'); onSubmitted(); }		// nobody is producing: let waiting fences/queries finish
			aheadStep();		// pipelines compiled ahead (while the game loads, the worker is mostly idle)
			const w0 = performance.now();
			// producers only notify while `sleeping` (header word 5) is set (wgpu_backend.cpp Publish): set it, then re-read head so a command published in between is not missed
			Atomics.store(i32, hi + 5, 1);
			if (Atomics.load(i32, hi) !== tail) { Atomics.store(i32, hi + 5, 0); continue; }
			const r = typeof Atomics.waitAsync === 'function' ? Atomics.waitAsync(i32, hi, tail, 100) : null;
			if (r && r.async) await r.value;
			else if (!r) await new Promise((res) => setTimeout(res, 1));
			Atomics.store(i32, hi + 5, 0);
			const idle = performance.now() - w0;
			idleMs += idle; fr.idle += idle;
			// what the game may have been waiting for while it sent nothing: data read back from the GPU, occlusion results, fences answered by the GPU
			if (readbacksInFlight) waitedOn.readback += idle;
			if (pendingResolve.length || resolvesInFlight) waitedOn.occlusion += idle;
			if (fencesInFlight) waitedOn.fence += idle;
			continue;
		}
		const b0 = performance.now();
		tail = await runCommands(tail, head);
		if (executedLocal) { Atomics.add(i32, ringW + 3, executedLocal); commandsRun += executedLocal; executedLocal = 0; }
		busyMs += performance.now() - b0;
		refreshViews();
		Atomics.store(i32, ti, tail);
		Atomics.notify(i32, ti);
	}
}

async function start(msg) {
	logLine('start: ring ' + msg.ring + ' size ' + msg.size + ' canvas ' + !!msg.canvas + ' shaders ' + msg.shaderUrl);
	mem = msg.memory;
	if (msg.shaderUrl) shaderUrl = msg.shaderUrl;
	if (!isNode && msg.shotEvery) shotEvery = msg.shotEvery;
	ringBase = msg.ring;
	ringW = w32(ringBase);
	ringSize = msg.size;
	if (msg.dbg) dbgIdx = w32(msg.dbg + 424);		// WasmInputBlock.dbgDrawLimit (platform/input/browser_input_wasm.cpp)
	refreshViews();
	try {
		await initDevice(msg);
	} catch (e) {
		logLine('init failed: ' + (e && e.stack || e));
		Atomics.store(i32, ringW + 2, 2);
		// drain forever so the producers never block
		for (;;) {
			refreshViews();
			const h = Atomics.load(i32, ringW);
			Atomics.store(i32, ringW + 1, h);
			Atomics.notify(i32, ringW + 1);
			await new Promise((res) => setTimeout(res, 5));
		}
	}
	post({ ready: true });
	loadRecipes().catch((e) => logLine('pipeline recipes not loaded: ' + (e && e.message)));
	await loop();
}

if (!isNode) {
	self.addEventListener('error', (e) => logLine('worker error: ' + e.message + ' ' + e.filename + ':' + e.lineno));
	self.addEventListener('unhandledrejection', (e) => logLine('worker rejection: ' + (e.reason && e.reason.stack || e.reason)));
	logLine('worker script loaded');
	self.postMessage({ loaded: true });		// loader.js waits for this before it starts the engine (see there)
}
if (isNode && parentPort) parentPort.on('message', (m) => { start(m); });
else if (!isNode) self.onmessage = (ev) => {
	if (ev.data && ev.data.localFiles) { localFiles = ev.data.localFiles; return; }		// loader.js, before the start message (see the fetch above)
	start(ev.data);
};
if (typeof module !== 'undefined') module.exports = { packUniforms, parseWgsl };
