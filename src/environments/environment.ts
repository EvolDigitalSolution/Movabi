export const environment = {
  production: false,
  supabaseUrl: typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '',
  supabaseAnonKey: typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : '',
  apiUrl: 'http://localhost:3001',
  appUrl: 'http://localhost:3000'
};
