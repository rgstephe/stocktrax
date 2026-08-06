// Minimal JSON fetch helper shared across pages.
window.api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
  post(path, body) { return this.send('POST', path, body); },
  patch(path, body) { return this.send('PATCH', path, body); },
  put(path, body) { return this.send('PUT', path, body); },
};
