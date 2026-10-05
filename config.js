// Configuração pública do hub. A anon key do Supabase é segura de expor —
// o acesso real é controlado por Row Level Security no banco.
window.HUB_CONFIG = {
  SUPABASE_URL: "https://wnjvifnspcyghrhezshl.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InduanZpZm5zcGN5Z2hyaGV6c2hsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4MzU1MDQsImV4cCI6MjEwMzQxMTUwNH0.GpG5dttc9MqVTSrlwMv5IzEAk2tjXDWX4oe9_G3mv7Q",
  // Preenchido quando o Facebook App for aprovado (ver README). Enquanto for null,
  // a tela usa o fluxo de token manual.
  FB_APP_ID: null,
  FB_API_VERSION: "v21.0",
};
