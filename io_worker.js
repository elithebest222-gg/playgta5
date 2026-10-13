// io_worker.js - Local Asset Integration Version
const pendingRequests = new Map();
let requestCounter = 0;

self.interceptAssetRead = function(filePath) {
    return new Promise((resolve, reject) => {
        const id = ++requestCounter;
        pendingRequests.set(id, { resolve, reject });

        self.postMessage({
            type: 'FETCH_REQUEST',
            requestId: id,
            path: filePath
        });
    });
};

self.onmessage = function(e) {
    if (e.data.type === 'FETCH_RESPONSE') {
        const callback = pendingRequests.get(e.data.requestId);
        if (!callback) return;

        pendingRequests.delete(e.data.requestId);

        if (e.data.success) {
            callback.resolve(e.data.buffer);
        } else {
            callback.reject(new Error(e.data.error));
        }
    }
};

self.addEventListener('message', function(e) {
    // Main framework lifecycle hooks
});
