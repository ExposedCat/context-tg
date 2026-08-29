const response = await fetch("http://127.0.0.1:8787/healthz");
if (!response.ok) {
  process.exit(1);
}

export {};
