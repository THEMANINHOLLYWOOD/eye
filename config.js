// Eye's backends. Same projects the clippers use; only public (publishable /
// anon) keys here — every read and write runs as the signed-in person under
// each app's row-level security.
globalThis.EYE_CONFIG = {
  name: "Eye",
  sbm: {
    name: "Storyboardmore",
    appUrl: "https://storyboardmore.com",
    supabaseUrl: "https://dcnlxruperstsktjgmax.supabase.co",
    anonKey: "sb_publishable_0QWAXdEgXkxSCujmErnJLQ_yi8eZ27v",
    maxUploadBytes: 50 * 1024 * 1024,
  },
  brn: {
    name: "BRN",
    appUrl: "https://burningstudioproductions.com",
    supabaseUrl: "https://yruvmgauixmtactkwesc.supabase.co",
    anonKey:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlydXZtZ2F1aXhtdGFjdGt3ZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk0NDg4MzEsImV4cCI6MjA4NTAyNDgzMX0.6lLJA5cMvzDnhxjg2Hp1WM3lGhm3e7qykw2wV7pCF5M",
    maxUploadBytes: 500 * 1024 * 1024,
    inboxMaxBytes: 20 * 1024 * 1024,
  },
  // The helper that runs Claude Code on this Mac (eye-helper/server.mjs).
  helperUrl: "http://127.0.0.1:47823",
};
