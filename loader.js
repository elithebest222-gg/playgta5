// loader.js - Local Asset Integration Version
function bootstrapGameRuntime() {
    console.log("Loading WASM core framework...");

    const ioWorker = new Worker('io_worker.js');

    ioWorker.onmessage = function(e) {
        if (e.data.type === 'FETCH_REQUEST') {
            const requestedFile = e.data.path;
            const fileBlob = window.GTA_LOCAL_ASSETS.get(requestedFile);

            if (fileBlob) {
                const reader = new FileReader();
                reader.onload = function(event) {
                    ioWorker.postMessage({
                        type: 'FETCH_RESPONSE',
                        requestId: e.data.requestId,
                        buffer: event.target.result,
                        success: true
                    }, [event.target.result]);
                };
                reader.readAsArrayBuffer(fileBlob);
            } else {
                ioWorker.postMessage({
                    type: 'FETCH_RESPONSE',
                    requestId: e.data.requestId,
                    success: false,
                    error: 'File not found in mapped mirror directory.'
                });
            }
        }
    };

    console.log("WASM Worker layer fully locked.");
}
