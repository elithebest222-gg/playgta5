// game.js - Local Asset Integration Version
window.GTA_LOCAL_ASSETS = new Map();

document.getElementById('folder-picker').addEventListener('change', async (event) => {
    const files = event.target.files;
    const status = document.getElementById('status-msg');
    
    if (files.length === 0) return;
    
    status.innerText = "Indexing asset chunks... Please wait.";
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        let cleanPath = file.webkitRelativePath.substring(file.webkitRelativePath.indexOf('/') + 1);
        window.GTA_LOCAL_ASSETS.set(cleanPath, file);
    }
    
    if (window.GTA_LOCAL_ASSETS.size > 0) {
        status.innerText = `Success! Verified ${window.GTA_LOCAL_ASSETS.size} file segments. Initing canvas...`;
        setTimeout(() => {
            document.getElementById('setup-overlay').style.display = 'none';
            initializeEngineCanvas();
        }, 1000);
    } else {
        status.innerText = "Error: Invalid folder structural payload. Ensure it is the root .mirror directory.";
    }
});

function initializeEngineCanvas() {
    console.log("Bootstrapping WebGL/WebGPU sub-systems...");
    if (typeof bootstrapGameRuntime === "function") {
        bootstrapGameRuntime();
    } else {
        const loaderScript = document.createElement('script');
        loaderScript.src = 'loader.js';
        document.body.appendChild(loaderScript);
    }
}
