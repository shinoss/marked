// Wait for module evaluation (including bundled WASM imports) before sending
// engine commands. Messages sent during top-level await can otherwise be lost.
export function waitForWorker(worker, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (error) reject(error); else resolve();
    };
    const onMessage = event => {
      if (event.data?.kind === 'marked-ready') finish();
    };
    const onError = event => finish(new Error(event.message || 'The local AI worker could not start.'));
    const timer = setTimeout(() => finish(new Error('The AI worker did not start within 45 seconds. Reload Marked and try again; check the extension console for a blocked script or WASM error.')), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
  });
}
