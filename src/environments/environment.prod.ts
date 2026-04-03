export const environment = {
  production: true,
  supabaseUrl: typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '',
  supabaseAnonKey: typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : '',
  apiUrl: 'https://movabinode.apps.evolsolution.com',
  appUrl: 'https://movemate-prod.app'
};
