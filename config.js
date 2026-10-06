// Configuração pública do hub. A anon key do Supabase é segura de expor —
// o acesso real é controlado por Row Level Security no banco.
window.HUB_CONFIG = {
  SUPABASE_URL: "https://wnjvifnspcyghrhezshl.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InduanZpZm5zcGN5Z2hyaGV6c2hsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4MzU1MDQsImV4cCI6MjEwMzQxMTUwNH0.GpG5dttc9MqVTSrlwMv5IzEAk2tjXDWX4oe9_G3mv7Q",
  // App em Acesso Padrão (sem Revisão da Meta) — funciona porque só o admin do app
  // (você) faz login aqui, nunca o cliente.
  FB_APP_ID: "1304916544999833",
  FB_API_VERSION: "v21.0",
};
