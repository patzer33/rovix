/**
 * Hub de eventos em memória + Server-Sent Events (SSE).
 * O front pode abrir um EventSource e receber atualizações sem ficar fazendo polling.
 */
function createHub() {
  const listeners = new Set();

  function publish(type, payload = {}) {
    const event = { type, at: new Date().toISOString(), ...payload };
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        /* um cliente com problema não pode derrubar os demais */
      }
    }
  }

  /**
   * Abre uma conexão SSE. `filter(event)` decide o que cada cliente recebe;
   * `transform(event)` (opcional) monta o dado enviado.
   */
  function openStream(req, res, { filter = () => true, transform = (e) => e, hello } = {}) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    res.write('retry: 2000\n\n');
    if (hello !== undefined) res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);

    const listener = (event) => {
      if (!filter(event)) return;
      const data = transform(event);
      if (data === undefined || data === null) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    listeners.add(listener);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      listeners.delete(listener);
    });
  }

  return { publish, openStream, listenerCount: () => listeners.size };
}

module.exports = { createHub };
